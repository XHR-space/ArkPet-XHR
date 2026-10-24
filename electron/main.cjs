const {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  nativeImage,
  Notification,
  protocol,
  screen,
  session,
  shell
} = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const { execFile, spawn, spawnSync } = require("node:child_process");
const sharp = require("sharp");
const { pathToFileURL } = require("node:url");
const { Store, id } = require("./store.cjs");
const ai = require("./ai.cjs");
const { LocalInferenceManager } = require("./local-inference.cjs");
const { VoiceAgent } = require("./voice-agent.cjs");

app.setName("ArkPet");

function softwareRootPath() {
  return app.isPackaged ? path.dirname(process.execPath) : path.join(__dirname, "..");
}

function softwareDataRootPath() {
  return path.join(softwareRootPath(), "data");
}

function preferredUserDataPath() {
  return path.join(softwareDataRootPath(), "user-data");
}

function canWriteDirectory(directory) {
  try {
    fs.mkdirSync(directory, { recursive: true });
    const probe = path.join(directory, `.write-test-${process.pid}`);
    fs.writeFileSync(probe, "ok", "utf8");
    fs.rmSync(probe, { force: true });
    return true;
  } catch {
    return false;
  }
}

function legacyUserDataCandidates() {
  const appDataRoot = process.env.APPDATA || app.getPath("appData");
  const developer = process.env.USERPROFILE || "";
  return [
    path.join(softwareRootPath(), "user-data"),
    path.join(appDataRoot, "XHR-cpu23", "DeskPetStudio", "data"),
    path.join(appDataRoot, "XHR-cpu23", "DeskPetStudio", "data", "user-data"),
    path.join(app.getPath("appData"), "desk-companion-studio"),
    developer
      ? path.join(developer, "Desktop", "Codex工作文件", "桌宠", "user-data")
      : ""
  ].filter(Boolean);
}

function migrateLegacyUserData(targetPath) {
  if (fs.existsSync(path.join(targetPath, "desk-pet-state.json"))) return false;
  for (const candidate of legacyUserDataCandidates()) {
    if (
      path.resolve(candidate) === path.resolve(targetPath) ||
      !fs.existsSync(path.join(candidate, "desk-pet-state.json"))
    ) {
      continue;
    }
    try {
      if (
        path.resolve(candidate) ===
        path.resolve(path.join(softwareRootPath(), "user-data"))
      ) {
        fs.mkdirSync(path.dirname(targetPath), { recursive: true });
        fs.renameSync(candidate, targetPath);
        return true;
      }
      fs.mkdirSync(targetPath, { recursive: true });
      fs.cpSync(candidate, targetPath, {
        recursive: true,
        force: false,
        errorOnExist: false
      });
      return true;
    } catch {
      // Try the next legacy location.
    }
  }
  return false;
}

function resolveUserDataPath() {
  const preferred = preferredUserDataPath();
  if (canWriteDirectory(softwareDataRootPath())) {
    migrateLegacyUserData(preferred);
    fs.mkdirSync(preferred, { recursive: true });
    return preferred;
  }
  const fallback = path.join(
    app.getPath("appData"),
    "XHR-cpu23",
    "DeskPetStudio",
    "data",
    "user-data"
  );
  fs.mkdirSync(fallback, { recursive: true });
  migrateLegacyUserData(fallback);
  return fallback;
}

const UPDATE_REPOSITORY = "XHR-cpu123/ArkPet-XHR";
const MODULE_REGISTRY_REPOSITORY = "XHR-cpu123/ArkPet-XHR";
const MODULE_REGISTRY_BRANCH = "main";
const MODULE_REGISTRY_URL = `https://raw.githubusercontent.com/${MODULE_REGISTRY_REPOSITORY}/${MODULE_REGISTRY_BRANCH}/module-registry/registry.json`;
const LOCAL_MODULE_REGISTRY_ROOT = path.join(__dirname, "..", "module-registry");
let updateCheckPromise = null;
let updateLaunchStarted = false;
let moduleRegistryCache = { data: null, fetchedAt: 0 };
const updateRuntime = {
  status: "idle",
  currentVersion: app.getVersion(),
  latestVersion: "",
  progress: 0,
  assetName: "",
  releaseUrl: "",
  downloadedPath: "",
  portable: false,
  error: "",
  checkedAt: ""
};

function publishUpdateStatus(patch = {}) {
  Object.assign(updateRuntime, patch);
  if (controlWindow && !controlWindow.isDestroyed()) {
    controlWindow.webContents.send("update:status", { ...updateRuntime });
  }
  return { ...updateRuntime };
}

function updateVersionParts(value) {
  return String(value || "")
    .replace(/^v/i, "")
    .split(/[.+-]/)
    .slice(0, 3)
    .map((part) => Number.parseInt(part, 10) || 0);
}

function isNewerVersion(latest, current) {
  const left = updateVersionParts(latest);
  const right = updateVersionParts(current);
  for (let index = 0; index < 3; index += 1) {
    if (left[index] > right[index]) return true;
    if (left[index] < right[index]) return false;
  }
  return false;
}

function selectUpdateAsset(release) {
  const assets = Array.isArray(release.assets) ? release.assets : [];
  if (process.platform === "win32") {
    const portable = Boolean(process.env.PORTABLE_EXECUTABLE_DIR);
    const token = portable ? "portable" : "setup";
    return {
      portable,
      asset: assets.find(
        (item) =>
          /\.exe$/i.test(item.name) &&
          item.name.toLowerCase().includes(token)
      )
    };
  }
  if (process.platform === "darwin") {
    const arch = process.arch === "arm64" ? "arm64" : "x64";
    return {
      portable: false,
      asset: assets.find(
        (item) => /\.dmg$/i.test(item.name) && item.name.includes(arch)
      )
    };
  }
  return { portable: false, asset: null };
}

async function downloadUpdateAsset(asset) {
  const cacheDirectory = path.join(app.getPath("temp"), "arkpet-updates");
  fs.mkdirSync(cacheDirectory, { recursive: true });
  const targetPath = path.join(cacheDirectory, path.basename(asset.name));
  const response = await fetch(asset.browser_download_url, {
    redirect: "follow",
    headers: { "User-Agent": "ArkPet-XHR-Updater" }
  });
  if (!response.ok || !response.body) {
    throw new Error(`下载更新失败：HTTP ${response.status}`);
  }
  const totalBytes = Number(response.headers.get("content-length") || 0);
  const reader = response.body.getReader();
  const handle = await fs.promises.open(targetPath, "w");
  const hash = crypto.createHash("sha256");
  let receivedBytes = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value);
      receivedBytes += chunk.length;
      hash.update(chunk);
      let offset = 0;
      while (offset < chunk.length) {
        const { bytesWritten } = await handle.write(
          chunk,
          offset,
          chunk.length - offset
        );
        if (!bytesWritten) throw new Error("写入更新包失败。");
        offset += bytesWritten;
      }
      publishUpdateStatus({
        status: "downloading",
        progress: totalBytes
          ? Math.min(99, Math.round((receivedBytes / totalBytes) * 100))
          : 0
      });
    }
  } finally {
    await handle.close();
  }
  const expectedDigest = String(asset.digest || "").toLowerCase();
  if (expectedDigest.startsWith("sha256:")) {
    const actualDigest = `sha256:${hash.digest("hex")}`;
    if (actualDigest !== expectedDigest) {
      fs.rmSync(targetPath, { force: true });
      throw new Error("更新包校验失败，已取消安装。");
    }
  }
  publishUpdateStatus({ progress: 100 });
  return targetPath;
}

async function checkForUpdates(options = {}) {
  if (updateCheckPromise) return updateCheckPromise;
  if (!app.isPackaged && !options.force) {
    return publishUpdateStatus({
      status: "development",
      error: "",
      checkedAt: new Date().toISOString()
    });
  }
  updateCheckPromise = (async () => {
    publishUpdateStatus({
      status: "checking",
      progress: 0,
      error: "",
      checkedAt: new Date().toISOString()
    });
    try {
      const response = await fetch(
        `https://api.github.com/repos/${UPDATE_REPOSITORY}/releases/latest`,
        {
          headers: {
            "User-Agent": "ArkPet-XHR-Updater",
            Accept: "application/vnd.github+json"
          },
          signal: AbortSignal.timeout(15000)
        }
      );
      if (!response.ok) throw new Error(`检查更新失败：HTTP ${response.status}`);
      const release = await response.json();
      const latestVersion = String(release.tag_name || "").replace(/^v/i, "");
      if (!latestVersion || !isNewerVersion(latestVersion, app.getVersion())) {
        return publishUpdateStatus({
          status: "up-to-date",
          latestVersion,
          releaseUrl: String(release.html_url || ""),
          checkedAt: new Date().toISOString()
        });
      }
      const selection = selectUpdateAsset(release);
      if (!selection.asset) {
        throw new Error("新版本没有适用于当前系统的安装包。");
      }
      publishUpdateStatus({
        status: "downloading",
        latestVersion,
        releaseUrl: String(release.html_url || ""),
        assetName: selection.asset.name,
        portable: selection.portable,
        progress: 0
      });
      const downloadedPath = await downloadUpdateAsset(selection.asset);
      return publishUpdateStatus({
        status: "ready",
        downloadedPath,
        progress: 100,
        checkedAt: new Date().toISOString()
      });
    } catch (error) {
      return publishUpdateStatus({
        status: "error",
        error: error?.message || "检查更新失败。",
        checkedAt: new Date().toISOString()
      });
    } finally {
      updateCheckPromise = null;
    }
  })();
  return updateCheckPromise;
}

function launchDownloadedUpdate() {
  if (updateLaunchStarted) return false;
  if (updateRuntime.status !== "ready" || !updateRuntime.downloadedPath) {
    return false;
  }
  if (!fs.existsSync(updateRuntime.downloadedPath)) {
    publishUpdateStatus({ status: "error", error: "更新文件已不存在。" });
    return false;
  }
  updateLaunchStarted = true;
  if (process.platform === "darwin") {
    void shell.openPath(updateRuntime.downloadedPath);
    return true;
  }
  if (updateRuntime.portable && process.platform === "win32") {
    const targetExe =
      process.env.PORTABLE_EXECUTABLE_FILE || process.execPath;
    const scriptPath = path.join(
      app.getPath("temp"),
      `arkpet-update-${Date.now()}.cmd`
    );
    const script = [
      "@echo off",
      "setlocal",
      ":wait",
      `tasklist /FI "PID eq ${process.pid}" 2>nul | find "${process.pid}" >nul`,
      "if not errorlevel 1 (",
      "  timeout /t 1 /nobreak >nul",
      "  goto wait",
      ")",
      `copy /Y "${updateRuntime.downloadedPath}" "${targetExe}" >nul`,
      `start "" "${targetExe}"`,
      'del "%~f0"'
    ].join("\r\n");
    fs.writeFileSync(scriptPath, script, "utf8");
    spawn("cmd.exe", ["/d", "/c", scriptPath], {
      detached: true,
      stdio: "ignore",
      windowsHide: true
    }).unref();
    return true;
  }
  spawn(updateRuntime.downloadedPath, ["/S"], {
    detached: true,
    stdio: "ignore",
    windowsHide: true
  }).unref();
  return true;
}

function copySeedUserData(targetPath) {
  if (!app.isPackaged) return;
  if (fs.existsSync(path.join(targetPath, "desk-pet-state.json"))) return;
  const seedPath = path.join(process.resourcesPath, "user-data-seed");
  if (!fs.existsSync(seedPath)) return;
  fs.mkdirSync(targetPath, { recursive: true });
  fs.cpSync(seedPath, targetPath, {
    recursive: true,
    force: false,
    errorOnExist: false
  });
}

let portableDataPath = resolveUserDataPath();
app.setPath("userData", portableDataPath);

protocol.registerSchemesAsPrivileged([
  {
    scheme: "deskpet",
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true
    }
  }
]);

let store;
let controlWindow = null;
let overlayWindow = null;
let isQuitting = false;
const auxiliaryWindows = new Map();
const chatWindows = new Map();
const externalModuleWindows = new Map();
const climbWindows = new Map();
const VOICE_SERVICE_URL = "http://127.0.0.1:9880";
// 官方 Windows 整合包（含引擎代码、独立 Python 运行环境、编码器与权重）。
const VOICE_ENGINE_DOWNLOAD_URL =
  "https://hf-mirror.com/lj1995/GPT-SoVITS-windows-package/resolve/main/GPT-SoVITS-v3lora-20250228.7z?download=true";
const VOICE_ENGINE_FOLDER_NAME = "GPT-SoVITS-v3lora-20250228";

function voiceEngineConfigFile() {
  return path.join(app.getPath("userData"), "voice-engine-config.json");
}

function readVoiceEngineConfig() {
  try {
    const parsed = JSON.parse(
      fs.readFileSync(voiceEngineConfigFile(), "utf8")
    );
    return { root: String(parsed?.root || "").trim() };
  } catch {
    return { root: "" };
  }
}

function writeVoiceEngineConfig(config) {
  const target = voiceEngineConfigFile();
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(
      target,
      JSON.stringify({ root: String(config?.root || "").trim() }, null, 2),
      "utf8"
    );
  } catch {
    // 写不进去就当作没设置，继续回退到内置引擎目录。
  }
}

// 引擎目录的标志文件是 api_v2.py。
function isVoiceEngineDir(directory) {
  if (!directory) return false;
  try {
    return fs.existsSync(path.join(directory, "api_v2.py"));
  } catch {
    return false;
  }
}

