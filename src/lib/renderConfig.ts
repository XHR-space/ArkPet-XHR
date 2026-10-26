import type { PetRenderConfig } from "../types";

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
