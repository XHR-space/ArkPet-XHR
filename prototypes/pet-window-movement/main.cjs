const { app, BrowserWindow, screen } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

const WINDOW_WIDTH = 260;
const WINDOW_HEIGHT = 340;
const TARGET_FPS = 60;
const FRAME_NS = 1_000_000_000n / BigInt(TARGET_FPS);
const HORIZONTAL_SPEED_DIP_PER_SECOND = 360;
const HELPER_READY_TIMEOUT_MS = 8_000;
const HELPER_EXIT_TIMEOUT_MS = 1_500;

function readArg(name, fallback) {
  const prefix = `--${name}=`;
  const match = process.argv.find((argument) => argument.startsWith(prefix));
  return match ? match.slice(prefix.length) : fallback;
}

function parsePositiveNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const mode = readArg("mode", "electron");
const durationSeconds = parsePositiveNumber(readArg("duration", "15"), 15);
const topmost = readArg("topmost", "0") === "1";

if (mode !== "electron" && mode !== "native") {
  console.error(`Unsupported --mode="${mode}". Use --mode=electron or --mode=native.`);
  process.exitCode = 2;
  app.quit();
}

let mainWindow = null;
let helperProcess = null;
let helperReady = false;
let helperShuttingDown = false;
let helperBackpressureEvents = 0;
let helperErrorCount = 0;
let helperLastError = null;
let movementTimer = null;
let finishTimer = null;
let finished = false;
let samplesNs = [];
let skippedLateFrames = 0;
let scheduledFrameCount = 0;
let measurementStartNs = 0n;
let measurementEndNs = 0n;

function percentile(sortedValues, ratio) {
  if (sortedValues.length === 0) {
    return 0;
  }

  const index = (sortedValues.length - 1) * ratio;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) {
    return sortedValues[lower];
  }

  const weight = index - lower;
  return sortedValues[lower] * (1 - weight) + sortedValues[upper] * weight;
}

function summarizeMetrics() {
  const milliseconds = samplesNs.map((value) => Number(value) / 1_000_000);
  const sorted = [...milliseconds].sort((left, right) => left - right);
  const totalMs = milliseconds.reduce((sum, value) => sum + value, 0);
  const elapsedSeconds = Number(measurementEndNs - measurementStartNs) / 1_000_000_000;

  return {
    mode,
    frames: milliseconds.length,
    scheduledFrames: scheduledFrameCount,
    skippedLateFrames,
    elapsedSeconds: Number(elapsedSeconds.toFixed(3)),
    fps: elapsedSeconds > 0 ? Number((milliseconds.length / elapsedSeconds).toFixed(2)) : 0,
    moveCall: {
      avgMs: milliseconds.length > 0 ? Number((totalMs / milliseconds.length).toFixed(4)) : 0,
      p50Ms: Number(percentile(sorted, 0.5).toFixed(4)),
      p95Ms: Number(percentile(sorted, 0.95).toFixed(4)),
      maxMs: sorted.length > 0 ? Number(sorted[sorted.length - 1].toFixed(4)) : 0,
    },
    nativeHelper:
      mode === "native"
        ? {
            backpressureEvents: helperBackpressureEvents,
            errorCount: helperErrorCount,
            lastError: helperLastError,
          }
        : null,
  };
}