// 用户可能选整合包本身、整合包上一层，或整个引擎根目录，这里统一找出来。
function discoverVoiceEngineDir(root) {
  if (isVoiceEngineDir(root)) return root;
  const bases = [path.join(root, "GPT-SoVITS-windows"), root];
  for (const base of bases) {
    let entries = [];
    try {
      entries = fs.readdirSync(base, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const candidate = path.join(base, entry.name);
      if (isVoiceEngineDir(candidate)) return candidate;
    }
  }
  return "";
}

function inspectVoiceEngine(root) {
  const engineDir = discoverVoiceEngineDir(root);
  if (!engineDir) {
    return { ok: false, engineDir: "", missing: ["引擎主程序 api_v2.py"] };
  }
  const missing = [];
  if (!fs.existsSync(path.join(engineDir, "runtime", "python.exe"))) {
    missing.push("Python 运行环境（runtime）");
  }
  if (!fs.existsSync(path.join(engineDir, "GPT_SoVITS", "pretrained_models"))) {
    missing.push("预训练模型目录（GPT_SoVITS/pretrained_models）");
  }
  return { ok: missing.length === 0, engineDir, missing };
}

const VOICE_ENGINE_CONFIG = readVoiceEngineConfig();

function resolveVoiceEngineRoot() {
  const candidates = [
    process.env.ARKPET_VOICE_ENGINE_DIR,
    VOICE_ENGINE_CONFIG.root,
    app.isPackaged ? path.join(process.resourcesPath, "voice-engine") : "",
    path.join(app.getPath("userData"), "voice-engine"),
    path.join(__dirname, "..", "voice-engine")
  ].filter(Boolean);
  return (
    candidates.find((candidate) => fs.existsSync(candidate)) ||
    path.join(__dirname, "..", "voice-engine")
  );
}

const VOICE_ENGINE_ROOT = resolveVoiceEngineRoot();
const CUDA128_RUNTIME_DIR = path.join(VOICE_ENGINE_ROOT, "cuda128-runtime");
const VOICE_ENGINE_DIR =
  discoverVoiceEngineDir(VOICE_ENGINE_ROOT) ||
  path.join(VOICE_ENGINE_ROOT, "GPT-SoVITS-windows", VOICE_ENGINE_FOLDER_NAME);
const VOICE_ENGINE_PYTHON = path.join(VOICE_ENGINE_DIR, "runtime", "python.exe");
const CUDA128_PYTHON = path.join(CUDA128_RUNTIME_DIR, "python.exe");
const localInference = new LocalInferenceManager({
  // 优先用带 CUDA 12.8 的运行环境，让本地对话模型的推理走显卡；缺失时回退内置环境。
  pythonPath: fs.existsSync(CUDA128_PYTHON)
    ? CUDA128_PYTHON
    : VOICE_ENGINE_PYTHON,
  scriptPath: path.join(__dirname, "..", "scripts", "local_model_worker.py"),
  cwd: path.join(__dirname, ".."),
  logPath: path.join(VOICE_ENGINE_ROOT, "local-inference.log")
});
const voiceAgent = new VoiceAgent({
  transcribe: (audioBytes) => transcribeAudioBytes(audioBytes),
  reply: (text, options) => replyWithProviders(store.get(), text, options),
  speak: (text, options) =>
    synthesizeWithSelectedVoice(store.get(), text, options)
});
let voiceServiceProcess = null;
let voiceServiceStartPromise = null;
let ownsVoiceService = false;

async function isVoiceServiceReady(timeoutMs = 1200) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${VOICE_SERVICE_URL}/docs`, {
      signal: controller.signal
    });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

function resolveVoiceServiceRuntimes() {
  const override = String(process.env.ARKPET_TTS_DEVICE || "")
    .trim()
    .toLowerCase();
  const cudaPython = path.join(CUDA128_RUNTIME_DIR, "python.exe");
  const basePython = path.join(VOICE_ENGINE_DIR, "runtime", "python.exe");
  const candidates = [];
  if (override !== "cpu" && fs.existsSync(cudaPython)) {
    candidates.push({
      pythonPath: cudaPython,
      device: "gpu",
      label: "GPU（CUDA 12.8 运行时）"
    });
  }
  if (override !== "gpu" && fs.existsSync(basePython)) {
    candidates.push({
      pythonPath: basePython,
      device: "cpu",
      label: "CPU（内置运行时）"
    });
  }
  return candidates;
}

let cudaGpuProbe = null;

let cudaGpuProbePromise = null;

function probeCudaGpuOnce(pythonPath) {
  return new Promise((resolve) => {
    const child = spawn(
      pythonPath,
      ["-c", "import torch;print(torch.cuda.is_available())"],
      { encoding: "utf8", windowsHide: true }
    );
    let stdout = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {}
      resolve(false);
    }, 15000);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve(code === 0 && stdout.trim() === "True");
    });
    child.on("error", () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
}

async function hasCudaGpu() {
  if (cudaGpuProbe !== null) return cudaGpuProbe;
  if (cudaGpuProbePromise) return cudaGpuProbePromise;
  const pythonPath = path.join(CUDA128_RUNTIME_DIR, "python.exe");
  if (!fs.existsSync(pythonPath)) {
    cudaGpuProbe = false;
    return false;
  }
  cudaGpuProbePromise = probeCudaGpuOnce(pythonPath).then((ok) => {
    cudaGpuProbePromise = null;
    cudaGpuProbe = ok;
    return ok;
  });
  return cudaGpuProbePromise;
}

let voiceServiceDevice = "";
let voiceServiceRuntimeLabel = "";

// 新版 torch 不再从 torch.nn.functional 里带出 typing 名称，GPU 运行时需要补回这行导入。
function ensureGpuCompatibility() {
  const target = path.join(
    VOICE_ENGINE_DIR,
    "GPT_SoVITS",
    "AR",
    "modules",
    "patched_mha_with_cache.py"
  );
  try {
    if (!fs.existsSync(target)) return false;
    const text = fs.readFileSync(target, "utf8");
    if (/^from typing import /m.test(text)) return true;
    const patched = text.replace(
      "from torch.nn.functional import *",
      "from torch.nn.functional import *\nfrom typing import Callable, List, Optional, Tuple, Union"
    );
    if (patched === text) return false;
    fs.writeFileSync(target, patched, "utf8");
    return true;
  } catch {
    return false;
  }
}

// 官方配置里 device 写死为 cpu，且 api 没有对应命令行参数，所以 GPU 模式单独生成一份配置。
function writeGpuVoiceConfig() {
  const sourcePath = path.join(
    VOICE_ENGINE_DIR,
    "GPT_SoVITS",
    "configs",
    "tts_infer.yaml"
  );
  try {
    if (!fs.existsSync(sourcePath)) return "";
    const text = fs.readFileSync(sourcePath, "utf8");
    const gpuText = text.replace(/^(\s*)device:\s*cpu\s*$/gm, "$1device: cuda");
    if (gpuText === text) return "";
    const targetPath = path.join(
      app.getPath("userData"),
      "tts_infer.gpu.yaml"
    );
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.writeFileSync(targetPath, gpuText, "utf8");
    return targetPath;
  } catch {
    return "";
  }
}

async function startVoiceServiceProcess(candidate, apiPath) {
  if (candidate.device === "gpu") {
    ensureGpuCompatibility();
  }
  let configPath = "GPT_SoVITS/configs/tts_infer.yaml";
  if (candidate.device === "gpu") {
    const gpuConfig = writeGpuVoiceConfig();
    if (gpuConfig) configPath = gpuConfig;
  }
  const logPath = path.join(VOICE_ENGINE_ROOT, "gpt-sovits-api.log");
  const errorLogPath = path.join(VOICE_ENGINE_ROOT, "gpt-sovits-api.err.log");
  const stdoutFd = fs.openSync(logPath, "a");
  const stderrFd = fs.openSync(errorLogPath, "a");
  let spawnError = null;
  try {
    voiceServiceProcess = spawn(
      candidate.pythonPath,
      [
        apiPath,
        "-a",
        "127.0.0.1",
        "-p",
        "9880",
        "-c",
        configPath
      ],
      {
        cwd: VOICE_ENGINE_DIR,
        windowsHide: true,
        env: {
          ...process.env,
          ...(candidate.device === "cpu"
            ? { CUDA_VISIBLE_DEVICES: "-1" }
            : {})
        },
        stdio: ["ignore", stdoutFd, stderrFd]
      }
    );
    ownsVoiceService = true;
  } finally {
    fs.closeSync(stdoutFd);
    fs.closeSync(stderrFd);
  }

  voiceServiceProcess.once("error", (error) => {
    spawnError = error;
  });
  voiceServiceProcess.once("exit", () => {
    voiceServiceProcess = null;
    ownsVoiceService = false;
    loadedVoiceWeights = { gpt: "", sovits: "" };
  });

  const deadline = Date.now() + (candidate.device === "gpu" ? 150000 : 180000);
  while (Date.now() < deadline) {
    if (spawnError) {
      stopOwnedVoiceService();
      return { ok: false, error: spawnError.message || "进程启动失败" };
    }
    if (voiceServiceProcess?.exitCode !== null) {
      stopOwnedVoiceService();
      return { ok: false, error: "服务进程提前退出，请看语音日志" };
    }
    if (await isVoiceServiceReady(800)) {
      voiceServiceDevice = candidate.device;
      voiceServiceRuntimeLabel = candidate.label;
      return {
        ok: true,
        reused: false,
        device: candidate.device,
        label: candidate.label
      };
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  stopOwnedVoiceService();
  return { ok: false, error: "启动超时" };
}

async function ensureVoiceService() {
  if (await isVoiceServiceReady()) {
    return { ok: true, reused: true, device: voiceServiceDevice };
  }
  if (voiceServiceStartPromise) return voiceServiceStartPromise;

  voiceServiceStartPromise = (async () => {
    const apiPath = path.join(VOICE_ENGINE_DIR, "api_v2.py");
    const candidates = resolveVoiceServiceRuntimes();
    if (!candidates.length || !fs.existsSync(apiPath)) {
      throw new Error(
        `没有找到内置 GPT-SoVITS 运行环境。请把运行环境放到：${VOICE_ENGINE_ROOT}`
      );
    }
    const failures = [];
    for (const candidate of candidates) {
      if (candidate.device === "gpu" && !(await hasCudaGpu())) {
        failures.push(`${candidate.label}：检测不到可用显卡`);
        continue;
      }
      const started = await startVoiceServiceProcess(candidate, apiPath);
      if (started.ok) return started;
      failures.push(`${candidate.label}：${started.error || "启动失败"}`);
    }
    throw new Error(
      failures.join("；") || "GPT-SoVITS 语音服务启动失败，请查看语音日志。"
    );
  })()
    .catch((error) => {
      stopOwnedVoiceService();
      return {
        ok: false,
        error: error.message || "GPT-SoVITS 语音服务启动失败。"
      };
    })
    .finally(() => {
      voiceServiceStartPromise = null;
    });

  return voiceServiceStartPromise;
}

function isBundledVoiceService(config) {
  const rawUrl = String(config?.baseUrl || "");
  if (!rawUrl) return false;
  try {
    const url = new URL(rawUrl);
    return (
      ["127.0.0.1", "localhost"].includes(url.hostname) &&
      url.port === "9880"
    );
  } catch {
    return false;
  }
}

function stopOwnedVoiceService() {
  if (!ownsVoiceService || !voiceServiceProcess) return;
  try {
    voiceServiceProcess.kill();
  } catch {
    // The process may have already exited.
  }
  voiceServiceProcess = null;
  ownsVoiceService = false;
  loadedVoiceWeights = { gpt: "", sovits: "" };
}

let loadedVoiceWeights = { gpt: "", sovits: "" };

async function applyVoiceWeights(gptWeight, sovitsWeight) {
  if (gptWeight && loadedVoiceWeights.gpt !== gptWeight) {
    const response = await fetch(
      `${VOICE_SERVICE_URL}/set_gpt_weights?weights_path=${encodeURIComponent(gptWeight)}`
    );
    if (!response.ok) throw new Error(await response.text());
    loadedVoiceWeights.gpt = gptWeight;
  }
  if (sovitsWeight && loadedVoiceWeights.sovits !== sovitsWeight) {
    const response = await fetch(
      `${VOICE_SERVICE_URL}/set_sovits_weights?weights_path=${encodeURIComponent(sovitsWeight)}`
    );
    if (!response.ok) throw new Error(await response.text());
    loadedVoiceWeights.sovits = sovitsWeight;
  }
}

function resolveVoiceWeights(state) {
  const localVoiceModel = (state.localModels || []).find(
    (model) =>
      model.id === state.localInference?.ttsModelId &&
      model.kind === "tts" &&
      model.status === "ready"
  );
  if (!localVoiceModel) return null;
  return {
    gptWeight: (localVoiceModel.companionPaths || []).find((filePath) =>
      filePath.toLowerCase().endsWith(".ckpt")
    ),
    sovitsWeight: (localVoiceModel.companionPaths || []).find((filePath) =>
      filePath.toLowerCase().endsWith(".pth")
    )
  };
}

async function primeVoiceWeights(state) {
  const weights = resolveVoiceWeights(state);
  if (!weights) return false;
  await applyVoiceWeights(weights.gptWeight, weights.sovitsWeight);
  return true;
}

function createSentenceBuffer() {
  let buffer = "";
  return {
    push(chunk) {
      buffer += String(chunk || "");
      const sentences = [];
      let index = buffer.search(/[。！？!?…\n；;]/);
      while (index >= 0) {
        const sentence = buffer.slice(0, index + 1).trim();
        buffer = buffer.slice(index + 1);
        if (sentence) sentences.push(sentence);
        index = buffer.search(/[。！？!?…\n；;]/);
      }
      return sentences;
    },
    flush() {
      const rest = buffer.trim();
      buffer = "";
      return rest ? [rest] : [];
    }
  };
}

function appendActivity(draft, type, text, petId = "") {
  draft.activity.unshift({
    id: id("activity"),
    type,
    text,
    petId,
    createdAt: new Date().toISOString()
  });
  draft.activity = draft.activity.slice(0, 60);
}

function rendererUrl(view) {
  const devUrl = process.env.VITE_DEV_SERVER_URL;
  const url = devUrl
    ? new URL(devUrl)
    : new URL(pathToFileURL(path.join(__dirname, "..", "dist", "index.html")).toString());
  if (view) url.searchParams.set("view", view);
  return url.toString();
}

function broadcastState() {
  if (!store) return;
  const state = store.get();
  const moduleWindowIds = new Set();
  for (const moduleWindow of externalModuleWindows.values()) {
    if (moduleWindow && !moduleWindow.isDestroyed()) {
      moduleWindowIds.add(moduleWindow.webContents.id);
    }
  }
  for (const window of BrowserWindow.getAllWindows()) {
    if (window.isDestroyed()) continue;
    // 外部模组不接收完整应用状态，只推脱敏后的桌宠快照。
    if (moduleWindowIds.has(window.webContents.id)) continue;
    window.webContents.send("store:changed", state);
  }
  const snapshot = modulePetSnapshot(state);
  for (const moduleWindow of externalModuleWindows.values()) {
    if (moduleWindow && !moduleWindow.isDestroyed()) {
      moduleWindow.webContents.send("module:pets-changed", snapshot);
    }
  }
}

function broadcastClimbPlatform(payload) {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) {
      window.webContents.send("overlay:climb-platform", payload);
    }
  }
}

function applyOverlaySettings() {
  if (!overlayWindow || overlayWindow.isDestroyed() || !store) return;
  const overlay = store.get().settings.overlay;
  overlayWindow.setAlwaysOnTop(Boolean(overlay.alwaysOnTop), "screen-saver");
  overlayWindow.webContents.send("overlay:settings", overlay);
}

function getPrimaryMetrics() {
  const display = screen.getPrimaryDisplay();
  return {
    bounds: display.bounds,
    workArea: display.workArea,
    scaleFactor: display.scaleFactor
  };
}

function positionOverlay() {
  if (!overlayWindow || overlayWindow.isDestroyed()) return;
  const { bounds } = getPrimaryMetrics();
  overlayWindow.setBounds(bounds);
  overlayWindow.webContents.send("display:changed", getPrimaryMetrics());
}

function createControlWindow() {
  if (controlWindow && !controlWindow.isDestroyed()) {
    controlWindow.show();
    controlWindow.focus();
    return controlWindow;
  }

  controlWindow = new BrowserWindow({
    width: 1360,
    height: 880,
    minWidth: 1080,
    minHeight: 720,
    title: "ArkPet",
    backgroundColor: "#f4f2ec",
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
      sandbox: false
    }
  });

  controlWindow.loadURL(rendererUrl());
  controlWindow.once("ready-to-show", () => controlWindow.show());
  controlWindow.on("close", (event) => {
    if (!isQuitting) {
      event.preventDefault();
      controlWindow.hide();
    }
  });
  controlWindow.on("closed", () => {
    controlWindow = null;
  });
  if (!app.isPackaged) {
    controlWindow.webContents.on("console-message", (_event, level, message) => {
      console.log(`[control:${level}] ${message}`);
    });
    controlWindow.webContents.on(
      "did-fail-load",
      (_event, code, description, url) => {
        console.error(`[control] load failed ${code} ${description} ${url}`);
      }
    );
  }
  controlWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  return controlWindow;
}

function createOverlayWindow() {
  if (overlayWindow && !overlayWindow.isDestroyed()) return overlayWindow;
  const { bounds } = getPrimaryMetrics();

  overlayWindow = new BrowserWindow({
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    focusable: false,
    hasShadow: false,
    show: false,
    alwaysOnTop: true,
    backgroundColor: "#00000000",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
      sandbox: false
    }
  });

  overlayWindow.setAlwaysOnTop(true, "screen-saver");
  overlayWindow.setFocusable(false);
  overlayWindow.setIgnoreMouseEvents(true, { forward: true });
  overlayWindow.loadURL(rendererUrl("overlay"));
  overlayWindow.on("closed", () => {
    overlayWindow = null;
  });
  if (!app.isPackaged) {
    overlayWindow.webContents.on("console-message", (_event, level, message) => {
      console.log(`[overlay:${level}] ${message}`);
    });
    overlayWindow.webContents.on(
      "did-fail-load",
      (_event, code, description, url) => {
        console.error(`[overlay] load failed ${code} ${description} ${url}`);
      }
    );
  }
  overlayWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));

  overlayWindow.once("ready-to-show", () => {
    applyOverlaySettings();
    const overlay = store.get().settings.overlay;
    if (overlay.visibleOnStart) overlayWindow.showInactive();
  });

  return overlayWindow;
}

function showOverlay() {
  const window = createOverlayWindow();
  window.setBounds(getPrimaryMetrics().bounds);
  window.showInactive();
}

function hideOverlay() {
  if (overlayWindow && !overlayWindow.isDestroyed()) overlayWindow.hide();
}

function pointToPrimaryDisplay(screenPoint) {
  const display = screen.getPrimaryDisplay();
  return {
    x: screenPoint.x - display.bounds.x,
    y: screenPoint.y - display.bounds.y
  };
}

function sendOverlayCommand(command) {
  const window = createOverlayWindow();
  showOverlay();
  const nextCommand = { ...command };

  if (command.type === "release" && controlWindow && !controlWindow.isDestroyed()) {
    const bounds = controlWindow.getBounds();
    nextCommand.origin = pointToPrimaryDisplay({
      x: bounds.x + bounds.width * 0.72,
      y: bounds.y + bounds.height * 0.68
    });
  }

  const state = store.mutate((draft) => {
    const petId = nextCommand.petId || draft.activePetId;
    if (command.type === "release") {
      draft.summonedPetIds = Array.from(
        new Set([...draft.summonedPetIds, petId])
      );
      draft.stats.releaseCount += 1;
      appendActivity(draft, "wake", "桌宠从管理窗口释放到桌面。", petId);
    } else if (command.type === "wake") {
      draft.summonedPetIds = Array.from(
        new Set([...draft.summonedPetIds, petId])
      );
      draft.stats.wakeCount += 1;
      appendActivity(draft, "wake", "桌宠被唤醒。", petId);
    } else if (command.type === "sleep") {
      draft.summonedPetIds = draft.summonedPetIds.filter(
        (id) => id !== petId
      );
      appendActivity(draft, "rest", "桌宠开始放松并进入休眠。", petId);
    } else if (command.type === "rest") {
      appendActivity(draft, "rest", "桌宠在桌面上进入休眠。", petId);
    }
  });
  broadcastState();
  window.webContents.send("overlay:command", nextCommand);
  for (const browserWindow of BrowserWindow.getAllWindows()) {
    if (!browserWindow.isDestroyed()) {
      browserWindow.webContents.send("overlay:mode", nextCommand.type);
    }
  }
  return state;
}

function createAuxiliaryWindow(config) {
  if (!config?.id) return null;
  const existing = auxiliaryWindows.get(config.id);
  if (existing && !existing.isDestroyed()) {
    existing.show();
    existing.focus();
    return existing;
  }

  const auxiliary = new BrowserWindow({
    width: Number(config.width) || 440,
    height: Number(config.height) || 320,
    minWidth: 320,
    minHeight: 220,
    title: config.title || config.name || "辅助窗口",
    autoHideMenuBar: true,
    backgroundColor: "#f7f5ef",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });
  auxiliary.loadURL(rendererUrl(`aux:${config.id}`));
  auxiliary.on("closed", () => auxiliaryWindows.delete(config.id));
  auxiliary.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  auxiliaryWindows.set(config.id, auxiliary);
  return auxiliary;
}

function resolveDialogModule(state, requestedId) {
  const usable = (item) =>
    item.kind === "dialog-box" && item.enabled !== false;
  return (
    state.customModules.find(
      (item) => item.id === requestedId && usable(item)
    ) || state.customModules.find(usable)
  );
}

function createChatWindow(mode, dialogModuleId) {
  const state = store.get();
  const dialogModule = resolveDialogModule(state, dialogModuleId);
  const resolvedModuleId = dialogModule?.id || "";
  const key = `${mode}:${resolvedModuleId || "default"}`;
  const existing = chatWindows.get(key);
  if (existing && !existing.isDestroyed()) {
    existing.show();
    existing.focus();
    return existing;
  }
  const window = new BrowserWindow({
    width: Number(dialogModule?.width) || 460,
    height: Number(dialogModule?.height) || 620,
    minWidth: 360,
    minHeight: 420,
    title: mode === "voice" ? "桌宠语音对话" : "桌宠文字对话",
    autoHideMenuBar: true,
    backgroundColor: dialogModule?.background || "#f7f5ef",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });
  window.loadURL(rendererUrl(`chat:${mode}`));
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.on("closed", () => chatWindows.delete(key));
  chatWindows.set(key, window);
  return window;
}

function externalModulesRoot() {
  return path.join(store.userDataPath, "custom-modules");
}

// 通过 webContents 反查是哪个模组在调用接口，模组无法冒充别人。
function moduleRecordForSender(sender) {
  if (!sender) return null;
  for (const [moduleId, window] of externalModuleWindows) {
    if (window && !window.isDestroyed() && window.webContents.id === sender.id) {
      return (
        store.get().customModules.find((item) => item.id === moduleId) || null
      );
    }
  }
  return null;
}

// 模组只能看到脱敏后的桌宠信息，拿不到完整应用状态。
function modulePetSnapshot(state) {
  return (state.pets || []).map((pet) => ({
    id: pet.id,
    name: pet.name,
    active: pet.id === state.activePetId,
    summoned: (state.summonedPetIds || []).includes(pet.id),
    vitals: { ...(pet.vitals || {}) }
  }));
}

function moduleStorageFile(moduleId) {
  return path.join(
    store.userDataPath,
    "module-storage",
    `${safeFileName(moduleId)}.json`
  );
}

function readModuleStorage(moduleId) {
  try {
    const parsed = JSON.parse(
      fs.readFileSync(moduleStorageFile(moduleId), "utf8")
    );
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function writeModuleStorage(moduleId, data) {
  const target = moduleStorageFile(moduleId);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, JSON.stringify(data, null, 2), "utf8");
}

function readExternalModuleManifest(folderPath) {
  const manifestPath = ["module.json", "manifest.json"]
    .map((name) => path.join(folderPath, name))
    .find((candidate) => fs.existsSync(candidate));
  if (!manifestPath) {
    throw new Error("模组文件夹里缺少 module.json 或 manifest.json。");
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    const apiVersion = Number(manifest.apiVersion) || 1;
    if (apiVersion > 1) {
      throw new Error(
        `该模组声明 apiVersion ${apiVersion}，当前软件只支持 1，请先更新 ArkPet。`
      );
    }
  const id = safeFileName(manifest.id || path.basename(folderPath));
  const entry = String(manifest.entry || "index.html");
  const entryPath = path.resolve(folderPath, entry);
  const relation = path.relative(folderPath, entryPath);
  if (relation.startsWith("..") || path.isAbsolute(relation)) {
    throw new Error("模组入口文件路径无效。");
  }
  if (!fs.existsSync(entryPath)) {
    throw new Error(`没有找到模组入口文件：${entry}`);
  }
  return {
    manifest,
    record: {
      id,
      name: String(manifest.name || id),
        apiVersion,
      description: String(manifest.description || "外部模组"),
      kind: manifest.type === "dialog-box" ? "dialog-box" : "interaction",
      moduleScope: manifest.scope === "pet" ? "pet" : "global",
      moduleCategory:
        manifest.category === "dialog-skin" ||
        manifest.category === "auxiliary-window" ||
        manifest.category === "interaction"
          ? manifest.category
          : "external",
      contextMenuLabel: String(
        manifest.contextMenuLabel || manifest.name || "打开模组"
      ),
      enabled: manifest.enabled !== false,
      quickControl: manifest.quickControl === true,
      builtinType:
        manifest.builtinType === "auxiliary-window"
          ? "auxiliary-window"
          : undefined,
      windowTitle: String(manifest.windowTitle || manifest.name || ""),
      windowBody: String(manifest.windowBody || manifest.description || ""),
      windowWidth: Number(manifest.windowWidth) || 420,
      windowHeight: Number(manifest.windowHeight) || 320,
      version: String(manifest.version || "1.0.0"),
      author: String(manifest.author || ""),
      entry,
      sourcePath: folderPath,
      width: Number(manifest.width) || 420,
      height: Number(manifest.height) || 420,
      background: String(manifest.background || "#f7f5ef"),
      borderColor: String(manifest.borderColor || "#d9d7d0"),
      borderRadius: Number(manifest.borderRadius) || 8,
      textColor: String(manifest.textColor || "#172033"),
      userBubbleColor: String(manifest.userBubbleColor || "#edf5ff"),
      assistantBubbleColor: String(
        manifest.assistantBubbleColor || "#ffffff"
      ),
      fontFamily: String(manifest.fontFamily || "Microsoft YaHei UI"),
      customCss: String(manifest.customCss || ""),
      metrics: Array.isArray(manifest.metrics)
        ? manifest.metrics.filter(
            (metric) =>
              metric &&
              typeof metric === "object" &&
              typeof metric.key === "string" &&
              typeof metric.label === "string"
          )
        : [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    }
  };
}

function loadExternalModules() {
  const root = externalModulesRoot();
  if (!fs.existsSync(root)) return;
  const records = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    try {
      records.push(
        readExternalModuleManifest(path.join(root, entry.name)).record
      );
    } catch (error) {
      console.warn(`[module] ${entry.name}: ${error.message}`);
    }
  }
  if (!records.length) return;
  store.mutate((draft) => {
    for (const record of records) {
      const index = draft.customModules.findIndex(
        (item) => item.id === record.id
      );
      if (index >= 0) {
          const existing = draft.customModules[index];
        draft.customModules[index] = {
            ...existing,
          ...record,
            enabled: existing.enabled ?? record.enabled,
            quickControl: existing.quickControl ?? record.quickControl,
            createdAt: existing.createdAt
        };
      } else {
        draft.customModules.push(record);
      }
    }
  });
}

function encodeRepositoryPath(value) {
  return String(value || "")
    .replace(/\\/g, "/")
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");
}

async function fetchModuleRegistry(force = false) {
  const now = Date.now();
  if (
    !force &&
    moduleRegistryCache.data &&
    now - moduleRegistryCache.fetchedAt < 60000
  ) {
    return moduleRegistryCache.data;
  }
  const localRegistryPath = path.join(LOCAL_MODULE_REGISTRY_ROOT, "registry.json");
  if (!app.isPackaged && fs.existsSync(localRegistryPath)) {
    const data = JSON.parse(fs.readFileSync(localRegistryPath, "utf8"));
    if (!data || !Array.isArray(data.modules)) {
      throw new Error("本地模组清单格式无效。");
    }
    moduleRegistryCache = { data, fetchedAt: now };
    return data;
  }
  const response = await fetch(`${MODULE_REGISTRY_URL}?ts=${now}`, {
    headers: { "User-Agent": "ArkPet-XHR-Module-Registry" },
    signal: AbortSignal.timeout(15000)
  });
  if (!response.ok) throw new Error(`获取官方模组清单失败：HTTP ${response.status}`);
  const data = await response.json();
  if (!data || !Array.isArray(data.modules)) {
    throw new Error("官方模组清单格式无效。");
  }
  moduleRegistryCache = { data, fetchedAt: now };
  return data;
}

function findInstalledOfficialModule(module) {
  const modules = store.get().customModules || [];
  return (
    (module.bundled
      ? modules.find((item) => item.id === module.id)
      : null) ||
    modules.find(
      (item) =>
        item.id === module.id &&
        item.sourcePath &&
        fs.existsSync(item.sourcePath)
    ) ||
    (module.bundled
      ? modules.find((item) => {
          const match = module.match || {};
          if (match.category) return item.moduleCategory === match.category;
          if (match.builtinType) return item.builtinType === match.builtinType;
          return false;
        })
        : null)
  );
}

function registryModuleView(module) {
  const installed = findInstalledOfficialModule(module);
  const installedVersion = String(
    installed?.version || (module.bundled ? "1.0.0" : "")
  );
  const status = !installed
    ? "available"
    : isNewerVersion(module.version, installedVersion)
      ? "update"
      : "installed";
  return {
    id: String(module.id || ""),
    name: String(module.name || module.id || "未命名模组"),
    version: String(module.version || "1.0.0"),
    author: String(module.author || ""),
    description: String(module.description || ""),
    category: String(module.category || "interaction"),
    installedVersion,
    status,
    source: "registry",
    builtin: false
  };
}

async function listRegistryModules(force = false) {
  try {
    const registry = await fetchModuleRegistry(force);
    const registryEntries = registry.modules.map(registryModuleView);
    return {
      ok: true,
      modules: registryEntries
    };
  } catch (error) {
    return {
      ok: false,
      modules: [],
      error: error?.message || "无法获取官方模组清单。"
    };
  }
}

async function readRegistryModuleFile(module, relativeFile) {
  const normalized = String(relativeFile || "").replace(/\\/g, "/");
  if (
    !normalized ||
    normalized.startsWith("/") ||
    normalized.split("/").includes("..")
  ) {
    throw new Error(`模组文件路径无效：${relativeFile}`);
  }
  const localSource = path.resolve(
    LOCAL_MODULE_REGISTRY_ROOT,
    String(module.basePath || "").replace(/^module-registry[\\/]/, ""),
    normalized
  );
  if (
    !app.isPackaged &&
    localSource.startsWith(LOCAL_MODULE_REGISTRY_ROOT) &&
    fs.existsSync(localSource)
  ) {
    return fs.readFileSync(localSource);
  }
  const rawUrl = `https://raw.githubusercontent.com/${MODULE_REGISTRY_REPOSITORY}/${MODULE_REGISTRY_BRANCH}/${encodeRepositoryPath(module.basePath)}/${encodeRepositoryPath(normalized)}?ts=${Date.now()}`;
  const response = await fetch(rawUrl, {
    headers: { "User-Agent": "ArkPet-XHR-Module-Registry" },
    signal: AbortSignal.timeout(20000)
  });
  if (!response.ok) {
    throw new Error(`下载 ${relativeFile} 失败：HTTP ${response.status}`);
  }
  return Buffer.from(await response.arrayBuffer());
}

