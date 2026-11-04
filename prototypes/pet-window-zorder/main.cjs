"use strict";

/*
 * Spike for risk 2 and 3 of the "one window per pet" plan:
 *
 *   risk 2 - real desktop z-order (pet above normal windows, below the taskbar)
 *   risk 3 - temporary focus steal for text chat
 *
 * The prototype creates two windows and drives a resident PowerShell helper
 * that talks to user32 through P/Invoke. It never loads ArkPet state, never
 * touches src/**, electron/** or the release config, and never starts or stops
 * the user's running ArkPet.
 *
 * Run from the repository root:
 *   node_modules\electron\dist\electron.exe prototypes\pet-window-zorder\main.cjs
 */

const { app, BrowserWindow, ipcMain, screen } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

const HELPER_READY_TIMEOUT_MS = 8_000;
const HELPER_CALL_TIMEOUT_MS = 10_000;
const PET_WINDOW = { width: 300, height: 360, x: 120, y: 120 };
const PET_BLOCK = { x: 180, y: 140, width: 120, height: 220 };
const PET_BLOCK_COLOR = { r: 255, g: 120, b: 0 };
const DUMMY_WINDOW = { width: 420, height: 320, x: 300, y: 200 };
const RESULTS_PATH = path.join(__dirname, "results.json");

const results = {
  mode: "windows-zorder-focus-spike",
  generatedAt: new Date().toISOString(),
  platform: process.platform,
  environment: {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
  },
  windows: {},
  checks: {},
  unverified: [],
  errors: [],
  summary: { passed: 0, failed: 0, unverified: 0 },
};

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function record(name, pass, detail) {
  results.checks[name] = { verified: true, pass: Boolean(pass), detail };
  return Boolean(pass);
}

function markUnverified(name, reason) {
  results.checks[name] = { verified: false, pass: null, detail: reason };
  results.unverified.push({ name, reason });
}

function readNativeWindowHandle(window) {
  const handle = window.getNativeWindowHandle();
  if (handle.length === 8) {
    return handle.readBigUInt64LE(0).toString();
  }

  if (handle.length === 4) {
    return handle.readUInt32LE(0).toString();
  }

  throw new Error(`Unsupported native window handle length: ${handle.length}`);
}

