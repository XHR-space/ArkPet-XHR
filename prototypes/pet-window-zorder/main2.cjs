"use strict";

/*
 * Focused spike for risk 2 and 3 (windows only, capture-path fixed).
 *
 * Lessons from the first attempt, both confirmed on this machine:
 *   - the PowerShell helper must be per-monitor-v2 DPI aware, otherwise every
 *     pixel / hit-test coordinate is virtualised and points somewhere else;
 *   - a background process can not reliably raise a plain window above the
 *     current foreground application, so the capture-based checks run with the
 *     pet temporarily in the topmost band (the mechanism ArkPet uses today).
 *
 * Run from the repository root:
 *   node_modules\electron\dist\electron.exe prototypes\pet-window-zorder\main2.cjs
 */

const { app, BrowserWindow, screen } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

const RESULTS_PATH = path.join(__dirname, "results-zorder-focus.json");
const PET_WINDOW = { x: 120, y: 120, width: 300, height: 360 };
const PET_BLOCK = { x: 90, y: 60, width: 120, height: 240 };
const PET_BLOCK_COLOR = { r: 255, g: 120, b: 0 };
const COLOR_TOLERANCE = 60;

const results = {
  mode: "windows-zorder-focus-spike-v2",
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
      const timer = setTimeout(() => reject(new Error("helper readiness timeout")), 15000);
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
      }, 15000);
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

function handleOf(window) {
  const handle = window.getNativeWindowHandle();
  return (handle.length === 8 ? handle.readBigUInt64LE(0) : BigInt(handle.readUInt32LE(0))).toString();
}

const parseRect = (text) => {
  if (!text) return null;
  const [left, top, right, bottom] = text.split(",").map(Number);
  return { left, top, right, bottom, width: right - left, height: bottom - top };
};

function looksLikePet(pixel) {
  return (
    !!pixel &&
    Math.abs(pixel.r - PET_BLOCK_COLOR.r) <= COLOR_TOLERANCE &&
    Math.abs(pixel.g - PET_BLOCK_COLOR.g) <= COLOR_TOLERANCE &&
    Math.abs(pixel.b - PET_BLOCK_COLOR.b) <= COLOR_TOLERANCE
  );
}

