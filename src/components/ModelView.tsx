import {
  AlertTriangle,
  CheckCircle2,
  Download,
  Cpu,
  FolderOpen,
  Mic,
  Package,
  Plus,
  RefreshCw,
  Trash2,
  Volume2
} from "lucide-react";
import { useState, useEffect } from "react";
import { useAppState } from "../state";
import type {
  LocalModelKind,
  LocalModelRecord,
  ServiceConfig
} from "../types";

const modelKinds: Array<{
  id: LocalModelKind;
  label: string;
  description: string;
  icon: typeof Package;
}> = [
  {
    id: "tts",
    label: "语音合成",
   description: "",
    icon: Volume2
  },
  {
    id: "asr",
    label: "语音识别",
    description: "Whisper 模型文件夹",
    icon: Mic
  },
  {
    id: "llm",
    label: "对话模型",
    description: ".safetensors 或 .gguf",
    icon: Cpu
  }
];

// 官方权重仓库（HuggingFace 国内镜像），文件名与内置引擎的默认权重一致。
const TTS_WEIGHT_URLS: Record<"ckpt" | "pth", string> = {
  ckpt: "https://hf-mirror.com/lj1995/GPT-SoVITS/blob/main/s1bert25hz-2kh-longer-epoch=68e-step=50232.ckpt",
  pth: "https://hf-mirror.com/lj1995/GPT-SoVITS/blob/main/s2G488k.pth"
};

function statusText(model: LocalModelRecord) {
  if (model.status === "ready") return "可用";
  if (model.status === "needs-files") return "缺少文件";
  if (model.status === "unsupported") return "暂未适配";
  return "文件异常";
}

