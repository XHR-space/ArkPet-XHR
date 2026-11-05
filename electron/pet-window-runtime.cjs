"use strict";

const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { mirrorOffsetX } = require("./pet-layout.cjs");
const { readNativeWindowHandle } = require("./native-window.cjs");

function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function num(value, fallback = 0) {
  const parsed = typeof value === "string" ? Number(value) : value;
  return isFiniteNumber(parsed) ? parsed : fallback;
}

/** 目标位置停止变化后多久落库（毫秒）。不要每帧写盘。 */
const PLACEMENT_SETTLE_MS = 400;

function normalizeScale(value) {
  const scale = Number(value);
  return Number.isFinite(scale) && scale > 0 ? scale : 1;
}

function roundPx(value) {
  return Math.round(value);
}

function sameRect(left, right) {
  if (!left || !right) return false;
  return (
    left.x === right.x &&
    left.y === right.y &&
    left.width === right.width &&
    left.height === right.height
  );
}

function normalizeBox(box, fallback = null) {
  const source = box && typeof box === "object" ? box : fallback;
  if (!source || typeof source !== "object") return null;
  const width = Number(source.width);
  const height = Number(source.height);
  if (!isFiniteNumber(width) || !isFiniteNumber(height) || width <= 0 || height <= 0) {
    return null;
  }
  return {
    width,
    height,
    offsetX: num(source.offsetX, 0),
    offsetY: num(source.offsetY, 0)
  };
}

function normalizeLayout(layout) {
  if (!layout || typeof layout !== "object" || !layout.placement) return null;
  const displayFrame = layout.displayFrame;
  const width = Number(displayFrame?.width);
  const height = Number(displayFrame?.height);
  if (!isFiniteNumber(width) || !isFiniteNumber(height) || width <= 0 || height <= 0) {
    return null;
  }

  const collision = normalizeBox(layout.collision);
  if (!collision) return null;
  const interaction = normalizeBox(layout.interaction, collision) || collision;
  const x = Number(layout.placement.x);
  const y = Number(layout.placement.y);
  if (!isFiniteNumber(x) || !isFiniteNumber(y)) return null;

  return {
    layoutVersion: num(layout.layoutVersion, 3),
    displayFrame: { width, height },
    collision,
    interaction,
    placement: {
      x,
      y,
      direction: layout.placement.direction === -1 ? -1 : 1
    }
  };
}

function resolveBoxRect(box, center, direction) {
  const centerX = center.x + mirrorOffsetX(box.offsetX, direction);
  const centerY = center.y + box.offsetY;
  return {
    left: centerX - box.width / 2,
    top: centerY - box.height / 2,
    right: centerX + box.width / 2,
    bottom: centerY + box.height / 2,
    width: box.width,
    height: box.height
  };
}

/**
 * 物理像素 → 逻辑单位（DIP）。
 * layout.placement 存的是逻辑单位；主显示器物理/逻辑比 = scaleFactor（本机 150% 时是 1.5）。
 */
function physicalPlacementToLogical(physical, scaleFactor) {
  const scale = normalizeScale(scaleFactor);
  return {
    x: roundPx(Number(physical?.x) / scale),
    y: roundPx(Number(physical?.y) / scale)
  };
}

function unionRects(rects) {
  if (!Array.isArray(rects) || rects.length === 0) return null;
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  for (const rect of rects) {
    if (!rect) continue;
    left = Math.min(left, rect.left);
    top = Math.min(top, rect.top);
    right = Math.max(right, rect.right);
    bottom = Math.max(bottom, rect.bottom);
  }
  if (!Number.isFinite(left) || !Number.isFinite(top)) return null;
  return {
    left,
    top,
    right,
    bottom,
    width: right - left,
    height: bottom - top
  };
}

function toPayloadRect(rect, windowRect) {
  const payload = {
    x: roundPx(rect.left - windowRect.left),
    y: roundPx(rect.top - windowRect.top),
    w: Math.max(1, roundPx(rect.width)),
    h: Math.max(1, roundPx(rect.height))
  };
  payload.width = payload.w;
  payload.height = payload.h;
  return payload;
}

