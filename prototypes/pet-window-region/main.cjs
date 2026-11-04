"use strict";

/*
 * Spike: keep a transparent, topmost pet window from covering the Windows taskbar.
 *
 * The z-order spike proved the Windows taskbar does NOT stay above a topmost
 * window, so the pet has to clip itself. This prototype applies
 * SetWindowRgn(window rect minus taskbar band) and measures:
 *   - before the clip: the pet really does paint over the taskbar
 *   - after the clip:   the pet still paints above the taskbar edge, but the
 *                       pixels inside the taskbar band belong to the taskbar
 *                       again (pixel + WindowFromPoint)
 *   - clearing the clip restores the previous behaviour
 *
 * Run from the repository root:
 *   node_modules\electron\dist\electron.exe prototypes\pet-window-region\main.cjs
 */

const { app, BrowserWindow, screen } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

const RESULTS_PATH = path.join(__dirname, "results-window-region.json");
const PET_WINDOW = { width: 300, height: 360 };
const PET_BLOCK = { x: 90, y: 60, width: 120, height: 240 };
const PET_BLOCK_COLOR = { r: 255, g: 120, b: 0 };
const COLOR_TOLERANCE = 60;
const EDGE_PROBE_OFFSET_PX = 30;

const results = {
  mode: "windows-window-region-spike",
  generatedAt: new Date().toISOString(),
  platform: process.platform,
  environment: {},
  windows: {},
  checks: {},
  errors: [],
  summary: { passed: 0, failed: 0 },
};

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function record(name, pass, detail) {
  results.checks[name] = { pass: Boolean(pass), detail };
  return Boolean(pass);
}

class Helper {
  constructor(scriptPath) {
    this.scriptPath = scriptPath;
    this.child = null;
    this.pending = new Map();
    this.buffer = "";
    this.stderr = "";
    this.sequence = 0;
    this.stopping = false;
  }