export function ModelManagerView() {
  const { state, updateState } = useAppState();
  const [busyKind, setBusyKind] = useState<LocalModelKind | "">("");
  const [engineStatus, setEngineStatus] = useState<{
    installed: boolean;
    engineDir: string;
    missing: string[];
    restartRequired: boolean;
    source: "custom" | "bundled" | "missing";
    message: string;
  } | null>(null);

  if (!state) return null;

  async function checkEngineStatus() {
    const result = await window.deskPet.voiceEngineStatus();
    setEngineStatus(result);
  }

  useEffect(() => {
    void checkEngineStatus();
  }, []);

  const models = state.localModels || [];
  const localInference = state.localInference || {
    llmModelId: "",
    asrModelId: "",
    ttsModelId: ""
  };
  const ttsModels = models.filter((model) => model.kind === "tts");
  const ttsWeightPaths = ttsModels
    .flatMap((model) => [model.sourcePath, ...(model.companionPaths || [])])
    .filter(Boolean) as string[];
  const hasCkptWeight = ttsWeightPaths.some((filePath) =>
    filePath.toLowerCase().endsWith(".ckpt")
  );
  const hasPthWeight = ttsWeightPaths.some((filePath) =>
    filePath.toLowerCase().endsWith(".pth")
  );
  const activeTtsModel =
    ttsModels.find((model) => model.status === "ready") || null;

  async function saveServiceMode(
    service: LocalModelKind,
    mode: "local" | "api"
  ) {
    const config = state?.settings.services[service];
    await updateState({
      settings: {
        ...state?.settings,
        services: {
          ...state?.settings.services,
          [service]: {
            ...config,
            mode
          }
        }
      }
    });
  }

  async function saveServiceField(
    service: LocalModelKind,
    patch: Partial<ServiceConfig>
  ) {
    const config = state?.settings.services[service];
    await updateState({
      settings: {
        ...state?.settings,
        services: {
          ...state?.settings.services,
          [service]: {
            ...config,
            ...patch,
            mode: "api"
          }
        }
      }
    });
  }

  async function importModel(
    kind: LocalModelKind,
    mode?: "file" | "folder"
  ) {
    if (busyKind) return;
    setBusyKind(kind);
    try {
      const selection = await window.deskPet.chooseLocalModel(kind, mode);
      if (selection.canceled || !selection.path) return;
      const result = await window.deskPet.inspectLocalModel(
        kind,
        selection.path
      );
      const model = result.model;
      if (!result.ok || !model) {
        window.alert(result.error || "无法识别这个模型文件。");
        return;
      }
      const nextModels = models.filter(
        (item) => !(item.kind === model.kind && item.sourcePath === model.sourcePath)
      );
      await updateState({ localModels: [model, ...nextModels] });
    // 导入成功后，如果是语音合成模型且可用，自动设为当前声线模型，做到导入即可用
    if (kind === "tts" && model.status === "ready") {
      await window.deskPet.voiceAgent.setModel("tts", model.id);
    }
    } finally {
      setBusyKind("");
    }
  }

  async function openTtsDownload(engine: "gpt" | "index") {
    await window.deskPet.ttsOpenDownload(engine);
  }

  async function openWeightUrl(kind: "ckpt" | "pth") {
    await window.deskPet.openExternalUrl(TTS_WEIGHT_URLS[kind]);
  }

  async function openEngineDownload() {
    await window.deskPet.openVoiceEngineDownload();
  }

  async function chooseEngineFolder() {
    const result = await window.deskPet.chooseVoiceEngine();
    if (result.canceled) return;
    if (!result.ok) {
      window.alert(result.error || "这个文件夹不能作为语音引擎目录。");
      return;
    }
    await checkEngineStatus();
    window.alert("已登记语音引擎位置，重启软件后生效。");
  }

  async function restartApp() {
    await window.deskPet.relaunchApp();
  }

  async function removeTtsWeights() {
    await updateState({
      localModels: models.filter((model) => model.kind !== "tts")
    });
    await window.deskPet.ttsRemoveSelection();
  }

  async function importTtsWeight(kind: "ckpt" | "pth") {
    if (busyKind) return;
    setBusyKind("tts");
    try {
      const selection = await window.deskPet.chooseLocalModel("tts", "file");
      if (selection.canceled || !selection.path) return;
      const result = await window.deskPet.inspectLocalModel("tts", selection.path);
      if (!result.ok || !result.model) {
        window.alert(result.error || "无法识别该权重文件");
        return;
      }

      // 本次选中的文件，加上之前导入过的“另一半”，凑成一对。
      let ckptPath = kind === "ckpt" ? selection.path : "";
      let pthPath = kind === "pth" ? selection.path : "";
      for (const item of models) {
        if (item.kind !== "tts") continue;
        for (const filePath of [item.sourcePath, ...(item.companionPaths || [])]) {
          if (!filePath) continue;
          if (!ckptPath && filePath.toLowerCase().endsWith(".ckpt")) {
            ckptPath = filePath;
          }
          if (!pthPath && filePath.toLowerCase().endsWith(".pth")) {
            pthPath = filePath;
          }
        }
      }

      const paired = Boolean(ckptPath && pthPath);
      const nextModel: LocalModelRecord = {
        ...result.model,
        status: paired ? "ready" : "needs-files",
        companionPaths: paired ? [ckptPath, pthPath] : [selection.path],
        validationMessage: paired
          ? "GPT-SoVITS 的两个权重文件已配对，可以直接使用。"
          : "已导入一个权重文件，还需要另一个：GPT 用 .ckpt，SoVITS 用 .pth。"
      };

      // 顺手清掉以前那些只含单个权重、永远凑不齐的旧记录。
      const keepModels = models.filter((item) => {
        if (item.kind !== "tts") return true;
        const paths = [item.sourcePath, ...(item.companionPaths || [])].filter(
          Boolean
        ) as string[];
        return (
          paths.some((filePath) => filePath.toLowerCase().endsWith(".ckpt")) &&
          paths.some((filePath) => filePath.toLowerCase().endsWith(".pth"))
        );
      });

      await updateState({ localModels: [nextModel, ...keepModels] });
      if (paired) {
        await window.deskPet.voiceAgent.setModel("tts", nextModel.id);
      } else {
        window.alert(
          kind === "ckpt"
            ? "已导入 GPT 权重（.ckpt）。再导入 SoVITS 权重（.pth）就能启用。"
            : "已导入 SoVITS 权重（.pth）。再导入 GPT 权重（.ckpt）就能启用。"
        );
      }
    } finally {
      setBusyKind("");
    }
  }

  const ttsMode = (state.settings.services.tts.mode || "local") as "local" | "api";
  const asrMode = (state.settings.services.asr.mode || "local") as "local" | "api";
  const llmMode = (state.settings.services.llm.mode || "local") as "local" | "api";

  return (
    <div className="form-section model-manager">
      <div className="section-heading">
        <span className="section-kicker">本地模型</span>
        <h2>模型文件检查与挂载</h2>
        <p>
          软件不负责下载模型。你选择已经下载好的本地文件或文件夹后，它会识别格式、检查必需文件并登记到本地模型库。
        </p>
      </div>

      <div className="tts-engine-panel">
        <strong className="tts-engine-title">语音引擎（GPT-SoVITS）</strong>
        <div
          className={`tts-install-status tts-install-status--${
            engineStatus?.installed ? "installed" : "missing"
          }`}
        >
          <div className="tts-install-status-icon">
            {engineStatus?.installed ? (
              <CheckCircle2 size={14} />
            ) : (
              <AlertTriangle size={14} />
            )}
          </div>
          <div className="tts-install-status-body">
            <div className="tts-install-status-title">
              {engineStatus?.installed ? "语音引擎已安装" : "未安装语音引擎"}
            </div>
            <div className="tts-install-status-desc">
              {engineStatus?.installed
                ? engineStatus.engineDir
                : "语音合成必须先有引擎。下载官方整合包（约 6.4GB）、解压，再把文件夹选进来。"}
            </div>
          </div>
        </div>
        <div className="tts-weight-actions">
          <button
            type="button"
            className="tts-weight-download"
            onClick={() => void openEngineDownload()}
          >
            <Download size={14} />
            从官方下载语音引擎
          </button>
          <button
            type="button"
            className="tts-weight-local"
            onClick={() => void chooseEngineFolder()}
          >
            <FolderOpen size={14} />
            选择本地引擎文件夹
          </button>
          {engineStatus?.restartRequired && (
            <button
              type="button"
              className="tts-weight-local"
              onClick={() => void restartApp()}
            >
              <RefreshCw size={14} />
              立即重启软件
            </button>
          )}
        </div>
        {engineStatus?.restartRequired && (
          <p className="tts-engine-hint">引擎位置已更新，重启后才会生效。</p>
        )}
      </div>

      <div className="model-kind-grid">
        {modelKinds.map((kind) => {
          const Icon = kind.icon;
          const count = models.filter((model) => model.kind === kind.id).length;
          const isTts = kind.id === "tts";
          const mode = isTts ? ttsMode : kind.id === "asr" ? asrMode : llmMode;
          const isLocal = mode === "local";
          return (
            <article className="model-kind-card" key={kind.id}>
              <div className="model-kind-heading">
                <span className="model-kind-icon">
                  <Icon size={19} />
                </span>
                <div>
                  <strong>{kind.label}</strong>
                  <span>{kind.description}</span>
                </div>
                  {isTts ? (
                    <em
                      className={
                        activeTtsModel
                          ? "model-kind-state model-kind-state--ready"
                          : "model-kind-state"
                      }
                    >
                      {activeTtsModel ? "已就绪" : "可选"}
                    </em>
                  ) : (
                    <em>{count}</em>
                  )}
              </div>

              {isTts ? (
                <>
                    <div className="tts-weight-group">
                      <div className="tts-weight-group-head">
                        <strong>声线权重</strong>
                        <span
                          className={
                            activeTtsModel
                              ? "tts-weight-ready"
                              : "tts-weight-missing"
                          }
                        >
                          {activeTtsModel
                            ? "已启用自定义权重"
                            : "正在使用引擎自带权重"}
                        </span>
                      </div>

                      <div className="tts-weight-item">
                        <div className="tts-weight-item-head">
                          <span className="tts-weight-item-name">
                            GPT 权重<em>.ckpt</em>
                          </span>
                          <span
                            className={
                              hasCkptWeight
                                ? "tts-weight-ready"
                                : "tts-weight-missing"
                            }
                          >
                            {hasCkptWeight ? "已导入" : "未导入"}
                          </span>
                        </div>
                        <div className="tts-weight-actions">
                          <button
                            type="button"
                            className="tts-weight-download"
                            onClick={() => void openWeightUrl("ckpt")}
                          >
                            <Download size={14} />
                            从官方下载 GPT .ckpt
                          </button>
                          <button
                            type="button"
                            className="tts-weight-local"
                            onClick={() => void importTtsWeight("ckpt")}
                          >
                            <Plus size={14} />
                            选择本地文件
                          </button>
                        </div>
                      </div>

                      <div className="tts-weight-item">
                        <div className="tts-weight-item-head">
                          <span className="tts-weight-item-name">
                            SoVITS 权重<em>.pth</em>
                          </span>
                          <span
                            className={
                              hasPthWeight
                                ? "tts-weight-ready"
                                : "tts-weight-missing"
                            }
                          >
                            {hasPthWeight ? "已导入" : "未导入"}
                          </span>
                        </div>
                        <div className="tts-weight-actions">
                          <button
                            type="button"
                            className="tts-weight-download"
                            onClick={() => void openWeightUrl("pth")}
                          >
                            <Download size={14} />
                            从官方下载 SoVITS .pth
                          </button>
                          <button
                            type="button"
                            className="tts-weight-local"
                            onClick={() => void importTtsWeight("pth")}
                          >
                            <Plus size={14} />
                            选择本地文件
                          </button>
                        </div>
                      </div>
                    </div>

                    <div
                      className={`tts-install-status tts-install-status--${
                        activeTtsModel ? "installed" : "missing"
                      }`}
                    >
                      <div className="tts-install-status-icon">
                        {activeTtsModel ? (
                          <CheckCircle2 size={14} />
                        ) : (
                          <AlertTriangle size={14} />
                        )}
                      </div>
                      <div className="tts-install-status-body">
                        <div className="tts-install-status-title">
                          {activeTtsModel
                            ? "自定义声线权重已启用"
                            : "未启用自定义声线权重"}
                        </div>
                        <div className="tts-install-status-desc">
                          {activeTtsModel
                            ? activeTtsModel.name
                            : "语音合成会使用引擎自带的默认权重；导入 .ckpt 与 .pth 后就会替换成你自己的。"}
                        </div>
                      </div>
                    </div>

                    {ttsModels.length > 0 && (
                      <div className="model-tts-actions">
                        <button
                          type="button"
                          onClick={() => void removeTtsWeights()}
                        >
                          <Trash2 size={14} />
                          移除已导入的声线权重
                        </button>
                      </div>
                    )}

                </>
              ) : kind.id === "llm" ? (
                <>
                  <div className="model-mode-toggle">
                    <button
                      className={isLocal ? "model-mode-button model-mode-button--active" : "model-mode-button"}
                      type="button"
                      onClick={() => void saveServiceMode(kind.id, "local")}
                    >
                      本地模式
                    </button>
                    <button
                      className={!isLocal ? "model-mode-button model-mode-button--active" : "model-mode-button"}
                      type="button"
                      onClick={() => void saveServiceMode(kind.id, "api")}
                    >
                      API 模式
                    </button>
                  </div>

                  {isLocal ? (
                    <div className="model-kind-actions">
                      <button
                        type="button"
                        disabled={Boolean(busyKind)}
                        onClick={() => void importModel(kind.id, "file")}
                      >
                        <Plus size={15} />
                        选择单个 .safetensors
                      </button>
                      <button
                        type="button"
                        disabled={Boolean(busyKind)}
                        onClick={() => void importModel(kind.id, "folder")}
                      >
                        <Plus size={15} />
                        选择完整模型文件夹
                      </button>
                    </div>
                  ) : (
                    <div className="model-kind-actions">
                      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                        <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                          <span style={{ fontSize: 11, color: "var(--muted)", fontWeight: 700 }}>API 地址</span>
                          <input
                            value={state?.settings.services.llm?.baseUrl || ""}
                            placeholder="例如 http://127.0.0.1:8000/v1"
                            onChange={(e) => void saveServiceField(kind.id, { baseUrl: e.target.value })}
                          />
                        </label>
                        <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                          <span style={{ fontSize: 11, color: "var(--muted)", fontWeight: 700 }}>模型名称</span>
                          <input
                            value={state?.settings.services.llm?.model || ""}
                            placeholder="例如 gpt-4o-mini"
                            onChange={(e) => void saveServiceField(kind.id, { model: e.target.value })}
                          />
                        </label>
                        <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                          <span style={{ fontSize: 11, color: "var(--muted)", fontWeight: 700 }}>API Key</span>
                          <input
                            type="password"
                            value={state?.settings.services.llm?.apiKey || ""}
                            placeholder="sk-..."
                            onChange={(e) => void saveServiceField(kind.id, { apiKey: e.target.value })}
                          />
                        </label>
                      </div>
                    </div>
                  )}
                </>
              ) : (
                <>
                  <div className="model-mode-toggle">
                    <button
                      className={isLocal ? "model-mode-button model-mode-button--active" : "model-mode-button"}
                      type="button"
                      onClick={() => void saveServiceMode(kind.id, "local")}
                    >
                      本地模式
                    </button>
                    <button
                      className={!isLocal ? "model-mode-button model-mode-button--active" : "model-mode-button"}
                      type="button"
                      onClick={() => void saveServiceMode(kind.id, "api")}
                    >
                      API 模式
                    </button>
                  </div>

                  {isLocal ? (
                    <button
                      type="button"
                      disabled={Boolean(busyKind)}
                      onClick={() => void importModel(kind.id)}
                    >
                      <Plus size={16} />
                      {busyKind === kind.id ? "正在检查..." : "选择本地模型文件夹"}
                    </button>
                  ) : (
                    <div className="model-kind-actions">
                      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                        <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                          <span style={{ fontSize: 11, color: "var(--muted)", fontWeight: 700 }}>API 地址</span>
                          <input
                            value={state?.settings.services.asr?.baseUrl || ""}
                            placeholder="例如 http://127.0.0.1:8000/v1"
                            onChange={(e) => void saveServiceField(kind.id, { baseUrl: e.target.value })}
                          />
                        </label>
                        <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                          <span style={{ fontSize: 11, color: "var(--muted)", fontWeight: 700 }}>模型名称</span>
                          <input
                            value={state?.settings.services.asr?.model || ""}
                            placeholder="例如 whisper-1"
                            onChange={(e) => void saveServiceField(kind.id, { model: e.target.value })}
                          />
                        </label>
                        <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                          <span style={{ fontSize: 11, color: "var(--muted)", fontWeight: 700 }}>API Key</span>
                          <input
                            type="password"
                            value={state?.settings.services.asr?.apiKey || ""}
                            placeholder="sk-..."
                            onChange={(e) => void saveServiceField(kind.id, { apiKey: e.target.value })}
                          />
                        </label>
                      </div>
                    </div>
                  )}
                </>
              )}
            </article>
          );
        })}
      </div>

      <section className="model-family-panel">
        <div className="panel-heading">
          <Package size={18} />
          <h3>对话模型适配</h3>
        </div>
        <div className="model-family-list">
          <span className="model-family-chip model-family-chip--primary">Qwen</span>
          <span className="model-family-chip model-family-chip--primary">
            DeepSeek
          </span>
          <span className="model-family-chip">GGUF</span>
          <span className="model-family-chip">Llama</span>
          <span className="model-family-chip">Mistral</span>
          <span className="model-family-chip">Gemma</span>
        </div>
        <p>
          Qwen 与 DeepSeek 作为首版重点适配；GGUF、Llama、Mistral 和 Gemma
          保留同样的接入位置，后续增加适配包即可启用。
        </p>
      </section>

      <div className="model-library-list">
        {models.map((model) => (
          <article className="model-library-item" key={model.id}>
            <span
              className={
                model.status === "ready"
                  ? "model-status-icon model-status-icon--ready"
                  : "model-status-icon"
              }
            >
              {model.status === "ready" ? (
                <CheckCircle2 size={18} />
              ) : (
                <AlertTriangle size={18} />
              )}
            </span>
            <div>
              <strong>{model.name}</strong>
              <span>
                {modelKinds.find((kind) => kind.id === model.kind)?.label} ·{" "}
                {model.format.toUpperCase()} · {statusText(model)}
                {model.parameterSize ? ` · ${model.parameterSize}` : ""}
              </span>
              <code>{model.sourcePath}</code>
              <p>{model.validationMessage}</p>
              <button
                className={
                  (model.kind === "llm" &&
                    localInference.llmModelId === model.id) ||
                  (model.kind === "asr" &&
                    localInference.asrModelId === model.id) ||
                  (model.kind === "tts" &&
                    localInference.ttsModelId === model.id)
                    ? "model-use-button model-use-button--active"
                    : "model-use-button"
                }
                type="button"
                disabled={model.status !== "ready"}
                onClick={() =>
                  void window.deskPet.voiceAgent.setModel(model.kind, model.id)
                }
              >
                {model.kind === "llm"
                  ? "设为当前对话模型"
                  : model.kind === "asr"
                    ? "设为当前识别模型"
                    : "设为当前声线模型"}
              </button>
            </div>
            <button
              type="button"
              title="从模型库移除"
              onClick={() =>
                void updateState({
                  localModels: models.filter((item) => item.id !== model.id)
                })
              }
            >
              <Trash2 size={16} />
            </button>
          </article>
        ))}
        {models.length === 0 && (
          <p className="empty-copy">还没有导入本地模型。</p>
        )}
      </div>
    </div>
  );
}