function computePetWindowGeometry(layoutValue, scaleValue, options = {}) {
  const layout = normalizeLayout(layoutValue);
  if (!layout) return null;

  const logicalScale = normalizeScale(scaleValue);
  const displayScaleFactor = normalizeScale(options.displayScaleFactor || 1);
  const pixelScale = logicalScale * displayScaleFactor;
  const originX = num(options.origin?.x, 0);
  const originY = num(options.origin?.y, 0);
  const direction = layout.placement.direction;

  const collisionSize = {
    width: layout.collision.width * pixelScale,
    height: layout.collision.height * pixelScale
  };
  const interactionSize = {
    width: layout.interaction.width * pixelScale,
    height: layout.interaction.height * pixelScale
  };
  const displaySize = {
    width: layout.displayFrame.width * pixelScale,
    height: layout.displayFrame.height * pixelScale
  };

  const placement = options.placement
    ? {
        x: num(options.placement.x, 0),
        y: num(options.placement.y, 0)
      }
    : {
        x: originX + layout.placement.x * displayScaleFactor,
        y: originY + layout.placement.y * displayScaleFactor
      };

  const collisionOffsetX =
    mirrorOffsetX(layout.collision.offsetX, direction) * pixelScale;
  const collisionOffsetY = layout.collision.offsetY * pixelScale;
  const displayCenter = {
    x: placement.x - collisionOffsetX,
    y: placement.y - collisionOffsetY
  };

  const displayRect = {
    left: displayCenter.x - displaySize.width / 2,
    top: displayCenter.y - displaySize.height / 2,
    right: displayCenter.x + displaySize.width / 2,
    bottom: displayCenter.y + displaySize.height / 2,
    width: displaySize.width,
    height: displaySize.height
  };
  function boxRectAtOffset(boxSize, offsetX, offsetY, facing) {
    const centerX =
      displayCenter.x + mirrorOffsetX(offsetX, facing) * pixelScale;
    const centerY = displayCenter.y + offsetY * pixelScale;
    return {
      left: centerX - boxSize.width / 2,
      top: centerY - boxSize.height / 2,
      right: centerX + boxSize.width / 2,
      bottom: centerY + boxSize.height / 2,
      width: boxSize.width,
      height: boxSize.height
    };
  }

  const collisionRect = boxRectAtOffset(
    collisionSize,
    layout.collision.offsetX,
    layout.collision.offsetY,
    direction
  );
  const interactionRect = boxRectAtOffset(
    interactionSize,
    layout.interaction.offsetX,
    layout.interaction.offsetY,
    direction
  );
  const stableExtent = unionRects([
    displayRect,
    boxRectAtOffset(
      collisionSize,
      layout.collision.offsetX,
      layout.collision.offsetY,
      1
    ),
    boxRectAtOffset(
      collisionSize,
      layout.collision.offsetX,
      layout.collision.offsetY,
      -1
    ),
    boxRectAtOffset(
      interactionSize,
      layout.interaction.offsetX,
      layout.interaction.offsetY,
      1
    ),
    boxRectAtOffset(
      interactionSize,
      layout.interaction.offsetX,
      layout.interaction.offsetY,
      -1
    )
  ]);

  const union = stableExtent;
  if (!union) return null;

  const collisionInWindow = toPayloadRect(collisionRect, union);
  const windowSize = {
    w: Math.max(1, roundPx(union.width)),
    h: Math.max(1, roundPx(union.height))
  };
  const window = {
    x: roundPx(placement.x - (collisionInWindow.x + collisionInWindow.w / 2)),
    y: roundPx(placement.y - (collisionInWindow.y + collisionInWindow.h / 2)),
    width: windowSize.w,
    height: windowSize.h
  };

  return {
    petId: String(options.petId || "").trim(),
    scale: logicalScale,
    windowSize,
    frameOffsetInWindow: {
      x: roundPx(displayRect.left - union.left),
      y: roundPx(displayRect.top - union.top)
    },
    collisionInWindow,
    interactionInWindow: toPayloadRect(interactionRect, union),
    window,
    collisionCenter: {
      x: placement.x,
      y: placement.y
    }
  };
}

function resolvePetWindowBounds(layout, scale, primaryBounds, options = {}) {
  const geometry = computePetWindowGeometry(layout, scale, {
    ...options,
    origin: {
      x: num(primaryBounds?.x, 0),
      y: num(primaryBounds?.y, 0)
    }
  });
  if (!geometry) return null;
  return geometry.window;
}

function toDipRect(physicalRect, scaleFactor) {
  const scale = normalizeScale(scaleFactor);
  return {
    x: roundPx(physicalRect.x / scale),
    y: roundPx(physicalRect.y / scale),
    width: Math.max(1, roundPx(physicalRect.width / scale)),
    height: Math.max(1, roundPx(physicalRect.height / scale))
  };
}