function createBundledModuleRecord(manifest, registryModule) {
  const now = new Date().toISOString();
  const category = String(manifest.category || registryModule.category || "interaction");
  const moduleCategory =
    category === "dialog-skin" ||
    category === "auxiliary-window" ||
    category === "interaction"
      ? category
      : "external";
  const builtinType =
    manifest.builtinType === "climb-platforms" ||
    manifest.builtinType === "hunger-food" ||
    manifest.builtinType === "auxiliary-window"
      ? manifest.builtinType
      : undefined;
  return {
    id: String(manifest.id || registryModule.id),
    name: String(manifest.name || registryModule.name || registryModule.id),
    description: String(manifest.description || registryModule.description || ""),
    kind: manifest.type === "dialog-box" ? "dialog-box" : "interaction",
    moduleScope: manifest.scope === "pet" ? "pet" : "global",
    moduleCategory,
    contextMenuLabel: String(
      manifest.contextMenuLabel ||
        registryModule.contextMenuLabel ||
        manifest.name ||
        registryModule.name ||
        "打开模组"
    ),
    enabled: true,
    quickControl: manifest.quickControl === true,
    builtinType,
    windowTitle: String(manifest.windowTitle || manifest.name || ""),
    windowBody: String(manifest.windowBody || manifest.description || ""),
    windowWidth: Number(manifest.windowWidth) || 420,
    windowHeight: Number(manifest.windowHeight) || 320,
    version: String(manifest.version || registryModule.version || "1.0.0"),
    author: String(manifest.author || registryModule.author || ""),
    apiVersion: Number(manifest.apiVersion) || 1,
    entry: "",
    sourcePath: "",
    width: Number(manifest.width) || 420,
    height: Number(manifest.height) || 320,
    background: String(manifest.background || "#f7f5ef"),
    borderColor: String(manifest.borderColor || "#d9d7d0"),
    borderRadius: Number(manifest.borderRadius) || 8,
    textColor: String(manifest.textColor || "#172033"),
    userBubbleColor: String(manifest.userBubbleColor || "#edf5ff"),
    assistantBubbleColor: String(manifest.assistantBubbleColor || "#ffffff"),
    fontFamily: String(manifest.fontFamily || "Microsoft YaHei UI"),
    customCss: String(manifest.customCss || ""),
    metrics: Array.isArray(manifest.metrics) ? manifest.metrics : [],
    createdAt: now,
    updatedAt: now
  };
}

async function installRegistryModule(moduleId) {
  const registry = await fetchModuleRegistry(true);
  const module = registry.modules.find((item) => item.id === moduleId);
  if (!module) throw new Error("官方模组清单中没有这个模组。");
  if (!Array.isArray(module.files) || module.files.length === 0) {
    throw new Error("这个模组没有声明需要下载的文件。");
  }
  if (module.bundled) {
    const installed = findInstalledOfficialModule(module);
    const manifestFile =
      module.files.find((file) => /(^|\/)module\.json$/i.test(file)) ||
      module.files[0];
    const manifest = JSON.parse(
      (await readRegistryModuleFile(module, manifestFile)).toString("utf8")
    );
    const nextVersion = String(manifest.version || module.version || "1.0.0");
    store.mutate((draft) => {
      const target = installed
        ? draft.customModules.find((item) => item.id === installed.id)
        : null;
      if (!target) {
        const record = createBundledModuleRecord(manifest, {
          ...module,
          version: nextVersion
        });
        draft.customModules.push(record);
        if (record.kind === "dialog-box") {
          draft.settings.chat = {
            ...(draft.settings.chat || {}),
            dialogModuleId: record.id
          };
        }
        return;
      }
      Object.assign(target, {
        name: String(manifest.name || module.name || target.name),
        description: String(
          manifest.description || module.description || target.description
        ),
        version: nextVersion,
        contextMenuLabel: String(
          manifest.contextMenuLabel ||
            module.contextMenuLabel ||
            target.contextMenuLabel
        ),
        updatedAt: new Date().toISOString()
      });
    });
    broadcastState();
    return {
      ok: true,
      module: registryModuleView({ ...module, version: nextVersion })
    };
  }
  const root = externalModulesRoot();
  fs.mkdirSync(root, { recursive: true });
  const target = path.join(root, safeFileName(module.id));
  const staging = path.join(root, `.staging-${safeFileName(module.id)}-${Date.now()}`);
  const backup = path.join(root, `.backup-${safeFileName(module.id)}-${Date.now()}`);
  fs.mkdirSync(staging, { recursive: true });
  try {
    for (const relativeFile of module.files) {
      const normalized = String(relativeFile || "").replace(/\\/g, "/");
      const destination = path.resolve(staging, normalized);
      if (
        destination !== staging &&
        !destination.startsWith(`${staging}${path.sep}`)
      ) {
        throw new Error(`模组文件越出目录：${relativeFile}`);
      }
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.writeFileSync(
        destination,
        await readRegistryModuleFile(module, relativeFile)
      );
    }
    const inspection = readExternalModuleManifest(staging);
    if (inspection.record.id !== safeFileName(module.id)) {
      throw new Error("下载的模组清单 id 与官方清单不一致。");
    }
    fs.rmSync(backup, { recursive: true, force: true });
    let movedExisting = false;
    if (fs.existsSync(target)) {
      fs.renameSync(target, backup);
      movedExisting = true;
    }
    try {
      fs.renameSync(staging, target);
    } catch (error) {
      if (movedExisting && !fs.existsSync(target)) {
        fs.renameSync(backup, target);
      }
      throw error;
    }
    fs.rmSync(backup, { recursive: true, force: true });
    loadExternalModules();
    broadcastState();
    return {
      ok: true,
      module: registryModuleView(module)
    };
  } catch (error) {
    fs.rmSync(staging, { recursive: true, force: true });
    throw error;
  }
}

function findModuleManifestRoot(directory, depth = 0) {
  if (fs.existsSync(path.join(directory, "module.json"))) return directory;
  if (fs.existsSync(path.join(directory, "manifest.json"))) return directory;
  if (depth >= 3) return "";
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const found = findModuleManifestRoot(
      path.join(directory, entry.name),
      depth + 1
    );
    if (found) return found;
  }
  return "";
}

function installLocalModuleDirectory(sourceDirectory) {
  const inspection = readExternalModuleManifest(sourceDirectory);
  const moduleId = safeFileName(inspection.record.id);
  const root = externalModulesRoot();
  fs.mkdirSync(root, { recursive: true });
  const target = path.join(root, moduleId);
  const staging = path.join(root, `.staging-${moduleId}-${Date.now()}`);
  const backup = path.join(root, `.backup-${moduleId}-${Date.now()}`);
  fs.cpSync(sourceDirectory, staging, { recursive: true, force: true });
  try {
    fs.rmSync(backup, { recursive: true, force: true });
    let movedExisting = false;
    if (fs.existsSync(target)) {
      fs.renameSync(target, backup);
      movedExisting = true;
    }
    try {
      fs.renameSync(staging, target);
    } catch (error) {
      if (movedExisting && !fs.existsSync(target)) {
        fs.renameSync(backup, target);
      }
      throw error;
    }
    fs.rmSync(backup, { recursive: true, force: true });
    loadExternalModules();
    broadcastState();
    return inspection.record;
  } catch (error) {
    fs.rmSync(staging, { recursive: true, force: true });
    throw error;
  }
}

async function importModuleArchive() {
  const result = await dialog.showOpenDialog(controlWindow, {
    title: "选择模组压缩包",
    properties: ["openFile"],
    filters: [{ name: "模组压缩包", extensions: ["zip"] }]
  });
  if (result.canceled || !result.filePaths?.[0]) return { canceled: true };
  const archivePath = result.filePaths[0];
  const tempDirectory = path.join(
    app.getPath("temp"),
    `arkpet-module-import-${Date.now()}`
  );
  fs.mkdirSync(tempDirectory, { recursive: true });
  try {
    await new Promise((resolve, reject) => {
      execFile(
        "tar",
        ["-xf", archivePath, "-C", tempDirectory],
        { windowsHide: true },
        (error) => (error ? reject(error) : resolve())
      );
    });
    const moduleRoot = findModuleManifestRoot(tempDirectory);
    if (!moduleRoot) throw new Error("压缩包中没有找到 module.json。");
    const record = installLocalModuleDirectory(moduleRoot);
    return { canceled: false, module: record };
  } catch (error) {
    return {
      canceled: false,
      error: error?.message || "导入模组压缩包失败。"
    };
  } finally {
    fs.rmSync(tempDirectory, { recursive: true, force: true });
  }
}