async function run() {
  const display = screen.getPrimaryDisplay();
  const scale = display.scaleFactor;
  results.environment = {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    scaleFactor: scale,
    bounds: display.bounds,
    workArea: display.workArea,
  };

  const pet = new BrowserWindow({
    ...PET_WINDOW,
    frame: false,
    transparent: true,
    hasShadow: false,
    resizable: false,
    skipTaskbar: true,
    focusable: false,
    show: false,
    alwaysOnTop: false,
    title: "ArkPet spike2 (pet)",
    webPreferences: { nodeIntegration: false, contextIsolation: true },
  });
  const dummy = new BrowserWindow({
    x: 300,
    y: 200,
    width: 420,
    height: 320,
    resizable: false,
    show: false,
    title: "ArkPet spike2 (dummy app window)",
  });
  pet.setMenuBarVisibility(false);
  dummy.setMenuBarVisibility(false);

  const petHtml = `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;width:100%;height:100%;overflow:hidden;background:transparent}
#block{position:absolute;left:${PET_BLOCK.x}px;top:${PET_BLOCK.y}px;width:${PET_BLOCK.width}px;height:${PET_BLOCK.height}px;background:rgb(${PET_BLOCK_COLOR.r},${PET_BLOCK_COLOR.g},${PET_BLOCK_COLOR.b})}
</style></head><body><div id="block"></div></body></html>`;

  await pet.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(petHtml)}`);
  await dummy.loadURL("data:text/html;charset=utf-8,%3Chtml%3E%3Cbody%20style%3D%22background%3A%231f2733%22%3E%3Ch1%20style%3D%22color%3A%23fff%3Bfont-family%3ASegoe%20UI%22%3Edummy%20app%3C%2Fh1%3E%3C%2Fbody%3E%3C%2Fhtml%3E");

  const helper = new Helper(path.join(__dirname, "native-window-style.ps1"));
  await helper.start();
  results.helper = { started: true };

  const petHwnd = handleOf(pet);
  const dummyHwnd = handleOf(dummy);
  const style = await helper.call("style", { hwnd: petHwnd, toolWindow: true, noActivate: true, clearTopmost: true });
  results.windows.pet = { hwnd: petHwnd, exStyle: style.exStyle };
  results.windows.dummy = { hwnd: dummyHwnd };
  results.windows.petRoot = (await helper.call("root", { hwnd: petHwnd })).hwnd;
  results.windows.dummyRoot = (await helper.call("root", { hwnd: dummyHwnd })).hwnd;
  const petRoot = results.windows.petRoot;
  const dummyRoot = results.windows.dummyRoot;

  pet.showInactive();
  dummy.showInactive();
  await delay(900);

  const petRect = parseRect((await helper.call("rect", { hwnd: petHwnd })).rect);
  results.windows.pet.rect = petRect;
  const blockCenter = {
    x: Math.round(petRect.left + (PET_BLOCK.x + PET_BLOCK.width / 2) * scale),
    y: Math.round(petRect.top + (PET_BLOCK.y + PET_BLOCK.height / 2) * scale),
  };
  results.windows.blockCenter = blockCenter;

  const exValue = parseInt(style.exStyle.replace("0x", ""), 16);
  record(
    "petWindowIsToolWindowAndNoActivate",
    (exValue & 0x08000000) === 0x08000000 && (exValue & 0x00000080) === 0x00000080,
    { exStyle: style.exStyle, expected: "WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW" },
  );

  // ---- check A: topmost pet stays above whatever else owns this pixel -------
  const coverBefore = await helper.call("windowFromPoint", blockCenter);
  await helper.call("topmost", { hwnd: petHwnd, on: true });
  await delay(400);
  const topmostPixel = (await helper.call("pixel", blockCenter)).pixel;
  const topmostHit = (await helper.call("windowFromPoint", blockCenter)).hwnd;
  results.windows.coverBeforeTopmost = coverBefore.hwnd;

  record("topmostPetVisibleOverOtherApps", topmostHit === petRoot && looksLikePet(topmostPixel), {
    blockCenter,
    windowOnTopBeforeTopmost: coverBefore.hwnd,
    petRoot,
    pixelAfterTopmost: topmostPixel,
    windowFromPointAfterTopmost: topmostHit,
  });

  // ---- check B: the shell taskbar still wins over a topmost pet -------------
  const taskbar = await helper.call("taskbar");
  const taskbarRect = parseRect(taskbar.rect);
  if (!taskbar.ok || !taskbarRect) {
    record("taskbarOccludesTopmostPet", false, { reason: "Shell_TrayWnd not found" });
  } else {
    const taskbarPoint = {
      x: Math.round(taskbarRect.left + taskbarRect.width / 2),
      y: Math.round(taskbarRect.top + taskbarRect.height / 2),
    };
    const targetX = Math.round(taskbarPoint.x - (PET_BLOCK.x + PET_BLOCK.width / 2) * scale);
    const targetY = Math.round(taskbarPoint.y - (PET_BLOCK.y + PET_BLOCK.height / 2) * scale);
    await helper.call("move", { hwnd: petHwnd, x: targetX, y: targetY });
    await delay(500);

    const movedRect = parseRect((await helper.call("rect", { hwnd: petHwnd })).rect);
    const taskbarPixel = (await helper.call("pixel", taskbarPoint)).pixel;
    const taskbarHit = (await helper.call("windowFromPoint", taskbarPoint)).hwnd;
    results.windows.taskbar = { hwnd: taskbar.hwnd, rect: taskbarRect, point: taskbarPoint };
    results.windows.petOverTaskbarRect = movedRect;

    record("taskbarOccludesTopmostPet", !looksLikePet(taskbarPixel) && taskbarHit !== petRoot, {
      taskbarPoint,
      taskbarHwnd: taskbar.hwnd,
      petRoot,
      petWindowCoversPoint: !!movedRect && taskbarPoint.x >= movedRect.left && taskbarPoint.x < movedRect.right && taskbarPoint.y >= movedRect.top && taskbarPoint.y < movedRect.bottom,
      pixelAtTaskbarPoint: taskbarPixel,
      windowFromPointAtTaskbar: taskbarHit,
    });

    await helper.call("move", { hwnd: petHwnd, x: petRect.left, y: petRect.top });
    await delay(300);
  }

  // ---- check C/D: normal z-order between two ordinary windows ---------------
  await helper.call("topmost", { hwnd: petHwnd, on: false });
  await delay(200);
  await helper.call("raise", { hwnd: petHwnd });
  await delay(200);
  await helper.call("raise", { hwnd: dummyHwnd });
  await delay(400);
  const dummyFirst = (await helper.call("compareZ", { hwndA: dummyHwnd, hwndB: petHwnd })).value;
  record("raisedNormalWindowCoversPet", dummyFirst === 1, { compareZ_dummyAbovePet: dummyFirst });

  const foregroundBeforePetRaise = (await helper.call("foreground")).hwnd;
  await helper.call("raise", { hwnd: petHwnd });
  await delay(400);
  const petFirst = (await helper.call("compareZ", { hwndA: petHwnd, hwndB: dummyHwnd })).value;
  const foregroundAfterPetRaise = (await helper.call("foreground")).hwnd;
  record("raiseNoActivatePutsPetBackOnTop", petFirst === 1 && foregroundAfterPetRaise !== petRoot, {
    compareZ_petAboveDummy: petFirst,
    foregroundBeforePetRaise,
    foregroundAfterPetRaise,
    petRoot,
  });

  // ---- check E: temporary focus for text chat ------------------------------
  // WS_EX_NOACTIVATE must be cleared before a window can take the foreground;
  // the real app restores it as soon as the temporary focus ends.
  await helper.call("style", { hwnd: petHwnd, toolWindow: true, noActivate: false, clearTopmost: false });
  await delay(150);
  const focusPet = await helper.call("focus", { hwnd: petHwnd });
  const foregroundAfterPetFocus = (await helper.call("foreground")).hwnd;
  record("temporaryFocusCanActivatePet", foregroundAfterPetFocus === petRoot, {
    method: focusPet.method,
    foregroundAfterPetFocus,
    petRoot,
  });

  const focusDummy = await helper.call("focus", { hwnd: dummyHwnd });
  const foregroundAfterDummyFocus = (await helper.call("foreground")).hwnd;
  await delay(1500);
  const foregroundAfterSettle = (await helper.call("foreground")).hwnd;
  record(
    "focusCanBeTakenBackAndDoesNotBounce",
    foregroundAfterSettle === dummyRoot,
    {
      method: focusDummy.method,
      foregroundImmediatelyAfterDummyFocus: foregroundAfterDummyFocus,
      note: "focus switches a few frames after the call; the settled value is what matters",
      foregroundAfterSettle,
      dummyRoot,
      waitMs: 1500,
    },
  );

  await helper.call("style", { hwnd: petHwnd, toolWindow: true, noActivate: true, clearTopmost: false });
  await helper.call("topmost", { hwnd: petHwnd, on: false });
  await helper.call("style", { hwnd: petHwnd, toolWindow: false, noActivate: false, clearTopmost: true });
  await helper.stop();
  results.helper.stopped = true;

  if (!pet.isDestroyed()) pet.destroy();
  if (!dummy.isDestroyed()) dummy.destroy();
}

function finalize() {
  const checks = Object.values(results.checks);
  results.summary.passed = checks.filter((check) => check.pass).length;
  results.summary.failed = checks.filter((check) => !check.pass).length;
  results.generatedAt = new Date().toISOString();
  fs.writeFileSync(RESULTS_PATH, `${JSON.stringify(results, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(results.summary, null, 2));
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