function toMetricsRect(rect) {
  if (!rect) return null;
  let payload = null;
  if (
    isFiniteNumber(rect.x) &&
    isFiniteNumber(rect.y) &&
    isFiniteNumber(rect.width) &&
    isFiniteNumber(rect.height)
  ) {
    payload = {
      x: roundPx(rect.x),
      y: roundPx(rect.y),
      w: Math.max(1, roundPx(rect.width)),
      h: Math.max(1, roundPx(rect.height))
    };
  } else if (
    isFiniteNumber(rect.x) &&
    isFiniteNumber(rect.y) &&
    isFiniteNumber(rect.w) &&
    isFiniteNumber(rect.h)
  ) {
    payload = {
      x: roundPx(rect.x),
      y: roundPx(rect.y),
      w: Math.max(1, roundPx(rect.w)),
      h: Math.max(1, roundPx(rect.h))
    };
  } else if (
    isFiniteNumber(rect.left) &&
    isFiniteNumber(rect.top) &&
    isFiniteNumber(rect.right) &&
    isFiniteNumber(rect.bottom)
  ) {
    payload = {
      x: roundPx(rect.left),
      y: roundPx(rect.top),
      w: Math.max(1, roundPx(rect.right - rect.left)),
      h: Math.max(1, roundPx(rect.bottom - rect.top))
    };
  }
  if (!payload) return null;
  payload.width = payload.w;
  payload.height = payload.h;
  return payload;
}

function toNativeRect(rect) {
  if (!rect) return null;
  if (
    isFiniteNumber(rect.left) &&
    isFiniteNumber(rect.top) &&
    isFiniteNumber(rect.right) &&
    isFiniteNumber(rect.bottom)
  ) {
    return rect;
  }
  if (
    isFiniteNumber(rect.x) &&
    isFiniteNumber(rect.y) &&
    isFiniteNumber(rect.w) &&
    isFiniteNumber(rect.h)
  ) {
    return {
      left: rect.x,
      top: rect.y,
      right: rect.x + rect.w,
      bottom: rect.y + rect.h,
      width: rect.w,
      height: rect.h
    };
  }
  if (
    isFiniteNumber(rect.x) &&
    isFiniteNumber(rect.y) &&
    isFiniteNumber(rect.width) &&
    isFiniteNumber(rect.height)
  ) {
    return {
      left: rect.x,
      top: rect.y,
      right: rect.x + rect.width,
      bottom: rect.y + rect.height,
      width: rect.width,
      height: rect.height
    };
  }
  return null;
}

function buildPetWindowUrl(urlFactory, petId) {
  const id = String(petId || "").trim();
  const url = new URL(urlFactory("pet-window"));
  url.searchParams.set("petId", id);
  return url.toString();
}

class PetWindowRuntime {
  constructor(options = {}) {
    this.BrowserWindow = options.BrowserWindow;
    this.screen = options.screen;
    this.nativeWindow = options.nativeWindow;
    this.preloadPath = options.preloadPath || path.join(__dirname, "preload.cjs");
    this.getState = options.getState || (() => null);
    this.rendererUrl = options.rendererUrl || options.getRendererUrl || null;
    this.logger = options.logger || console;
    this.onPlacementSettled =
      typeof options.onPlacementSettled === "function"
        ? options.onPlacementSettled
        : null;
    this.platform = options.platform || process.platform;
    this.windows = new Map();
    this.disposed = false;
    this.pendingState = null;
    this.syncing = null;
    this.metrics = null;
    this.metricsPromise = null;
    this.taskbarRect = null;
    this.taskbarResolved = false;
    this.taskbarPromise = null;

    if (!this.BrowserWindow || !this.screen || !this.nativeWindow) {
      throw new Error("PetWindowRuntime requires BrowserWindow, screen and nativeWindow.");
    }
  }

  get enabled() {
    return this.platform === "win32" && !this.disposed;
  }

  get size() {
    return this.windows.size;
  }

  sync(state) {
    if (this.disposed) return Promise.resolve();
    this.pendingState = state || this.getState();

    if (!this.syncing) {
      this.syncing = this._flushPending()
        .catch((error) => {
          this.logger.warn?.("[pet-window-runtime] sync failed", error);
        })
        .finally(() => {
          this.syncing = null;
          if (this.pendingState && !this.disposed) void this.sync();
        });
    }

    return this.syncing;
  }

