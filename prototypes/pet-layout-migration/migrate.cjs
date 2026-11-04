"use strict";

/*
 * ArkPet PetDesktopLayout v3 migration prototype.
 *
 * Pure functions only. No IO, no clock, no randomness, no shared mutable state.
 * The prototype never writes state; it only converts one legacy pet record into
 * the v3 layout shape so the migration can be reviewed and unit tested before it
 * lands in electron/ or src/.
 */

const LAYOUT_VERSION = 3;

const DEFAULT_DISPLAY_WIDTH = 260;
const DEFAULT_DISPLAY_HEIGHT = 320;
const DEFAULT_VISUAL_WIDTH = 104;
const DEFAULT_VISUAL_HEIGHT = 134;
const DEFAULT_HITBOX_WIDTH = 104;
const DEFAULT_HITBOX_HEIGHT = 134;

/* ---------------------------------------------------------------- helpers */

function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * Coerce a legacy field to a finite number. Strings are accepted because old
 * backups occasionally stored numeric values as text.
 */
function num(value, fallback) {
  const parsed = typeof value === "string" ? Number(value) : value;
  return isFiniteNumber(parsed) ? parsed : fallback;
}

/**
 * Round to at most 2 decimals, half away from zero.
 *
 * Math.round() rounds halves toward +Infinity, which is asymmetric: -0.125
 * would become -0.12 while 0.125 becomes 0.13. Symmetric rounding matters here
 * because collision.offsetX is mirrored for direction=-1 at runtime, so an
 * asymmetric round would make left/right facing pets differ by 0.01px.
 */
