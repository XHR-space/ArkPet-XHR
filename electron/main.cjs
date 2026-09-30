const {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  nativeImage,
  protocol,
  screen,
  shell
} = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { spawn, spawnSync } = require("node:child_process");
const sharp = require("sharp");
const { pathToFileURL } = require("node:url");
const { Store, id } = require("./store.cjs");
const ai = require("./ai.cjs");

const portableDataPath = path.join(__dirname, "..", "user-data");
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

function appendActivity(draft, type, text) {
  draft.activity.unshift({
    id: id("activity"),
    type,
    text,
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
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send("store:changed", state);
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
    title: "桌宠工房",
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
      appendActivity(draft, "wake", "桌宠从管理窗口释放到桌面。");
    } else if (command.type === "wake") {
      draft.summonedPetIds = Array.from(
        new Set([...draft.summonedPetIds, petId])
      );
      draft.stats.wakeCount += 1;
      appendActivity(draft, "wake", "桌宠被唤醒。");
    } else if (command.type === "sleep") {
      draft.summonedPetIds = draft.summonedPetIds.filter(
        (id) => id !== petId
      );
      appendActivity(draft, "rest", "桌宠开始放松并进入休眠。");
    } else if (command.type === "rest") {
      appendActivity(draft, "rest", "桌宠在桌面上进入休眠。");
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

function safeFileName(value) {
  return String(value || "asset")
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "-")
    .replace(/\s+/g, "-")
    .slice(0, 80);
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

  ipcMain.handle("display:get-metrics", () => getPrimaryMetrics());
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

  ipcMain.handle("services:test", (_event, service) => {
    const config = store.get().settings.services?.[service];
    return ai.testLocalService(config);
  });
  ipcMain.handle("ai:chat", (_event, messages) => {
    const state = store.get();
    return ai.chatLocal(state, messages);
  });
  ipcMain.handle("voice:speak", (_event, text, voiceId, voiceConfig) => {
    const state = store.get();
    const nextVoiceConfig = { ...(voiceConfig || {}) };
    if (nextVoiceConfig.engineType === "gpt-sovits") {
      const profile = state.voiceProfiles.find(
        (item) => item.id === nextVoiceConfig.voiceProfileId
      );
      const sample = profile?.samples?.[0];
      if (sample?.relativePath) {
        const sourcePath = path.join(
          store.assetsPath,
          sample.relativePath
        );
        const referenceDir = path.join(os.tmpdir(), "desk-pet-voice");
        fs.mkdirSync(referenceDir, { recursive: true });
        const referencePath = path.join(
          referenceDir,
          `${profile.id}-source${path.extname(sourcePath) || ".wav"}`
        );
        fs.copyFileSync(sourcePath, referencePath);
        const trimmedPath = path.join(referenceDir, `${profile.id}-ref.wav`);
        const pythonPath = path.join(
          __dirname,
          "..",
          "voice-engine",
          "GPT-SoVITS-windows",
          "GPT-SoVITS-v3lora-20250228",
          "runtime",
          "python.exe"
        );
        const trimScript = path.join(__dirname, "..", "scripts", "trim_reference_wav.py");
        const trimResult = spawnSync(
          pythonPath,
          [trimScript, referencePath, trimmedPath, "8"],
          { windowsHide: true }
        );
        nextVoiceConfig.refAudioPath =
          trimResult.status === 0 ? trimmedPath : referencePath;
      }
    }
    return ai.synthesizeLocal(state, text, voiceId, nextVoiceConfig);
  });

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
    const response = await ai.transcribeLocal(store.get(), result.filePaths[0]);
    return { canceled: false, ...response };
  });

  ipcMain.handle("data:get-paths", () => ({
    dataPath: store.userDataPath,
    statePath: store.filePath,
    assetsPath: store.assetsPath,
    petStorePath: store.petStorePath
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
    const parsed = JSON.parse(fs.readFileSync(result.filePaths[0], "utf8"));
    const state = store.replace(parsed);
    broadcastState();
    applyOverlaySettings();
    return { canceled: false, state };
  });
  ipcMain.handle("app:quit", () => {
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
    const legacyDataPath = path.join(
      app.getPath("appData"),
      "desk-companion-studio"
    );
    fs.mkdirSync(portableDataPath, { recursive: true });
    if (
      !fs.existsSync(path.join(portableDataPath, "desk-pet-state.json")) &&
      fs.existsSync(legacyDataPath)
    ) {
      for (const entry of ["desk-pet-state.json", "pet-store", "assets"]) {
        const source = path.join(legacyDataPath, entry);
        if (!fs.existsSync(source)) continue;
        fs.cpSync(source, path.join(portableDataPath, entry), {
          recursive: true,
          force: false
        });
      }
    }

    store = new Store(app.getPath("userData"));
    store.load();
    await registerAssetProtocol();
    registerIpc();
    createControlWindow();
    createOverlayWindow();

    screen.on("display-metrics-changed", () => {
      positionOverlay();
    });
    screen.on("display-added", positionOverlay);
    screen.on("display-removed", positionOverlay);
  });
}

app.on("before-quit", () => {
  isQuitting = true;
});

app.on("window-all-closed", () => {
  if (isQuitting) app.quit();
});

app.on("activate", () => {
  createControlWindow();
});