  async _flushPending() {
    while (this.pendingState && !this.disposed) {
      const state = this.pendingState;
      this.pendingState = null;
      await this._applyState(state);
    }
  }

  async _applyState(state) {
    const overlay = state?.settings?.overlay || {};
    const shouldEnable = overlay.perPetWindows === true && this.enabled;

    if (!shouldEnable) {
      this.destroyAll();
      return;
    }

    const metrics = await this._getMetrics();
    if (!metrics) return;
    await this._getTaskbarRect();

    const pets = Array.isArray(state?.pets) ? state.pets : [];
    const summoned = new Set(
      Array.isArray(state?.summonedPetIds) ? state.summonedPetIds : []
    );
    const activeIds = new Set();
    const displayScaleFactor = normalizeScale(metrics.scaleFactor);

    for (const pet of pets) {
      if (!pet || !summoned.has(pet.id)) continue;
      const petId = normalizePetId(pet.id);
      if (!petId) continue;

      const scale = normalizeScale(overlay.scale) * normalizeScale(pet.scale);
      const geometry = computePetWindowGeometry(pet.layout, scale, {
        petId,
        displayScaleFactor,
        origin: {
          x: num(metrics.bounds?.x, 0),
          y: num(metrics.bounds?.y, 0)
        }
      });
      if (!geometry) {
        this.logger.warn?.(
          `[pet-window-runtime] pet ${petId} has no usable v3 layout.`
        );
        continue;
      }

      activeIds.add(petId);
      let entry = this.windows.get(petId);
      if (!entry || entry.window.isDestroyed()) {
        if (entry) this.windows.delete(petId);
        entry = this._createWindow(pet, geometry, metrics);
        if (!entry) continue;
      } else {
        this._updateEntryGeometry(entry, pet, geometry, metrics);
      }

      void this._prepareNative(entry);
    }

    for (const petId of Array.from(this.windows.keys())) {
      if (!activeIds.has(petId)) this.destroyWindow(petId);
    }

    this._broadcastPeers();
    this._broadcastPlatforms();
  }

  _updateEntryGeometry(entry, pet, geometry, metrics) {
    const previousSignature = entry.geometrySignature;
    entry.pet = pet;
    entry.layout = pet.layout;
    entry.scale = geometry.scale;
    entry.geometry = geometry;
    entry.geometrySignature = JSON.stringify({
      windowSize: geometry.windowSize,
      frameOffsetInWindow: geometry.frameOffsetInWindow,
      collisionInWindow: geometry.collisionInWindow,
      interactionInWindow: geometry.interactionInWindow
    });

    entry.placementPhysical =
      entry.hasTarget && entry.placementPhysical
        ? { ...entry.placementPhysical }
        : { ...geometry.collisionCenter };

    if (!previousSignature || previousSignature !== entry.geometrySignature) {
      const collision = geometry.collisionInWindow;
      const physicalWindow =
        entry.hasTarget && entry.placementPhysical
          ? {
              x: roundPx(
                entry.placementPhysical.x -
                  (collision.x + collision.w / 2)
              ),
              y: roundPx(
                entry.placementPhysical.y -
                  (collision.y + collision.h / 2)
              ),
              width: geometry.windowSize.w,
              height: geometry.windowSize.h
            }
          : geometry.window;
      const dipBounds = toDipRect(physicalWindow, metrics.scaleFactor);
      entry.bounds = physicalWindow;
      entry.windowBounds = dipBounds;
      if (!entry.window.isDestroyed()) entry.window.setBounds(dipBounds, false);
      if (entry.rendererReady) this._sendInit(entry, true);
    }

    void this._prepareNative(entry);
  }

