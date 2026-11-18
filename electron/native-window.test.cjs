"use strict";

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");

const {
  NativeWindowClient,
  computeTaskbarClip,
  normalizeRect,
  readNativeWindowHandle
} = require("./native-window.cjs");
const {
  PetWindowRuntime,
  buildPetWindowUrl,
  computePetWindowGeometry,
  physicalPlacementToLogical,
  resolvePetWindowBounds,
  toDipRect,
  unionRects
} = require("./pet-window-runtime.cjs");

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log("ok   - " + name);
  } catch (error) {
    failed += 1;
    console.error("FAIL - " + name);
    console.error("       " + (error && error.stack ? error.stack : error));
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class MockWebContents extends EventEmitter {
  constructor() {
    super();
    this.id = nextWebContentsId++;
    this.sent = [];
  }

  setWindowOpenHandler() {}

  send(channel, payload) {
    this.sent.push({ channel, payload });
  }

  isDestroyed() {
    return false;
  }
}

let nextWebContentsId = 1;

class MockBrowserWindow extends EventEmitter {
  constructor(options) {
    super();
    this.options = options;
    this.webContents = new MockWebContents();
    this.bounds = {
      x: options.x,
      y: options.y,
      width: options.width,
      height: options.height
    };
    this.destroyed = false;
    this.shownInactive = 0;
    this.setBoundsCalls = [];
    this.handle = Buffer.alloc(8);
    this.handle.writeBigUInt64LE(0x1000n, 0);
    this.ignoreMouseCalls = [];
    this.focusableCalls = [];
  }

  getNativeWindowHandle() {
    return this.handle;
  }

  setAlwaysOnTop() {}
  setSkipTaskbar() {}
  setFocusable(value) {
    this.focusableCalls.push(value);
  }
  setBackgroundColor() {}

  setIgnoreMouseEvents(ignore, options) {
    this.ignoreMouseCalls.push({ ignore, options });
  }

  setBounds(bounds) {
    this.bounds = { ...bounds };
    this.setBoundsCalls.push({ ...bounds });
  }

  showInactive() {
    this.shownInactive += 1;
  }

  isDestroyed() {
    return this.destroyed;
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.emit("closed");
  }

  loadURL(url) {
    this.loadedUrl = url;
    queueMicrotask(() => {
      this.emit("ready-to-show");
      this.webContents.emit("did-finish-load");
    });
    return Promise.resolve();
  }
}

function createMockNativeWindow() {
  return {
    calls: [],
    isSupported: () => true,
    applyPetWindowStyle(hwnd) {
      this.calls.push({ op: "style", hwnd });
      return Promise.resolve({ ok: true });
    },
    setTopmost(hwnd, on) {
      this.calls.push({ op: "topmost", hwnd, on });
      return Promise.resolve({ ok: true });
    },
    setNoActivate(hwnd, on) {
      this.calls.push({ op: "setNoActivate", hwnd, on });
      return Promise.resolve({ ok: true });
    },
    raise(hwnd) {
      this.calls.push({ op: "raise", hwnd });
      return Promise.resolve({ ok: true });
    },
    focus(hwnd) {
      this.calls.push({ op: "focus", hwnd });
      return Promise.resolve({ ok: true, method: "test" });
    },
    move(hwnd, x, y) {
      this.calls.push({ op: "move", hwnd, x, y });
      return Promise.resolve({ accepted: true, backpressure: false });
    },
    excludeTaskbar(hwnd, rect) {
      this.calls.push({ op: "excludeTaskbar", hwnd, rect });
      return Promise.resolve({ ok: true });
    },
    clearRegion(hwnd) {
      this.calls.push({ op: "clearRegion", hwnd });
      return Promise.resolve({ ok: true });
    },
    getTaskbarRect() {
      return Promise.resolve({
        left: 0,
        top: 760,
        right: 1280,
        bottom: 800
      });
    },
    getPrimaryMetrics() {
      return Promise.resolve({
        bounds: {
          left: 0,
          top: 0,
          right: 1280,
          bottom: 800,
          width: 1280,
          height: 800
        },
        workArea: {
          left: 0,
          top: 0,
          right: 1280,
          bottom: 760,
          width: 1280,
          height: 760
        },
        scaleFactor: 1.25
      });
    },
    stop() {
      return Promise.resolve();
    }
  };
}

async function main() {
  await test("normalizeRect accepts screen and size rectangles", () => {
    assert.deepEqual(normalizeRect({ left: 10, top: 20, right: 50, bottom: 80 }), {
      left: 10,
      top: 20,
      right: 50,
      bottom: 80,
      width: 40,
      height: 60
    });
    assert.deepEqual(normalizeRect({ x: 10, y: 20, width: 40, height: 60 }), {
      left: 10,
      top: 20,
      right: 50,
      bottom: 80,
      width: 40,
      height: 60
    });
    assert.equal(normalizeRect({ left: 1, top: 1, right: 1, bottom: 2 }), null);
  });

  await test("computeTaskbarClip calculates the local taskbar cutout", () => {
    const clip = computeTaskbarClip(
      { left: 100, top: 100, right: 500, bottom: 500 },
      { left: 0, top: 400, right: 1000, bottom: 450 }
    );
    assert.equal(clip.hasOverlap, true);
    assert.deepEqual(clip.cut, {
      left: 0,
      top: 300,
      right: 400,
      bottom: 350,
      width: 400,
      height: 50
    });

    const noOverlap = computeTaskbarClip(
      { left: 100, top: 100, right: 500, bottom: 500 },
      { left: 0, top: 600, right: 1000, bottom: 650 }
    );
    assert.equal(noOverlap.hasOverlap, false);
    assert.equal(noOverlap.cut, null);
  });

  await test("readNativeWindowHandle supports 64-bit and 32-bit buffers", () => {
    const handle64 = Buffer.alloc(8);
    handle64.writeBigUInt64LE(0x12345678n, 0);
    assert.equal(
      readNativeWindowHandle({ getNativeWindowHandle: () => handle64 }),
      "305419896"
    );

    const handle32 = Buffer.alloc(4);
    handle32.writeUInt32LE(0x12345678, 0);
    assert.equal(
      readNativeWindowHandle({ getNativeWindowHandle: () => handle32 }),
      "305419896"
    );
  });

  await test("per-pet window bounds reverse the collision placement to the display frame", () => {
    const layout = {
      displayFrame: { width: 50, height: 60 },
      collision: { width: 20, height: 30, offsetX: 0, offsetY: 10 },
      placement: { x: 100, y: 200, direction: 1 }
    };

    assert.deepEqual(
      resolvePetWindowBounds(layout, 2, { x: 0, y: 0 }),
      { x: 50, y: 120, width: 100, height: 120 }
    );
  });

  await test("per-pet geometry uses the union of display, collision and interaction", () => {
    const layout = {
      displayFrame: { width: 50, height: 60 },
      collision: { width: 20, height: 30, offsetX: 0, offsetY: 10 },
      interaction: { width: 80, height: 20, offsetX: 20, offsetY: -20 },
      placement: { x: 100, y: 200, direction: 1 }
    };

    const union = unionRects([
      { left: 10, top: 20, right: 30, bottom: 40 },
      { left: 0, top: 25, right: 45, bottom: 35 }
    ]);
    assert.deepEqual(union, {
      left: 0,
      top: 20,
      right: 45,
      bottom: 40,
      width: 45,
      height: 20
    });

    const geometry = computePetWindowGeometry(layout, 1);
    assert.deepEqual(geometry.windowSize, { w: 120, h: 60 });
    assert.deepEqual(geometry.frameOffsetInWindow, { x: 35, y: 0 });
    assert.deepEqual(geometry.collisionInWindow, {
      x: 50,
      y: 25,
      w: 20,
      h: 30,
      width: 20,
      height: 30
    });
    assert.deepEqual(geometry.interactionInWindow, {
      x: 40,
      y: 0,
      w: 80,
      h: 20,
      width: 80,
      height: 20
    });
    assert.deepEqual(geometry.window, {
      x: 40,
      y: 160,
      width: 120,
      height: 60
    });

    const mirrored = computePetWindowGeometry(
      {
        ...layout,
        placement: { ...layout.placement, direction: -1 }
      },
      1
    );
    assert.deepEqual(mirrored.windowSize, geometry.windowSize);
    assert.deepEqual(mirrored.window, geometry.window);
    assert.equal(mirrored.interactionInWindow.x, 0);
  });

  await test("per-pet geometry honours an explicit displayFrame offset", () => {
    const layout = {
      displayFrame: { width: 50, height: 60, offsetX: 30, offsetY: -5 },
      collision: { width: 20, height: 30, offsetX: -30, offsetY: 5 },
      interaction: { width: 20, height: 30, offsetX: 0, offsetY: 0 },
      placement: { x: 100, y: 200, direction: -1 }
    };

    const geometry = computePetWindowGeometry(layout, 2);
    // 显示框中心 = (100 + mirror(30, -1)×2, 200 - 5×2) = (40, 190)；
    // 碰撞框中心（direction=-1）= 显示框中心 + mirror(-30, -1)×2, +5×2 = (100, 200)
    // 仍等于 placement。union 覆盖正反朝向的碰撞/交互框。
    assert.deepEqual(geometry.window, {
      x: -40,
      y: 130,
      width: 160,
      height: 120
    });
  });

  await test("pet-window URL keeps the renderer view and adds petId", () => {
    const url = buildPetWindowUrl(
      (view) => `http://127.0.0.1:5173/?view=${view}`,
      "pet_a"
    );
    assert.equal(
      url,
      "http://127.0.0.1:5173/?view=pet-window&petId=pet_a"
    );
    assert.deepEqual(toDipRect({ x: 100, y: 150, width: 200, height: 250 }, 2), {
      x: 50,
      y: 75,
      width: 100,
      height: 125
    });
  });

  await test("per-pet runtime is opt-in and movePetWindow avoids setBounds", async () => {
    const nativeWindow = createMockNativeWindow();
    const screen = {
      getPrimaryDisplay() {
        return {
          bounds: { x: 0, y: 0, width: 1280, height: 800 },
          scaleFactor: 1.25
        };
      }
    };
    const runtime = new PetWindowRuntime({
      BrowserWindow: MockBrowserWindow,
      screen,
      nativeWindow,
      preloadPath: "preload.cjs",
      logger: { warn() {} }
    });
    const layout = {
      displayFrame: { width: 50, height: 60 },
      collision: { width: 20, height: 30, offsetX: 0, offsetY: 10 },
      placement: { x: 100, y: 200, direction: 1 }
    };
    const baseState = {
      settings: { overlay: { perPetWindows: false, scale: 2 } },
      pets: [{ id: "pet_a", layout }],
      summonedPetIds: ["pet_a"]
    };

    await runtime.sync(baseState);
    assert.equal(runtime.size, 0);
    assert.equal(nativeWindow.calls.length, 0);

    await runtime.sync({
      ...baseState,
      settings: { overlay: { perPetWindows: true, scale: 2 } }
    });
    await delay(0);
    assert.equal(runtime.size, 1);

    const entry = runtime.windows.get("pet_a");
    assert.equal(entry.window.options.frame, false);
    assert.equal(entry.window.options.transparent, true);
    assert.equal(entry.window.options.skipTaskbar, true);
    assert.equal(entry.window.options.focusable, false);
    assert.equal(entry.window.options.hasShadow, false);
    assert.equal(entry.window.options.resizable, false);
    assert.ok(entry.window.loadedUrl.includes("index.html"));
    assert.ok(entry.window.loadedUrl.includes("view=pet-window"));
    assert.deepEqual(entry.geometry.windowSize, { w: 125, h: 150 });
    assert.deepEqual(entry.window.bounds, {
      x: 50,
      y: 120,
      width: 100,
      height: 120
    });

    await entry.nativeTask;
    assert.equal(nativeWindow.calls.some((call) => call.op === "style"), true);
    assert.equal(nativeWindow.calls.some((call) => call.op === "topmost"), true);
    assert.equal(
      nativeWindow.calls.some(
        (call) => call.op === "move" && call.x === 62 && call.y === 150
      ),
      true
    );
    assert.equal(
      nativeWindow.calls.some((call) => call.op === "excludeTaskbar"),
      true
    );

    const setBoundsCount = entry.window.setBoundsCalls.length;
    const moveResult = await runtime.movePetWindow("pet_a", 500, 600);
    assert.equal(moveResult.ok, true);
    assert.equal(
      nativeWindow.calls.some(
        (call) => call.op === "move" && call.x === 500 && call.y === 600
      ),
      true
    );
    assert.equal(entry.window.setBoundsCalls.length, setBoundsCount);

    await runtime.sync({
      ...baseState,
      settings: { overlay: { perPetWindows: false, scale: 2 } }
    });
    assert.equal(runtime.size, 0);
    assert.equal(entry.window.isDestroyed(), true);
    await runtime.dispose();
  });

  await test("per-pet runtime sends the handshake, metrics, peers and focus IPC", async () => {
    const nativeWindow = createMockNativeWindow();
    const screen = {
      getPrimaryDisplay() {
        return {
          bounds: { x: 0, y: 0, width: 1280, height: 800 },
          scaleFactor: 1.25
        };
      }
    };
    const runtime = new PetWindowRuntime({
      BrowserWindow: MockBrowserWindow,
      screen,
      nativeWindow,
      preloadPath: "preload.cjs",
      rendererUrl: (view) => `http://127.0.0.1:5173/?view=${view}`,
      logger: { warn() {} }
    });
    const layoutA = {
      displayFrame: { width: 50, height: 60 },
      collision: { width: 20, height: 30, offsetX: 0, offsetY: 10 },
      interaction: { width: 30, height: 40, offsetX: 5, offsetY: 0 },
      placement: { x: 100, y: 200, direction: 1 }
    };
    const layoutB = {
      displayFrame: { width: 50, height: 60 },
      collision: { width: 20, height: 30, offsetX: 0, offsetY: 10 },
      interaction: { width: 30, height: 40, offsetX: 5, offsetY: 0 },
      placement: { x: 260, y: 200, direction: -1 }
    };
    const state = {
      settings: { overlay: { perPetWindows: true, scale: 1 } },
      pets: [
        { id: "pet_a", scale: 1, layout: layoutA },
        { id: "pet_b", scale: 1, layout: layoutB }
      ],
      summonedPetIds: ["pet_a", "pet_b"]
    };

    await runtime.sync(state);
    await delay(0);
    const entryA = runtime.windows.get("pet_a");
    const entryB = runtime.windows.get("pet_b");
    assert.ok(entryA.window.loadedUrl.includes("view=pet-window"));
    assert.ok(entryA.window.loadedUrl.includes("petId=pet_a"));

    assert.equal(
      runtime.handleRendererReady(entryA.window.webContents, { petId: "pet_a" }),
      true
    );
    assert.equal(
      runtime.handleRendererReady(entryB.window.webContents, { petId: "pet_b" }),
      true
    );

    const init = entryA.window.webContents.sent.find(
      (message) => message.channel === "pet-window:init"
    );
    assert.ok(init);
    assert.equal(init.payload.petId, "pet_a");
    assert.ok(init.payload.windowSize.w > 0);
    assert.ok(init.payload.collisionInWindow.w > 0);
    assert.ok(init.payload.metrics.bounds.w > 0);
    assert.equal(init.payload.metrics.taskbar.y, 760);
    assert.deepEqual(init.payload.layout, layoutA);

    const platforms = entryA.window.webContents.sent.find(
      (message) => message.channel === "pet-window:platforms"
    );
    assert.deepEqual(platforms.payload, { platforms: [] });

    const peers = entryA.window.webContents.sent
      .filter((message) => message.channel === "pet-window:peers")
      .at(-1);
    assert.equal(peers.payload.peers.length, 1);
    assert.equal(peers.payload.peers[0].petId, "pet_b");
    assert.equal(peers.payload.peers[0].direction, -1);

    const targetResult = runtime.queueRendererTarget(
      entryA.window.webContents,
      "pet_a",
      300,
      350
    );
    assert.equal(targetResult.ok, true);
    await entryA.targetTask;
    assert.equal(
      nativeWindow.calls.some(
        (call) => call.op === "move" && call.x === 300 && call.y === 350
      ),
      true
    );

    assert.equal(
      runtime.setIgnoreMouse(entryA.window.webContents, "pet_a", true),
      true
    );
    assert.deepEqual(entryA.window.ignoreMouseCalls.at(-1), {
      ignore: true,
      options: { forward: true }
    });
    assert.equal(
      entryA.window.webContents.sent.some(
        (message) =>
          message.channel === "pet-window:set-ignore-mouse" &&
          message.payload.ignore === true
      ),
      true
    );

    assert.equal(
      await runtime.setFocus(entryA.window.webContents, "pet_a", true),
      true
    );
    assert.ok(
      nativeWindow.calls.some(
        (call) => call.op === "setNoActivate" && call.on === false
      )
    );
    assert.ok(nativeWindow.calls.some((call) => call.op === "raise"));
    assert.ok(nativeWindow.calls.some((call) => call.op === "focus"));
    await runtime.setFocus(entryA.window.webContents, "pet_a", false);
    assert.ok(
      nativeWindow.calls.some(
        (call) => call.op === "setNoActivate" && call.on === true
      )
    );

    await runtime.dispose();
  });

  if (process.platform === "win32") {
    await test("resident helper reports DPI-aware physical primary metrics", async () => {
      const client = new NativeWindowClient({
        logger: { warn() {} },
        readyTimeoutMs: 20000,
        requestTimeoutMs: 20000
      });
      try {
        await client.start();
        assert.equal(client.metrics.spawnCount, 1);
        assert.ok(client.helperInfo?.dpiAwareness);

        const metrics = await client.getPrimaryMetrics();
        assert.ok(metrics);
        assert.ok(metrics.bounds.width > 0);
        assert.ok(metrics.bounds.height > 0);
        assert.ok(metrics.workArea.width > 0);
        assert.ok(metrics.workArea.height > 0);
        assert.ok(metrics.scaleFactor > 0);

        const taskbar = await client.getTaskbarRect();
        assert.ok(taskbar === null || taskbar.width > 0);

        const invalidNoActivate = await client.call("setNoActivate", {
          hwnd: "0",
          on: false
        });
        assert.equal(invalidNoActivate.op, "setNoActivate");
      } finally {
        await client.stop();
      }
      await delay(50);
    });
  }


  await test("physical placement converts to logical units", async () => {
    assert.deepEqual(
      physicalPlacementToLogical({ x: 1230, y: 916.5 }, 1.5),
      { x: 820, y: 611 }
    );
    assert.deepEqual(
      physicalPlacementToLogical({ x: 400, y: 300 }, 1),
      { x: 400, y: 300 }
    );
    assert.deepEqual(
      physicalPlacementToLogical({ x: 400, y: 300 }, 0),
      { x: 400, y: 300 },
      "invalid scale must fall back to 1"
    );
  });

  console.log("");
  console.log(passed + " passed, " + failed + " failed");
  if (failed > 0) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
