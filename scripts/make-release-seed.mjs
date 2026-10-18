// 生成发布用种子数据：只保留前 5 只桌宠，去掉本地模型、个人设置与个人素材。
// 用法：npm run seed
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { ensureShape } = require("../electron/store.cjs");

const PET_LIMIT = 5;
const root = process.cwd();
const sourceDir = path.join(root, "user-data");
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

  const pets = (state.pets || []).slice(0, PET_LIMIT);
  if (pets.length === 0) {
    throw new Error("桌宠列表为空，无法生成发布种子。");
  }
  state.pets = pets;
  state.activePetId = pets[0].id;
  state.summonedPetIds = [pets[0].id];

  // 本地模型与推理设置不随发布出去
  state.localModels = [];
  state.localInference = { llmModelId: "", asrModelId: "", ttsModelId: "" };

  // 个人服务地址、模型与密钥恢复为默认
  state.settings.services = defaultServices;

  // 个人内容不随发布出去
  state.voiceProfiles = [];
  state.conversations = [];
  state.documents = [];
  state.memories = [];
  state.activity = [];
  state.trainingProfiles = [];
  state.activeTrainingProfileId = "";
  state.aiModules = [];
  state.customModules = (state.customModules || []).map((module) => ({
    ...module,
    backgroundImageUrl: "",
    userBubbleImageUrl: "",
    assistantBubbleImageUrl: "",
    decorationImageUrl: ""
  }));
  for (const pet of state.pets) {
    pet.voiceLines = {
      enabled: true,
      intervalSeconds: 60,
      probability: 60,
      clips: []
    };
    if (pet.modulePlugins) {
      pet.modulePlugins.voiceProfileId = undefined;
      pet.modulePlugins.aiModuleId = undefined;
    }
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
  console.log("已清除：本地模型、推理设置、服务密钥与地址、声音档案、对话记录、训练模块、个人语音素材");
  if (missing.length) {
    console.log(`注意：有 ${missing.length} 个被引用的素材在本地缺失，已跳过`);
  }
}

main();