function writeResults() {
  const metrics = summarizeMetrics();
  const resultsPath = path.join(__dirname, `results-${mode}.json`);
  fs.writeFileSync(resultsPath, `${JSON.stringify(metrics, null, 2)}\n`, "utf8");

  console.log(JSON.stringify({ ...metrics, resultsPath }, null, 2));
  return resultsPath;
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

function startNativeHelper(window) {
  return new Promise((resolve, reject) => {
    const helperPath = path.join(__dirname, "native-window-mover.ps1");
    const child = spawn(
      "powershell.exe",
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        helperPath,
      ],
      {
        cwd: __dirname,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      },
    );

    helperProcess = child;
    let stdoutBuffer = "";
    let stderrBuffer = "";
    let settled = false;

    const settleReject = (error) => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(readyTimeout);
      reject(error);
    };

    const readyTimeout = setTimeout(() => {
      settleReject(new Error("Timed out waiting for native window helper readiness."));
    }, HELPER_READY_TIMEOUT_MS);

    child.stdout.on("data", (chunk) => {
      stdoutBuffer += chunk.toString("utf8");
      const lines = stdoutBuffer.split(/\r?\n/);
      stdoutBuffer = lines.pop() ?? "";

      for (const line of lines) {
        if (!line.trim()) {
          continue;
        }

        try {
          const message = JSON.parse(line);
          if (message.kind === "ready") {
            helperReady = true;
            if (!settled) {
              settled = true;
              clearTimeout(readyTimeout);
              resolve();
            }
            continue;
          }

          if (message.kind === "error") {
            helperErrorCount += 1;
            helperLastError = message;
            console.error("Native window helper error:", message);
          }
        } catch (error) {
          helperErrorCount += 1;
          helperLastError = {
            kind: "protocol",
            message: `Invalid helper output: ${line}`,
          };
          console.error("Native window helper emitted invalid JSON:", line, error);
        }
      }
    });

    child.stderr.on("data", (chunk) => {
      stderrBuffer += chunk.toString("utf8");
      if (stderrBuffer.length > 4_000) {
        stderrBuffer = stderrBuffer.slice(-4_000);
      }
    });

    child.on("error", (error) => {
      settleReject(error);
    });

    child.on("exit", (code, signal) => {
      const wasExpected = helperShuttingDown;
      helperProcess = null;
      helperReady = false;

      if (!settled) {
        settleReject(
          new Error(
            `Native window helper exited before ready (code=${code}, signal=${signal}): ${stderrBuffer}`,
          ),
        );
        return;
      }

      if (!wasExpected && !finished) {
        helperErrorCount += 1;
        helperLastError = {
          kind: "exit",
          code,
          signal,
          stderr: stderrBuffer,
        };
        console.error("Native window helper exited unexpectedly:", helperLastError);
      }
    });

    const hwnd = readNativeWindowHandle(window);
    const initLine = `${JSON.stringify({ kind: "init", hwnd })}\n`;
    child.stdin.write(initLine, (error) => {
      if (error) {
        settleReject(error);
      }
    });
  });
}

async function stopNativeHelper() {
  const child = helperProcess;
  if (!child) {
    return;
  }

  helperShuttingDown = true;
  if (helperReady && child.stdin.writable) {
    child.stdin.write(`${JSON.stringify({ kind: "exit" })}\n`);
  }

  if (child.stdin.writable) {
    child.stdin.end();
  }

  await new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timeout);
      resolve();
    };

    const timeout = setTimeout(() => {
      if (helperProcess === child) {
        child.kill();
      }
      finish();
    }, HELPER_EXIT_TIMEOUT_MS);

    child.once("exit", finish);
  });

  helperProcess = null;
  helperReady = false;
}

function moveWindow(moveContext) {
  const startNs = process.hrtime.bigint();

  if (mode === "electron") {
    mainWindow.setBounds(
      {
        x: Math.round(moveContext.dipX),
        y: moveContext.dipY,
        width: WINDOW_WIDTH,
        height: WINDOW_HEIGHT,
      },
      false,
    );
  } else {
    if (!helperReady || !helperProcess || !helperProcess.stdin.writable) {
      throw new Error("Native window helper is not ready.");
    }

    const line = `${JSON.stringify({
      kind: "move",
      hwnd: moveContext.hwnd,
      x: Math.round(moveContext.dipX * moveContext.scaleFactor),
      y: Math.round(moveContext.dipY * moveContext.scaleFactor),
    })}\n`;

    const accepted = helperProcess.stdin.write(line, (error) => {
      if (!error) {
        return;
      }

      helperErrorCount += 1;
      helperLastError = {
        kind: "stdin",
        message: error.message,
      };
    });

    if (!accepted) {
      helperBackpressureEvents += 1;
    }
  }

  return process.hrtime.bigint() - startNs;
}