function openExternalModuleWindow(moduleId) {
  const module = store
    .get()
    .customModules.find((item) => item.id === moduleId);
  if (module?.builtinType === "auxiliary-window") {
    createAuxiliaryWindow({
      id: module.id,
      name: module.name,
      title: module.windowTitle || module.name,
      body: module.windowBody || module.description,
      width: module.windowWidth || 420,
      height: module.windowHeight || 320,
      enabled: true
    });
    return true;
  }
  if (!module?.sourcePath || !module.entry) {
    throw new Error("该模组没有可打开的入口文件。");
  }
  const existing = externalModuleWindows.get(module.id);
  if (existing && !existing.isDestroyed()) {
    existing.show();
    existing.focus();
    return existing;
  }
  const entryPath = path.resolve(module.sourcePath, module.entry);
  const relation = path.relative(module.sourcePath, entryPath);
  if (relation.startsWith("..") || path.isAbsolute(relation)) {
    throw new Error("模组入口路径无效。");
  }
  const window = new BrowserWindow({
    width: module.width,
    height: module.height,
    title: module.name,
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
        sandbox: true,
        preload: path.join(__dirname, "module-preload.cjs")
    }
  });
  window.loadFile(entryPath);
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.on("closed", () => externalModuleWindows.delete(module.id));
  externalModuleWindows.set(module.id, window);
  return window;
}

function triggerModuleAction(moduleId, petId = "default", origin = null) {
  const module = store
    .get()
    .customModules.find((item) => item.id === moduleId);
  if (!module) throw new Error("没有找到模组。");
  if (module.builtinType === "hunger-food") {
    return { ok: true, type: "hunger" };
  }
  if (module.builtinType !== "climb-platforms") {
    return openExternalModuleWindow(moduleId);
  }
  const key = String(petId || "default");
  const windows = climbWindows.get(key) || [];
  const maxWindows = Math.max(1, Number(module.climbMaxWindows || 2));
  const display = screen.getPrimaryDisplay().workArea;
  const width = Number(module.windowWidth) || 420;
  const originX = Number(origin?.x);
  const originY = Number(origin?.y);
  const stepX = Math.max(48, Number(origin?.stepX) || 115);
  const stepY = Math.max(48, Number(origin?.stepY) || 147);
  const configuredHeight = Number(module.windowHeight) || 300;
  const height =
    key === "preview"
      ? configuredHeight
      : Math.min(configuredHeight, Math.max(96, stepY));
  const maxRise = stepY * 2;
  const x = Number.isFinite(originX)
    ? Math.round(
        Math.max(
          display.x,
          Math.min(display.x + display.width - width, originX - width / 2)
        )
      )
    : Math.round(
        display.x + display.width / 2 - width / 2
      );
  const y = Number.isFinite(originY)
    ? Math.round(
        Math.max(
          display.y + 40,
          Math.min(
            display.y + display.height - height,
            originY - maxRise
          )
        )
      )
    : Math.round(display.y + display.height * 0.35);
  const overlappingWindow = windows.find((item) => {
    if (!item?.window || item.window.isDestroyed()) return false;
    const current = item.window.getBounds();
    return (
      current.x < x + width &&
      current.x + current.width > x &&
      current.y < y + height &&
      current.y + current.height > y
    );
  });
  if (overlappingWindow?.window) {
    const current = overlappingWindow.window.getBounds();
    overlappingWindow.window.showInactive();
    broadcastClimbPlatform({
      id: overlappingWindow.id,
      petId: key,
      closed: false,
      x: current.x,
      y: current.y,
      width: current.width,
      height: current.height
    });
    return {
      id: overlappingWindow.id,
      x: current.x,
      y: current.y,
      width: current.width,
      height: current.height,
      stepX,
      stepY
    };
  }
  while (windows.length >= maxWindows) {
    const oldest = windows.shift();
    if (oldest?.window && !oldest.window.isDestroyed()) {
      oldest.window.close();
    }
  }
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
    html,body{margin:0;height:100%;background:${module.background || "#f7f5ef"};color:${module.textColor || "#172033"};font-family:${module.fontFamily || "Microsoft YaHei UI"};}
    main{display:grid;height:100%;place-content:center;gap:10px;padding:22px;text-align:center;}
    h1{margin:0;font-size:18px;}p{margin:0;font-size:12px;line-height:1.7;}
  </style></head><body><main><h1>${String(module.windowTitle || module.name).replace(/[<>&"]/g, "")}</h1><p>${String(module.windowBody || module.description).replace(/[<>&"]/g, "")}</p></main></body></html>`;
  const platformId = id("climb");
  const window = new BrowserWindow({
    x,
    y,
    width,
    height,
    title: module.windowTitle || module.name,
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  const publishBounds = () => {
    if (window.isDestroyed()) return;
    const bounds = window.getBounds();
    broadcastClimbPlatform({
      id: platformId,
      petId: key,
      closed: false,
      x: bounds.x,
      y: bounds.y,
      width: bounds.width,
      height: bounds.height
    });
  };
  window.on("move", publishBounds);
  window.on("resize", publishBounds);
  const closeTimer = setTimeout(() => {
    if (!window.isDestroyed()) window.close();
  }, 4500);
  window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  window.on("closed", () => {
    clearTimeout(closeTimer);
    const current = climbWindows.get(key) || [];
    climbWindows.set(
      key,
      current.filter((item) => item.id !== platformId)
    );
    broadcastClimbPlatform({
      id: platformId,
      petId: key,
      closed: true
    });
  });
  windows.push({ id: platformId, window });
  climbWindows.set(key, windows);
  return { id: platformId, x, y, width, height, stepX, stepY };
}

function safeFileName(value) {
  return String(value || "asset")
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "-")
    .replace(/\s+/g, "-")
    .slice(0, 80);
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function assetUrl(relativePath) {
  return `deskpet://assets/${relativePath.split(path.sep).join("/")}`;
}

function copyIntoAssets(sourcePath, folder) {
  const targetDir = path.join(store.assetsPath, folder);
  fs.mkdirSync(targetDir, { recursive: true });
  const extension = path.extname(sourcePath);
  const baseName = safeFileName(path.basename(sourcePath, extension));
  const uniqueName = `${Date.now()}-${baseName}${extension.toLowerCase()}`;
  const targetPath = path.join(targetDir, uniqueName);
  fs.copyFileSync(sourcePath, targetPath);
  const relativePath = path.relative(store.assetsPath, targetPath);
  return {
    id: id("asset"),
    name: path.basename(sourcePath),
    relativePath,
    url: assetUrl(relativePath),
    size: fs.statSync(targetPath).size,
    createdAt: new Date().toISOString()
  };
}

function formatParameterSize(parameterCount) {
  if (!Number.isFinite(parameterCount) || parameterCount <= 0) return "";
  if (parameterCount >= 1_000_000_000) {
    return `${(parameterCount / 1_000_000_000).toFixed(1)}B`;
  }
  if (parameterCount >= 1_000_000) {
    return `${(parameterCount / 1_000_000).toFixed(1)}M`;
  }
  return `${parameterCount}`;
}

function inferModelFamily(filePath, details = "") {
  const value = `${path.basename(filePath)} ${details}`.toLowerCase();
  if (value.includes("deepseek")) return "DeepSeek";
  if (value.includes("qwen")) return "Qwen";
  if (value.includes("mistral") || value.includes("mixtral")) return "Mistral";
  if (value.includes("gemma")) return "Gemma";
  if (value.includes("llama")) return "Llama";
  return "Unknown";
}

function suggestModelAdapter(family, parameterSize, fileName = "") {
  const normalized = String(parameterSize || "").toUpperCase();
  if (family === "Qwen") {
    const isQwen3 = /qwen[\s_-]*3/i.test(fileName);
    const isBase = /base/i.test(fileName);
    if (
      isQwen3 &&
      (normalized.startsWith("596") || normalized.startsWith("0.6B"))
    ) {
      return isBase ? "Qwen/Qwen3-0.6B-Base" : "Qwen/Qwen3-0.6B";
    }
    if (normalized.startsWith("0.5B")) return "Qwen/Qwen2.5-0.5B-Instruct";
    if (normalized.startsWith("1.5B")) return "Qwen/Qwen2.5-1.5B-Instruct";
    if (normalized.startsWith("3")) return "Qwen/Qwen2.5-3B-Instruct";
    if (normalized.startsWith("7")) return "Qwen/Qwen2.5-7B-Instruct";
    if (normalized.startsWith("14")) return "Qwen/Qwen2.5-14B-Instruct";
  }
  if (family === "DeepSeek") {
    if (normalized.startsWith("1.5B")) {
      return "deepseek-ai/DeepSeek-R1-Distill-Qwen-1.5B";
    }
    if (normalized.startsWith("7")) {
      return "deepseek-ai/DeepSeek-R1-Distill-Qwen-7B";
    }
    if (normalized.startsWith("14")) {
      return "deepseek-ai/DeepSeek-R1-Distill-Qwen-14B";
    }
    if (normalized.startsWith("32")) {
      return "deepseek-ai/DeepSeek-R1-Distill-Qwen-32B";
    }
  }
  return "";
}

function inspectSafetensors(filePath) {
  const stat = fs.statSync(filePath);
  if (stat.size < 16) {
    throw new Error("文件太小，不是有效的 .safetensors 模型。");
  }
  const fd = fs.openSync(filePath, "r");
  try {
    const lengthBuffer = Buffer.alloc(8);
    fs.readSync(fd, lengthBuffer, 0, 8, 0);
    const headerLength = Number(lengthBuffer.readBigUInt64LE(0));
    if (
      !Number.isSafeInteger(headerLength) ||
      headerLength <= 2 ||
      headerLength > stat.size - 8 ||
      headerLength > 128 * 1024 * 1024
    ) {
      throw new Error("safetensors 头信息无效，文件可能未下载完整。");
    }
    const headerBuffer = Buffer.alloc(headerLength);
    fs.readSync(fd, headerBuffer, 0, headerLength, 8);
    const header = JSON.parse(headerBuffer.toString("utf8"));
    let parameterCount = 0;
    const tensorNames = [];
    for (const [name, value] of Object.entries(header)) {
      if (name === "__metadata__" || !value?.shape) continue;
      tensorNames.push(name);
      parameterCount += value.shape.reduce(
        (total, dimension) => total * Number(dimension || 1),
        1
      );
    }
    const metadataText = JSON.stringify(header.__metadata__ || {});
    const tensorText = tensorNames.slice(0, 80).join(" ");
    return {
      metadata: header.__metadata__ || {},
      tensorCount: tensorNames.length,
      parameterCount,
      family: inferModelFamily(filePath, `${metadataText} ${tensorText}`)
    };
  } finally {
    fs.closeSync(fd);
  }
}

function inspectGguf(filePath) {
  const stat = fs.statSync(filePath);
  const length = Math.max(0, Math.min(1024 * 1024, stat.size));
  const preview = Buffer.alloc(length);
  const fd = fs.openSync(filePath, "r");
  try {
    if (length > 0) {
      fs.readSync(fd, preview, 0, length, 0);
    }
  } finally {
    fs.closeSync(fd);
  }
  if (preview.subarray(0, 4).toString("ascii") !== "GGUF") {
    throw new Error("文件头不是 GGUF，可能不是有效的对话模型。");
  }
  return {
    family: inferModelFamily(filePath, preview.toString("latin1"))
  };
}

function inspectWhisperModel(sourcePath) {
  if (!fs.statSync(sourcePath).isDirectory()) {
    throw new Error("Whisper 模型需要选择包含配置和权重的模型文件夹。");
  }
  const entries = fs.readdirSync(sourcePath);
  const lower = new Map(entries.map((name) => [name.toLowerCase(), name]));
  const hasConfig = lower.has("config.json");
  const hasTokenizer =
    lower.has("tokenizer.json") ||
    lower.has("vocabulary.json") ||
    lower.has("vocabulary.txt");
  const hasWeights =
    lower.has("model.safetensors") ||
    lower.has("model.bin") ||
    entries.some((name) => name.toLowerCase().endsWith(".safetensors"));
  const missing = [];
  if (!hasConfig) missing.push("config.json");
  if (!hasWeights) missing.push("模型权重");
  if (!hasTokenizer) missing.push("分词器文件");
  return {
    status: missing.length === 0 ? "ready" : "needs-files",
    family: "Whisper",
    companionPaths: entries.map((name) => path.join(sourcePath, name)),
    validationMessage:
      missing.length === 0
        ? "Whisper 模型文件完整，可以直接用于本地语音识别。"
        : `缺少：${missing.join("、")}。`
  };
}

function inspectGptSoVitsVoiceModel(sourcePath) {
  const stat = fs.statSync(sourcePath);
  if (stat.isDirectory()) {
    const files = fs.readdirSync(sourcePath);
    const gptFiles = files.filter((name) => /.ckpt$/i.test(name));
    const sovitsFiles = files.filter((name) => /.pth$/i.test(name));
    const missing = [];
    if (gptFiles.length === 0) missing.push("GPT .ckpt 模型文件");
    if (sovitsFiles.length === 0) missing.push("SoVITS .pth 模型文件");
    return {
      status: missing.length === 0 ? "ready" : "needs-files",
      family: "GPT-SoVITS",
      companionPaths: [...gptFiles, ...sovitsFiles].map((name) =>
        path.join(sourcePath, name)
      ),
      validationMessage:
        missing.length === 0
          ? "GPT-SoVITS 模型文件已完整，可粘贴到语音后方模型"
          : `细节:${missing.join("，")}。`
    };
  }
  // 单文件：只能是 .ckpt 或 .pth
  const ext = path.extname(sourcePath).toLowerCase();
  if (ext === ".ckpt" || ext === ".pth") {
    return {
      status: "needs-files",
      family: "GPT-SoVITS",
      companionPaths: [sourcePath],
      validationMessage: `已选中 ${path.basename(sourcePath)}，还需配对另一权重文件才能使用`
    };
  }
  throw new Error("请选择 GPT-SoVITS 声线模型文件（.ckpt 或 .pth）或包含它们的文件夹");
};

function inspectLlmFolder(sourcePath) {
  const entries = fs.readdirSync(sourcePath);
  const lowerEntries = entries.map((name) => name.toLowerCase());
  const configName =
    entries.find((name) => name.toLowerCase() === "config.json") || "";
  const tokenizerNames = [
    "tokenizer.json",
    "tokenizer_config.json",
    "vocab.json",
    "merges.txt",
    "special_tokens_map.json"
  ].filter((name) => lowerEntries.includes(name));
  const weightNames = entries.filter((name) =>
    /\.(safetensors|gguf)$/i.test(name)
  );
  const missing = [];
  if (!configName) missing.push("config.json");
  if (!weightNames.length) missing.push("模型权重");
  if (!tokenizerNames.length) missing.push("分词器文件");

  let family = inferModelFamily(sourcePath);
  if (family === "Unknown" && configName) {
    try {
      const configText = fs.readFileSync(path.join(sourcePath, configName), "utf8");
      family = inferModelFamily(sourcePath, configText);
    } catch {
      // Keep the folder usable if one metadata file cannot be read.
    }
  }

  return {
    status: missing.length === 0 ? "ready" : "needs-files",
    family,
    companionPaths: entries.map((name) => path.join(sourcePath, name)),
    validationMessage:
      missing.length === 0
        ? `完整模型文件夹已识别${family !== "Unknown" ? `：${family}` : ""}。`
        : `缺少：${missing.join("、")}。`
  };
}

function inspectLocalModel(kind, sourcePath) {
  const stat = fs.statSync(sourcePath);
  if (kind === "tts") {
    const result = inspectGptSoVitsVoiceModel(sourcePath);
    return {
      kind,
      name: path.basename(sourcePath),
      format: "gpt-sovits",
      sourcePath,
      backend: "gpt-sovits",
      ...result
    };
  }
  if (kind === "asr") {
    const result = inspectWhisperModel(sourcePath);
    return {
      kind,
      name: path.basename(sourcePath),
      format: "whisper",
      sourcePath,
      backend: "whisper",
      ...result
    };
  }
  if (stat.isDirectory()) {
    const result = inspectLlmFolder(sourcePath);
    return {
      kind: "llm",
      name: path.basename(sourcePath),
      format: "safetensors",
      sourcePath,
      backend: "transformers",
      family: inferModelFamily(sourcePath),
      status: result.status,
      companionPaths: result.companionPaths,
      validationMessage: result.validationMessage
    };
  }

  const extension = path.extname(sourcePath).toLowerCase();
  if (extension === ".gguf") {
    const result = inspectGguf(sourcePath);
    return {
      kind: "llm",
      name: path.basename(sourcePath),
      format: "gguf",
      sourcePath,
      backend: "llama.cpp",
      family: result.family,
      companionPaths: [sourcePath],
      status: "ready",
      validationMessage: "GGUF 文件结构有效，已准备使用 llama.cpp 本地后端。"
    };
  }
  if (extension === ".safetensors") {
    const result = inspectSafetensors(sourcePath);
    const parameterSize = formatParameterSize(result.parameterCount);
    const fileName = path.basename(sourcePath);
    const looksLikeVae = /vae/i.test(fileName);
    const modelId = looksLikeVae
      ? ""
      : suggestModelAdapter(result.family, parameterSize, fileName);
    return {
      kind: "llm",
      name: fileName,
      format: "safetensors",
      sourcePath,
      backend: "transformers",
      family: result.family,
      parameterSize,
      modelId,
      companionPaths: [sourcePath],
      status: modelId ? "ready" : looksLikeVae ? "invalid" : "unsupported",
      validationMessage:
        modelId
          ? `已识别 ${result.family} 权重，将使用内置适配信息加载。`
          : looksLikeVae
            ? "这是图像或视频模型的 VAE 组件，不是对话语言模型，不能用于 AI 对话。"
          : result.family === "Unknown"
            ? "权重文件有效，但暂时无法识别模型家族，需要后续选择适配包。"
            : `已识别 ${result.family} 权重，但该家族目前在预留窗口，尚未启用推理。`
    };
  }
  throw new Error("当前只支持 .safetensors、.gguf、Whisper 和 GPT-SoVITS 模型。");
}

