"use strict";

const path = require("node:path");
const { spawn } = require("node:child_process");

const DEFAULT_HELPER_PATH = path.join(
  __dirname,
  "..",
  "scripts",
  "native-window-helper.ps1"
);

function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function normalizeRect(value) {
  if (!value || typeof value !== "object") return null;

  if (
    isFiniteNumber(value.left) &&
    isFiniteNumber(value.top) &&
    isFiniteNumber(value.right) &&
    isFiniteNumber(value.bottom)
  ) {
    const left = Math.round(value.left);
    const top = Math.round(value.top);
    const right = Math.round(value.right);
    const bottom = Math.round(value.bottom);
    if (right <= left || bottom <= top) return null;
    return {
      left,
      top,
      right,
      bottom,
      width: right - left,
      height: bottom - top
    };
  }

  if (
    isFiniteNumber(value.x) &&
    isFiniteNumber(value.y) &&
    isFiniteNumber(value.width) &&
    isFiniteNumber(value.height)
  ) {
    const left = Math.round(value.x);
    const top = Math.round(value.y);
    const width = Math.round(value.width);
    const height = Math.round(value.height);
    if (width <= 0 || height <= 0) return null;
    return {
      left,
      top,
      right: left + width,
      bottom: top + height,
      width,
      height
    };
  }

  return null;
}

function computeTaskbarClip(windowRect, taskbarRect) {
  const window = normalizeRect(windowRect);
  const taskbar = normalizeRect(taskbarRect);
  if (!window || !taskbar) return null;

  const left = Math.max(taskbar.left, window.left) - window.left;
  const top = Math.max(taskbar.top, window.top) - window.top;
  const right = Math.min(taskbar.right, window.right) - window.left;
  const bottom = Math.min(taskbar.bottom, window.bottom) - window.top;
  const hasOverlap = right > left && bottom > top;

  return {
    window,
    taskbar,
    hasOverlap,
    cut: hasOverlap
      ? {
          left,
          top,
          right,
          bottom,
          width: right - left,
          height: bottom - top
        }
      : null
  };
}

function readNativeWindowHandle(browserWindow) {
  if (!browserWindow || typeof browserWindow.getNativeWindowHandle !== "function") {
    throw new Error("BrowserWindow.getNativeWindowHandle is unavailable.");
  }

  const rawHandle = browserWindow.getNativeWindowHandle();
  if (!Buffer.isBuffer(rawHandle) && !(rawHandle instanceof Uint8Array)) {
    throw new Error("Unsupported native window handle type.");
  }
  const handle = Buffer.isBuffer(rawHandle) ? rawHandle : Buffer.from(rawHandle);

  if (handle.length === 8) {
    return handle.readBigUInt64LE(0).toString();
  }

  if (handle.length === 4) {
    return String(handle.readUInt32LE(0));
  }

  throw new Error(`Unsupported native window handle length: ${handle.length}`);
}

function toPhysical(value, scaleFactor) {
  const number = Number(value);
  const scale = Number(scaleFactor);
  if (!Number.isFinite(number)) return null;
  if (!Number.isFinite(scale) || scale <= 0) return Math.round(number);
  return Math.round(number * scale);
}

class NativeWindowClient {
  constructor(options = {}) {
    this.platform = options.platform || process.platform;
    this.helperPath = options.helperPath || DEFAULT_HELPER_PATH;
    this.spawnImpl = options.spawnImpl || spawn;
    this.logger = options.logger || console;
    this.readyTimeoutMs = Number(options.readyTimeoutMs) || 10000;
    this.requestTimeoutMs = Number(options.requestTimeoutMs) || 10000;
    this.stopTimeoutMs = Number(options.stopTimeoutMs) || 1500;

    this.child = null;
    this.ready = false;
    this.starting = null;
    this.exited = false;
    this.stopping = null;
    this.pending = new Map();
    this.stdoutBuffer = "";
    this.stderrBuffer = "";
    this.sequence = 0;
    this.helperInfo = null;
    this.lastError = null;
    this.metrics = {
      spawnCount: 0,
      backpressureEvents: 0,
      writeErrors: 0,
      protocolErrors: 0,
      exits: 0
    };
  }

  isSupported() {
    return this.platform === "win32";
  }