  start() {
    return new Promise((resolve, reject) => {
      const child = spawn(
        "powershell.exe",
        ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", this.scriptPath],
        { cwd: __dirname, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] },
      );
      this.child = child;
      const timer = setTimeout(() => reject(new Error("helper readiness timeout")), 20000);
      let settled = false;
      const finish = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        error ? reject(error) : resolve();
      };
      child.stdout.on("data", (chunk) => {
        this.buffer += chunk.toString("utf8");
        const lines = this.buffer.split(/\r?\n/);
        this.buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          let message;
          try {
            message = JSON.parse(line);
          } catch (error) {
            results.errors.push({ kind: "protocol", line });
            continue;
          }
          if (message.kind === "ready") {
            results.environment.helperDpiAwareness = message.dpiAwareness;
            finish(null);
            continue;
          }
          const entry = this.pending.get(message.id);
          if (!entry) {
            results.errors.push({ kind: "orphan", message });
            continue;
          }
          this.pending.delete(message.id);
          clearTimeout(entry.timer);
          message.kind === "error" ? entry.reject(new Error(message.message)) : entry.resolve(message);
        }
      });
      child.stderr.on("data", (chunk) => {
        this.stderr = (this.stderr + chunk.toString("utf8")).slice(-4000);
      });
      child.on("error", finish);
      child.on("exit", (code, signal) => {
        if (!this.stopping) {
          results.errors.push({ kind: "helperExit", code, signal, stderr: this.stderr });
          finish(new Error("helper exited early"));
        }
      });
    });
  }

  call(op, fields = {}) {
    return new Promise((resolve, reject) => {
      const id = ++this.sequence;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${op} timed out`));
      }, 20000);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(`${JSON.stringify({ id, op, ...fields })}\n`);
    });
  }

  async stop() {
    this.stopping = true;
    if (this.child && this.child.stdin.writable) {
      try {
        await this.call("exit");
      } catch {}
    }
    if (this.child && !this.child.killed) this.child.kill();
  }
}

const handleOf = (window) => {
  const handle = window.getNativeWindowHandle();
  return (handle.length === 8 ? handle.readBigUInt64LE(0) : BigInt(handle.readUInt32LE(0))).toString();
};

const parseRect = (text) => {
  if (!text) return null;
  const [left, top, right, bottom] = text.split(",").map(Number);
  return { left, top, right, bottom, width: right - left, height: bottom - top };
};

const looksLikePet = (pixel) =>
  !!pixel &&
  Math.abs(pixel.r - PET_BLOCK_COLOR.r) <= COLOR_TOLERANCE &&
  Math.abs(pixel.g - PET_BLOCK_COLOR.g) <= COLOR_TOLERANCE &&
  Math.abs(pixel.b - PET_BLOCK_COLOR.b) <= COLOR_TOLERANCE;

async function probePoint(helper, point) {
  return {
    point,
    pixel: (await helper.call("pixel", point)).pixel,
    windowFromPoint: (await helper.call("windowFromPoint", point)).hwnd,
  };
}

async function run() {
  const display = screen.getPrimaryDisplay();
  const scale = display.scaleFactor;
  results.environment = {
    electron: process.versions.electron,
    scaleFactor: scale,
    bounds: display.bounds,
    workArea: display.workArea,
  };

  const dummyHelper = new Helper(path.join(__dirname, "native-window-region.ps1"));
  await dummyHelper.start();
  const taskbar = await dummyHelper.call("taskbar");
  const taskbarRect = parseRect(taskbar.rect);
  await dummyHelper.stop();
  results.windowsHelper = { started: true, stopped: true };

  if (!taskbar.ok || !taskbarRect) {
    throw new Error("Shell_TrayWnd was not found; this spike needs a Windows taskbar.");
  }
  results.windows.taskbar = { hwnd: taskbar.hwnd, rect: taskbarRect };

  const blockCenterDip = { x: PET_BLOCK.x + PET_BLOCK.width / 2, y: PET_BLOCK.y + PET_BLOCK.height / 2 };

  const pet = new BrowserWindow({
    x: 120,
    y: 120,
    width: PET_WINDOW.width,
    height: PET_WINDOW.height,
    frame: false,
    transparent: true,
    hasShadow: false,
    resizable: false,
    skipTaskbar: true,
    focusable: false,
    show: false,
    alwaysOnTop: false,
    title: "ArkPet region spike (pet)",
    webPreferences: { nodeIntegration: false, contextIsolation: true },
  });
  pet.setMenuBarVisibility(false);

  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;width:100%;height:100%;overflow:hidden;background:transparent}
#block{position:absolute;left:${PET_BLOCK.x}px;top:${PET_BLOCK.y}px;width:${PET_BLOCK.width}px;height:${PET_BLOCK.height}px;background:rgb(${PET_BLOCK_COLOR.r},${PET_BLOCK_COLOR.g},${PET_BLOCK_COLOR.b})}
</style></head><body><div id="stage" style="position:absolute;inset:0"><div id="block"></div></div></body></html>`;
  await pet.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);

  const helper = new Helper(path.join(__dirname, "native-window-region.ps1"));
  await helper.start();

  const petHwnd = handleOf(pet);
  // Show first, then style and raise: the z-order spike showed that a raise
  // issued before the window is visible does not stick on this desktop.
  pet.showInactive();
  await delay(900);
  await helper.call("style", { hwnd: petHwnd, toolWindow: true, noActivate: true, clearTopmost: true });
  await helper.call("topmost", { hwnd: petHwnd, on: true });
  await delay(600);

  const initialRect = parseRect((await helper.call("rect", { hwnd: petHwnd })).rect);
  results.windows.petInitialRect = initialRect;
  const physicalScreenWidth = Math.round(display.bounds.width * scale);
  const targetX = Math.round(physicalScreenWidth / 2 - blockCenterDip.x * scale);
  const targetY = Math.round(taskbarRect.top - blockCenterDip.y * scale);
  const moveResult = await helper.call("move", { hwnd: petHwnd, x: targetX, y: targetY });
  results.windows.plannedMove = { targetX, targetY, physicalScreenWidth, ok: moveResult.ok, win32Error: moveResult.win32Error };
  await delay(500);

  const petRoot = (await helper.call("root", { hwnd: petHwnd })).hwnd;
  const petRect = parseRect((await helper.call("rect", { hwnd: petHwnd })).rect);
  results.windows.pet = { hwnd: petHwnd, root: petRoot, rect: petRect };

  const blockCenter = {
    x: Math.round(petRect.left + blockCenterDip.x * scale),
    y: Math.round(petRect.top + blockCenterDip.y * scale),
  };
  const aboveEdge = { x: blockCenter.x, y: blockCenter.y - EDGE_PROBE_OFFSET_PX };
  const insideBand = { x: blockCenter.x, y: blockCenter.y + EDGE_PROBE_OFFSET_PX };
  results.windows.probePoints = { blockCenter, aboveEdge, insideBand, taskbarTop: taskbarRect.top };

  // ---- 1. baseline: a topmost pet really does paint over the taskbar -------
  const baselineAbove = await probePoint(helper, aboveEdge);
  const baselineInside = await probePoint(helper, insideBand);
  results.windows.baseline = { aboveEdge: baselineAbove, insideBand: baselineInside };

  record(
    "baselineTopmostPetCoversTaskbar",
    looksLikePet(baselineAbove.pixel) &&
      looksLikePet(baselineInside.pixel) &&
      baselineAbove.windowFromPoint === petRoot &&
      baselineInside.windowFromPoint === petRoot,
    {
      note: "Without a clip the pet owns the pixels inside the taskbar band; this is the problem being solved.",
      aboveEdge: baselineAbove,
      insideBand: baselineInside,
      petRoot,
      taskbarTop: taskbarRect.top,
    },
  );

  // ---- 2. approach A: native SetWindowRgn on the transparent window --------
  // Kept in the results because it is the obvious first idea, and because the
  // measurement below is what rules it out for Chromium's layered window.
  const clip = await helper.call("region", {
    hwnd: petHwnd,
    clipTaskbar: true,
    taskbarLeft: taskbarRect.left,
    taskbarTop: taskbarRect.top,
    taskbarRight: taskbarRect.right,
    taskbarBottom: taskbarRect.bottom,
  });
  results.windows.nativeRegionCall = { ok: clip.ok, detail: clip.detail };
  await delay(700);

  const nativeClippedInside = await probePoint(helper, insideBand);
  const nativeClippedAbove = await probePoint(helper, aboveEdge);
  await delay(700);
  const nativeClippedInsideSettled = await probePoint(helper, insideBand);
  results.windows.nativeRegion = {
    aboveEdgeImmediately: nativeClippedAbove,
    insideBandImmediately: nativeClippedInside,
    insideBandAfterSettling: nativeClippedInsideSettled,
  };

  const nativeRegionWorks =
    looksLikePet(nativeClippedAbove.pixel) && !looksLikePet(nativeClippedInside.pixel);
  record("nativeSetWindowRgnClipsTaskbarBand", nativeRegionWorks, {
    note: "SetWindowRgn on a Chromium transparent window: set() reports success but the composited pixels stay.",
    call: results.windows.nativeRegionCall,
    aboveEdge: nativeClippedAbove,
    insideBandImmediately: nativeClippedInside,
    insideBandAfterSettling: nativeClippedInsideSettled,
    petRoot,
  });

  await helper.call("region", { hwnd: petHwnd, clipTaskbar: false });
  await delay(400);

  // ---- 3. approach B: clip the rendering itself ----------------------------
  const clipBottomDip = Math.max(0, Math.round((taskbarRect.top - petRect.top) / scale));
  results.windows.rendererClip = { clipBottomDip, windowHeightDip: PET_WINDOW.height };
  await pet.webContents.executeJavaScript(
    `document.getElementById("stage").style.clipPath = "inset(0 0 ${clipBottomDip}px 0)"; true;`,
  );
  await delay(600);

  const rendererClippedAbove = await probePoint(helper, aboveEdge);
  const rendererClippedInside = await probePoint(helper, insideBand);
  results.windows.rendererClipResult = { aboveEdge: rendererClippedAbove, insideBand: rendererClippedInside };

  record(
    "rendererClipStillPaintsAboveTaskbar",
    looksLikePet(rendererClippedAbove.pixel) && rendererClippedAbove.windowFromPoint === petRoot,
    { point: aboveEdge, result: rendererClippedAbove, petRoot },
  );

  record(
    "rendererClipHidesTaskbarBand",
    !looksLikePet(rendererClippedInside.pixel),
    {
      point: insideBand,
      result: rendererClippedInside,
      petRoot,
      taskbarTop: taskbarRect.top,
      note: "Only the pixels matter here: the window rect and its region stay untouched.",
    },
  );

  // ---- 4. clearing the renderer clip brings the pet back -------------------
  await pet.webContents.executeJavaScript('document.getElementById("stage").style.clipPath = "none"; true;');
  await delay(600);
  const clipCleared = await probePoint(helper, insideBand);
  record("rendererClipCanBeCleared", looksLikePet(clipCleared.pixel), {
    point: insideBand,
    result: clipCleared,
    petRoot,
  });
  await helper.call("topmost", { hwnd: petHwnd, on: false });
  await helper.call("style", { hwnd: petHwnd, toolWindow: false, noActivate: false, clearTopmost: true });
  await helper.stop();
  results.helper = { started: true, stopped: true };

  if (!pet.isDestroyed()) pet.destroy();
}

function finalize() {
  const checks = Object.values(results.checks);
  results.summary.passed = checks.filter((check) => check.pass).length;
  results.summary.failed = checks.filter((check) => !check.pass).length;
  results.generatedAt = new Date().toISOString();
  fs.writeFileSync(RESULTS_PATH, `${JSON.stringify(results, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(results.summary));
  for (const [name, check] of Object.entries(results.checks)) {
    console.log(`${check.pass ? "PASS" : "FAIL"}  ${name}`);
  }
}

app.whenReady().then(async () => {
  let code = 0;
  try {
    await run();
  } catch (error) {
    results.errors.push({ kind: "run", message: error && error.message ? error.message : String(error) });
    code = 1;
  }
  finalize();
  app.exit(code);
});