function registerApiServiceModel(kind, config) {
  const now = new Date().toISOString();
  const sourcePath = String(config.baseUrl || "").trim();
  const displayName =
    config.model ||
    config.voiceId ||
    `${kind.toUpperCase()} API`;
  return store.mutate((draft) => {
    const modelKey = config.model || config.voiceId || "";
    const existing = draft.localModels.find(
      (model) =>
        model.kind === kind &&
        model.format === "api" &&
        model.sourcePath === sourcePath &&
        (model.modelId || "") === modelKey
    );
    const record = {
      id: existing?.id || id("model"),
      name: displayName,
      kind,
      format: "api",
      sourcePath,
      companionPaths: [],
      family: "API",
      parameterSize: "",
      status: "ready",
      validationMessage: "API 连接测试成功，可以设为当前模型。",
      backend: "api",
      modelId: modelKey,
      apiConfig: {
        ...config,
        mode: "api"
      },
      createdAt: existing?.createdAt || now,
      updatedAt: now
    };
    if (existing) {
      Object.assign(existing, record);
    } else {
      draft.localModels.unshift(record);
    }
  });
}

function resolveAiModule(state, options = {}) {
  const activePet =
    state.pets?.find((pet) => pet.id === state.activePetId) || state.pets?.[0];
  const voiceProfileId =
    options.voiceProfileId || activePet?.modulePlugins?.voiceProfileId || "";
  const voiceProfile = state.voiceProfiles?.find(
    (profile) => profile.id === voiceProfileId
  );
  const moduleId =
    options.aiModuleId ||
    activePet?.modulePlugins?.aiModuleId ||
    voiceProfile?.defaultAiModuleId ||
    state.activeTrainingProfileId;
  return (
    state.trainingProfiles?.find((profile) => profile.id === moduleId) ||
    state.trainingProfiles?.find(
      (profile) => profile.id === state.activeTrainingProfileId
    ) ||
    state.trainingProfiles?.[0] ||
    null
  );
}

function resolveReplyPet(state, options = {}, aiModule = null) {
  return (
    (state.pets || []).find((pet) => pet.id === options.petId) ||
    (aiModule
      ? (state.pets || []).find(
          (pet) => pet.modulePlugins?.aiModuleId === aiModule.id
        )
      : null) ||
    (state.pets || []).find((pet) => pet.id === state.activePetId) ||
    (state.pets || [])[0] ||
    null
  );
}

function buildReplyState(state, aiModule, options = {}) {
  const pet = resolveReplyPet(state, options, aiModule);
  return {
    ...state,
    activePetId: pet?.id || state.activePetId,
    ...(aiModule
      ? {
          character: aiModule.character || state.character,
          documents: aiModule.documents || state.documents,
          memories: aiModule.memories || state.memories
        }
      : {})
  };
}

async function replyWithProviders(state, text, options = {}) {
  const aiModule = resolveAiModule(state, options);
  const replyState = buildReplyState(state, aiModule, options);
  const modelId =
    aiModule?.localModelId ||
    options.modelId ||
    state.localInference?.llmModelId ||
    "";
  const llmMode = state.settings?.services?.llm?.mode || "local";
  if (llmMode === "api") {
    return ai.chatLocal(replyState, [{ role: "user", content: text }]);
  }
  const selectedModel = (state.localModels || []).find(
    (model) => model.id === modelId && model.status === "ready"
  );
  if (!selectedModel) {
    return {
      ok: true,
      source: "fallback",
      text: ai.fallbackReply(replyState, text),
      warning: "当前 AI 模块还没有可用的本地对话模型。"
    };
  }
  const systemPrompt = ai.buildSystemPrompt(replyState);
  const messages = [{ role: "user", content: text }];
  try {
    const chatMessages = [
      { role: "system", content: systemPrompt },
      ...messages
    ];
    const localResult =
      typeof options.onDelta === "function"
        ? await localInference.chatStream(
            state,
            chatMessages,
            { modelId: selectedModel.id },
            options.onDelta
          )
        : await localInference.chat(state, chatMessages, {
            modelId: selectedModel.id
          });
    if (localResult) {
      const parsedResult = ai.parseModelPayload(localResult.text);
      return {
        ...localResult,
        text: ai.sanitizeCharacterReply(
          parsedResult.text || localResult.text
        ),
        speech: parsedResult.speech || undefined
      };
    }
  } catch (error) {
    return {
      ok: false,
      source: "local-model",
      text: `本地模型暂时无法运行：${error.message || "未知错误"}`,
      error: error.message || "本地模型推理失败。"
    };
  }
  return ai.chatLocal(replyState, messages);
}

async function transcribeWithProviders(state, filePath) {
  let apiResult = null;
  if ((state.settings?.services?.asr?.mode || "local") === "api") {
    apiResult = await ai.transcribeLocal(state, filePath);
    if (apiResult.ok) return apiResult;
  }
  const tempDir = path.join(os.tmpdir(), "arkpet-asr-audio");
  fs.mkdirSync(tempDir, { recursive: true });
  const extension = path.extname(filePath).toLowerCase();
  const normalizedPath =
    extension === ".wav"
      ? filePath
      : path.join(tempDir, `normalized-${Date.now()}.wav`);
  let createdNormalizedFile = false;

  if (normalizedPath !== filePath) {
    const ffmpegPath = path.join(VOICE_ENGINE_DIR, "ffmpeg.exe");
    const conversion = spawnSync(
      ffmpegPath,
      [
        "-y",
        "-i",
        filePath,
        "-ar",
        "16000",
        "-ac",
        "1",
        "-c:a",
        "pcm_s16le",
        normalizedPath
      ],
      { windowsHide: true }
    );
    if (conversion.status !== 0 || !fs.existsSync(normalizedPath)) {
      return {
        ok: false,
        error: "录音格式转换失败，无法准备 Whisper 输入音频。"
      };
    }
    createdNormalizedFile = true;
  }

  try {
    const localResult = await localInference.transcribe(
      state,
      normalizedPath
    );
    if (localResult) return localResult;
  } catch (error) {
    return {
      ok: false,
      error: error.message || "本地 Whisper 识别失败。"
    };
  } finally {
    if (createdNormalizedFile) {
      fs.rmSync(normalizedPath, { force: true });
    }
  }
  return apiResult || ai.transcribeLocal(state, filePath);
}

async function transcribeAudioBytes(audioBytes) {
  const tempDir = path.join(os.tmpdir(), "arkpet-voice-agent");
  fs.mkdirSync(tempDir, { recursive: true });
  const filePath = path.join(tempDir, `input-${Date.now()}.webm`);
  fs.writeFileSync(filePath, Buffer.from(audioBytes));
  try {
    return await transcribeWithProviders(store.get(), filePath);
  } finally {
    fs.rmSync(filePath, { force: true });
  }
}

function getVoiceTrainingRuntime() {
  const pythonPath = path.join(CUDA128_RUNTIME_DIR, "python.exe");
  const logPath = path.join(VOICE_ENGINE_ROOT, "cuda128-setup.log");
  const logText = fs.existsSync(logPath)
    ? fs.readFileSync(logPath, "utf8")
    : "";
  if (!fs.existsSync(pythonPath)) {
    return {
      ready: false,
      progress: logText.includes("Copying base runtime") ? 8 : 0,
      phase: "复制运行环境",
      message:
        "独立 CUDA 12.8 训练环境尚未安装。训练按钮会在环境验证通过后自动启用。"
    };
  }
  if (logText.includes("Verifying CUDA 12.8")) {
    return {
      ready: false,
      progress: 92,
      phase: "验证 RTX 5070",
      message: "CUDA 组件安装完成，正在验证 RTX 5070 的 sm_120 支持。"
    };
  }
  if (logText.includes("Installing CUDA 12.8 PyTorch")) {
    return {
      ready: false,
      progress: 55,
      phase: "下载并安装 CUDA 12.8",
      message: "正在下载和安装 GPU 训练组件，预计需要一些时间。"
    };
  }
  const result = spawnSync(
    pythonPath,
    [
      "-c",
      [
        "import torch",
        "print(torch.__version__)",
        "print(torch.version.cuda or '')",
        "print(torch.cuda.get_device_name(0) if torch.cuda.is_available() else 'CPU')",
        "print('sm_120' in torch.cuda.get_arch_list() if torch.cuda.is_available() else False)"
      ].join(";")
    ],
    { encoding: "utf8", windowsHide: true }
  );
  if (result.status !== 0) {
    return {
      ready: false,
      progress: 80,
      phase: "检查失败",
      message: "CUDA 训练环境存在，但 PyTorch 检查失败。"
    };
  }
  const [version, cuda, device, supportsSm120] = result.stdout
    .trim()
    .split(/\r?\n/);
  if (supportsSm120 !== "True") {
    return {
      ready: false,
      progress: 90,
      phase: "需要升级",
      message: `当前 PyTorch ${version} 尚未支持 RTX 5070 sm_120。`,
      cuda,
      device
    };
  }
  return {
    ready: true,
    progress: 100,
    phase: "训练环境可用",
    message: `CUDA 训练环境可用：PyTorch ${version} / CUDA ${cuda} / ${device}`,
    cuda,
    device
  };
}

function getAudioDuration(filePath) {
  const ffprobePath = path.join(VOICE_ENGINE_DIR, "ffprobe.exe");
  const result = spawnSync(
    ffprobePath,
    [
      "-v",
      "error",
      "-show_entries",
      "format=duration",
      "-of",
      "default=noprint_wrappers=1:nokey=1",
      filePath
    ],
    { encoding: "utf8", windowsHide: true }
  );
  if (result.status !== 0) return 0;
  const duration = Number(result.stdout.trim());
  return Number.isFinite(duration) ? duration : 0;
}

function getDesktopIcons() {
  const scriptPath = path.join(
    __dirname,
    "..",
    "scripts",
    "get_desktop_icons.ps1"
  );
  const desktopPath = app.getPath("desktop");
  let foodFiles = [];
  try {
    foodFiles = fs
      .readdirSync(desktopPath, { withFileTypes: true })
      .filter(
        (entry) =>
          entry.isFile() && entry.name.toLowerCase().endsWith(".food")
      )
      .map((entry) => ({
        name: entry.name,
        stem: path.parse(entry.name).name,
        path: path.join(desktopPath, entry.name)
      }));
  } catch {
    foodFiles = [];
  }
  return new Promise((resolve) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", scriptPath],
      { encoding: "utf8", windowsHide: true, timeout: 10000 },
      (error, stdout) => {
        if (error) {
          resolve([]);
          return;
        }
        try {
          const parsed = JSON.parse(String(stdout).trim());
          const scale = screen.getPrimaryDisplay().scaleFactor || 1;
          resolve(
            parsed.map((icon) => {
              let name = "";
              try {
                name = Buffer.from(String(icon.label || ""), "base64")
                  .toString("utf16le")
                  .replace(/\0+$/g, "");
              } catch {
                name = "";
              }
              const normalizedName = name.trim().toLowerCase();
              const matchedFood = foodFiles.find(
                (food) =>
                  food.name.toLowerCase() === normalizedName ||
                  food.stem.toLowerCase() === normalizedName
              );
              return {
                id: name || `desktop-${icon.x}-${icon.y}`,
                name,
                foodPath: matchedFood?.path || "",
                x: Number(icon.x) / scale,
                y: Number(icon.y) / scale,
                width: Number(icon.width) / scale,
                height: Number(icon.height) / scale
              };
            })
          );
        } catch {
          resolve([]);
        }
      }
    );
  });
}

async function synthesizeWithSelectedVoice(state, text, options = {}) {
  const activeProfile = state.trainingProfiles?.find(
    (profile) => profile.id === state.activeTrainingProfileId
  );
  const profileId =
    options.voiceProfileId ||
    activeProfile?.voiceProfileIds?.[0] ||
    state.voiceProfiles?.[0]?.id;
  const profile =
    state.voiceProfiles?.find((item) => item.id === profileId) ||
    state.voiceProfiles?.find((item) =>
      activeProfile?.voiceProfileIds?.includes(item.id)
    ) ||
    state.voiceProfiles?.[0];
  const nextVoiceConfig = {
    ...(options.config || {}),
    ...options,
    voiceProfileId: profile?.id || options.voiceProfileId || "",
    engineType: profile?.engineType || options.engineType || "gpt-sovits",
    baseUrl: profile?.baseUrl || options.baseUrl || VOICE_SERVICE_URL,
    model: profile?.model || options.model || "",
    apiKey: profile?.apiKey || options.apiKey || "",
    referenceText: profile?.referenceText || options.referenceText || ""
  };

  const ttsMode = state.settings?.services?.tts?.mode || "local";
  if (ttsMode === "api") {
    nextVoiceConfig.engineType = "api";
    return ai.synthesizeLocal(
      state,
      text,
      profile?.voiceId || options.voiceId,
      nextVoiceConfig
    );
  }

  if (nextVoiceConfig.engineType === "gpt-sovits") {
    const effectiveVoiceConfig = {
      ...(state.settings?.services?.tts || {}),
      ...nextVoiceConfig
    };
    if (!isBundledVoiceService(effectiveVoiceConfig)) {
      return { ok: false, error: "GPT-SoVITS 地址必须指向本机 9880 端口。" };
    }
    const serviceState = await ensureVoiceService();
    if (!serviceState.ok) return serviceState;
    const weights = resolveVoiceWeights(state);
    if (weights) {
      try {
        await applyVoiceWeights(weights.gptWeight, weights.sovitsWeight);
      } catch (error) {
        return {
          ok: false,
          error: `声线模型切换失败：${error.message || "未知错误"}`
        };
      }
    }
    const sample =
      profile?.samples?.find((item) => item.id === profile.activeSampleId) ||
      profile?.samples?.[0];
    if (sample?.relativePath) {
      const sourcePath = path.join(store.assetsPath, sample.relativePath);
      const referenceDir = path.join(os.tmpdir(), "desk-pet-voice");
      fs.mkdirSync(referenceDir, { recursive: true });
      const trimmedPath = path.join(referenceDir, `${profile.id}-ref.wav`);
      const sourceStat = fs.statSync(sourcePath);
      const trimmedReady =
        fs.existsSync(trimmedPath) &&
        fs.statSync(trimmedPath).mtimeMs >= sourceStat.mtimeMs;
      if (!trimmedReady) {
        const pythonPath = path.join(
          VOICE_ENGINE_DIR,
          "runtime",
          "python.exe"
        );
        const trimScript = path.join(
          __dirname,
          "..",
          "scripts",
          "trim_reference_wav.py"
        );
        const trimResult = spawnSync(
          pythonPath,
          [trimScript, sourcePath, trimmedPath, "8"],
          { windowsHide: true }
        );
        nextVoiceConfig.refAudioPath =
          trimResult.status === 0 ? trimmedPath : sourcePath;
      } else {
        nextVoiceConfig.refAudioPath = trimmedPath;
      }
    }
  }
  return ai.synthesizeLocal(
    state,
    text,
    profile?.voiceId || options.voiceId,
    nextVoiceConfig
  );
}

function buildTrainingDataset(profile) {
  const character = profile.character || {};
  const skillPrompt = ai.buildProfileSkillPrompt(profile);
  const examples = [
    {
      messages: [
        {
          role: "system",
          content: skillPrompt
        },
        {
          role: "user",
          content: "简单介绍一下你自己。"
        },
        {
          role: "assistant",
          content: `我是${character.name || profile.name}。${character.personality || "我会保持自己的性格回应你。"}`
        }
      ]
    }
  ];
  for (const document of profile.documents || []) {
    examples.push({
      messages: [
        {
          role: "system",
          content: `${skillPrompt}\n\n以下是${character.name || profile.name}的背景资料，请用于保持角色设定。`
        },
        { role: "user", content: document.title || "阅读这份资料。" },
        { role: "assistant", content: document.content || "" }
      ]
    });
  }
  for (const memory of profile.memories || []) {
    examples.push({
      messages: [
        {
          role: "system",
          content: `${skillPrompt}\n\n请记住这条与用户有关的长期记忆：${memory.title || "记忆"}`
        },
        { role: "user", content: "你还记得这件事吗？" },
        { role: "assistant", content: memory.content || "" }
      ]
    });
  }
  return examples.map((item) => JSON.stringify(item)).join("\n");
}

