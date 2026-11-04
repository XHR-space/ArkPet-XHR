import type {
  PetDesktopLayout,
  PetDesktopPosition,
  PetLayoutBox,
  PetRenderConfig
} from "../types";

export const PET_LAYOUT_VERSION = 3;

export const DEFAULT_RENDER_CONFIG: PetRenderConfig = {
  displayWidth: 260,
  displayHeight: 320,
  visualWidth: 104,
  visualHeight: 134,
  hitboxWidth: 104,
  hitboxHeight: 134,
  hitboxOffsetX: 0,
  hitboxOffsetY: 0,
  offsetX: 0,
  offsetY: 0
};

export type HitboxGeometry = {
  displayWidth: number;
  displayHeight: number;
  hitboxWidth: number;
  hitboxHeight: number;
  hitboxOffsetX?: number;
  hitboxOffsetY?: number;
  direction?: 1 | -1;
};

export type HitboxPosition = {
  left: number;
  top: number;
};

function finiteNumber(value: unknown, fallback: number) {
  const parsed = typeof value === "string" ? Number(value) : value;
  return typeof parsed === "number" && Number.isFinite(parsed)
    ? parsed
    : fallback;
}

function round2(value: number) {
  const rounded = Math.round(value * 100) / 100;
  return rounded === 0 ? 0 : rounded;
}

function mirrorLayoutOffsetX(offsetX: number, direction: 1 | -1) {
  const mirrored = direction === -1 ? -offsetX : offsetX;
  return mirrored === 0 ? 0 : mirrored;
}

function normalizeLayoutBox(
  value: Partial<PetLayoutBox> | null | undefined,
  fallback: PetLayoutBox
): PetLayoutBox {
  return {
    width: Math.max(1, finiteNumber(value?.width, fallback.width)),
    height: Math.max(1, finiteNumber(value?.height, fallback.height)),
    offsetX: finiteNumber(value?.offsetX, fallback.offsetX),
    offsetY: finiteNumber(value?.offsetY, fallback.offsetY)
  };
}

export function isPetLayoutV3(
  layout: unknown
): layout is PetDesktopLayout {
  return (
    Boolean(layout) &&
    typeof layout === "object" &&
    finiteNumber(
      (layout as { layoutVersion?: unknown }).layoutVersion,
      -1
    ) === PET_LAYOUT_VERSION
  );
}

export function resolvePetLayout(
  layout?: Partial<PetDesktopLayout> | null,
  renderConfig?: Partial<PetRenderConfig> | null,
  desktopPosition?: PetDesktopPosition | null
): PetDesktopLayout {
  const config = withRenderConfigDefaults(renderConfig);
  const legacyDisplayFrame = {
    width: Math.max(config.displayWidth, config.visualWidth),
    height: Math.max(config.displayHeight, config.visualHeight)
  };
  const legacyCollision: PetLayoutBox = {
    width: config.hitboxWidth,
    height: config.hitboxHeight,
    offsetX: 0,
    offsetY:
      legacyDisplayFrame.height / 2 - config.hitboxHeight / 2
  };
  const hasLayout = isPetLayoutV3(layout);
  const displayFrame = {
    width: Math.max(
      1,
      finiteNumber(
        hasLayout ? layout?.displayFrame?.width : undefined,
        legacyDisplayFrame.width
      )
    ),
    height: Math.max(
      1,
      finiteNumber(
        hasLayout ? layout?.displayFrame?.height : undefined,
        legacyDisplayFrame.height
      )
    )
  };
  const collision = normalizeLayoutBox(
    hasLayout ? layout?.collision : undefined,
    legacyCollision
  );
  const interaction = normalizeLayoutBox(
    hasLayout ? layout?.interaction : undefined,
    collision
  );
  const direction: 1 | -1 =
    (hasLayout && layout?.placement?.direction === -1) ||
    (!hasLayout && desktopPosition?.direction === -1)
      ? -1
      : 1;
  const baseX = finiteNumber(desktopPosition?.x, 0);
  const baseY = finiteNumber(desktopPosition?.y, 0);
  const placement = {
    x: finiteNumber(
      hasLayout ? layout?.placement?.x : undefined,
      baseX + config.hitboxWidth / 2
    ),
    y: finiteNumber(
      hasLayout ? layout?.placement?.y : undefined,
      baseY + config.hitboxHeight / 2
    ),
    direction
  };

  return {
    layoutVersion: PET_LAYOUT_VERSION,
    displayFrame,
    collision,
    interaction,
    placement
  };
}

export function getLayoutBoxPosition(
  displayFrame: PetDesktopLayout["displayFrame"],
  box: PetLayoutBox,
  direction: 1 | -1 = 1
): HitboxPosition {
  return {
    left:
      displayFrame.width / 2 +
      mirrorLayoutOffsetX(box.offsetX, direction) -
      box.width / 2,
    top:
      displayFrame.height / 2 +
      box.offsetY -
      box.height / 2
  };
}

export function getLayoutDisplayFrameCenter(layout: PetDesktopLayout) {
  return {
    x:
      layout.placement.x -
      mirrorLayoutOffsetX(
        layout.collision.offsetX,
        layout.placement.direction
      ),
    y: layout.placement.y - layout.collision.offsetY
  };
}

export function anchorLayoutPlacement(
  original: PetDesktopLayout,
  next: PetDesktopLayout
): PetDesktopLayout {
  const center = getLayoutDisplayFrameCenter(original);
  return {
    ...next,
    placement: {
      ...next.placement,
      x: round2(
        center.x +
          mirrorLayoutOffsetX(
            next.collision.offsetX,
            next.placement.direction
          )
      ),
      y: round2(center.y + next.collision.offsetY)
    }
  };
}

export function getVisualSize(config?: Partial<PetRenderConfig> | null) {
  const hitboxWidth =
    Number(config?.hitboxWidth) || DEFAULT_RENDER_CONFIG.hitboxWidth;
  const hitboxHeight =
    Number(config?.hitboxHeight) || DEFAULT_RENDER_CONFIG.hitboxHeight;
  return {
    visualWidth: Number(config?.visualWidth) || hitboxWidth,
    visualHeight: Number(config?.visualHeight) || hitboxHeight
  };
}

export function getHitboxPosition({
  displayWidth,
  displayHeight,
  hitboxWidth,
  hitboxHeight,
  hitboxOffsetX = 0,
  hitboxOffsetY = 0,
  direction = 1
}: HitboxGeometry): HitboxPosition {
  const horizontalOffset = direction < 0 ? -hitboxOffsetX : hitboxOffsetX;
  return {
    left: (displayWidth - hitboxWidth) / 2 + horizontalOffset,
    top: (displayHeight - hitboxHeight) / 2 + hitboxOffsetY
  };
}

export function withRenderConfigDefaults(
  config?: Partial<PetRenderConfig> | null
): PetRenderConfig & { visualWidth: number; visualHeight: number } {
  const visual = getVisualSize(config);
  return {
    ...DEFAULT_RENDER_CONFIG,
    ...(config || {}),
    visualWidth: visual.visualWidth,
    visualHeight: visual.visualHeight
  };
}
