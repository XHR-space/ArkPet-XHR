"use strict";

/*
 * ArkPet PetDesktopLayout v3 data-layer implementation.
 *
 * Ported from the verified prototype prototypes/pet-layout-migration/migrate.cjs
 * (see prototypes/pet-layout-migration/README.md, "与真实 2.2.0 DOM 的对账").
 * The formulas are intentionally identical to the prototype so the reviewed
 * fixtures still describe this module: do not re-derive them here.
 *
 * Pure functions only. No IO, no clock, no randomness, no shared mutable state.
 * "host" is the shipping geometry basis; "legacy-offset" is kept only so the two
 * interpretations can be diffed during review.
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
    // offsetX / offsetY are read only so they can be reported as dropped; they
    // are never used in the v3 geometry (rule 6).
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
  const useLegacyOffset = basis === "legacy-offset";
  const displayFrameWidth = Math.max(legacy.displayWidth, legacy.visualWidth);
  const displayFrameHeight = Math.max(legacy.displayHeight, legacy.visualHeight);

  // Display frame (the Spine canvas) in host-local coordinates: the canvas is
  // horizontally centred on the host and its bottom edge sits on the host
  // bottom edge. Source: src/components/PetOverlay.tsx sets the host transform
  // to translate3d(entity.x, entity.y) and sizes the host to the hitbox,
  // src/styles.css gives .multi-pet-visual inset:0 and .multi-pet-spine
  // bottom:0 / left:50%.
  const centerX = legacy.hitboxWidth / 2;
  const centerY = legacy.hitboxHeight - displayFrameHeight / 2;

  // Collision body in host-local coordinates.
  //
  // host (default): the box the 2.2.0 runtime actually simulated and anchored
  //   the sprite to - grounding compares entity.y + entity.height against the
  //   work-area floor, and the host is exactly that rectangle. Preserving it
  //   keeps both the physics rect and the visible pet in place.
  //
  // legacy-offset: additionally adds hitboxOffsetX/Y. In 2.2.0 those offsets
  //   only move the pointer-target div (PetOverlay.tsx hitboxRef.style.left/top)
  //   and, differently again, the editor preview (getHitboxPosition centres the
  //   box inside the display frame first). Treating them as a world offset moves
  //   the pet by that amount, so this basis is kept only for A/B review.
  const collisionCenterX = useLegacyOffset
    ? legacy.hitboxOffsetX + legacy.hitboxWidth / 2
    : legacy.hitboxWidth / 2;
  const collisionCenterY = useLegacyOffset
    ? legacy.hitboxOffsetY + legacy.hitboxHeight / 2
    : legacy.hitboxHeight / 2;

  // The legacy host is not mirrored for direction=-1; only the pointer target
  // was, and only under the legacy-offset basis.
  const mirroredCollisionCenterX = useLegacyOffset
    ? (facing < 0 ? -legacy.hitboxOffsetX : legacy.hitboxOffsetX) + legacy.hitboxWidth / 2
    : collisionCenterX;

  return {
    basis: useLegacyOffset ? "legacy-offset" : "host",
    displayFrameWidth,
    displayFrameHeight,
    centerX,
    centerY,
    collisionCenterX,
    collisionCenterY,
    mirroredCollisionCenterX,
    collisionOffsetX: collisionCenterX - centerX,
    collisionOffsetY: collisionCenterY - centerY
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
 * options.geometryBasis
 *   "host" (default) -> the collision body is the host rectangle at
 *            desktopPosition. Preserves the legacy physics rect and the visible
 *            pet position exactly.
 *   "legacy-offset" -> also adds hitboxOffsetX/Y to the body centre. 2.2.0 only
 *            used those offsets for the pointer target, so this basis moves the
 *            pet by (hitboxOffsetX, hitboxOffsetY). Kept for A/B review only.
 */