function scheduleMovement(moveContext) {
  const dipPerFrame = HORIZONTAL_SPEED_DIP_PER_SECOND / TARGET_FPS;
  let direction = 1;
  let nextDeadlineNs = process.hrtime.bigint() + FRAME_NS;
  measurementStartNs = process.hrtime.bigint();

  const tick = () => {
    if (finished) {
      return;
    }

    const nowNs = process.hrtime.bigint();
    if (nowNs >= nextDeadlineNs) {
      try {
        samplesNs.push(moveWindow(moveContext));
      } catch (error) {
        helperErrorCount += 1;
        helperLastError = {
          kind: "runtime",
          message: error.message,
        };
        console.error("Window movement failed:", error);
        finish().catch((finishError) => {
          console.error(finishError);
          app.exit(1);
        });
        return;
      }
      scheduledFrameCount += 1;

      moveContext.dipX += direction * dipPerFrame;
      if (moveContext.dipX >= moveContext.maxX) {
        moveContext.dipX = moveContext.maxX;
        direction = -1;
      } else if (moveContext.dipX <= moveContext.minX) {
        moveContext.dipX = moveContext.minX;
        direction = 1;
      }

      const afterMoveNs = process.hrtime.bigint();
      let candidateDeadlineNs = nextDeadlineNs + FRAME_NS;
      if (candidateDeadlineNs <= afterMoveNs) {
        const lateFrames = Number((afterMoveNs - candidateDeadlineNs) / FRAME_NS) + 1;
        skippedLateFrames += lateFrames;
        candidateDeadlineNs = afterMoveNs + FRAME_NS;
      }
      nextDeadlineNs = candidateDeadlineNs;
    }

    const delayMs = Math.max(0, Number(nextDeadlineNs - process.hrtime.bigint()) / 1_000_000);
    movementTimer = setTimeout(tick, Math.min(delayMs, 25));
  };

  tick();
}

async function finish() {
  if (finished) {
    return;
  }

  finished = true;
  measurementEndNs = process.hrtime.bigint();

  if (movementTimer) {
    clearTimeout(movementTimer);
    movementTimer = null;
  }

  if (finishTimer) {
    clearTimeout(finishTimer);
    finishTimer = null;
  }

  try {
    await stopNativeHelper();
  } catch (error) {
    console.error("Failed to stop native window helper cleanly:", error);
  }

  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.destroy();
  }

  try {
    writeResults();
  } finally {
    app.quit();
  }
}

async function run() {
  const primaryDisplay = screen.getPrimaryDisplay();
  const workArea = primaryDisplay.workArea;
  const scaleFactor = primaryDisplay.scaleFactor;
  const minX = workArea.x + 40;
  const maxX = Math.max(minX, workArea.x + workArea.width - WINDOW_WIDTH - 40);
  const y = workArea.y + Math.max(40, Math.round((workArea.height - WINDOW_HEIGHT) / 2));
  const startX = Math.round((minX + maxX) / 2);

  mainWindow = new BrowserWindow({
    x: startX,
    y,
    width: WINDOW_WIDTH,
    height: WINDOW_HEIGHT,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    hasShadow: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    closable: true,
    skipTaskbar: true,
    focusable: false,
    alwaysOnTop: topmost,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });

  mainWindow.setIgnoreMouseEvents(true, { forward: true });
  await mainWindow.loadFile(path.join(__dirname, "index.html"));
  mainWindow.showInactive();

  const moveContext = {
    dipX: startX,
    dipY: y,
    minX,
    maxX,
    scaleFactor,
    hwnd: null,
  };

  if (mode === "native") {
    await startNativeHelper(mainWindow);
    moveContext.hwnd = readNativeWindowHandle(mainWindow);
  }

  await new Promise((resolve) => setTimeout(resolve, 250));
  scheduleMovement(moveContext);
  finishTimer = setTimeout(() => {
    finish().catch((error) => {
      console.error(error);
      app.exit(1);
    });
  }, durationSeconds * 1_000);
}

app.whenReady().then(run).catch((error) => {
  console.error(error);
  app.exit(1);
});