function registerIpc() {
  ipcMain.handle("store:get", () => store.get());
  ipcMain.handle("store:update", (_event, patch) => {
    const state = store.update(patch);
    broadcastState();
    applyOverlaySettings();
    return state;
  });
  ipcMain.on("store:update-sync", (event, patch) => {
    const state = store.update(patch);
    broadcastState();
    applyOverlaySettings();
    event.returnValue = state;
  });
  ipcMain.handle("store:replace", (_event, nextState) => {
    const state = store.replace(nextState);
    broadcastState();
    applyOverlaySettings();
    return state;
  });
  ipcMain.handle("pets:apply", (_event, petId, patch) => {
    const state = store.mutate((draft) => {
      const pet = draft.pets.find((item) => item.id === petId);
      if (!pet) return;
      if (isPlainObject(patch?.vitals)) {
        pet.vitals = { ...(pet.vitals || {}), ...patch.vitals };
      }
      if (isPlainObject(patch?.moduleState)) {
        const nextModuleState = { ...(pet.moduleState || {}) };
        for (const [moduleId, values] of Object.entries(patch.moduleState)) {
          if (!isPlainObject(values)) continue;
          nextModuleState[moduleId] = {
            ...(nextModuleState[moduleId] || {}),
            ...values
          };
        }
        pet.moduleState = nextModuleState;
      }
      pet.updatedAt = new Date().toISOString();
    });
    broadcastState();
    return state;
  });

  ipcMain.handle("display:get-metrics", () => getPrimaryMetrics());
  ipcMain.handle("desktop:get-icons", () => getDesktopIcons());
  ipcMain.on("debug:physics-log", (_event, message) => {
    if (process.env.ARKPET_PHYSICS_DEBUG !== "1") return;
    fs.appendFileSync(
      path.join(VOICE_ENGINE_ROOT, "physics-debug.log"),
      `${message}\n`,
      "utf8"
    );
  });
  ipcMain.handle("window:get-control-bounds", () => {
    if (!controlWindow || controlWindow.isDestroyed()) return null;
    return controlWindow.getBounds();
  });
  ipcMain.handle("window:show-control", () => {
    createControlWindow();
    return true;
  });
  ipcMain.handle("window:hide-control", () => {
    if (controlWindow && !controlWindow.isDestroyed()) controlWindow.hide();
    return true;
  });

  ipcMain.on("overlay:ignore-mouse", (_event, ignore) => {
    if (overlayWindow && !overlayWindow.isDestroyed()) {
      overlayWindow.setIgnoreMouseEvents(Boolean(ignore), { forward: true });
    }
  });
  ipcMain.on("overlay:set-focusable", (_event, focusable) => {
    if (overlayWindow && !overlayWindow.isDestroyed()) {
      overlayWindow.setFocusable(Boolean(focusable));
      if (focusable) {
        overlayWindow.setIgnoreMouseEvents(false);
        overlayWindow.focus();
      }
    }
  });
  // —— 外部模组接口（只有模组窗口能调用，且拿不到完整状态）——
  ipcMain.handle("module:info", (event) => {
    const module = moduleRecordForSender(event.sender);
    if (!module) return null;
    return {
      id: module.id,
      name: module.name,
      version: module.version || "1.0.0",
      apiVersion: Number(module.apiVersion) || 1,
      entry: module.entry || "",
      scope: module.moduleScope,
      category: module.moduleCategory
    };
  });

  ipcMain.handle("module:app-version", () => app.getVersion());

  ipcMain.handle("module:open-external", async (event, url) => {
    if (!moduleRecordForSender(event.sender)) return { ok: false };
    const target = String(url || "").trim();
    if (!/^https?:\/\//i.test(target)) return { ok: false };
    await shell.openExternal(target);
    return { ok: true };
  });

  ipcMain.handle("module:notify", (event, title, body) => {
    if (!moduleRecordForSender(event.sender)) return { ok: false };
    if (!Notification.isSupported()) return { ok: false };
    new Notification({
      title: String(title || "ArkPet").slice(0, 80),
      body: String(body || "").slice(0, 240)
    }).show();
    return { ok: true };
  });

  ipcMain.handle("module:pets-list", (event) =>
    moduleRecordForSender(event.sender) ? modulePetSnapshot(store.get()) : []
  );

  ipcMain.handle("module:pets-active", (event) => {
    if (!moduleRecordForSender(event.sender)) return null;
    const state = store.get();
    const pet =
      (state.pets || []).find((item) => item.id === state.activePetId) ||
      (state.pets || [])[0];
    if (!pet) return null;
    return {
      id: pet.id,
      name: pet.name,
      active: true,
      summoned: (state.summonedPetIds || []).includes(pet.id),
      vitals: { ...(pet.vitals || {}) }
    };
  });

  ipcMain.handle("module:pet-command", (event, command) => {
    if (!moduleRecordForSender(event.sender)) {
      throw new Error("该操作只能由模组窗口调用。");
    }
    const allowed = new Set([
      "wake",
      "sleep",
      "rest",
      "release",
      "home",
      "walk",
      "drop",
      "show",
      "action"
    ]);
    const type = String(command?.type || "");
    if (!allowed.has(type)) {
      throw new Error(`不支持的桌宠指令：${type || "(空)"}`);
    }
    const payload = { ...command, type };
    if (payload.petId) payload.petId = String(payload.petId);
    if (type === "action") payload.name = String(payload.name || "idle");
    sendOverlayCommand(payload);
    return { ok: true };
  });

  ipcMain.handle("module:chat-ask", async (event, text, petId) => {
    if (!moduleRecordForSender(event.sender)) {
      throw new Error("该操作只能由模组窗口调用。");
    }
    const message = String(text || "").trim();
    if (!message) return { ok: false, text: "", error: "内容为空。" };
    const state = store.get();
    const pet =
      (state.pets || []).find((item) => item.id === petId) ||
      (state.pets || []).find((item) => item.id === state.activePetId) ||
      (state.pets || [])[0];
    const result = await replyWithProviders(state, message, {
      aiModuleId: pet?.modulePlugins?.aiModuleId,
      petId: pet?.id
    });
    return {
      ok: Boolean(result?.ok),
      text: String(result?.text || ""),
      error: result?.error
    };
  });

  ipcMain.handle("module:voice-speak", async (event, text) => {
    if (!moduleRecordForSender(event.sender)) {
      throw new Error("该操作只能由模组窗口调用。");
    }
    const message = String(text || "").trim();
    if (!message) return { ok: false, error: "内容为空。" };
    const state = store.get();
    const pet =
      (state.pets || []).find((item) => item.id === state.activePetId) ||
      (state.pets || [])[0];
    return synthesizeWithSelectedVoice(state, message, {
      voiceProfileId: pet?.modulePlugins?.voiceProfileId
    });
  });

  ipcMain.handle("module:storage-keys", (event) => {
    const module = moduleRecordForSender(event.sender);
    return module ? Object.keys(readModuleStorage(module.id)) : [];
  });

  ipcMain.handle("module:storage-get", (event, key) => {
    const module = moduleRecordForSender(event.sender);
    if (!module) return null;
    const data = readModuleStorage(module.id);
    const value = data[String(key)];
    return value === undefined ? null : value;
  });

  ipcMain.handle("module:storage-set", (event, key, value) => {
    const module = moduleRecordForSender(event.sender);
    if (!module) return false;
    const name = String(key || "").trim();
    if (!name) return false;
    const data = readModuleStorage(module.id);
    data[name] = value;
    writeModuleStorage(module.id, data);
    return true;
  });

  ipcMain.handle("module:storage-remove", (event, key) => {
    const module = moduleRecordForSender(event.sender);
    if (!module) return false;
    const data = readModuleStorage(module.id);
    delete data[String(key)];
    writeModuleStorage(module.id, data);
    return true;
  });

  ipcMain.handle("module:activity-log", (event, text) => {
    const module = moduleRecordForSender(event.sender);
    if (!module) return false;
    const message = String(text || "").trim();
    if (!message) return false;
    store.mutate((draft) => {
      appendActivity(
        draft,
        "module",
        `[${module.name}] ${message}`.slice(0, 160)
      );
    });
    broadcastState();
    return true;
  });

  ipcMain.handle("module:ui-close", (event) => {
    if (!moduleRecordForSender(event.sender)) return false;
    BrowserWindow.fromWebContents(event.sender)?.close();
    return true;
  });

  ipcMain.handle("module:ui-set-size", (event, width, height) => {
    if (!moduleRecordForSender(event.sender)) return false;
    const window = BrowserWindow.fromWebContents(event.sender);
    if (!window) return false;
    window.setContentSize(
      Math.round(Math.max(240, Math.min(1600, Number(width) || 480))),
      Math.round(Math.max(200, Math.min(1200, Number(height) || 520)))
    );
    return true;
  });

  ipcMain.handle("module:ui-set-title", (event, title) => {
    if (!moduleRecordForSender(event.sender)) return false;
    const window = BrowserWindow.fromWebContents(event.sender);
    if (!window) return false;
    window.setTitle(String(title || "").slice(0, 80));
    return true;
  });

  ipcMain.handle("clipboard:write", (_event, text) => {
    clipboard.writeText(String(text || ""));
    return { ok: true };
  });

  ipcMain.handle("overlay:command", (_event, command) => sendOverlayCommand(command));
  ipcMain.handle("overlay:hide", () => {
    hideOverlay();
    return true;
  });

  ipcMain.handle("auxiliary:open", (_event, auxiliaryId) => {
    const state = store.get();
    const config = state.auxiliaryWindows.find((item) => item.id === auxiliaryId);
    if (!config) throw new Error("没有找到辅助窗口配置。");
    createAuxiliaryWindow(config);
    return true;
  });
  ipcMain.handle("chat:open", (_event, mode, dialogModuleId) => {
    const state = store.get();
    const dialogModule = resolveDialogModule(
      state,
      dialogModuleId || state.settings.chat?.dialogModuleId || ""
    );
    const nextModuleId = dialogModule?.id || "";
    if (nextModuleId !== state.settings.chat?.dialogModuleId) {
      store.update({
        settings: {
          ...state.settings,
          chat: {
            ...(state.settings.chat || {}),
            dialogModuleId: nextModuleId
          }
        }
      });
      broadcastState();
    }
    createChatWindow(mode, nextModuleId);
    return true;
  });

  ipcMain.handle("assets:import-pet", async (_event, petId) => {
    const result = await dialog.showOpenDialog(controlWindow, {
      title: "导入桌宠图片素材",
      properties: ["openFile", "multiSelections"],
      filters: [
        {
          name: "图片素材",
          extensions: ["png", "webp", "gif", "jpg", "jpeg", "bmp", "svg"]
        }
      ]
    });
    if (result.canceled) return { canceled: true };

    const assets = result.filePaths.map((filePath) =>
      copyIntoAssets(filePath, path.join("pets", petId))
    );
    const state = store.mutate((draft) => {
      const pet = draft.pets.find((item) => item.id === petId);
      if (!pet) throw new Error("没有找到要导入素材的桌宠。");
      pet.assets = [...(pet.assets || []), ...assets];
      if (!pet.avatarUrl && assets[0]) pet.avatarUrl = assets[0].url;
      pet.updatedAt = new Date().toISOString();
      appendActivity(draft, "asset", `导入了 ${assets.length} 个桌宠素材。`);
    });
    broadcastState();
    return { canceled: false, assets, state };
  });

  ipcMain.handle("assets:import-spine", async (_event, petId) => {
    const skeletonResult = await dialog.showOpenDialog(controlWindow, {
      title: "选择 Spine 骨骼文件",
      properties: ["openFile"],
      filters: [{ name: "Spine 骨骼", extensions: ["skel"] }]
    });
    if (skeletonResult.canceled) return { canceled: true };

    const skeletonPath = skeletonResult.filePaths[0];
    const skeletonExtension = path.extname(skeletonPath);
    const skeletonBase = skeletonPath.slice(0, -skeletonExtension.length);
    const atlasPath = `${skeletonBase}.atlas`;
    if (!fs.existsSync(atlasPath)) {
      throw new Error("没有找到与 .skel 同名的 .atlas 文件。");
    }

    const atlasText = fs.readFileSync(atlasPath, "utf8");
    const atlasPageName = atlasText
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line.toLowerCase().endsWith(".png"));
    if (!atlasPageName) {
      throw new Error("图集文件里没有找到纹理页名称。");
    }

    let texturePath = path.join(path.dirname(skeletonPath), atlasPageName);
    if (!fs.existsSync(texturePath)) {
      const textureResult = await dialog.showOpenDialog(controlWindow, {
        title: `请选择图集纹理页 ${atlasPageName}`,
        properties: ["openFile"],
        filters: [{ name: "图集纹理", extensions: ["png", "webp", "jpg", "jpeg"] }]
      });
      if (textureResult.canceled) return { canceled: true };
      texturePath = textureResult.filePaths[0];
    }

    const folderName = `${safeFileName(path.basename(skeletonBase))}-${Date.now()}`;
    const targetDirectory = path.join(store.assetsPath, "spine", folderName);
    fs.mkdirSync(targetDirectory, { recursive: true });

    const skeletonName = path.basename(skeletonPath);
    const atlasName = path.basename(atlasPath);
    const textureName = atlasPageName;
    fs.copyFileSync(skeletonPath, path.join(targetDirectory, skeletonName));
    fs.copyFileSync(atlasPath, path.join(targetDirectory, atlasName));
    fs.copyFileSync(texturePath, path.join(targetDirectory, textureName));

    const relativeRoot = path.relative(store.assetsPath, targetDirectory);
    const spine = {
      skelUrl: assetUrl(path.join(relativeRoot, skeletonName)),
      atlasUrl: assetUrl(path.join(relativeRoot, atlasName)),
      textureUrl: assetUrl(path.join(relativeRoot, textureName)),
      folder: folderName,
      animations: []
    };

    const state = store.mutate((draft) => {
      const pet = draft.pets.find((item) => item.id === petId);
      if (!pet) throw new Error("没有找到要导入 Spine 的桌宠。");
      pet.spine = spine;
      pet.updatedAt = new Date().toISOString();
      appendActivity(draft, "asset", `导入了 Spine 角色：${skeletonName}`);
    });
    broadcastState();
    return { canceled: false, spine, state };
  });

  ipcMain.handle("spine:select-part", async (_event, kind, draftId) => {
    const filters = {
      skeleton: [{ name: "Spine 骨骼", extensions: ["skel"] }],
      atlas: [{ name: "Spine 图集", extensions: ["atlas"] }],
      texture: [{ name: "纹理页", extensions: ["png", "webp", "jpg", "jpeg"] }]
    };
    const titles = {
      skeleton: "选择 .skel 骨骼文件",
      atlas: "选择 .atlas 图集文件",
      texture: "选择纹理页 PNG"
    };
    if (!filters[kind]) throw new Error("不支持的 Spine 素材类型。");

    const result = await dialog.showOpenDialog(controlWindow, {
      title: titles[kind],
      properties: ["openFile"],
      filters: filters[kind]
    });
    if (result.canceled) return { canceled: true };

    const asset = copyIntoAssets(
      result.filePaths[0],
      path.join("spine-drafts", safeFileName(draftId))
    );
    return {
      canceled: false,
      part: {
        ...asset,
        kind
      }
    };
  });

  ipcMain.handle(
    "spine:create-from-parts",
    async (_event, draftId, parts, requestedName) => {
      if (
        !parts?.skeleton ||
        !parts?.atlas ||
        !parts?.texture ||
        !draftId
      ) {
        return { ok: false, error: "三份 Spine 文件还没有全部导入。" };
      }

      const resolveStagedPath = (part) => {
        const target = path.resolve(store.assetsPath, part.relativePath);
        const relation = path.relative(store.assetsPath, target);
        if (relation.startsWith("..") || path.isAbsolute(relation)) {
          throw new Error("素材路径无效。");
        }
        return target;
      };

      const skeletonSource = resolveStagedPath(parts.skeleton);
      const atlasSource = resolveStagedPath(parts.atlas);
      const textureSource = resolveStagedPath(parts.texture);
      if (
        !fs.existsSync(skeletonSource) ||
        !fs.existsSync(atlasSource) ||
        !fs.existsSync(textureSource)
      ) {
        return { ok: false, error: "暂存的 Spine 文件已经不存在，请重新导入。" };
      }

      const skeletonHeader = fs
        .readFileSync(skeletonSource)
        .subarray(0, 160)
        .toString("latin1");
      const version = skeletonHeader.match(/(\d+\.\d+\.\d+)/)?.[1] || "";
      if (!version.startsWith("3.8.")) {
        return {
          ok: false,
          error: `当前只支持 Spine 3.8 骨骼，检测到版本 ${version || "未知"}。`
        };
      }

      const atlasText = fs.readFileSync(atlasSource, "utf8");
      const expectedSize = atlasText.match(
        /^size:\s*(\d+)\s*,\s*(\d+)\s*$/m
      );
      const texturePageName = atlasText
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find((line) => line.toLowerCase().endsWith(".png"));
      if (!texturePageName) {
        return { ok: false, error: "图集文件中没有找到纹理页名称。" };
      }
      let textureResize = null;
      if (expectedSize) {
        const imageSize = nativeImage.createFromPath(textureSource).getSize();
        const expectedWidth = Number(expectedSize[1]);
        const expectedHeight = Number(expectedSize[2]);
        if (
          imageSize.width !== expectedWidth ||
          imageSize.height !== expectedHeight
        ) {
          textureResize = {
            width: expectedWidth,
            height: expectedHeight
          };
        }
      }

      const baseName =
        safeFileName(path.basename(parts.skeleton.name, path.extname(parts.skeleton.name))) ||
        "spine-character";
      const folderName = `${baseName}-${Date.now()}`;
      const targetDirectory = path.join(store.assetsPath, "spine", folderName);
      fs.mkdirSync(targetDirectory, { recursive: true });

      const skeletonName = `${baseName}.skel`;
      const atlasName = `${baseName}.atlas`;
      fs.copyFileSync(skeletonSource, path.join(targetDirectory, skeletonName));
      fs.copyFileSync(atlasSource, path.join(targetDirectory, atlasName));
      if (textureResize || expectedSize) {
        const width = textureResize
          ? textureResize.width
          : Number(expectedSize[1]);
        const height = textureResize
          ? textureResize.height
          : Number(expectedSize[2]);
        await sharp(textureSource)
          .resize(width, height, {
            fit: "fill",
            kernel: "lanczos3"
          })
          .sharpen({ sigma: 0.8 })
          .png()
          .toFile(path.join(targetDirectory, texturePageName));
      } else {
        fs.copyFileSync(
          textureSource,
          path.join(targetDirectory, texturePageName)
        );
      }

      const relativeRoot = path.relative(store.assetsPath, targetDirectory);
      const spine = {
        skelUrl: assetUrl(path.join(relativeRoot, skeletonName)),
        atlasUrl: assetUrl(path.join(relativeRoot, atlasName)),
        textureUrl: assetUrl(path.join(relativeRoot, texturePageName)),
        folder: folderName,
        animations: []
      };
      const now = new Date().toISOString();
      const petId = id("pet");
      const petName = String(requestedName || baseName).trim() || "新桌宠";
      const pet = {
        id: petId,
        name: petName,
        title: "Spine 3.8 角色",
        description: "由 .skel、.atlas 和纹理页创建的新桌宠。",
        accent: "#2f7df6",
        secondary: "#f59f38",
        scale: 1,
        greeting: "我在这里。",
        assets: [],
        animationMap: {
          idle: "",
          walk: "",
          fall: "",
          land: "",
          drag: "",
          sleep: ""
        },
        spine,
        boneMap: {},
        actionBindings: {},
        renderConfig: {
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
        },
        createdAt: now,
        updatedAt: now
      };

      const state = store.mutate((draft) => {
        draft.pets.push(pet);
        draft.activePetId = petId;
        draft.activeView = "workshop";
        appendActivity(draft, "asset", `创建了新桌宠：${petName}`);
      });
      broadcastState();
      return { ok: true, petId, state };
    }
  );

  ipcMain.handle("assets:import-voice-sample", async () => {
    const result = await dialog.showOpenDialog(controlWindow, {
      title: "导入声音样本",
      properties: ["openFile", "multiSelections"],
      filters: [
        {
          name: "音频素材",
          extensions: ["wav", "mp3", "m4a", "flac", "ogg", "webm"]
        }
      ]
    });
    if (result.canceled) return { canceled: true };

    const samples = result.filePaths.map((filePath) =>
      copyIntoAssets(filePath, "voice-samples")
    );
    const state = store.mutate((draft) => {
      draft.voiceProfiles.unshift({
        id: id("voice"),
        name: `声音样本 ${draft.voiceProfiles.length + 1}`,
        samples,
        voiceId: "",
        engineType: "api",
        baseUrl: draft.settings.services.tts.baseUrl || "",
        model: draft.settings.services.tts.model || "",
        apiKey: draft.settings.services.tts.apiKey || "",
        localModelPath: "",
        status: "draft",
        createdAt: new Date().toISOString()
      });
      appendActivity(draft, "voice", `导入了 ${samples.length} 个声音样本。`);
    });
    broadcastState();
    return { canceled: false, samples, state };
  });

  ipcMain.handle("voice-lines:import", async (_event, petId) => {
    const result = await dialog.showOpenDialog(controlWindow, {
      title: "导入角色语音（WAV）",
      properties: ["openFile", "multiSelections"],
      filters: [{ name: "WAV 音频", extensions: ["wav"] }]
    });
    if (result.canceled) return { canceled: true };
    const clips = result.filePaths.map((filePath) =>
      copyIntoAssets(
        filePath,
        path.join("voice-lines", safeFileName(petId || "pet"))
      )
    );
    const state = store.mutate((draft) => {
      const pet = draft.pets.find((item) => item.id === petId);
      if (!pet) throw new Error("没有找到要导入语音的桌宠。");
      const current = isPlainObject(pet.voiceLines) ? pet.voiceLines : {};
      pet.voiceLines = {
        enabled: current.enabled !== false,
        intervalSeconds: Math.max(5, Number(current.intervalSeconds || 60)),
        probability: Math.max(
          0,
          Math.min(100, Number(current.probability ?? 60))
        ),
        clips: [
          ...(Array.isArray(current.clips) ? current.clips : []),
          ...clips
        ]
      };
      appendActivity(
        draft,
        "voice",
        `导入了 ${clips.length} 段角色语音。`,
        petId
      );
    });
    broadcastState();
    return { canceled: false, clips, state };
  });

  ipcMain.handle("voice-lines:remove", (_event, petId, clipId) => {
    const state = store.mutate((draft) => {
      const pet = draft.pets.find((item) => item.id === petId);
      if (!pet || !isPlainObject(pet.voiceLines)) return;
      const clips = Array.isArray(pet.voiceLines.clips)
        ? pet.voiceLines.clips
        : [];
      const clip = clips.find((item) => item.id === clipId);
      if (clip?.relativePath) {
        const target = path.resolve(
          store.assetsPath,
          String(clip.relativePath)
        );
        const relation = path.relative(store.assetsPath, target);
        if (!relation.startsWith("..") && !path.isAbsolute(relation)) {
          fs.rmSync(target, { force: true });
        }
      }
      pet.voiceLines.clips = clips.filter((item) => item.id !== clipId);
    });
    broadcastState();
    return state;
  });

  ipcMain.handle("voice:stage-samples", async (_event, draftId) => {
    const result = await dialog.showOpenDialog(controlWindow, {
      title: "选择声音样本",
      properties: ["openFile", "multiSelections"],
      filters: [
        {
          name: "音频素材",
          extensions: ["wav", "mp3", "m4a", "flac", "ogg", "webm"]
        }
      ]
    });
    if (result.canceled) return { canceled: true };
    return {
      canceled: false,
      samples: result.filePaths.map((filePath) =>
        copyIntoAssets(
          filePath,
          path.join("voice-staging", safeFileName(draftId || "draft"))
        )
      )
    };
  });

  ipcMain.handle("voice:remove-staged-sample", (_event, relativePath) => {
    const target = path.resolve(store.assetsPath, String(relativePath || ""));
    const relation = path.relative(store.assetsPath, target);
    if (
      relation.startsWith("..") ||
      path.isAbsolute(relation) ||
      !relation.startsWith(`voice-staging${path.sep}`)
    ) {
      throw new Error("声音样本路径无效。");
    }
    fs.rmSync(target, { force: true });
    return true;
  });

  ipcMain.handle(
    "voice-training:transcribe-sample",
    async (_event, relativePath) => {
      const target = path.resolve(store.assetsPath, String(relativePath || ""));
      const relation = path.relative(store.assetsPath, target);
      if (relation.startsWith("..") || path.isAbsolute(relation)) {
        return { ok: false, error: "训练音频路径无效。" };
      }
      if (!fs.existsSync(target)) {
        return { ok: false, error: "训练音频文件不存在。" };
      }
      const response = await transcribeWithProviders(store.get(), target);
      return {
        ...response,
        durationSeconds: getAudioDuration(target)
      };
    }
  );

  ipcMain.handle("voice-training:runtime", () => getVoiceTrainingRuntime());

  ipcMain.handle(
    "voice-training:prepare",
    (_event, profileId, clips) => {
      const runtime = getVoiceTrainingRuntime();
      if (!runtime.ready) {
        return { ok: false, error: runtime.message };
      }
      const validClips = (clips || []).filter(
        (clip) => clip.relativePath && clip.transcript?.trim()
      );
      const totalSeconds = validClips.reduce(
        (total, clip) => total + Number(clip.durationSeconds || 0),
        0
      );
      if (validClips.length < 3 && totalSeconds < 60) {
        return {
          ok: false,
          error: "至少需要 3 段音频，或总时长超过 1 分钟。"
        };
      }
      const folder = path.join(
        store.userDataPath,
        "voice-training",
        safeFileName(profileId || "voice")
      );
      fs.mkdirSync(folder, { recursive: true });
      const datasetPath = path.join(folder, "dataset.jsonl");
      const content = validClips
        .map((clip) =>
          JSON.stringify({
            audio: path.join(store.assetsPath, clip.relativePath),
            text: clip.transcript.trim(),
            duration: Number(clip.durationSeconds || 0)
          })
        )
        .join("\n");
      fs.writeFileSync(datasetPath, content, "utf8");
      return { ok: true, datasetPath };
    }
  );

  ipcMain.handle("models:choose", async (_event, kind, mode) => {
    const directoryMode =
      kind === "asr" || mode === "folder";
    const result = await dialog.showOpenDialog(controlWindow, {
      title:
        mode === "folder"
          ? "选择完整模型文件夹"
          : kind === "tts"
          ? "选择 GPT-SoVITS 声线权重文件（.ckpt 或 .pth）"
          : kind === "asr"
            ? "选择 Whisper 模型文件夹"
            : "选择本地对话模型文件",
      properties: directoryMode ? ["openDirectory"] : ["openFile"],
      filters:
        kind === "llm"
          ? [
              {
                name: "本地对话模型",
                extensions: ["safetensors", "gguf"]
              }
            ]
          : undefined
    });
    if (result.canceled) return { canceled: true };
    return { canceled: false, path: result.filePaths[0] };
  });

  ipcMain.handle(
    "modules:create-example",
    (_event, manifestText, htmlText) => {
      const root = externalModulesRoot();
      const folder = path.join(root, "example-module");
      fs.mkdirSync(folder, { recursive: true });
      fs.writeFileSync(
        path.join(folder, "module.json"),
        String(manifestText || "{}"),
        "utf8"
      );
      fs.writeFileSync(
        path.join(folder, "index.html"),
        String(htmlText || ""),
        "utf8"
      );
      loadExternalModules();
      broadcastState();
      return { ok: true, folder };
    }
  );

  ipcMain.handle("modules:import-folder", async () => {
    const result = await dialog.showOpenDialog(controlWindow, {
      title: "选择模组文件夹",
      properties: ["openDirectory"]
    });
    if (result.canceled) return { canceled: true };
    try {
      const source = result.filePaths[0];
        const installed = installLocalModuleDirectory(source);
        return { canceled: false, module: installed, state: store.get() };
    } catch (error) {
      return {
        canceled: false,
        error: error.message || "模组文件夹导入失败。"
      };
    }
  });
    ipcMain.handle("modules:import-file", () => importModuleArchive());
    ipcMain.handle("modules:registry-list", (_event, force) =>
      listRegistryModules(Boolean(force))
    );
    ipcMain.handle("modules:install-registry", async (_event, moduleId) => {
      try {
        const result = await installRegistryModule(String(moduleId || ""));
        return { ...result, state: store.get() };
      } catch (error) {
        return { ok: false, error: error?.message || "安装官方模组失败。" };
      }
    });

  ipcMain.handle("modules:open-external", (_event, moduleId) => {
    openExternalModuleWindow(moduleId);
    return true;
  });
  ipcMain.handle("modules:trigger", (_event, moduleId, petId, origin) =>
    triggerModuleAction(moduleId, petId, origin)
  );

  ipcMain.handle("modules:choose-image", async (_event, moduleId, slot) => {
    const result = await dialog.showOpenDialog(controlWindow, {
      title: "选择模组图片",
      properties: ["openFile"],
      filters: [
        {
          name: "图片",
          extensions: ["png", "jpg", "jpeg", "webp", "gif", "bmp"]
        }
      ]
    });
    if (result.canceled) return { canceled: true };
    try {
      const asset = copyIntoAssets(
        result.filePaths[0],
        path.join("module-assets", safeFileName(moduleId))
      );
      return { canceled: false, url: asset.url, slot };
    } catch (error) {
      return {
        canceled: false,
        error: error.message || "图片导入失败。"
      };
    }
  });

  ipcMain.handle("food:consume", async (_event, foodPath, options = {}) => {
    const target = path.resolve(String(foodPath || ""));
    const desktopRoot = path.resolve(app.getPath("desktop"));
    const relation = path.relative(desktopRoot, target);
    const allowOutsideDesktop = options?.allowOutsideDesktop === true;
    const blockedRoots = [
      process.env.WINDIR,
      process.env.ProgramFiles,
      process.env["ProgramFiles(x86)"],
      process.resourcesPath,
      app.getAppPath()
    ]
      .filter(Boolean)
      .map((item) => path.resolve(String(item)));
    const insideBlockedRoot = blockedRoots.some((blockedRoot) => {
      const blockedRelation = path.relative(blockedRoot, target);
      return (
        blockedRelation === "" ||
        (!blockedRelation.startsWith("..") &&
          !path.isAbsolute(blockedRelation))
      );
    });
    if (
      insideBlockedRoot ||
      (!allowOutsideDesktop &&
        (relation.startsWith("..") || path.isAbsolute(relation))) ||
      path.extname(target).toLowerCase() !== ".food"
    ) {
      return { ok: false, error: "食物文件路径无效。" };
    }
    if (!fs.existsSync(target)) {
      return { ok: false, error: "这个食物文件已经不存在。" };
    }
    try {
      await shell.trashItem(target);
      return { ok: true };
    } catch (error) {
      return {
        ok: false,
        error: error?.message || "无法吃掉这个食物文件。"
      };
    }
  });

  ipcMain.handle("models:inspect", (_event, kind, sourcePath) => {
    try {
      const now = new Date().toISOString();
      const inspection = inspectLocalModel(kind, sourcePath);
      return {
        ok: true,
        model: {
          id: id("model"),
          ...inspection,
          createdAt: now,
          updatedAt: now
        }
      };
    } catch (error) {
      return { ok: false, error: error.message || "无法读取模型文件。" };
    }
  });

  ipcMain.handle("models:add", (_event, model) => {
    const state = store.mutate((draft) => {
      const existingIndex = draft.localModels.findIndex(
        (item) =>
          item.kind === model.kind &&
          path.resolve(item.sourcePath) === path.resolve(model.sourcePath)
      );
      if (existingIndex >= 0) {
        draft.localModels[existingIndex] = {
          ...draft.localModels[existingIndex],
          ...model,
          updatedAt: new Date().toISOString()
        };
      } else {
        draft.localModels.unshift(model);
      }
      appendActivity(draft, "model", `已导入本地模型：${model.name}`);
    });
    broadcastState();
    return state;
  });

  ipcMain.handle("models:remove", (_event, modelId) => {
    const state = store.mutate((draft) => {
      draft.localModels = draft.localModels.filter(
        (model) => model.id !== modelId
      );
    });
    broadcastState();
    return state;
  });

  ipcMain.handle("services:test", async (_event, service) => {
    const config = store.get().settings.services?.[service];
    if (
      service === "tts" &&
      (config?.mode || "local") === "local" &&
      isBundledVoiceService({
        baseUrl: config?.baseUrl || VOICE_SERVICE_URL
      })
    ) {
      const serviceState = await ensureVoiceService();
      if (!serviceState.ok) return serviceState;
    }
    const result = await ai.testLocalService(config, service);
    if (result.ok && (config?.mode || "local") === "api") {
      registerApiServiceModel(service, config);
      broadcastState();
    }
    return result;
  });
  ipcMain.handle("ai:chat", async (_event, messages, aiModuleId, petId) => {
    const state = store.get();
    const text = [...messages]
      .reverse()
      .find((message) => message.role === "user")?.content;
    return replyWithProviders(state, String(text || ""), {
      aiModuleId,
      petId
    });
  });
  ipcMain.handle("ai:chat-stream", async (event, messages, aiModuleId, requestId, petId) => {
    const state = store.get();
    const text = [...messages]
      .reverse()
      .find((message) => message.role === "user")?.content;
    const userText = String(text || "");
    const aiModule = resolveAiModule(state, { aiModuleId });
    const replyState = buildReplyState(state, aiModule, { petId });
    const streamId = String(requestId || aiModuleId || "");
    const emitDelta = (delta) => {
      if (delta && !event.sender.isDestroyed()) {
        event.sender.send("ai:chat-stream", { delta, requestId: streamId });
      }
    };
    if ((state.settings?.services?.llm?.mode || "local") === "api") {
      return ai.chatLocalStream(
        replyState,
        [{ role: "user", content: userText }],
        emitDelta
      );
    }
    const result = await replyWithProviders(state, userText, {
      aiModuleId,
      petId
    });
    emitDelta(result.text);
    return result;
  });
  ipcMain.handle("voice:speak", async (_event, text, voiceId, voiceConfig) => {
    const state = store.get();
    return synthesizeWithSelectedVoice(state, text, {
      ...(voiceConfig || {}),
      voiceId
    });
  });

  ipcMain.handle("voice-agent:set-model", (_event, kind, modelId) => {
    const key =
      kind === "llm"
        ? "llmModelId"
        : kind === "asr"
          ? "asrModelId"
          : "ttsModelId";
    const selectedModel = store
      .get()
      .localModels.find((model) => model.id === modelId);
    const state = store.mutate((draft) => {
      draft.localInference = {
        ...draft.localInference,
        [key]: String(modelId || "")
      };
      if (selectedModel?.format === "api" && selectedModel.apiConfig) {
        draft.settings.services[kind] = {
          ...selectedModel.apiConfig,
          mode: "api"
        };
      }
    });
    broadcastState();
    if (kind === "llm" || kind === "asr") {
      localInference.preload(state, kind)?.catch(() => {
        // The normal request path will show a detailed error if loading fails.
      });
    }
    return state;
  });
  ipcMain.handle("voice-agent:transcribe", (_event, audioBytes) =>
    voiceAgent.transcribe(audioBytes)
  );
  ipcMain.handle("voice-agent:reply", (_event, text, options) =>
    voiceAgent.reply(String(text || ""), options || {})
  );
  ipcMain.handle("voice-agent:speak", (_event, text, options) =>
    voiceAgent.speak(String(text || ""), options || {})
  );
  ipcMain.handle("voice-agent:turn", (_event, audioBytes, options) =>
    voiceAgent.onUserAudio(audioBytes, options || {})
  );
  ipcMain.handle("voice:engine-info", async () => ({
    device: voiceServiceDevice,
    label: voiceServiceRuntimeLabel,
    cudaAvailable: await hasCudaGpu(),
    runtimes: resolveVoiceServiceRuntimes().map((candidate) => ({
      label: candidate.label,
      device: candidate.device,
      exists: fs.existsSync(candidate.pythonPath)
    }))
  }));
  ipcMain.handle("shell:open-external", async (_event, url) => {
    await shell.openExternal(url);
    return { ok: true };
  });
  ipcMain.handle("voice-agent:warmup", async () => {
    const state = store.get();
    const result = { asr: false, tts: false, llm: false, errors: [] };
    try {
      await localInference.preload(state, "asr");
      result.asr = true;
    } catch (error) {
      result.errors.push(`asr: ${error?.message || "语音识别预热失败"}`);
    }
    try {
      await localInference.preload(state, "llm");
      result.llm = true;
    } catch (error) {
      result.errors.push(`llm: ${error?.message || "对话模型预热失败"}`);
    }
    try {
      const serviceState = await ensureVoiceService();
      if (serviceState.ok) {
        result.tts = true;
        await primeVoiceWeights(state).catch(() => {});
      } else {
        result.errors.push(
          `tts: ${serviceState.error || "语音合成服务未就绪"}`
        );
      }
    } catch (error) {
      result.errors.push(`tts: ${error?.message || "语音合成预热失败"}`);
    }
    return result;
  });
  

  function voiceEngineStatusPayload() {
    const persisted = readVoiceEngineConfig();
    const inspection = inspectVoiceEngine(VOICE_ENGINE_ROOT);
    return {
      installed: inspection.ok,
      root: VOICE_ENGINE_ROOT,
      engineDir: inspection.engineDir,
      missing: inspection.missing,
      customRoot: persisted.root,
      restartRequired: persisted.root !== VOICE_ENGINE_CONFIG.root,
      source: persisted.root ? "custom" : inspection.ok ? "bundled" : "missing",
      message: inspection.ok
        ? "语音引擎已就绪"
        : "未检测到可用的语音引擎"
    };
  }

  ipcMain.handle("voice-engine:status", () => voiceEngineStatusPayload());

  ipcMain.handle("voice-engine:choose", async () => {
    const result = await dialog.showOpenDialog(controlWindow, {
      title: "选择解压后的 GPT-SoVITS 语音引擎文件夹",
      properties: ["openDirectory"]
    });
    if (result.canceled || !result.filePaths?.[0]) {
      return { canceled: true };
    }
    const picked = result.filePaths[0];
    const inspection = inspectVoiceEngine(picked);
    if (!inspection.ok) {
      return {
        ok: false,
        error: `这个文件夹里缺少：${inspection.missing.join(
          "、"
        )}。请选择解压后包含 api_v2.py 的 GPT-SoVITS 目录。`
      };
    }
    writeVoiceEngineConfig({ root: picked });
    return {
      ok: true,
      restartRequired: true,
      engineDir: inspection.engineDir
    };
  });

  ipcMain.handle("voice-engine:clear", () => {
    writeVoiceEngineConfig({ root: "" });
    return { ok: true, restartRequired: true };
  });

  ipcMain.handle("voice-engine:open-download", async () => {
    await shell.openExternal(VOICE_ENGINE_DOWNLOAD_URL);
    return { ok: true };
  });

  ipcMain.handle("app:relaunch", () => {
    app.relaunch();
    app.exit(0);
    return { ok: true };
  });

ipcMain.handle("ttsInstallStatus", () => {
    const state = store.get();
    const ttsModels = state.localModels?.filter((m) => m.kind === "tts") || [];
    const readyModel = ttsModels.find((m) => m.status === "ready");

    let gptInstalled = false;
    let sovitsInstalled = false;

    for (const m of ttsModels) {
      const paths = [m.sourcePath || "", ...(m.companionPaths || [])];
      for (const p of paths) {
        const ext = path.extname(p || "").toLowerCase();
        if (ext === ".ckpt") gptInstalled = true;
        if (ext === ".pth") sovitsInstalled = true;
      }
    }

    if (readyModel) {
      gptInstalled = true;
      sovitsInstalled = true;
    }

    // 语音档案里配置了本地 GPT-SoVITS 服务，也视为已安装
    const hasLocalVoiceProfile = (state.voiceProfiles || []).some((p) => {
      if (p.engineType !== "gpt-sovits") return false;
      const baseUrl = String(p.baseUrl || "");
      if (!baseUrl) return false;
      try {
        const url = new URL(baseUrl);
        return url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "::1";
      } catch {
        return false;
      }
    });

    if (hasLocalVoiceProfile) {
      gptInstalled = true;
      sovitsInstalled = true;
    }

    const installed = gptInstalled && sovitsInstalled;

    return {
      installed,
      engine: "gpt-sovits",
      gptInstalled,
      sovitsInstalled,
      message: installed
        ? "已安装 GPT-SoVITS 语音合成模型"
        : "未检测到 GPT-SoVITS 语音合成模型文件"
    };
  });

  ipcMain.handle("ttsOpenDownload", async (_event, engine) => {
    const url = "https://github.com/RVC-Boss/GPT-SoVITS/releases";
    await shell.openExternal(url);
    return { ok: true };
  });

  ipcMain.handle("ttsRemoveSelection", () => {
    const state = store.mutate((draft) => {
      const ttsIndex = draft.localModels.findIndex(
        (m) => m.kind === "tts"
      );
      if (ttsIndex >= 0) {
        draft.localModels.splice(ttsIndex, 1);
      }
      draft.localInference.ttsModelId = "";
    });
    broadcastState();
    return state;
  });

  ipcMain.handle(
    "voice-agent:turn-stream",
    async (event, audioBytes, options = {}) => {
      const sessionId = String(options?.sessionId || "");
      const send = (channel, payload) => {
        if (!event.sender.isDestroyed()) event.sender.send(channel, payload);
      };
      const transcription = await transcribeAudioBytes(audioBytes);
      if (!transcription.ok || !transcription.text) {
        return {
          ok: false,
          error: transcription.error || "没有识别到有效语音。",
          transcription
        };
      }
      send("voice-agent:transcript", {
        sessionId,
        text: transcription.text
      });

      const state = store.get();
      const sentenceBuffer = createSentenceBuffer();
      let spokenCount = 0;
      let spokenChain = Promise.resolve();
      const speakSentence = async (sentence) => {
        const clean = ai.sanitizeCharacterReply(sentence);
        if (!clean) return;
        const speech = await synthesizeWithSelectedVoice(
          store.get(),
          clean,
          options || {}
        );
        if (!speech.ok || !speech.audioDataUrl) return;
        send("voice-agent:audio", {
          sessionId,
          index: spokenCount,
          text: clean,
          audioDataUrl: speech.audioDataUrl
        });
        spokenCount += 1;
      };
      const enqueueSentence = (sentence) => {
        spokenChain = spokenChain
          .then(() => speakSentence(sentence))
          .catch(() => {});
      };

      let finalText = "";
      const aiModuleId = options?.aiModuleId;
        const petId = options?.petId;
      if ((state.settings?.services?.llm?.mode || "local") === "api") {
        const aiModule = resolveAiModule(state, { aiModuleId });
          const replyState = buildReplyState(state, aiModule, { petId });
        const result = await ai.chatLocalStream(
          replyState,
          [{ role: "user", content: transcription.text }],
          (delta) => {
            sentenceBuffer.push(delta).forEach(enqueueSentence);
          }
        );
        finalText = String(result?.text || "");
      } else {
        let streamed = false;
        const result = await replyWithProviders(state, transcription.text, {
          aiModuleId,
            petId,
          onDelta: (delta) => {
            if (!delta) return;
            streamed = true;
            sentenceBuffer.push(delta).forEach(enqueueSentence);
          }
        });
        finalText = String(result?.text || "");
        if (!streamed) {
          sentenceBuffer.push(finalText).forEach(enqueueSentence);
        }
      }
      sentenceBuffer.flush().forEach(enqueueSentence);
      await spokenChain;
      return {
        ok: Boolean(finalText),
        text: finalText,
        transcript: transcription.text,
        spokenCount
      };
    }
  );

  ipcMain.handle("training:start", (_event, profileId) => {
    const state = store.get();
    const profile =
      state.trainingProfiles.find((item) => item.id === profileId) ||
      state.trainingProfiles[0];
    if (!profile) return { ok: false, error: "没有可训练的 AI 模块。" };

    const config = profile.trainingConfig || {
      baseModel: "Qwen/Qwen2.5-7B-Instruct",
      epochs: 3,
      learningRate: 0.0002,
      batchSize: 1,
      maxLength: 1024
    };
    const moduleId = profile.id;
    const moduleDir = path.join(store.userDataPath, "ai-modules", moduleId);
    const datasetPath = path.join(moduleDir, "dataset.jsonl");
    const configPath = path.join(moduleDir, "training.json");
    const logPath = path.join(moduleDir, "train.log");
    const outputPath = path.join(moduleDir, "lora-output");
    fs.mkdirSync(moduleDir, { recursive: true });
    fs.writeFileSync(datasetPath, buildTrainingDataset(profile), "utf8");
    fs.writeFileSync(
      configPath,
      JSON.stringify(
        {
          baseModel: config.baseModel,
          datasetPath,
          outputPath,
          epochs: config.epochs,
          learningRate: config.learningRate,
          batchSize: config.batchSize,
          maxLength: config.maxLength
        },
        null,
        2
      ),
      "utf8"
    );

    const now = new Date().toISOString();
    const nextModule = {
      id: moduleId,
      name: profile.name,
      description: profile.character?.personality || "本地角色模块",
      status: "training",
      sourceProfileId: profile.id,
      skillPrompt: ai.buildProfileSkillPrompt(profile),
      training: {
        baseModel: config.baseModel,
        datasetPath,
        configPath,
        logPath,
        outputPath,
        progress: 0,
        startedAt: now
      },
      createdAt: now,
      updatedAt: now
    };
    store.mutate((draft) => {
      const existing = draft.aiModules.find((item) => item.id === moduleId);
      if (existing) {
        Object.assign(existing, nextModule, {
          createdAt: existing.createdAt || now
        });
      } else {
        draft.aiModules.unshift(nextModule);
      }
      const trainingProfile = draft.trainingProfiles.find(
        (item) => item.id === profile.id
      );
      if (trainingProfile) {
        trainingProfile.status = "training";
        trainingProfile.updatedAt = now;
      }
    });
    broadcastState();

    const python = process.platform === "win32" ? "python" : "python3";
    const scriptPath = path.join(__dirname, "..", "scripts", "train_lora.py");
    const child = spawn(python, [scriptPath, "--config", configPath], {
      cwd: path.join(__dirname, ".."),
      windowsHide: true
    });
    const logStream = fs.createWriteStream(logPath, { flags: "a" });
    child.stdout.pipe(logStream);
    child.stderr.pipe(logStream);
    child.on("error", (error) => {
      logStream.write(`\n[runner] ${error.message}\n`);
      store.mutate((draft) => {
        const module = draft.aiModules.find((item) => item.id === moduleId);
        if (module) {
          module.status = "draft";
          module.training = {
            ...(module.training || {}),
            error: error.message
          };
          module.updatedAt = new Date().toISOString();
        }
        const trainingProfile = draft.trainingProfiles.find(
          (item) => item.id === profile.id
        );
        if (trainingProfile) trainingProfile.status = "draft";
      });
      broadcastState();
    });
    child.on("close", (code) => {
      store.mutate((draft) => {
        const module = draft.aiModules.find((item) => item.id === moduleId);
        if (module) {
          module.status = code === 0 ? "ready" : "draft";
          module.training = {
            ...(module.training || {}),
            progress: code === 0 ? 100 : Number(module.training?.progress || 0),
            finishedAt: new Date().toISOString(),
            error: code === 0 ? undefined : `训练进程退出码 ${code}`
          };
          module.updatedAt = new Date().toISOString();
        }
        const trainingProfile = draft.trainingProfiles.find(
          (item) => item.id === profile.id
        );
        if (trainingProfile) {
          trainingProfile.status = code === 0 ? "ready" : "draft";
        }
      });
      broadcastState();
    });

    return { ok: true, moduleId, logPath, outputPath };
  });

  ipcMain.handle("training:open-folder", (_event, moduleId) => {
    const folder = path.join(store.userDataPath, "ai-modules", moduleId);
    fs.mkdirSync(folder, { recursive: true });
    shell.openPath(folder);
    return true;
  });
  ipcMain.handle("voice:transcribe-file", async () => {
    const result = await dialog.showOpenDialog(controlWindow, {
      title: "选择要识别的音频",
      properties: ["openFile"],
      filters: [
        {
          name: "音频文件",
          extensions: ["wav", "mp3", "m4a", "flac", "ogg", "webm"]
        }
      ]
    });
    if (result.canceled) return { canceled: true };
    const response = await transcribeWithProviders(
      store.get(),
      result.filePaths[0]
    );
    return { canceled: false, ...response };
  });

  ipcMain.handle("data:get-paths", () => ({
    dataPath: store.userDataPath,
    statePath: store.filePath,
    assetsPath: store.assetsPath,
    petStorePath: store.petStorePath,
    softwarePath: app.isPackaged ? path.dirname(process.execPath) : app.getAppPath(),
    softwareDataPath: path.dirname(store.userDataPath),
    appPath: app.getAppPath(),
    updateCachePath: path.join(app.getPath("temp"), "arkpet-updates")
  }));
  ipcMain.handle("data:sync-pet-store", () => {
    const count = store.syncPetStore();
    return { ok: true, count };
  });
  ipcMain.handle("data:open-pet-store", async () => {
    await shell.openPath(store.petStorePath);
    return true;
  });
  ipcMain.handle("data:open-folder", async () => {
    await shell.openPath(store.userDataPath);
    return true;
  });
  ipcMain.handle("data:open-software-folder", async () => {
    await shell.openPath(
      app.isPackaged ? path.dirname(process.execPath) : app.getAppPath()
    );
    return true;
  });
  ipcMain.handle("data:export-backup", async () => {
    const result = await dialog.showOpenDialog(controlWindow, {
      title: "选择备份文件夹",
      properties: ["openDirectory", "createDirectory"]
    });
    if (result.canceled) return { canceled: true };
    const folder = path.join(
      result.filePaths[0],
      `desk-pet-backup-${new Date().toISOString().slice(0, 10)}`
    );
    fs.mkdirSync(folder, { recursive: true });
    fs.copyFileSync(store.filePath, path.join(folder, "desk-pet-state.json"));
    if (fs.existsSync(store.assetsPath)) {
      fs.cpSync(store.assetsPath, path.join(folder, "assets"), {
        recursive: true,
        force: true
      });
    }
    await shell.openPath(folder);
    return { canceled: false, folder };
  });
  ipcMain.handle("data:import-backup", async () => {
    const result = await dialog.showOpenDialog(controlWindow, {
      title: "选择备份数据文件",
      properties: ["openFile"],
      filters: [{ name: "桌宠备份", extensions: ["json"] }]
    });
    if (result.canceled) return { canceled: true };
    try {
      const backupFile = result.filePaths[0];
      const parsed = JSON.parse(fs.readFileSync(backupFile, "utf8"));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return {
          canceled: false,
          ok: false,
          error: "备份文件内容不是有效的桌宠数据。"
        };
      }
      const backupAssets = path.join(path.dirname(backupFile), "assets");
      if (fs.existsSync(backupAssets)) {
        fs.mkdirSync(store.assetsPath, { recursive: true });
        fs.cpSync(backupAssets, store.assetsPath, {
          recursive: true,
          force: true
        });
      }
      const state = store.replace(parsed);
      broadcastState();
      applyOverlaySettings();
      return { canceled: false, ok: true, state };
    } catch (error) {
      return {
        canceled: false,
        ok: false,
        error: error?.message || "导入备份失败。"
      };
    }
  });
  ipcMain.handle("app:quit", () => {
    isQuitting = true;
    app.quit();
    return true;
  });
  ipcMain.handle("update:status", () => ({ ...updateRuntime }));
  ipcMain.handle("update:check", () => checkForUpdates({ force: false }));
  ipcMain.handle("update:install", () => {
    updateCheckPromise = null;
    const launched = launchDownloadedUpdate();
    if (!launched) return false;
    isQuitting = true;
    app.quit();
    return true;
  });
}