class NativeStyleHelper {
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
        [
          "-NoLogo",
          "-NoProfile",
          "-NonInteractive",
          "-ExecutionPolicy",
          "Bypass",
          "-File",
          this.scriptPath,
        ],
        { cwd: __dirname, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] },
      );

      this.child = child;
      let settled = false;

      const finish = (error) => {
        if (settled) {
          return;
        }

        settled = true;
        clearTimeout(timer);
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      };

      const timer = setTimeout(() => {
        finish(new Error("Timed out waiting for native style helper readiness."));
      }, HELPER_READY_TIMEOUT_MS);

      child.stdout.on("data", (chunk) => {
        this.buffer += chunk.toString("utf8");
        const lines = this.buffer.split(/\r?\n/);
        this.buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (!line.trim()) {
            continue;
          }

          let message;
          try {
            message = JSON.parse(line);
          } catch (error) {
            results.errors.push({ kind: "protocol", message: `Invalid helper output: ${line}` });
            continue;
          }

          if (message.kind === "ready") {
            finish(null);
            continue;
          }

          this.settle(message);
        }
      });

      child.stderr.on("data", (chunk) => {
        this.stderr = (this.stderr + chunk.toString("utf8")).slice(-4_000);
      });

      child.on("error", (error) => finish(error));
      child.on("exit", (code, signal) => {
        if (!this.stopping) {
          results.errors.push({ kind: "helperExit", code, signal, stderr: this.stderr });
          finish(new Error(`Native style helper exited early (code=${code}, signal=${signal}).`));
        }
      });
    });
  }

  settle(message) {
    const entry = this.pending.get(message.id);
    if (!entry) {
      results.errors.push({ kind: "orphanMessage", message });
      return;
    }

    this.pending.delete(message.id);
    clearTimeout(entry.timer);

    if (message.kind === "error") {
      entry.reject(new Error(`${message.op} failed: ${message.message}`));
      return;
    }

    entry.resolve(message);
  }

  call(op, fields = {}) {
    if (!this.child || !this.child.stdin.writable) {
      return Promise.reject(new Error("Native style helper is not running."));
    }

    this.sequence += 1;
    const id = this.sequence;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Native style helper timed out on op "${op}".`));
      }, HELPER_CALL_TIMEOUT_MS);

      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(`${JSON.stringify({ id, op, ...fields })}\n`, (error) => {
        if (error) {
          this.pending.delete(id);
          clearTimeout(timer);
          reject(error);
        }
      });
    });
  }

  async stop() {
    const child = this.child;
    if (!child) {
      return;
    }

    this.stopping = true;

    try {
      await this.call("exit");
    } catch {
      // The helper may already be gone; stdin.end() below is the fallback.
    }

    if (child.stdin.writable) {
      child.stdin.end();
    }

    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        try {
          child.kill();
        } catch {
          // ignore
        }
        resolve();
      }, 2_000);

      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
}

function parseRect(text) {
  if (!text) {
    return null;
  }

  const parts = text.split(",").map((value) => Number(value));
  if (parts.length !== 4 || parts.some((value) => !Number.isFinite(value))) {
    return null;
  }

  return {
    left: parts[0],
    top: parts[1],
    right: parts[2],
    bottom: parts[3],
    width: parts[2] - parts[0],
    height: parts[3] - parts[1],
  };
}

function intersectRects(a, b) {
  const left = Math.max(a.left, b.left);
  const top = Math.max(a.top, b.top);
  const right = Math.min(a.right, b.right);
  const bottom = Math.min(a.bottom, b.bottom);

  if (right <= left || bottom <= top) {
    return null;
  }

  return { left, top, right, bottom, width: right - left, height: bottom - top };
}

function pointInRect(x, y, rect) {
  return x >= rect.left && x < rect.right && y >= rect.top && y < rect.bottom;
}

function blockPoint(rect) {
  return {
    x: Math.round(rect.left + rect.width * ((PET_BLOCK.x + PET_BLOCK.width / 2) / PET_WINDOW.width)),
    y: Math.round(rect.top + rect.height * ((PET_BLOCK.y + PET_BLOCK.height / 2) / PET_WINDOW.height)),
  };
}

function looksLikePetColor(pixel) {
  if (!pixel) {
    return false;
  }

  return (
    Math.abs(pixel.r - PET_BLOCK_COLOR.r) <= 24 &&
    Math.abs(pixel.g - PET_BLOCK_COLOR.g) <= 24 &&
    Math.abs(pixel.b - PET_BLOCK_COLOR.b) <= 24
  );
}

const eventLog = { pet: [], dummy: [] };

async function run() {
  const display = screen.getPrimaryDisplay();
  results.environment.scaleFactor = display.scaleFactor;
  results.environment.workArea = display.workArea;
  results.environment.bounds = display.bounds;

  const petWindow = new BrowserWindow({
    ...PET_WINDOW,
    frame: false,
    transparent: true,
    resizable: false,
    hasShadow: false,
    skipTaskbar: true,
    show: false,
    alwaysOnTop: false,
    title: "ArkPet z-order spike (pet)",
    webPreferences: { nodeIntegration: true, contextIsolation: false },
  });

  const dummyWindow = new BrowserWindow({
    ...DUMMY_WINDOW,
    resizable: false,
    show: false,
    alwaysOnTop: false,
    title: "ArkPet z-order spike (dummy app window)",
    webPreferences: { nodeIntegration: true, contextIsolation: false },
  });

  petWindow.setMenuBarVisibility(false);
  dummyWindow.setMenuBarVisibility(false);

  await petWindow.loadFile(path.join(__dirname, "pet.html"));
  await dummyWindow.loadFile(path.join(__dirname, "dummy.html"));

  const helper = new NativeStyleHelper(path.join(__dirname, "native-window-style.ps1"));
  await helper.start();
  results.helper = { started: true };

  const petHwnd = readNativeWindowHandle(petWindow);
  const dummyHwnd = readNativeWindowHandle(dummyWindow);
  results.windows.pet = { hwnd: petHwnd };
  results.windows.dummy = { hwnd: dummyHwnd };

  // Windows/macOS: a tool window plus WS_EX_NOACTIVATE keeps the pet out of
  // alt-tab and out of the foreground while still receiving mouse input.
  const style = await helper.call("style", {
    hwnd: petHwnd,
    toolWindow: true,
    noActivate: true,
    clearTopmost: true,
  });
  results.windows.pet.exStyle = style.exStyle;

  petWindow.showInactive();
  dummyWindow.show();
  await delay(900);

  if (process.platform !== "win32") {
    markUnverified("all", "This spike only drives user32; run it on Windows to collect results.");
  }

  const petRect = parseRect((await helper.call("rect", { hwnd: petHwnd })).rect);
  const dummyRect = parseRect((await helper.call("rect", { hwnd: dummyHwnd })).rect);
  results.windows.pet.rect = petRect;
  results.windows.dummy.rect = dummyRect;

  if (!petRect || !dummyRect) {
    throw new Error("Could not read window rects.");
  }

  const overlap = intersectRects(petRect, dummyRect);
  if (!overlap) {
    throw new Error("The two prototype windows do not overlap; the click test is invalid.");
  }

  const overlapPoint = {
    x: Math.round(overlap.left + overlap.width / 2),
    y: Math.round(overlap.top + overlap.height / 2),
  };
  const petBlockCenter = blockPoint(petRect);

  results.windows.overlap = overlap;
  results.windows.overlapPoint = overlapPoint;
  results.windows.petBlockCenter = petBlockCenter;
  results.windows.overlapIsInsideBlock = pointInRect(overlapPoint.x, overlapPoint.y, petRect)
    ? pointInRect(
        overlapPoint.x - petRect.left,
        overlapPoint.y - petRect.top,
        {
          left: PET_BLOCK.x,
          top: PET_BLOCK.y,
          right: PET_BLOCK.x + PET_BLOCK.width,
          bottom: PET_BLOCK.y + PET_BLOCK.height,
        },
      )
    : false;

  // ---------------------------------------------------------------- z-order

  await helper.call("raise", { hwnd: dummyHwnd });
  await delay(350);

  const zDummyFirst = (await helper.call("compareZ", { hwndA: dummyHwnd, hwndB: petHwnd })).value;
  const hitDummyFirst = (await helper.call("windowFromPoint", overlapPoint)).hwnd;
  const dummyRoot = (await helper.call("root", { hwnd: dummyHwnd })).hwnd;
  const petRoot = (await helper.call("root", { hwnd: petHwnd })).hwnd;

  record("normalWindowAbovePet", zDummyFirst === 1 && hitDummyFirst === dummyRoot, {
    dummyAbovePet: zDummyFirst === 1,
    windowFromPoint: hitDummyFirst,
    dummyRoot,
    overlapPoint,
  });

  // A real injected click at the shared point, with the cursor restored.
  eventLog.pet.length = 0;
  eventLog.dummy.length = 0;
  const clickDown = await helper.call("click", overlapPoint);
  await delay(450);
  const dummyClickEvents = eventLog.dummy.filter((entry) => entry.type === "mousedown");

  record("clickGoesToFrontWindow", dummyClickEvents.length > 0, {
    injected: true,
    method: "SendInput mouse_event at the shared point, cursor restored afterwards",
    overlapPoint,
    dummyMouseDownEvents: dummyClickEvents.length,
    petMouseDownEvents: eventLog.pet.filter((entry) => entry.type === "mousedown").length,
    foregroundAfterClick: clickDown.foreground,
    dummyRoot,
  });

  await helper.call("raise", { hwnd: petHwnd });
  await delay(350);

  const zPetFirst = (await helper.call("compareZ", { hwndA: petHwnd, hwndB: dummyHwnd })).value;
  const hitPetFirst = (await helper.call("windowFromPoint", overlapPoint)).hwnd;
  const foregroundAfterRaise = (await helper.call("foreground")).hwnd;

  record("raiseNoActivatePutsPetOnTopWithoutFocus", zPetFirst === 1 && hitPetFirst === petRoot, {
    petAboveDummy: zPetFirst === 1,
    windowFromPoint: hitPetFirst,
    petRoot,
    overlapPoint,
  });

  record("raiseNoActivateDoesNotStealForeground", foregroundAfterRaise !== petRoot, {
    foregroundAfterRaise,
    petRoot,
    dummyRoot,
  });

  eventLog.pet.length = 0;
  eventLog.dummy.length = 0;
  const clickUp = await helper.call("click", overlapPoint);
  await delay(450);
  const petClickEvents = eventLog.pet.filter((entry) => entry.type === "mousedown");

  record("raisedPetReceivesClick", petClickEvents.length > 0, {
    injected: true,
    overlapPoint,
    petMouseDownEvents: petClickEvents.length,
    dummyMouseDownEvents: eventLog.dummy.filter((entry) => entry.type === "mousedown").length,
    foregroundAfterClick: clickUp.foreground,
  });

  record("petClickDoesNotActivatePet", clickUp.foreground !== petRoot, {
    foregroundAfterClick: clickUp.foreground,
    petRoot,
  });

  // ------------------------------------------------------------ taskbar test

  const taskbar = await helper.call("taskbar");
  const taskbarRect = parseRect(taskbar.rect);
  results.windows.taskbar = { hwnd: taskbar.hwnd, rect: taskbarRect };

  if (!taskbar.ok || !taskbarRect) {
    markUnverified("taskbarCoversPetWindow", "Shell_TrayWnd was not found; taskbar suppression stays unverified.");
    markUnverified("taskbarPixelNotOverpainted", "Shell_TrayWnd was not found; pixel comparison stays unverified.");
  } else {
    const taskbarPoint = {
      x: Math.round(taskbarRect.left + taskbarRect.width / 2),
      y: Math.round(taskbarRect.top + taskbarRect.height / 2),
    };
    results.windows.taskbarPoint = taskbarPoint;

    const controlPixel = (await helper.call("pixel", petBlockCenter)).pixel;
    const controlLooksLikePet = looksLikePetColor(controlPixel);

    record("pixelCaptureControl", controlLooksLikePet, {
      note: "The same capture path must see the pet block before the taskbar test can be trusted.",
      point: petBlockCenter,
      pixel: controlPixel,
      expectedPetColor: PET_BLOCK_COLOR,
    });

    const targetX = taskbarPoint.x - Math.round(PET_BLOCK.width * (petRect.width / PET_WINDOW.width) / 2);
    const targetY = taskbarPoint.y - Math.round(PET_BLOCK.height * (petRect.height / PET_WINDOW.height) / 2);
    await helper.call("move", { hwnd: petHwnd, x: targetX, y: targetY });
    await delay(450);

    const movedRect = parseRect((await helper.call("rect", { hwnd: petHwnd })).rect);
    const movedBlockPoint = blockPoint(movedRect);
    const taskbarPixel = (await helper.call("pixel", taskbarPoint)).pixel;
    const taskbarHit = (await helper.call("windowFromPoint", taskbarPoint)).hwnd;

    results.windows.petMovedRect = movedRect;
    results.windows.petMovedBlockPoint = movedBlockPoint;

    const petReportedOverTaskbar = pointInRect(taskbarPoint.x, taskbarPoint.y, movedRect);
    const pixelIsPet = looksLikePetColor(taskbarPixel);

    record(
      "taskbarPixelNotOverpainted",
      petReportedOverTaskbar && controlLooksLikePet && !pixelIsPet,
      {
        note: "The pet window rect covers the taskbar point, so the pixel must not show the pet block.",
        taskbarPoint,
        petRectCoversTaskbarPoint: petReportedOverTaskbar,
        pixelAtTaskbarPoint: taskbarPixel,
        petColorVisible: pixelIsPet,
      },
    );

    record("taskbarCoversPetWindow", taskbarHit !== petRoot, {
      windowFromPointAtTaskbar: taskbarHit,
      taskbarHwnd: taskbar.hwnd,
      petRoot,
    });

    await helper.call("move", { hwnd: petHwnd, x: petRect.left, y: petRect.top });
    await delay(300);
  }

  // -------------------------------------------------------------- focus test

  await helper.call("style", { hwnd: petHwnd, toolWindow: true, noActivate: false, clearTopmost: true });
  const focusPet = await helper.call("focus", { hwnd: petHwnd });
  const foregroundAfterFocusPet = (await helper.call("foreground")).hwnd;

  record("temporaryFocusCanActivatePet", foregroundAfterFocusPet === petRoot, {
    helperReportedSuccess: focusPet.ok,
    method: focusPet.method,
    foregroundAfterFocus: foregroundAfterFocusPet,
    petRoot,
  });

  const focusDummyBack = await helper.call("focus", { hwnd: dummyHwnd });
  const foregroundAfterDummyFocus = (await helper.call("foreground")).hwnd;
  await delay(1_500);
  const foregroundAfterSettling = (await helper.call("foreground")).hwnd;

  record(
    "focusCanBeTakenBackAndDoesNotBounce",
    foregroundAfterDummyFocus === dummyRoot && foregroundAfterSettling === dummyRoot,
    {
      helperReportedSuccess: focusDummyBack.ok,
      method: focusDummyBack.method,
      foregroundAfterDummyFocus,
      foregroundAfterSettling,
      dummyRoot,
      petRoot,
      waitMs: 1_500,
    },
  );

  await helper.call("style", { hwnd: petHwnd, toolWindow: true, noActivate: true, clearTopmost: true });

  // ------------------------------------------------------------------ clean up

  await helper.call("style", {
    hwnd: petHwnd,
    toolWindow: false,
    noActivate: false,
    clearTopmost: true,
  });
  await helper.stop();
  results.helper.stopped = true;
  results.windows.eventLog = eventLog;
}

function finalize() {
  const checks = Object.values(results.checks);
  results.summary.passed = checks.filter((check) => check.verified && check.pass).length;
  results.summary.failed = checks.filter((check) => check.verified && check.pass === false).length;
  results.summary.unverified = checks.filter((check) => !check.verified).length;
  results.generatedAt = new Date().toISOString();

  fs.writeFileSync(RESULTS_PATH, `${JSON.stringify(results, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(results, null, 2));
}

ipcMain.on("pet-window-event", (_event, payload) => {
  const bucket = payload && payload.window === "pet" ? eventLog.pet : eventLog.dummy;
  bucket.push({ type: payload.type, at: Date.now() });
});

app.whenReady().then(async () => {
  let exitCode = 0;
  try {
    await run();
  } catch (error) {
    results.errors.push({ kind: "run", message: error && error.message ? error.message : String(error) });
    exitCode = 1;
  }

  finalize();
  app.exit(exitCode);
});
