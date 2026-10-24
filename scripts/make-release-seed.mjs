// 生成发布用种子数据：只保留三个“黍”角色和黍的角色档案/语音模块。
// 用法：npm run seed
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { ensureShape } = require("../electron/store.cjs");

const root = process.cwd();
const sourceDir = path.join(root, "data", "user-data");
const outDir = path.join(root, "release-seed");

const defaultServices = {
  llm: {
    mode: "local",
    baseUrl: "http://127.0.0.1:11434/v1",
    model: "qwen2.5:7b",
    apiKey: ""
  },
  asr: {
    mode: "local",
    baseUrl: "http://127.0.0.1:8000/v1",
    model: "whisper-1",
    apiKey: ""
  },
  tts: {
    mode: "local",
    baseUrl: "http://127.0.0.1:9880/v1",
    model: "",
    voiceId: "",
    apiKey: ""
  }
};

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function assetRelativePath(url) {
  if (typeof url !== "string" || !url.startsWith("deskpet://assets/")) {
    return "";
  }
  try {
    return decodeURIComponent(url.slice("deskpet://assets/".length));
  } catch {
    return "";
  }
}

function collectAssetFiles(state) {
  const files = new Set();
  const add = (url) => {
    const relative = assetRelativePath(url);
    if (relative) files.add(relative.split("/").join(path.sep));
  };
  for (const pet of state.pets) {
    add(pet.avatarUrl);
    for (const asset of pet.assets || []) add(asset.url);
    add(pet.spine?.skelUrl);
    add(pet.spine?.atlasUrl);
    add(pet.spine?.textureUrl);
  }
  for (const module of state.customModules || []) {
    add(module.backgroundImageUrl);
    add(module.userBubbleImageUrl);
    add(module.assistantBubbleImageUrl);
    add(module.decorationImageUrl);
  }
  return files;
}

function main() {
  const sourceState = path.join(sourceDir, "desk-pet-state.json");
  if (!fs.existsSync(sourceState)) {
    throw new Error(`没有找到 ${sourceState}`);
  }
  const state = ensureShape(readJson(sourceState));
  const defaults = ensureShape({});

  const pets = (state.pets || []).filter((pet) =>
    String(pet.name || "").startsWith("黍")
  ).slice(0, 3);
  if (pets.length !== 3) {
    throw new Error(`需要三个名字以“黍”开头的角色，当前找到 ${pets.length} 个。`);
  }
  state.pets = pets;
  state.activePetId = pets[0].id;
  state.summonedPetIds = [pets[0].id];
  state.activeView = "home";

  // 本地模型与推理设置不随发布出去
  state.localModels = [];
  state.localInference = { llmModelId: "", asrModelId: "", ttsModelId: "" };

  // 个人服务地址、模型与密钥恢复为默认
  state.settings.services = defaultServices;

  // 只保留黍的角色档案和语音模块，清理个人样本与运行数据。
  const keptProfile =
    (state.trainingProfiles || []).find(
      (profile) => profile.name === "黍" || profile.character?.name === "黍"
    ) || null;
  if (!keptProfile) throw new Error("没有找到黍的角色档案。");
  const keptVoice =
    (state.voiceProfiles || []).find((profile) => profile.name === "黍") ||
    state.voiceProfiles?.[0] ||
    null;
  if (!keptVoice) throw new Error("没有找到黍的语音模块。");

  keptProfile.documents = [];
  keptProfile.memories = [];
  keptProfile.aiModuleIds = [];
  keptProfile.voiceProfileIds = [keptVoice.id];
  keptProfile.localModelId = "";
  state.trainingProfiles = [keptProfile];
  state.activeTrainingProfileId = keptProfile.id;

  state.voiceProfiles = [
    {
      ...keptVoice,
      name: "黍",
      samples: [],
      activeSampleId: "",
      baseUrl: "http://127.0.0.1:9880",
      apiKey: "",
      voiceId: "",
      defaultAiModuleId: keptProfile.id
    }
  ];

  // 个人内容与下载型模组都不随发布出去。
  state.conversations = [];
  state.documents = [];
  state.memories = [];
  state.activity = [];
  state.aiModules = [];
  state.customModules = [];
  state.auxiliaryWindows = [];
  state.stats = defaults.stats;
  state.settings = {
    ...state.settings,
    appearance: defaults.settings.appearance,
    overlay: defaults.settings.overlay,
    chat: { dialogModuleId: "" }
  };
  state.character = keptProfile.character || state.character;

  const now = new Date().toISOString();
  const todayKey = now.slice(0, 10);
  for (const pet of state.pets) {
    pet.scale = 1;
    pet.hunger = 100;
    pet.hungerUpdatedAt = now;
    delete pet.desktopRelationship;
    delete pet.desktopSecondsToday;
    delete pet.desktopSecondsTotal;
    delete pet.desktopDayKey;
    delete pet.desktopSampleAt;
    delete pet.autoDialogueEnabled;
    pet.autoTextEnabled = true;
    pet.autoVoiceEnabled = true;
    pet.moduleState = {};
    pet.vitals = {
      energy: 76,
      initiative: 58,
      relationship: 12,
      mood: "平静",
      moodScore: 61,
      secondsToday: 0,
      secondsTotal: 0,
      todayKey,
      lastSimulatedAt: now,
      lastInteractionAt: now,
      lastPetAt: now,
      today: {
        energyDelta: 0,
        initiativeDelta: 0,
        relationshipDelta: 0,
        interactions: 0,
        petCount: 0
      },
      recentEvents: []
    };
    pet.voiceLines = {
      enabled: true,
      intervalSeconds: 60,
      probability: 60,
      clips: []
    };
    pet.modulePlugins = {
      ...(pet.modulePlugins || {}),
      boundModuleIds: [],
      aiModuleId: keptProfile.id,
      voiceProfileId: keptVoice.id
    };
  }

  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(path.join(outDir, "pet-store"), { recursive: true });
  fs.writeFileSync(
    path.join(outDir, "desk-pet-state.json"),
    JSON.stringify(state, null, 2),
    "utf8"
  );
  for (const pet of state.pets) {
    fs.writeFileSync(
      path.join(outDir, "pet-store", `${pet.id}.json`),
      JSON.stringify(pet, null, 2),
      "utf8"
    );
  }

  let copied = 0;
  const missing = [];
  for (const relative of collectAssetFiles(state)) {
    const source = path.join(sourceDir, "assets", relative);
    const target = path.join(outDir, "assets", relative);
    if (!fs.existsSync(source)) {
      missing.push(relative);
      continue;
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(source, target);
    copied += 1;
  }

  const totalBytes = fs
    .readdirSync(outDir, { recursive: true })
    .map((entry) => path.join(outDir, entry))
    .filter((entry) => fs.existsSync(entry) && fs.statSync(entry).isFile())
    .reduce((sum, entry) => sum + fs.statSync(entry).size, 0);

  console.log(
    `发布种子已生成：${state.pets.length} 只桌宠 / 素材 ${copied} 个 / 合计 ${(
      totalBytes /
      1024 /
      1024
    ).toFixed(1)}MB`
  );
  console.log(`输出目录：${outDir}`);
  console.log("已清除：本地模型、推理设置、服务密钥与地址、个人声音样本、对话记录、训练模块、全部预设模组和个人使用时间");
  if (missing.length) {
    console.log(`注意：有 ${missing.length} 个被引用的素材在本地缺失，已跳过`);
  }
}

main();