async function registerAssetProtocol() {
  protocol.handle("deskpet", async (request) => {
    try {
      const url = new URL(request.url);
      const relative = decodeURIComponent(url.pathname).replace(/^[/\\]+/, "");
      const root = path.resolve(store.assetsPath);
      const target = path.resolve(root, relative);
      const relation = path.relative(root, target);
      if (relation.startsWith("..") || path.isAbsolute(relation)) {
        return new Response("Forbidden", { status: 403 });
      }
      const extension = path.extname(target).toLowerCase();
      const mimeTypes = {
        ".png": "image/png",
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".webp": "image/webp",
        ".gif": "image/gif",
        ".bmp": "image/bmp",
        ".svg": "image/svg+xml",
        ".wav": "audio/wav",
        ".mp3": "audio/mpeg",
        ".m4a": "audio/mp4",
        ".flac": "audio/flac",
        ".ogg": "audio/ogg",
        ".webm": "audio/webm"
      };
      return new Response(fs.readFileSync(target), {
        headers: {
          "Content-Type": mimeTypes[extension] || "application/octet-stream",
          "Cache-Control": "no-cache"
        }
      });
    } catch (error) {
      return new Response(error.message || "Not found", { status: 404 });
    }
  });
}

const singleInstance = app.requestSingleInstanceLock();
if (!singleInstance) {
  app.quit();
} else {
  app.on("second-instance", () => {
    createControlWindow();
  });

  app.whenReady().then(async () => {
    copySeedUserData(portableDataPath);
    session.defaultSession.setPermissionRequestHandler(
      (_webContents, permission, callback) => {
        callback(permission === "media");
      }
    );
    fs.mkdirSync(portableDataPath, { recursive: true });

    store = new Store(app.getPath("userData"));
    store.load();
      // 每次完整退出后重新启动，都从首页总览开始。
      store.mutate((draft) => {
        draft.activeView = "home";
      });
    if (process.env.ARKPET_PHYSICS_DEBUG === "1") {
      store.mutate((draft) => {
        draft.summonedPetIds = [draft.activePetId];
      });
    }
    loadExternalModules();
    const initialState = store.get();
    // 本地模型不随启动加载：首次真正用到时再载入，空闲 10 分钟后自动释放，避免常驻内存。
    await registerAssetProtocol();
    registerIpc();
    createControlWindow();
    createOverlayWindow();

      // 自动检查更新：只在正式安装包中运行，下载内容放在临时目录，
      // 永不写入 userData，退出时再替换软件文件。
      if (app.isPackaged) {
        setTimeout(() => {
          void checkForUpdates({ force: false });
        }, 15000);
      }

    // 声音模块不阻塞启动：窗口显示后再异步预热语音服务，
    // 首次真正使用时也会按需启动（synthesizeWithSelectedVoice 里会再次调用）。
    if (initialState.voiceProfiles?.length) {
      setTimeout(() => {
        ensureVoiceService().catch(() => {
          // Voice synthesis will start it again on demand if preloading fails.
        });
      }, 0);
    }

    screen.on("display-metrics-changed", () => {
      positionOverlay();
    });
    screen.on("display-added", positionOverlay);
    screen.on("display-removed", positionOverlay);
  });
}

app.on("before-quit", () => {
  isQuitting = true;
  if (updateRuntime.status === "ready") {
    launchDownloadedUpdate();
  }
  stopOwnedVoiceService();
  localInference.stopAll();
});

app.on("window-all-closed", () => {
  if (isQuitting) app.quit();
});

app.on("activate", () => {
  createControlWindow();
});