function migratePetLayoutWithOptions(pet, options) {
  const input = pet && typeof pet === "object" ? pet : {};
  const opts = options && typeof options === "object" ? options : {};
  // "host" is the shipping basis; "legacy-offset" exists only so the two
  // interpretations can be diffed side by side.
  const basis = opts.geometryBasis === "legacy-offset" ? "legacy-offset" : "host";
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
  const placementCenterX = geometry.mirroredCollisionCenterX;

  if (legacy.desktopPosition) {
    // Rule 8: keep the world position of the old collision rectangle.
    placementX = baseX + placementCenterX;
    placementY = baseY + geometry.collisionCenterY;
  } else {
    // No stored position at all. There is nothing to preserve, so the legacy
    // host origin is treated as (0,0): the pet lands in the top-left corner of
    // the primary display instead of being parked off-screen.
    warnings.push("missing-desktop-position");
    placementX = placementCenterX;
    placementY = geometry.collisionCenterY;
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
    placementFormula: basis === "legacy-offset" ? "legacy-offset-center" : "host-collision-center",
    before: {
      renderConfig: input.renderConfig ? clone(input.renderConfig) : null,
      desktopRenderConfig: input.desktopRenderConfig ? clone(input.desktopRenderConfig) : null,
      desktopPosition: input.desktopPosition ? clone(input.desktopPosition) : null,
      droppedOffsetX: legacy.droppedOffsetX,
      droppedOffsetY: legacy.droppedOffsetY,
      direction,
      // Where the "add hitboxOffsetX/Y" reading would have put the pet, for review only.
      legacyOffsetPlacement: (function () {
        const legacyGeometry = computeLegacyGeometry(legacy, direction, "legacy-offset");
        return {
          x: round2(baseX + legacyGeometry.mirroredCollisionCenterX),
          y: round2(baseY + legacyGeometry.collisionCenterY)
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

/**
 * Ensure one pet record carries a v3 layout, mutating it in place.
 *
 * Incremental write: only `pet.layout` is added when the record has no v3
 * layout yet. renderConfig / desktopRenderConfig / desktopPosition and every
 * other legacy field are left untouched so the archive stays rollbackable.
 *
 * Idempotent: a record that already has layoutVersion 3 is not recomputed and
 * its placement is not touched.
 */
function ensurePetLayout(pet, options) {
  if (!pet || typeof pet !== "object") {
    return { changed: false, layoutVersion: LAYOUT_VERSION, layout: null, source: "invalid" };
  }
  const result = migratePetLayoutWithOptions(pet, options);
  if (result.changed) {
    pet.layout = result.layout;
  }
  return result;
}

/** Ensure every pet in the list carries a v3 layout, in place. */
function ensurePetLayouts(pets, options) {
  const list = Array.isArray(pets) ? pets : [];
  return list.map(function (pet) {
    return ensurePetLayout(pet, options);
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
function resolveLegacyCollisionRect(pet) {
  const legacy = readLegacyLayout(pet);
  const x = legacy.desktopPosition ? num(legacy.desktopPosition.x, 0) : 0;
  const y = legacy.desktopPosition ? num(legacy.desktopPosition.y, 0) : 0;
  return {
    left: round2(x),
    top: round2(y),
    right: round2(x + legacy.hitboxWidth),
    bottom: round2(y + legacy.hitboxHeight),
    centerX: round2(x + legacy.hitboxWidth / 2),
    centerY: round2(y + legacy.hitboxHeight / 2)
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
  const geometry = computeLegacyGeometry(legacy, legacy.direction);
  const x = legacy.desktopPosition ? num(legacy.desktopPosition.x, 0) : 0;
  const y = legacy.desktopPosition ? num(legacy.desktopPosition.y, 0) : 0;
  return {
    x: round2(x + geometry.centerX),
    y: round2(y + geometry.centerY)
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
  ensurePetLayout,
  ensurePetLayouts,
  mirrorOffsetX,
  resolveDisplayFrameCenter,
  resolveBoxRect,
  resolveLayoutRects,
  resolveLegacyCollisionRect,
  resolveLegacyDisplayFrameCenter
};