  _createWindow(pet, geometry, metrics) {
    const petId = geometry.petId;
    const dipBounds = toDipRect(geometry.window, metrics.scaleFactor);
    const window = new this.BrowserWindow({
      x: dipBounds.x,
      y: dipBounds.y,
      width: dipBounds.width,
      height: dipBounds.height,
      frame: false,
      transparent: true,
      backgroundColor: "#00000000",
      skipTaskbar: true,
      focusable: false,
      hasShadow: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      show: false,
      webPreferences: {
        preload: this.preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false,
        sandbox: false
      }
    });

    const entry = {
      petId,
      pet,
      window,
      hwnd: "",
      bounds: geometry.window,
      windowBounds: dipBounds,
      geometry,
      geometrySignature: "",
      layout: pet.layout,
      scale: geometry.scale,
      placementPhysical: { ...geometry.collisionCenter },
      loaded: false,
      rendererReady: false,
      initRevision: "",
      nativeTask: Promise.resolve(),
      regionTask: Promise.resolve(),
      targetTask: null,
      pendingTarget: null,
      targetPhysical: null,
      hasTarget: false,
      focusHeld: false,
      destroyed: false
    };

    this.windows.set(petId, entry);
    window.setAlwaysOnTop(false);
    window.setSkipTaskbar(true);
    window.setFocusable(false);
    window.setBackgroundColor("#00000000");
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));

    try {
      entry.hwnd = readNativeWindowHandle(window);
    } catch (error) {
      this.logger.warn?.(
        `[pet-window-runtime] could not read the native handle for ${petId}.`,
        error
      );
    }

    window.once("ready-to-show", () => {
      if (entry.destroyed || this.windows.get(petId) !== entry) return;
      void this._prepareNative(entry).then(() => {
        if (entry.destroyed || this.windows.get(petId) !== entry) return;
        if (!window.isDestroyed()) window.showInactive();
      });
    });
    window.webContents.once("did-finish-load", () => {
      if (entry.destroyed || this.windows.get(petId) !== entry) return;
      entry.loaded = true;
      this._sendInitIfReady(entry);
      void this._prepareNative(entry);
    });
    window.on("closed", () => {
      entry.destroyed = true;
      if (this.windows.get(petId) === entry) this.windows.delete(petId);
    });

    const url = this.rendererUrl
      ? buildPetWindowUrl(this.rendererUrl, petId)
      : buildPetWindowUrl(
          (view) => {
            const fallback = new URL(
              pathToFileURL(
                path.join(__dirname, "..", "dist", "index.html")
              ).toString()
            );
            fallback.searchParams.set("view", view);
            return fallback.toString();
          },
          petId
        );
    void window.loadURL(url).catch((error) => {
      this.logger.warn?.(`[pet-window-runtime] failed to load ${petId}.`, error);
    });

    return entry;
  }

  _sendInitIfReady(entry) {
    if (!entry.loaded || !entry.rendererReady) return;
    this._sendInit(entry, false);
  }

  _sendInit(entry, force) {
    if (
      this.disposed ||
      entry.destroyed ||
      entry.window.isDestroyed() ||
      entry.window.webContents.isDestroyed()
    ) {
      return;
    }
    const revision = JSON.stringify({
      geometrySignature: entry.geometrySignature,
      metrics: this.metrics
    });
    if (!force && entry.initRevision === revision) return;
    entry.initRevision = revision;
    entry.window.webContents.send("pet-window:init", {
      petId: entry.petId,
      layout: entry.layout,
      scale: entry.geometry.scale,
      windowSize: entry.geometry.windowSize,
      frameOffsetInWindow: entry.geometry.frameOffsetInWindow,
      collisionInWindow: entry.geometry.collisionInWindow,
      interactionInWindow: entry.geometry.interactionInWindow,
      metrics: this._metricsPayload()
    });
  }

  _prepareNative(entry) {
    if (
      this.disposed ||
      entry.destroyed ||
      !entry.hwnd ||
      !this.nativeWindow.isSupported()
    ) {
      return entry.nativeTask;
    }

    entry.nativeTask = entry.nativeTask
      .catch(() => undefined)
      .then(async () => {
        if (entry.destroyed || this.windows.get(entry.petId) !== entry) return;
        await this.nativeWindow.applyPetWindowStyle(entry.hwnd);
        if (entry.focusHeld) {
          await this.nativeWindow.setNoActivate(entry.hwnd, false);
        }
        const collision = entry.geometry.collisionInWindow;
        const target =
          entry.hasTarget && entry.placementPhysical
            ? {
                x: roundPx(
                  entry.placementPhysical.x -
                    (collision.x + collision.w / 2)
                ),
                y: roundPx(
                  entry.placementPhysical.y -
                    (collision.y + collision.h / 2)
                )
              }
            : {
                x: entry.geometry.window.x,
                y: entry.geometry.window.y
              };
        if (!entry.pendingTarget && !entry.targetTask) {
          await this.nativeWindow.move(entry.hwnd, target.x, target.y);
        }
        await this.nativeWindow.setTopmost(entry.hwnd, true);
        await this._refreshRegion(entry);
      })
      .catch((error) => {
        this.logger.warn?.(
          `[pet-window-runtime] native setup failed for ${entry.petId}.`,
          error
        );
      });

    return entry.nativeTask;
  }

  _refreshRegion(entry) {
    if (
      this.disposed ||
      entry.destroyed ||
      !entry.hwnd ||
      !this.nativeWindow.isSupported()
    ) {
      return Promise.resolve();
    }

    entry.regionTask = entry.regionTask
      .catch(() => undefined)
      .then(async () => {
        const taskbar = await this._getTaskbarRect();
        if (entry.destroyed || this.windows.get(entry.petId) !== entry) return;
        if (taskbar) {
          await this.nativeWindow.excludeTaskbar(entry.hwnd, taskbar);
        } else {
          await this.nativeWindow.clearRegion(entry.hwnd);
        }
      })
      .catch((error) => {
        this.logger.warn?.(
          `[pet-window-runtime] taskbar region refresh failed for ${entry.petId}.`,
          error
        );
      });

    return entry.regionTask;
  }

  async _getMetrics(force = false) {
    if (force) this.metrics = null;
    if (this.metrics && !this.metricsPromise) return this.metrics;
    if (this.metricsPromise) return this.metricsPromise;

    this.metricsPromise = (async () => {
      let rects = null;
      if (
        this.nativeWindow.isSupported() &&
        typeof this.nativeWindow.getPrimaryMetrics === "function"
      ) {
        try {
          rects = await this.nativeWindow.getPrimaryMetrics();
        } catch (error) {
          this.logger.warn?.("[pet-window-runtime] native metrics lookup failed", error);
        }
      }

      const fallbackDisplay = this.screen.getPrimaryDisplay();
      const nativeScaleFactor = Number(rects?.scaleFactor);
      const fallbackScaleFactor = Number(fallbackDisplay?.scaleFactor);
      const scaleFactor =
        Number.isFinite(nativeScaleFactor) && nativeScaleFactor > 0
          ? nativeScaleFactor
          : Number.isFinite(fallbackScaleFactor) && fallbackScaleFactor > 0
            ? fallbackScaleFactor
            : 1;
      const bounds = toMetricsRect(rects?.bounds || fallbackDisplay?.bounds);
      const workArea = toMetricsRect(
        rects?.workArea || fallbackDisplay?.workArea || fallbackDisplay?.bounds
      );
      if (!bounds || !workArea) return null;
      this.metrics = {
        bounds,
        workArea,
        scaleFactor: normalizeScale(scaleFactor)
      };
      return this.metrics;
    })().finally(() => {
      this.metricsPromise = null;
    });

    return this.metricsPromise;
  }

  async _getTaskbarRect(force = false) {
    if (force) {
      this.taskbarResolved = false;
      this.taskbarRect = null;
      this.taskbarPromise = null;
    }
    if (this.taskbarResolved && !this.taskbarPromise) return this.taskbarRect;
    if (this.taskbarPromise) return this.taskbarPromise;

    this.taskbarPromise = (async () => {
      if (
        !this.nativeWindow.isSupported() ||
        typeof this.nativeWindow.getTaskbarRect !== "function"
      ) {
        this.taskbarRect = null;
        this.taskbarResolved = true;
        return null;
      }
      try {
        const rect = await this.nativeWindow.getTaskbarRect();
        this.taskbarRect = toNativeRect(rect);
      } catch (error) {
        this.logger.warn?.("[pet-window-runtime] taskbar lookup failed", error);
        this.taskbarRect = null;
      }
      this.taskbarResolved = true;
      return this.taskbarRect;
    })().finally(() => {
      this.taskbarPromise = null;
    });

    return this.taskbarPromise;
  }

  _metricsPayload() {
    const metrics = this.metrics || {
      bounds: { x: 0, y: 0, w: 1, h: 1 },
      workArea: { x: 0, y: 0, w: 1, h: 1 }
    };
    return {
      bounds: metrics.bounds,
      workArea: metrics.workArea,
      taskbar: toMetricsRect(this.taskbarRect)
    };
  }

  _broadcastMetrics() {
    const payload = this._metricsPayload();
    for (const entry of this.windows.values()) {
      if (
        entry.destroyed ||
        !entry.rendererReady ||
        entry.window.isDestroyed() ||
        entry.window.webContents.isDestroyed()
      ) {
        continue;
      }
      entry.window.webContents.send("pet-window:metrics", payload);
    }
  }

  _broadcastPlatforms() {
    const payload = { platforms: [] };
    for (const entry of this.windows.values()) {
      if (
        entry.destroyed ||
        !entry.rendererReady ||
        entry.window.isDestroyed() ||
        entry.window.webContents.isDestroyed()
      ) {
        continue;
      }
      entry.window.webContents.send("pet-window:platforms", payload);
    }
  }

  _peerRect(entry) {
    const collision = entry.geometry?.collisionInWindow;
    const placement = entry.placementPhysical;
    if (!collision || !placement) return null;
    return {
      x: roundPx(placement.x - collision.w / 2),
      y: roundPx(placement.y - collision.h / 2),
      w: Math.max(1, roundPx(collision.w)),
      h: Math.max(1, roundPx(collision.h)),
      width: Math.max(1, roundPx(collision.w)),
      height: Math.max(1, roundPx(collision.h))
    };
  }

  _broadcastPeers() {
    for (const entry of this.windows.values()) {
      if (
        entry.destroyed ||
        !entry.rendererReady ||
        entry.window.isDestroyed() ||
        entry.window.webContents.isDestroyed()
      ) {
        continue;
      }
      const peers = [];
      for (const other of this.windows.values()) {
        if (other === entry || other.destroyed || other.window.isDestroyed()) {
          continue;
        }
        const rect = this._peerRect(other);
        if (!rect) continue;
        peers.push({
          petId: other.petId,
          rect,
          direction: other.layout?.placement?.direction === -1 ? -1 : 1
        });
      }
      entry.window.webContents.send("pet-window:peers", { peers });
    }
  }

  _entryForSender(sender, petId) {
    const id = normalizePetId(petId);
    for (const entry of this.windows.values()) {
      if (!entry || entry.destroyed || entry.window.isDestroyed()) continue;
      if (entry.window.webContents?.id !== sender?.id) continue;
      if (id && entry.petId !== id) return null;
      return entry;
    }
    return null;
  }

  handleRendererReady(sender, payload) {
    const entry = this._entryForSender(sender, payload?.petId);
    if (!entry) return false;
    entry.rendererReady = true;
    this._sendInitIfReady(entry);
    this._broadcastPeers();
    this._broadcastPlatforms();
    return true;
  }

  queueRendererTarget(sender, petId, physicalX, physicalY) {
    const entry = this._entryForSender(sender, petId);
    if (!entry) return { ok: false, error: "pet-window-not-found" };
    return this.queuePetWindowTarget(entry.petId, physicalX, physicalY);
  }

  _schedulePlacementPersist(entry) {
    if (!this.onPlacementSettled) return;
    if (entry.placementPersistTask) clearTimeout(entry.placementPersistTask);
    entry.placementPersistTask = setTimeout(() => {
      entry.placementPersistTask = null;
      if (entry.destroyed || this.disposed) return;
      const physical = entry.placementPhysical;
      if (!physical) return;
      const last = entry.persistedPlacementPhysical;
      if (
        last &&
        Math.abs(last.x - physical.x) < 1 &&
        Math.abs(last.y - physical.y) < 1
      ) {
        return;
      }
      entry.persistedPlacementPhysical = { ...physical };
      const direction =
        entry.layout?.placement?.direction === -1 ? -1 : 1;
      try {
        this.onPlacementSettled(entry.petId, { ...physical }, { direction });
      } catch (error) {
        this.logger.warn?.(
          "[pet-window-runtime] placement persist failed",
          error
        );
      }
    }, PLACEMENT_SETTLE_MS);
    entry.placementPersistTask.unref?.();
  }

  queuePetWindowTarget(petId, physicalX, physicalY) {
    const id = normalizePetId(petId);
    const x = Number(physicalX);
    const y = Number(physicalY);
    if (!id || !Number.isFinite(x) || !Number.isFinite(y)) {
      return { ok: false, error: "invalid-request" };
    }
    const entry = this.windows.get(id);
    if (!entry || entry.destroyed || entry.window.isDestroyed()) {
      return { ok: false, error: "pet-window-not-found" };
    }

    entry.pendingTarget = { x: roundPx(x), y: roundPx(y) };
    entry.targetPhysical = { ...entry.pendingTarget };
    entry.hasTarget = true;
    entry.placementPhysical = {
      x:
        entry.pendingTarget.x +
        entry.geometry.collisionInWindow.x +
        entry.geometry.collisionInWindow.w / 2,
      y:
        entry.pendingTarget.y +
        entry.geometry.collisionInWindow.y +
        entry.geometry.collisionInWindow.h / 2
    };

    this._schedulePlacementPersist(entry);

    if (entry.targetTask) {
      return { ok: true, queued: true, coalesced: true };
    }

    entry.targetTask = (async () => {
      while (entry.pendingTarget && !entry.destroyed && !this.disposed) {
        const target = entry.pendingTarget;
        entry.pendingTarget = null;
        if (!entry.hwnd || !this.nativeWindow.isSupported()) continue;
        await this.nativeWindow.move(entry.hwnd, target.x, target.y);
        this._broadcastPeers();
        void this._refreshRegion(entry);
      }
    })()
      .catch((error) => {
        this.logger.warn?.(
          `[pet-window-runtime] target move failed for ${id}.`,
          error
        );
      })
      .finally(() => {
        entry.targetTask = null;
        if (entry.pendingTarget && !entry.destroyed && !this.disposed) {
          this.queuePetWindowTarget(id, entry.pendingTarget.x, entry.pendingTarget.y);
        }
      });

    return { ok: true, queued: true, coalesced: false };
  }

  async movePetWindow(petId, physicalX, physicalY) {
    const result = this.queuePetWindowTarget(petId, physicalX, physicalY);
    if (!result.ok) return result;
    const entry = this.windows.get(normalizePetId(petId));
    if (entry) await entry.targetTask;
    return { ...result, petId: normalizePetId(petId) };
  }

  setIgnoreMouse(sender, petId, ignore) {
    const entry = this._entryForSender(sender, petId);
    if (!entry || entry.window.isDestroyed()) return false;
    const next = Boolean(ignore);
    entry.window.setIgnoreMouseEvents(next, { forward: true });
    if (!entry.window.webContents.isDestroyed()) {
      entry.window.webContents.send("pet-window:set-ignore-mouse", {
        ignore: next
      });
    }
    return true;
  }

  async setFocus(sender, petId, take) {
    const entry = this._entryForSender(sender, petId);
    if (!entry || entry.window.isDestroyed()) return false;
    const shouldTake = Boolean(take);
    entry.focusHeld = shouldTake;
    entry.window.setFocusable(shouldTake);
    if (!entry.hwnd || !this.nativeWindow.isSupported()) return true;

    try {
      await this.nativeWindow.setNoActivate(entry.hwnd, !shouldTake);
      if (shouldTake) {
        await this.nativeWindow.raise(entry.hwnd);
        await this.nativeWindow.focus(entry.hwnd);
      } else {
        entry.window.setFocusable(false);
        await this.nativeWindow.raise(entry.hwnd);
        await this.nativeWindow.setNoActivate(entry.hwnd, true);
      }
      return true;
    } catch (error) {
      entry.focusHeld = false;
      entry.window.setFocusable(false);
      this.logger.warn?.(
        `[pet-window-runtime] focus update failed for ${entry.petId}.`,
        error
      );
      return false;
    }
  }

  async handleDisplayChange() {
    if (this.disposed) return;
    const state = this.pendingState || this.getState();
    if (!state?.settings?.overlay?.perPetWindows) {
      this.destroyAll();
      return;
    }
    await this._getMetrics(true);
    await this._getTaskbarRect(true);
    if (state) await this.sync(state);
    this._broadcastMetrics();
    for (const entry of this.windows.values()) {
      void this._refreshRegion(entry);
      await this._prepareNative(entry);
    }
  }

  destroyWindow(petId) {
    const entry = this.windows.get(normalizePetId(petId));
    if (!entry) return;
    this.windows.delete(entry.petId);
    entry.destroyed = true;
    entry.pendingTarget = null;
    if (entry.window && !entry.window.isDestroyed()) entry.window.destroy();
  }

  destroyAll() {
    for (const petId of Array.from(this.windows.keys())) {
      this.destroyWindow(petId);
    }
  }

  async dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.pendingState = null;
    this.destroyAll();
    await this.nativeWindow.stop().catch(() => undefined);
  }
}

function normalizePetId(value) {
  return String(value || "").trim();
}

function createPetWindowRuntime(options = {}) {
  return new PetWindowRuntime(options);
}

module.exports = {
  PetWindowRuntime,
  buildPetWindowUrl,
  computePetWindowGeometry,
  createPetWindowRuntime,
  normalizeLayout,
  physicalPlacementToLogical,
  resolvePetWindowBounds,
  resolvePetWindowGeometry: computePetWindowGeometry,
  sameRect,
  toDipRect,
  toMetricsRect,
  unionRects
};