function round2(value) {
  if (!isFiniteNumber(value)) return value;
  const sign = value < 0 ? -1 : 1;
  const rounded = (sign * Math.round(Math.abs(value) * 100)) / 100;
  return rounded === 0 ? 0 : rounded; // normalise -0
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

/* ------------------------------------------------------- legacy extraction */

/**
 * Resolve one legacy render field with the same precedence the 2.2.0 runtime
 * uses: desktopRenderConfig wins, then renderConfig, then the built-in default.
 *
 * Fallback is field-wise (not object-wise) so a partially written
 * desktopRenderConfig still picks up missing fields from renderConfig.
 */
function readField(desktopRenderConfig, renderConfig, key, fallback) {
  const fromDesktop = num(desktopRenderConfig && desktopRenderConfig[key], NaN);
  if (isFiniteNumber(fromDesktop)) return fromDesktop;
  const fromRender = num(renderConfig && renderConfig[key], NaN);
  if (isFiniteNumber(fromRender)) return fromRender;
  return fallback;
}

/**
 * Normalise every legacy geometry input the migration needs, including which
 * values fell back to a default. `defaultsUsed` is reported to the caller so a
 * silent default never moves a pet without leaving a trace.
 */
function readLegacyLayout(pet) {
  const input = pet && typeof pet === "object" ? pet : {};
  const desktopRenderConfig = input.desktopRenderConfig || null;
  const renderConfig = input.renderConfig || null;
  const hasRenderConfig = Boolean(desktopRenderConfig || renderConfig);
  const defaultsUsed = [];

  function field(key, fallback) {
    const value = readField(desktopRenderConfig, renderConfig, key, NaN);
    if (isFiniteNumber(value)) return value;
    defaultsUsed.push(key);
    return fallback;
  }

  const hitboxWidth = field("hitboxWidth", DEFAULT_HITBOX_WIDTH);
  const hitboxHeight = field("hitboxHeight", DEFAULT_HITBOX_HEIGHT);

  // Rule 1: the new display frame must be at least as large as the old display
  // box and the old visual box, otherwise migration would clip the sprite.
  const displayWidth = field("displayWidth", DEFAULT_DISPLAY_WIDTH);
  const displayHeight = field("displayHeight", DEFAULT_DISPLAY_HEIGHT);
  const visualWidth = field("visualWidth", DEFAULT_VISUAL_WIDTH);
  const visualHeight = field("visualHeight", DEFAULT_VISUAL_HEIGHT);

  const hitboxOffsetX = field("hitboxOffsetX", 0);
  const hitboxOffsetY = field("hitboxOffsetY", 0);

  const desktopPosition = input.desktopPosition && typeof input.desktopPosition === "object"
    ? input.desktopPosition
    : null;

  return {
    hasRenderConfig,
    defaultsUsed,
    displayWidth,
    displayHeight,
    visualWidth,
    visualHeight,
    hitboxWidth,
    hitboxHeight,
    hitboxOffsetX,
    hitboxOffsetY,
    direction: num(desktopPosition && desktopPosition.direction, 1) === -1 ? -1 : 1,
    // offsetX / offsetY are read only so they can be reported in the snapshot as
    // dropped; they are never used in the v3 geometry (rule 6).
    droppedOffsetX: readField(desktopRenderConfig, renderConfig, "offsetX", NaN),
    droppedOffsetY: readField(desktopRenderConfig, renderConfig, "offsetY", NaN),
    desktopPosition
  };
}

/* ------------------------------------------------------------ core maths */

/**
 * Legacy geometry in host-local coordinates.
 *
 * In 2.2.0 the host element is exactly the hitbox rectangle and the Spine canvas
 * is horizontally centred on it with its bottom edge aligned to the host bottom.
 * Legacy numeric evidence for the bottom alignment: hitboxOffsetY values such as
 * 125 with a 96px hitbox only line up with the sprite feet when the display box
 * hangs off the bottom of the host.
 *
 *   host origin (0,0) ──────────────── host right edge (hitboxWidth)
 *   │
 *   │            ┌ display frame ┐        centreY = hitboxHeight - displayHeight/2
 *   │            └───────────────┘        (negative when the box is taller)
 *   │
 *   └──────────── host bottom (hitboxHeight) ─── display frame bottom
 */
function computeLegacyGeometry(legacy, direction, basis) {
  const facing = direction === -1 ? -1 : 1;
  const useEditorOffset = basis === "editor-offset";
  const displayFrameWidth = Math.max(legacy.displayWidth, legacy.visualWidth);
  const displayFrameHeight = Math.max(legacy.displayHeight, legacy.visualHeight);

  // 2.2.0 里有两个不同的坐标系，混用会让角色在升级后位移：
  //
  // A. 运行时：宿主元素 = hitbox 矩形，位置 = desktopPosition；Spine 画布水平居中、
  //    底边贴宿主底边。显示框世界中心相对宿主原点 =
  //    (hitboxWidth/2, hitboxHeight - displayFrameHeight/2)。
  //    PetOverlay.tsx:1447-1460（transform/宽高）、styles.css(.multi-pet-visual inset:0、
  //    .multi-pet-spine bottom:0 left:50%)。落地判定用 entity.y + entity.height。
  //
  // B. 编辑器：显示框居中在舞台中心，碰撞框画在显示框内部
  //    ((dw-hw)/2 + ox, (dh-hh)/2 + oy)；而且编辑器里 anchorBottom=false，sprite 与
  //    运行时也不是同一套摆放。
  //    WorkshopView.tsx:875-898 / 1095-1135、lib/renderConfig.ts getHitboxPosition。
  //
  // 两种口径对「新碰撞体 offset」的取值不同，见 docs/桌宠最终规格.zh-CN.md 第 8.2 节：
  //   host（默认）        : offset = (0, displayFrameHeight/2 - hitboxHeight/2)
  //                         即旧运行时那个身体，角色升级后位置与落地状态都不变。
  //   editor-offset      : offset = (hitboxOffsetX, hitboxOffsetY)
  //                         即旧编辑器里画的框，但角色会按两者差值下落/上移。
  const displayCenterX = legacy.hitboxWidth / 2;
  const displayCenterY = legacy.hitboxHeight - displayFrameHeight / 2;

  const collisionOffsetX = useEditorOffset ? legacy.hitboxOffsetX : 0;
  const collisionOffsetY = useEditorOffset
    ? legacy.hitboxOffsetY
    : displayFrameHeight / 2 - legacy.hitboxHeight / 2;
  const mirroredCollisionOffsetX = facing < 0 ? -collisionOffsetX : collisionOffsetX;

  return {
    basis: useEditorOffset ? "editor-offset" : "host",
    displayFrameWidth,
    displayFrameHeight,
    displayCenterX,
    displayCenterY,
    collisionOffsetX,
    collisionOffsetY,
    mirroredCollisionOffsetX,
    collisionCenterX: displayCenterX + collisionOffsetX,
    collisionCenterY: displayCenterY + collisionOffsetY,
    mirroredCollisionCenterX: displayCenterX + mirroredCollisionOffsetX
  };
}
/* --------------------------------------------------------------- exports */

/**
 * Migrate one pet record to PetDesktopLayout v3.
 *
 * Returns a descriptor rather than a pet so callers can decide where the layout
 * is stored:
 *   { changed, layoutVersion, layout, source, warnings, defaultsUsed, before }
 *
 * Idempotent: a record that already carries layoutVersion 3 is returned
 * unchanged (deep-cloned) with changed=false, so a second import cannot shift
 * the collision rectangle.
 */
function migratePetLayout(pet) {
  return migratePetLayoutWithOptions(pet, null);
}

/**
 * Same as migratePetLayout but lets the caller pick the placement formula.
 *
 * 规格来源：docs/桌宠最终规格.zh-CN.md 第 8 节。碰撞体 = 用户在 2.2.0 编辑器里编辑的那
 */
function migratePetLayoutWithOptions(pet, options) {
  const input = pet && typeof pet === "object" ? pet : {};
  const opts = options && typeof options === "object" ? options : {};
  const existing = (input.layout && typeof input.layout === "object" && input.layout)
    || (input.desktopLayout && typeof input.desktopLayout === "object" && input.desktopLayout)
    || null;

  if (existing && num(existing.layoutVersion, 0) === LAYOUT_VERSION) {
    return {
      changed: false,
      layoutVersion: LAYOUT_VERSION,
      layout: clone(existing),
      source: "v3",
      warnings: [],
      defaultsUsed: [],
      placementFormula: "unchanged"
    };
  }

  const legacy = readLegacyLayout(input);
  const direction = legacy.direction;
  // docs/桌宠最终规格.zh-CN.md 第 8.2 节：默认 host（角色不位移），editor-offset 为另一个口径。
  const basis = opts.geometryBasis === "editor-offset" ? "editor-offset" : "host";
  const geometry = computeLegacyGeometry(legacy, direction, basis);
  const warnings = [];

  if (!legacy.hasRenderConfig) {
    warnings.push("missing-render-config");
  } else if (legacy.defaultsUsed.length > 0) {
    warnings.push("partial-render-config");
  }

  let placementX;
  let placementY;
  const baseX = legacy.desktopPosition ? num(legacy.desktopPosition.x, 0) : 0;
  const baseY = legacy.desktopPosition ? num(legacy.desktopPosition.y, 0) : 0;
  // placement = 显示框世界中心 + 镜像后的碰撞偏移
  const placementCenterX = geometry.displayCenterX + geometry.mirroredCollisionOffsetX;
  const placementCenterY = geometry.displayCenterY + geometry.collisionOffsetY;

  if (legacy.desktopPosition) {
    // Rule 8: keep the world position of the old collision rectangle.
    placementX = baseX + placementCenterX;
    placementY = baseY + placementCenterY;
  } else {
    // No stored position at all. There is nothing to preserve, so the legacy
    // host origin is treated as (0,0): the pet lands in the top-left corner of
    // the primary display instead of being parked off-screen.
    warnings.push("missing-desktop-position");
    placementX = placementCenterX;
    placementY = placementCenterY;
  }

  const collision = {
    width: round2(legacy.hitboxWidth),
    height: round2(legacy.hitboxHeight),
    offsetX: round2(geometry.collisionOffsetX),
    offsetY: round2(geometry.collisionOffsetY)
  };

  const layout = {
    layoutVersion: LAYOUT_VERSION,
    displayFrame: {
      width: round2(geometry.displayFrameWidth),
      height: round2(geometry.displayFrameHeight)
    },
    collision,
    // Rule 7: interaction starts as an exact copy of collision.
    interaction: {
      width: collision.width,
      height: collision.height,
      offsetX: collision.offsetX,
      offsetY: collision.offsetY
    },
    placement: {
      x: round2(placementX),
      y: round2(placementY),
      direction
    }
  };

  return {
    changed: true,
    layoutVersion: LAYOUT_VERSION,
    layout,
    source: legacy.hasRenderConfig ? "legacy" : "defaults",
    warnings,
    defaultsUsed: legacy.defaultsUsed.slice(),
    placementFormula: basis === "editor-offset" ? "editor-offset-center" : "host-collision-center",
    before: {
      renderConfig: input.renderConfig ? clone(input.renderConfig) : null,
      desktopRenderConfig: input.desktopRenderConfig ? clone(input.desktopRenderConfig) : null,
      desktopPosition: input.desktopPosition ? clone(input.desktopPosition) : null,
      droppedOffsetX: legacy.droppedOffsetX,
      droppedOffsetY: legacy.droppedOffsetY,
      direction,
      // The other reading, kept in the snapshot so the difference is reviewable.
      alternativePlacement: (function () {
        const other = computeLegacyGeometry(legacy, direction, basis === "editor-offset" ? "host" : "editor-offset");
        return {
          x: round2(baseX + other.displayCenterX + other.mirroredCollisionOffsetX),
          y: round2(baseY + other.displayCenterY + other.collisionOffsetY)
        };
      })()
    }
  };
}

/**
 * Convenience wrapper: return a new pet record with `layout` attached. Legacy
 * fields are intentionally left untouched so a rollback stays possible and the
 * before/after diff stays readable.
 */
function migratePet(pet, options) {
  const input = pet && typeof pet === "object" ? pet : {};
  const result = migratePetLayoutWithOptions(input, options);
  const migrated = Object.assign({}, input, { layout: result.layout });
  return { changed: result.changed, pet: migrated, result };
}

function migratePets(pets, options) {
  const list = Array.isArray(pets) ? pets : [];
  return list.map(function (pet) {
    return migratePet(pet, options);
  });
}

/** Mirror collision/interaction offsetX for the given facing direction. */
function mirrorOffsetX(offsetX, direction) {
  const mirrored = direction === -1 ? -offsetX : offsetX;
  // Normalise -0: it would otherwise leak into resolved rects as "-0".
  return mirrored === 0 ? 0 : mirrored;
}

/**
 * World position of the display frame centre.
 *
 * placement stores the collision centre, so the display frame centre is the
 * collision centre minus the (direction-aware) collision offset.
 */
function resolveDisplayFrameCenter(layout) {
  const collision = layout.collision;
  const direction = layout.placement.direction === -1 ? -1 : 1;
  return {
    x: round2(layout.placement.x - mirrorOffsetX(collision.offsetX, direction)),
    y: round2(layout.placement.y - collision.offsetY)
  };
}

/** World rectangle of an offset box, given the display frame centre. */
function resolveBoxRect(box, displayCenter, direction) {
  const centerX = displayCenter.x + mirrorOffsetX(box.offsetX, direction);
  const centerY = displayCenter.y + box.offsetY;
  return {
    left: round2(centerX - box.width / 2),
    top: round2(centerY - box.height / 2),
    right: round2(centerX + box.width / 2),
    bottom: round2(centerY + box.height / 2),
    centerX: round2(centerX),
    centerY: round2(centerY)
  };
}

/** World rectangles for the migrated layout (debugging + invariant checks). */
function resolveLayoutRects(layout) {
  const direction = layout.placement.direction === -1 ? -1 : 1;
  const displayCenter = resolveDisplayFrameCenter(layout);
  return {
    direction,
    displayCenter,
    displayFrame: {
      left: round2(displayCenter.x - layout.displayFrame.width / 2),
      top: round2(displayCenter.y - layout.displayFrame.height / 2),
      right: round2(displayCenter.x + layout.displayFrame.width / 2),
      bottom: round2(displayCenter.y + layout.displayFrame.height / 2)
    },
    collision: resolveBoxRect(layout.collision, displayCenter, direction),
    interaction: resolveBoxRect(layout.interaction, displayCenter, direction)
  };
}

/**
 * Legacy world rectangle of the ON-SCREEN collision body.
 *
 * This is the rectangle 2.2.0 actually simulated: the host element, which is
 * hitbox sized and positioned at desktopPosition, and which the sprite canvas is
 * anchored to. It is the invariant the migration must preserve.
 */
function resolveLegacyCollisionRect(pet, options) {
  const legacy = readLegacyLayout(pet);
  const basis = options && options.geometryBasis === "editor-offset" ? "editor-offset" : "host";
  const geometry = computeLegacyGeometry(legacy, legacy.direction, basis);
  const x = legacy.desktopPosition ? num(legacy.desktopPosition.x, 0) : 0;
  const y = legacy.desktopPosition ? num(legacy.desktopPosition.y, 0) : 0;
  const centerX = x + geometry.mirroredCollisionCenterX;
  const centerY = y + geometry.collisionCenterY;
  return {
    left: round2(centerX - legacy.hitboxWidth / 2),
    top: round2(centerY - legacy.hitboxHeight / 2),
    right: round2(centerX + legacy.hitboxWidth / 2),
    bottom: round2(centerY + legacy.hitboxHeight / 2),
    centerX: round2(centerX),
    centerY: round2(centerY)
  };
}

/**
 * Legacy world centre of the display frame (the Spine canvas).
 *
 * The canvas was horizontally centred on the hitbox host and bottom aligned to
 * it, so both components are direction invariant. Migration must keep this
 * point fixed: it is where the user perceived the sprite to be.
 */
function resolveLegacyDisplayFrameCenter(pet) {
  const legacy = readLegacyLayout(pet);
  const geometry = computeLegacyGeometry(legacy, legacy.direction, "host");
  const x = legacy.desktopPosition ? num(legacy.desktopPosition.x, 0) : 0;
  const y = legacy.desktopPosition ? num(legacy.desktopPosition.y, 0) : 0;
  return {
    x: round2(x + geometry.displayCenterX),
    y: round2(y + geometry.displayCenterY)
  };
}

module.exports = {
  LAYOUT_VERSION,
  DEFAULT_DISPLAY_WIDTH,
  DEFAULT_DISPLAY_HEIGHT,
  DEFAULT_VISUAL_WIDTH,
  DEFAULT_VISUAL_HEIGHT,
  DEFAULT_HITBOX_WIDTH,
  DEFAULT_HITBOX_HEIGHT,
  num,
  round2,
  readLegacyLayout,
  computeLegacyGeometry,
  migratePetLayout,
  migratePetLayoutWithOptions,
  migratePet,
  migratePets,
  mirrorOffsetX,
  resolveDisplayFrameCenter,
  resolveBoxRect,
  resolveLayoutRects,
  resolveLegacyCollisionRect,
  resolveLegacyDisplayFrameCenter
};