  start() {
    if (!this.isSupported()) {
      return Promise.reject(new Error("Native window control is only supported on Windows."));
    }

    if (this.ready && this.child && !this.child.killed && this.child.exitCode === null) {
      return Promise.resolve(this);
    }

    if (this.starting) return this.starting;

    if (this.exited) {
      return Promise.reject(new Error("Native window helper has already exited."));
    }

    this.starting = new Promise((resolve, reject) => {
      let settled = false;
      const child = this.spawnImpl(
        "powershell.exe",
        [
          "-NoLogo",
          "-NoProfile",
          "-NonInteractive",
          "-ExecutionPolicy",
          "Bypass",
          "-File",
          this.helperPath
        ],
        {
          cwd: path.dirname(this.helperPath),
          windowsHide: true,
          stdio: ["pipe", "pipe", "pipe"]
        }
      );

      this.child = child;
      this.metrics.spawnCount += 1;

      const finish = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) reject(error);
        else resolve(this);
      };

      const timer = setTimeout(() => {
        finish(
          new Error(
            `Timed out waiting for native window helper readiness after ${this.readyTimeoutMs} ms.`
          )
        );
      }, this.readyTimeoutMs);

      child.stdout.on("data", (chunk) => {
        this.stdoutBuffer += chunk.toString("utf8");
        const lines = this.stdoutBuffer.split(/\r?\n/);
        this.stdoutBuffer = lines.pop() || "";
        for (const line of lines) {
          this._handleLine(line, finish);
        }
      });

      child.stderr.on("data", (chunk) => {
        this.stderrBuffer = (this.stderrBuffer + chunk.toString("utf8")).slice(
          -4000
        );
      });

      child.on("error", (error) => {
        this.lastError = error;
        finish(error);
      });

      child.on("exit", (code, signal) => {
        this.metrics.exits += 1;
        this.ready = false;
        this.child = null;
        this.starting = null;
        this.exited = true;

        const error = new Error(
          `Native window helper exited (code=${code}, signal=${signal}). ${this.stderrBuffer}`.trim()
        );
        this.lastError = error;
        finish(error);
        this._rejectPending(error);
      });
    });

    this.starting = this.starting
      .catch((error) => {
        this.starting = null;
        throw error;
      });

    return this.starting;
  }

  _handleLine(line, finishReady) {
    const value = String(line || "").trim();
    if (!value) return;

    let message;
    try {
      message = JSON.parse(value);
    } catch (error) {
      this.metrics.protocolErrors += 1;
      this.lastError = error;
      this.logger.warn?.("[native-window] invalid helper output", value);
      return;
    }

    if (message.kind === "ready") {
      this.ready = true;
      this.helperInfo = message;
      if (typeof finishReady === "function") finishReady();
      return;
    }

    const entry = this.pending.get(message.id);
    if (entry) {
      this.pending.delete(message.id);
      clearTimeout(entry.timer);
      if (message.kind === "error") {
        const error = new Error(
          `${message.op || "native operation"} failed: ${message.message || "unknown error"}`
        );
        error.code = "NATIVE_WINDOW_OPERATION_FAILED";
        error.details = message;
        entry.reject(error);
      } else {
        entry.resolve(message);
      }
      return;
    }

    if (message.kind === "error") {
      this.metrics.protocolErrors += 1;
      this.lastError = message;
      this.logger.warn?.("[native-window] helper reported an error", message);
    }
  }

  _writeLine(line, waitForAck, id) {
    const child = this.child;
    if (!child || !child.stdin || !child.stdin.writable || child.exitCode !== null) {
      return Promise.reject(new Error("Native window helper is not running."));
    }

    return new Promise((resolve, reject) => {
      let accepted = false;
      accepted = child.stdin.write(line, (error) => {
        if (error) {
          this.metrics.writeErrors += 1;
          this.lastError = error;
          reject(error);
          return;
        }
        resolve({
          id,
          accepted,
          backpressure: !accepted
        });
      });

      if (!accepted) {
        this.metrics.backpressureEvents += 1;
      }
    });
  }

  async call(op, fields = {}) {
    await this.start();

    this.sequence += 1;
    const id = this.sequence;
    const request = {
      id,
      op,
      ack: true,
      ...fields
    };

    const response = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Native window helper timed out on op "${op}".`));
      }, this.requestTimeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
    });

    try {
      await this._writeLine(`${JSON.stringify(request)}\n`, true, id);
    } catch (error) {
      const entry = this.pending.get(id);
      if (entry) {
        this.pending.delete(id);
        clearTimeout(entry.timer);
        entry.reject(error);
      }
      return response.catch(() => {
        throw error;
      });
    }

    return response;
  }

  async send(op, fields = {}) {
    await this.start();

    this.sequence += 1;
    const id = this.sequence;
    return this._writeLine(
      `${JSON.stringify({ id, op, ack: false, ...fields })}\n`,
      false,
      id
    );
  }

  async applyPetWindowStyle(hwnd) {
    const result = await this.call("applyPetWindowStyle", { hwnd });
    if (result.ok === false) {
      throw new Error(result.error || "Applying the pet window style failed.");
    }
    return result;
  }

  async setTopmost(hwnd, on) {
    const result = await this.call("setTopmost", {
      hwnd,
      on: Boolean(on)
    });
    if (result.ok === false) {
      throw new Error(result.error || "Changing the topmost state failed.");
    }
    return result;
  }

  async setNoActivate(hwnd, on) {
    const result = await this.call("setNoActivate", {
      hwnd,
      on: Boolean(on)
    });
    if (result.ok === false) {
      throw new Error(result.error || "Changing no-activate state failed.");
    }
    return result;
  }

  async raise(hwnd) {
    const result = await this.call("raise", { hwnd });
    if (result.ok === false) {
      throw new Error(result.error || "Raising the window failed.");
    }
    return result;
  }

  async focus(hwnd) {
    const result = await this.call("focus", { hwnd });
    if (result.ok === false) {
      throw new Error(result.error || "Focusing the window failed.");
    }
    return result;
  }

  async move(hwnd, physicalX, physicalY) {
    const x = Math.round(Number(physicalX));
    const y = Math.round(Number(physicalY));
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      throw new Error("move expects finite physical coordinates.");
    }
    return this.send("move", { hwnd, x, y });
  }

  async excludeTaskbar(hwnd, taskbarRect) {
    const rect = normalizeRect(taskbarRect);
    if (!rect) {
      throw new Error("excludeTaskbar expects a finite taskbar rectangle.");
    }

    const result = await this.call("excludeTaskbar", {
      hwnd,
      taskbarLeft: rect.left,
      taskbarTop: rect.top,
      taskbarRight: rect.right,
      taskbarBottom: rect.bottom
    });
    if (result.ok === false) {
      throw new Error(result.error || "Excluding the taskbar from the window failed.");
    }
    return result;
  }

  async clearRegion(hwnd) {
    const result = await this.call("clearRegion", { hwnd });
    if (result.ok === false) {
      throw new Error(result.error || "Clearing the window region failed.");
    }
    return result;
  }

  async getTaskbarRect() {
    const result = await this.call("getTaskbarRect");
    if (result.ok === false || !result.rect) return null;
    return normalizeRect(result.rect);
  }

  async getPrimaryMetrics() {
    const result = await this.call("getPrimaryMetrics");
    if (result.ok === false) return null;

    const bounds = normalizeRect(result.bounds);
    const workArea = normalizeRect(result.workArea);
    if (!bounds || !workArea) return null;

    const dpiX = Number(result.dpi?.x) || 96;
    const dpiY = Number(result.dpi?.y) || 96;
    const scaleFactor =
      Number.isFinite(Number(result.scaleFactor)) && Number(result.scaleFactor) > 0
        ? Number(result.scaleFactor)
        : dpiX / 96;

    return {
      bounds,
      workArea,
      dpiX,
      dpiY,
      scaleFactor
    };
  }

  _rejectPending(error) {
    for (const [id, entry] of this.pending) {
      this.pending.delete(id);
      clearTimeout(entry.timer);
      entry.reject(error);
    }
  }

  stop() {
    if (this.stopping) return this.stopping;

    const child = this.child;
    if (!child || child.exitCode !== null || child.killed) {
      return Promise.resolve();
    }

    this.stopping = new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      };

      const timer = setTimeout(() => {
        try {
          child.kill();
        } catch {
          // The helper may already be gone.
        }
        finish();
      }, this.stopTimeoutMs);

      child.once("exit", finish);

      try {
        child.stdin.write(
          `${JSON.stringify({ id: ++this.sequence, op: "exit", ack: false })}\n`
        );
      } catch {
        // stdin.end below remains the fallback.
      }

      if (child.stdin.writable) child.stdin.end();
    });

    return this.stopping;
  }
}

let singleton = null;

function createNativeWindowClient(options = {}) {
  return new NativeWindowClient(options);
}

function getNativeWindowClient(options = {}) {
  if (!singleton) singleton = createNativeWindowClient(options);
  return singleton;
}

function resetNativeWindowClientForTests() {
  singleton = null;
}

function isNativeWindowControlSupported(platform = process.platform) {
  return platform === "win32";
}

module.exports = {
  NativeWindowClient,
  createNativeWindowClient,
  getNativeWindowClient,
  resetNativeWindowClientForTests,
  isNativeWindowControlSupported,
  readNativeWindowHandle,
  normalizeRect,
  computeTaskbarClip,
  toPhysical
};
