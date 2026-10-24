import {
  Copy,
  Download,
  FolderPlus,
  Puzzle,
  RefreshCw,
  Settings,
  Trash2
} from "lucide-react";
import { useState } from "react";
import { useAppState } from "../state";
import type { CustomDialogModule, RegistryModule } from "../types";

const MODULE_MANIFEST_TEMPLATE = `{
  "id": "my-module",
  "name": "我的模组",
  "version": "1.0.0",
  "apiVersion": 1,
  "author": "你的名字",
  "description": "一句话说明这个模组做什么",
  "type": "interaction",
  "scope": "global",
  "category": "interaction",
  "entry": "index.html",
  "contextMenuLabel": "打开我的模组",
  "width": 480,
  "height": 520,
  "quickControl": false,
  "enabled": true
}`;

const MODULE_FIELDS: Array<{
  field: string;
  required: boolean;
  note: string;
}> = [
  { field: "id", required: true, note: "模组唯一标识，建议只用字母、数字和短横线" },
  { field: "name", required: true, note: "显示名称，同时作为默认的右键菜单文字" },
  { field: "entry", required: true, note: "入口页面，必须在模组文件夹内，默认 index.html" },
  { field: "version", required: false, note: "模组版本号，显示在模组库里" },
  { field: "author", required: false, note: "作者署名" },
  { field: "description", required: false, note: "模组说明，显示在卡片上" },
  { field: "apiVersion", required: false, note: "接口版本，当前为 1；填 2 及以上会被拒绝加载" },
  { field: "type", required: false, note: "interaction（交互模组）或 dialog-box（对话框模组）" },
  { field: "scope", required: false, note: "global 全局作用 / pet 角色作用（默认 global）" },
  {
    field: "category",
    required: false,
    note: "interaction / dialog-skin / auxiliary-window / external"
  },
  { field: "contextMenuLabel", required: false, note: "右键菜单里显示的文字" },
  { field: "width / height", required: false, note: "模组窗口初始尺寸，默认 420 × 420" },
  { field: "quickControl", required: false, note: "true 时出现在桌宠行为控制的快捷区" },
  { field: "enabled", required: false, note: "false 时导入后默认处于关闭状态" }
];

const MODULE_API_DOCS: Array<{ signature: string; note: string }> = [
  { signature: "arkpet.module.info()", note: "读取当前模组信息（id / name / version / apiVersion）" },
  { signature: "arkpet.pets.list()", note: "读取桌宠列表（id、名字、是否上桌、状态数值）" },
  { signature: "arkpet.pets.active()", note: "读取当前选中的桌宠" },
  { signature: "arkpet.pets.onChanged(fn)", note: "桌宠状态变化时回调，返回取消订阅函数" },
  {
    signature: "arkpet.pet.command({ type })",
    note: "指挥桌宠：wake / sleep / rest / release / home / walk / drop / show / action"
  },
  { signature: "arkpet.chat.ask(text, petId?)", note: "让角色按自己的档案回答，返回 { ok, text }" },
  { signature: "arkpet.voice.speak(text)", note: "用当前声线合成语音，返回 { ok, audioDataUrl }" },
  { signature: "arkpet.storage.get / set / remove / keys", note: "模组自己的本地存储，各模组互不干扰" },
  { signature: "arkpet.activity.log(text)", note: "往软件的动态列表写一条记录" },
  { signature: "arkpet.app.notify(title, body)", note: "发一条系统通知" },
  { signature: "arkpet.app.openExternal(url)", note: "用默认浏览器打开链接（仅 http / https）" },
  { signature: "arkpet.ui.setSize(w, h)", note: "调整模组窗口尺寸" },
  { signature: "arkpet.ui.setTitle(text)", note: "修改模组窗口标题" },
  { signature: "arkpet.ui.close()", note: "关闭模组窗口" }
];

const MODULE_HTML_SAMPLE = `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <title>示例模组</title>
    <style>
      body { margin: 0; padding: 18px; font-family: "Microsoft YaHei UI", sans-serif; color: #172033; background: #f7f5ef; }
      h1 { margin: 0 0 4px; font-size: 18px; }
      p.hint { margin: 0 0 14px; color: #6e7481; font-size: 12px; }
      .row { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 12px; }
      button { min-height: 34px; padding: 0 12px; border: 1px solid #b8cce6; border-radius: 6px; color: #245c9f; background: #fff; cursor: pointer; font-size: 12px; }
      pre { margin: 0; padding: 10px; border: 1px solid #dfe0dc; border-radius: 6px; background: #fff; font-size: 12px; white-space: pre-wrap; }
    </style>
  </head>
  <body>
    <h1 id="title">示例模组</h1>
    <p class="hint" id="meta"></p>

    <div class="row">
      <button id="refresh">读取桌宠</button>
      <button id="wake">让桌宠上桌</button>
      <button id="ask">让角色回答一句</button>
      <button id="count">点我加一</button>
    </div>

    <pre id="out">准备好了。</pre>

    <script>
      var out = document.getElementById("out");

      arkpet.module.info().then(function (info) {
        document.getElementById("title").textContent = info.name;
        document.getElementById("meta").textContent =
          "模组 id：" + info.id + " · 接口版本 " + info.apiVersion;
      });

      document.getElementById("refresh").onclick = async function () {
        var pets = await arkpet.pets.list();
        var active = await arkpet.pets.active();
        out.textContent =
          "共 " + pets.length + " 只桌宠，当前选中：" + (active ? active.name : "无");
      };

      document.getElementById("wake").onclick = async function () {
        await arkpet.pet.command({ type: "wake" });
        arkpet.activity.log("从示例模组唤醒了桌宠");
        out.textContent = "已经让桌宠上桌了。";
      };

      document.getElementById("ask").onclick = async function () {
        var reply = await arkpet.chat.ask("用一句话打个招呼");
        out.textContent = reply.ok ? reply.text : "回答失败：" + (reply.error || "未知原因");
      };

      document.getElementById("count").onclick = async function () {
        var current = (await arkpet.storage.get("clicks")) || 0;
        current += 1;
        await arkpet.storage.set("clicks", current);
        out.textContent = "这个按钮累计点了 " + current + " 次（数据存在模组自己的存储里）。";
      };
    </script>
  </body>
</html>`;

export function ModuleManagerView() {
  const { state, updateState, refresh } = useAppState();
  const [settingsId, setSettingsId] = useState("");
  const [registryOpen, setRegistryOpen] = useState(false);
  const [registryLoading, setRegistryLoading] = useState(false);
  const [registryError, setRegistryError] = useState("");
  const [registryModules, setRegistryModules] = useState<RegistryModule[]>([]);
  const [installingId, setInstallingId] = useState("");
  if (!state) return null;
  const currentState = state;
  const settingsModule = currentState.customModules.find(
    (item) => item.id === settingsId
  );

  async function importModuleFile() {
    const result = await window.deskPet.importModuleArchive();
    if (result.canceled) return;
    if (result.error) {
      window.alert(result.error);
      return;
    }
    await refresh();
  }

  async function loadRegistry(force = false) {
    setRegistryLoading(true);
    setRegistryError("");
    const result = await window.deskPet.listRegistryModules(force);
    setRegistryModules(result.modules || []);
    if (!result.ok) setRegistryError(result.error || "无法获取官方模组清单。");
    setRegistryLoading(false);
  }

  async function toggleRegistry() {
    const next = !registryOpen;
    setRegistryOpen(next);
    if (next) await loadRegistry(true);
  }

  async function installRegistryModule(moduleId: string) {
    setInstallingId(moduleId);
    try {
      const result = await window.deskPet.installRegistryModule(moduleId);
      if (!result.ok) {
        window.alert(result.error || "安装官方模组失败。");
        return;
      }
      await refresh();
      await loadRegistry(true);
    } finally {
      setInstallingId("");
    }
  }

  async function copyManifestTemplate() {
    const result = await window.deskPet.clipboardWrite(MODULE_MANIFEST_TEMPLATE);
    window.alert(result?.ok ? "已复制 module.json 模板。" : "复制失败。");
  }

  async function createExampleModule() {
    const result = await window.deskPet.createExampleModule(
      MODULE_MANIFEST_TEMPLATE,
      MODULE_HTML_SAMPLE
    );
    if (!result?.ok) {
      window.alert("生成示例模组失败。");
      return;
    }
    await updateState({});
    window.alert("已生成示例模组「my-module」，模组库里现在能看到它。");
  }

  async function chooseImage(
    slot: "background" | "user" | "assistant" | "decoration"
  ) {
    if (!settingsModule) return;
    const result = await window.deskPet.chooseModuleImage(
      settingsModule.id,
      slot
    );
    if (result.canceled || !result.url) {
      if (result.error) window.alert(result.error);
      return;
    }
    const patch =
      slot === "background"
        ? { backgroundImageUrl: result.url }
        : slot === "user"
          ? { userBubbleImageUrl: result.url }
          : slot === "assistant"
            ? { assistantBubbleImageUrl: result.url }
            : { decorationImageUrl: result.url };
    await updateState({
      customModules: currentState.customModules.map((module) =>
        module.id === settingsModule.id ? { ...module, ...patch } : module
      )
    });
  }

  return (
    <div className="module-manager-page">
      <div className="section-heading section-heading--split">
        <div>
          <span className="section-kicker">模组管理</span>
          <h2>添加外部模组包</h2>
          <p>
            选择一个包含 module.json 或 manifest.json 的模组文件夹。导入后，需要在桌宠制作里绑定，右键菜单才会显示。
          </p>
        </div>
          <div className="module-heading-actions">
            <button
              className="primary-small"
              type="button"
              onClick={() => void toggleRegistry()}
            >
              <Download size={16} />
              官方模组库
            </button>
            <button type="button" onClick={() => void importModuleFile()}>
              <Download size={16} />
              导入模组文件
            </button>
          </div>
      </div>

        {registryOpen && (
          <section className="module-registry-panel">
            <div className="module-registry-header">
              <div>
                <span className="section-kicker">仓库模组库</span>
                <strong>官方与本地模组</strong>
                <p>仓库模组来自 `module-registry/registry.json`，内置和本地已安装模组也会一起列出。</p>
              </div>
              <button
                type="button"
                disabled={registryLoading}
                onClick={() => void loadRegistry(true)}
              >
                <RefreshCw size={14} />
                刷新清单
              </button>
            </div>
            {registryLoading && <p className="empty-copy">正在读取仓库模组清单...</p>}
            {registryError && <p className="name-error">{registryError}</p>}
            {!registryLoading && !registryError && registryModules.length === 0 && (
              <p className="empty-copy">仓库里暂时没有可安装模组。</p>
            )}
            <div className="module-registry-list">
              {registryModules.map((module) => (
                <article className="module-registry-item" key={module.id}>
                  <div>
                    <strong>{module.name}</strong>
                    <span>
                      v{module.version}
                      {module.installedVersion
                        ? ` · 已安装 v${module.installedVersion}`
                        : ""}
                    </span>
                    <p>{module.description}</p>
                  </div>
                  <button
                    type="button"
                    disabled={
                      module.status === "installed" ||
                      installingId === module.id
                    }
                    onClick={() => void installRegistryModule(module.id)}
                  >
                    {installingId === module.id
                      ? "正在安装..."
                      : module.status === "update"
                        ? "更新"
                        : module.status === "installed"
                          ? "已安装"
                          : "安装"}
                  </button>
                </article>
              ))}
            </div>
          </section>
        )}

      <div className="module-library-grid">
        {currentState.customModules.map((item) => (
          <article className="module-library-card" key={item.id}>
            <span className="module-library-icon">
              <Puzzle size={21} />
            </span>
            <div>
              <strong>{item.name}</strong>
                <span>
                  {item.kind} · v{item.version || "1.0.0"}
                </span>
              {item.builtinType !== "climb-platforms" && (
                <>
                  <span>
                    {item.moduleScope === "global" ? "全局作用" : "角色作用"} ·{" "}
                    {item.moduleCategory}
                  </span>
                </>
              )}
              <p>{item.description}</p>
              {item.builtinType !== "climb-platforms" && (
                <small>右键名称：{item.contextMenuLabel || item.name}</small>
              )}
            </div>
            <div className="module-library-actions">
              <button
                className={
                  item.enabled !== false
                    ? "module-switch module-switch--on"
                    : "module-switch"
                }
                type="button"
                title={item.enabled !== false ? "关闭模组" : "启用模组"}
                onClick={() =>
                  void updateState({
                    customModules: currentState.customModules.map((module) =>
                      module.id === item.id
                        ? { ...module, enabled: module.enabled === false }
                        : module
                    )
                  })
                }
              >
                <span />
              </button>
              <button
                type="button"
                title="模组设置"
                onClick={() => setSettingsId(item.id)}
              >
                <Settings size={15} />
              </button>
            </div>
          </article>
        ))}
        {currentState.customModules.length === 0 && (
          <p className="empty-copy">还没有导入外部模组。</p>
        )}
      </div>

      {settingsModule && (
        <section className="module-settings-panel">
          <div className="panel-heading">
            <Settings size={18} />
            <strong>{settingsModule.name} 设置</strong>
          </div>
          {settingsModule.moduleCategory === "dialog-skin" && (
            <section className="dialog-skin-workbench">
              <div
                className="dialog-skin-preview"
                style={{
                  background: settingsModule.background,
                  borderColor: settingsModule.borderColor,
                  borderRadius: settingsModule.borderRadius,
                  color: settingsModule.textColor,
                  backgroundImage: settingsModule.backgroundImageUrl
                    ? `url("${settingsModule.backgroundImageUrl}")`
                    : undefined,
                  backgroundSize: "cover",
                  backgroundPosition: "center"
                }}
              >
                <div
                  className="dialog-skin-preview-line dialog-skin-preview-line--assistant"
                  style={{
                    background: settingsModule.assistantBubbleColor,
                    backgroundImage: settingsModule.assistantBubbleImageUrl
                      ? `url("${settingsModule.assistantBubbleImageUrl}")`
                      : undefined
                  }}
                >
                  你今天过得怎么样？
                </div>
                <div
                  className="dialog-skin-preview-line dialog-skin-preview-line--user"
                  style={{
                    background: settingsModule.userBubbleColor,
                    backgroundImage: settingsModule.userBubbleImageUrl
                      ? `url("${settingsModule.userBubbleImageUrl}")`
                      : undefined
                  }}
                >
                  还好，就是有点累。
                </div>
                {settingsModule.decorationImageUrl && (
                  <img
                    className="dialog-skin-decoration"
                    src={settingsModule.decorationImageUrl}
                    alt=""
                  />
                )}
              </div>
              <div className="dialog-skin-tools">
                <label>
                  <span>背景颜色</span>
                  <input
                    type="color"
                    value={settingsModule.background}
                    onChange={(event) =>
                      void updateState({
                        customModules: currentState.customModules.map(
                          (module) =>
                            module.id === settingsModule.id
                              ? { ...module, background: event.target.value }
                              : module
                        )
                      })
                    }
                  />
                </label>
                <label>
                  <span>边框颜色</span>
                  <input
                    type="color"
                    value={settingsModule.borderColor}
                    onChange={(event) =>
                      void updateState({
                        customModules: currentState.customModules.map(
                          (module) =>
                            module.id === settingsModule.id
                              ? { ...module, borderColor: event.target.value }
                              : module
                        )
                      })
                    }
                  />
                </label>
                <label>
                  <span>文字颜色</span>
                  <input
                    type="color"
                    value={settingsModule.textColor}
                    onChange={(event) =>
                      void updateState({
                        customModules: currentState.customModules.map(
                          (module) =>
                            module.id === settingsModule.id
                              ? { ...module, textColor: event.target.value }
                              : module
                        )
                      })
                    }
                  />
                </label>
                <label>
                  <span>圆角</span>
                  <input
                    type="number"
                    min="0"
                    max="40"
                    value={settingsModule.borderRadius}
                    onChange={(event) =>
                      void updateState({
                        customModules: currentState.customModules.map(
                          (module) =>
                            module.id === settingsModule.id
                              ? {
                                  ...module,
                                  borderRadius: Number(event.target.value) || 0
                                }
                              : module
                        )
                      })
                    }
                  />
                </label>
                <button type="button" onClick={() => void chooseImage("background")}>
                  导入背景图片
                </button>
                <button type="button" onClick={() => void chooseImage("user")}>
                  导入用户气泡图片
                </button>
                <button type="button" onClick={() => void chooseImage("assistant")}>
                  导入角色气泡图片
                </button>
                <button type="button" onClick={() => void chooseImage("decoration")}>
                  导入装饰图片
                </button>
              </div>
            </section>
          )}
          <div
            className={
              settingsModule.builtinType === "climb-platforms"
                ? "module-editor-grid module-editor-grid--climb"
                : "module-editor-grid"
            }
          >
            <label>
              <span>模组名称</span>
              <input
                value={settingsModule.name}
                onChange={(event) =>
                  void updateState({
                    customModules: currentState.customModules.map((module) =>
                      module.id === settingsModule.id
                        ? { ...module, name: event.target.value }
                        : module
                    )
                  })
                }
                onBlur={(event) => {
                  const name = event.target.value.trim();
                  void updateState({
                    customModules: currentState.customModules.map((module) =>
                      module.id === settingsModule.id
                        ? { ...module, name }
                        : module
                    )
                  });
                }}
              />
            </label>
            <label>
              <span>右键菜单名称</span>
              <input
                value={settingsModule.contextMenuLabel || ""}
                onChange={(event) =>
                  void updateState({
                    customModules: currentState.customModules.map((module) =>
                      module.id === settingsModule.id
                        ? { ...module, contextMenuLabel: event.target.value }
                        : module
                    )
                  })
                }
              />
            </label>
            <label className="full-field">
              <span>说明</span>
              <input
                value={settingsModule.description}
                onChange={(event) =>
                  void updateState({
                    customModules: currentState.customModules.map((module) =>
                      module.id === settingsModule.id
                        ? { ...module, description: event.target.value }
                        : module
                    )
                  })
                }
              />
            </label>
            <label>
              <span>作用范围</span>
              <select
                value={settingsModule.moduleScope || "pet"}
                onChange={(event) =>
                  void updateState({
                    customModules: currentState.customModules.map((module) =>
                      module.id === settingsModule.id
                        ? {
                            ...module,
                            moduleScope: event.target.value as
                              | "global"
                              | "pet",
                            quickControl:
                              event.target.value === "global"
                                ? module.quickControl
                                : false
                          }
                        : module
                    )
                  })
                }
              >
                <option value="global">全局作用模组</option>
                <option value="pet">角色作用模组</option>
              </select>
            </label>
            <label>
              <span>模组分类</span>
              <select
                value={settingsModule.moduleCategory || "external"}
                onChange={(event) =>
                  void updateState({
                    customModules: currentState.customModules.map((module) =>
                      module.id === settingsModule.id
                        ? {
                            ...module,
                            moduleCategory: event.target.value as CustomDialogModule["moduleCategory"]
                          }
                        : module
                    )
                  })
                }
              >
                <option value="dialog-skin">对话框皮肤</option>
                <option value="auxiliary-window">辅助窗口</option>
                <option value="interaction">交互模组</option>
                <option value="external">外部扩展</option>
              </select>
            </label>
            {settingsModule.builtinType !== "climb-platforms" && (
              <label className="module-quick-toggle">
                <input
                  type="checkbox"
                  checked={settingsModule.quickControl === true}
                  disabled={settingsModule.moduleScope !== "global"}
                  onChange={(event) =>
                    void updateState({
                      customModules: currentState.customModules.map(
                        (module) =>
                          module.id === settingsModule.id
                            ? { ...module, quickControl: event.target.checked }
                            : module
                      )
                    })
                  }
                />
                <span>添加到桌宠行为控制快捷区</span>
              </label>
            )}
            {settingsModule.builtinType === "hunger-food" && (
              <>
                <label>
                  <span>每分钟饥饿下降</span>
                  <input
                    type="number"
                    min="0"
                    max="10"
                    step="0.1"
                    value={settingsModule.hungerDecayPerMinute ?? 1}
                    onChange={(event) =>
                      void updateState({
                        customModules: currentState.customModules.map(
                          (module) =>
                            module.id === settingsModule.id
                              ? {
                                  ...module,
                                  hungerDecayPerMinute: Math.max(
                                    0,
                                    Number(event.target.value) || 0
                                  )
                                }
                              : module
                        )
                      })
                    }
                  />
                </label>
                <label>
                  <span>寻找食物间隔（秒）</span>
                  <input
                    type="number"
                    min="3"
                    max="300"
                    value={settingsModule.foodSeekIntervalSeconds ?? 8}
                    onChange={(event) =>
                      void updateState({
                        customModules: currentState.customModules.map(
                          (module) =>
                            module.id === settingsModule.id
                              ? {
                                  ...module,
                                  foodSeekIntervalSeconds: Math.max(
                                    3,
                                    Number(event.target.value) || 8
                                  )
                                }
                              : module
                        )
                      })
                    }
                  />
                </label>
              </>
            )}
            {(settingsModule.builtinType === "auxiliary-window" ||
              settingsModule.builtinType === "climb-platforms") && (
              <>
                <label className="full-field module-climb-setting">
                  <span>窗口标题</span>
                  <input
                    value={settingsModule.windowTitle || ""}
                    onChange={(event) =>
                      void updateState({
                        customModules: currentState.customModules.map((module) =>
                          module.id === settingsModule.id
                            ? { ...module, windowTitle: event.target.value }
                            : module
                        )
                      })
                    }
                  />
                </label>
                <label className="full-field module-climb-setting">
                  <span>窗口内容</span>
                  <textarea
                    rows={3}
                    value={settingsModule.windowBody || ""}
                    onChange={(event) =>
                      void updateState({
                        customModules: currentState.customModules.map((module) =>
                          module.id === settingsModule.id
                            ? { ...module, windowBody: event.target.value }
                            : module
                        )
                      })
                    }
                  />
                </label>
                <label className="module-climb-setting">
                  <span>窗口宽度</span>
                  <input
                    type="range"
                    min="180"
                    max="900"
                    value={settingsModule.windowWidth || 420}
                    onChange={(event) =>
                      void updateState({
                        customModules: currentState.customModules.map((module) =>
                          module.id === settingsModule.id
                            ? {
                                ...module,
                                windowWidth: Number(event.target.value)
                              }
                            : module
                        )
                      })
                    }
                  />
                  <input
                    type="number"
                    value={settingsModule.windowWidth || 420}
                    onChange={(event) =>
                      void updateState({
                        customModules: currentState.customModules.map((module) =>
                          module.id === settingsModule.id
                            ? {
                                ...module,
                                windowWidth: Number(event.target.value) || 420
                              }
                            : module
                        )
                      })
                    }
                  />
                </label>
                <label className="module-climb-setting">
                  <span>窗口高度</span>
                  <input
                    type="range"
                    min="140"
                    max="700"
                    value={settingsModule.windowHeight || 320}
                    onChange={(event) =>
                      void updateState({
                        customModules: currentState.customModules.map((module) =>
                          module.id === settingsModule.id
                            ? {
                                ...module,
                                windowHeight: Number(event.target.value)
                              }
                            : module
                        )
                      })
                    }
                  />
                  <input
                    type="number"
                    value={settingsModule.windowHeight || 320}
                    onChange={(event) =>
                      void updateState({
                        customModules: currentState.customModules.map((module) =>
                          module.id === settingsModule.id
                            ? {
                                ...module,
                                windowHeight: Number(event.target.value) || 320
                              }
                            : module
                        )
                      })
                    }
                  />
                </label>
                {settingsModule.builtinType === "climb-platforms" && (
                  <>
                    <label className="module-climb-setting">
                      <span>召唤攀爬落脚点概率</span>
                      <input
                        type="range"
                        min="0"
                        max="100"
                        value={settingsModule.climbChance ?? 55}
                        onChange={(event) =>
                          void updateState({
                            customModules: currentState.customModules.map(
                              (module) =>
                                module.id === settingsModule.id
                                  ? {
                                      ...module,
                                      climbChance: Number(event.target.value)
                                    }
                                  : module
                            )
                          })
                        }
                      />
                      <input
                        type="number"
                        min="0"
                        max="100"
                        value={settingsModule.climbChance ?? 55}
                        onChange={(event) =>
                          void updateState({
                            customModules: currentState.customModules.map(
                              (module) =>
                                module.id === settingsModule.id
                                  ? {
                                      ...module,
                                      climbChance: Math.max(
                                        0,
                                        Math.min(
                                          100,
                                          Number(event.target.value) || 0
                                        )
                                      )
                                    }
                                  : module
                            )
                          })
                        }
                      />
                    </label>
                    <label className="module-climb-setting">
                      <span>新一轮攀爬概率</span>
                      <input
                        type="range"
                        min="0"
                        max="100"
                        value={settingsModule.climbJumpChance ?? 65}
                        onChange={(event) =>
                          void updateState({
                            customModules: currentState.customModules.map(
                              (module) =>
                                module.id === settingsModule.id
                                  ? {
                                      ...module,
                                      climbJumpChance: Number(event.target.value)
                                    }
                                  : module
                            )
                          })
                        }
                      />
                      <input
                        type="number"
                        min="0"
                        max="100"
                        value={settingsModule.climbJumpChance ?? 65}
                        onChange={(event) =>
                          void updateState({
                            customModules: currentState.customModules.map(
                              (module) =>
                                module.id === settingsModule.id
                                  ? {
                                      ...module,
                                      climbJumpChance: Math.max(
                                        0,
                                        Math.min(
                                          100,
                                          Number(event.target.value) || 0
                                        )
                                      )
                                    }
                                  : module
                            )
                          })
                        }
                      />
                    </label>
                    <label className="module-climb-setting">
                      <span>主动追踪软件概率</span>
                      <input
                        type="range"
                        min="0"
                        max="100"
                        value={settingsModule.climbApproachChance ?? 45}
                        onChange={(event) =>
                          void updateState({
                            customModules: currentState.customModules.map(
                              (module) =>
                                module.id === settingsModule.id
                                  ? {
                                      ...module,
                                      climbApproachChance: Number(
                                        event.target.value
                                      )
                                    }
                                  : module
                            )
                          })
                        }
                      />
                      <input
                        type="number"
                        min="0"
                        max="100"
                        value={settingsModule.climbApproachChance ?? 45}
                        onChange={(event) =>
                          void updateState({
                            customModules: currentState.customModules.map(
                              (module) =>
                                module.id === settingsModule.id
                                  ? {
                                      ...module,
                                      climbApproachChance: Math.max(
                                        0,
                                        Math.min(
                                          100,
                                          Number(event.target.value) || 0
                                        )
                                      )
                                    }
                                  : module
                            )
                          })
                        }
                      />
                    </label>
                    <label className="module-climb-setting">
                      <span>连跳续跳概率</span>
                      <input
                        type="number"
                        min="0"
                        max="100"
                        value={settingsModule.climbChainChance ?? 90}
                        onChange={(event) =>
                          void updateState({
                            customModules: currentState.customModules.map(
                              (module) =>
                                module.id === settingsModule.id
                                  ? {
                                      ...module,
                                      climbChainChance: Math.max(
                                        0,
                                        Math.min(
                                          100,
                                          Number(event.target.value) || 0
                                        )
                                      )
                                    }
                                  : module
                            )
                          })
                        }
                      />
                    </label>
                    <label className="module-climb-setting">
                      <span>每次续跳衰减倍数</span>
                      <input
                        type="number"
                        min="0"
                        max="1"
                        step="0.05"
                        value={settingsModule.climbChainDecay ?? 0.65}
                        onChange={(event) =>
                          void updateState({
                            customModules: currentState.customModules.map(
                              (module) =>
                                module.id === settingsModule.id
                                  ? {
                                      ...module,
                                      climbChainDecay: Math.max(
                                        0,
                                        Math.min(
                                          1,
                                          Number(event.target.value) || 0
                                        )
                                      )
                                    }
                                  : module
                            )
                          })
                        }
                      />
                    </label>
                    <label className="module-climb-setting">
                      <span>每升高一格衰减倍数</span>
                      <input
                        type="number"
                        min="0"
                        max="1"
                        step="0.05"
                        value={settingsModule.climbHeightDecay ?? 0.8}
                        onChange={(event) =>
                          void updateState({
                            customModules: currentState.customModules.map(
                              (module) =>
                                module.id === settingsModule.id
                                  ? {
                                      ...module,
                                      climbHeightDecay: Math.max(
                                        0,
                                        Math.min(
                                          1,
                                          Number(event.target.value) || 0
                                        )
                                      )
                                    }
                                  : module
                            )
                          })
                        }
                      />
                    </label>
                    <label className="module-climb-setting">
                      <span>跳跃判定间隔（秒）</span>
                      <input
                        type="range"
                        min="1"
                        max="300"
                        value={settingsModule.climbJumpIntervalSeconds ?? 3}
                        onChange={(event) =>
                          void updateState({
                            customModules: currentState.customModules.map(
                              (module) =>
                                module.id === settingsModule.id
                                  ? {
                                      ...module,
                                      climbJumpIntervalSeconds: Number(
                                        event.target.value
                                      )
                                    }
                                  : module
                            )
                          })
                        }
                      />
                      <input
                        type="number"
                        min="1"
                        value={settingsModule.climbJumpIntervalSeconds ?? 3}
                        onChange={(event) =>
                          void updateState({
                            customModules: currentState.customModules.map(
                              (module) =>
                                module.id === settingsModule.id
                                  ? {
                                      ...module,
                                      climbJumpIntervalSeconds: Math.max(
                                        1,
                                        Number(event.target.value) || 3
                                      )
                                    }
                                  : module
                            )
                          })
                        }
                      />
                    </label>
                    <label className="module-climb-setting">
                      <span>最多窗口数量</span>
                      <input
                        type="range"
                        min="1"
                        max="4"
                        value={settingsModule.climbMaxWindows ?? 2}
                        onChange={(event) =>
                          void updateState({
                            customModules: currentState.customModules.map(
                              (module) =>
                                module.id === settingsModule.id
                                  ? {
                                      ...module,
                                      climbMaxWindows: Number(event.target.value)
                                    }
                                  : module
                            )
                          })
                        }
                      />
                      <input
                        type="number"
                        min="1"
                        max="4"
                        value={settingsModule.climbMaxWindows ?? 2}
                        onChange={(event) =>
                          void updateState({
                            customModules: currentState.customModules.map(
                              (module) =>
                                module.id === settingsModule.id
                                  ? {
                                      ...module,
                                      climbMaxWindows: Math.max(
                                        1,
                                        Math.min(
                                          4,
                                          Number(event.target.value) || 2
                                        )
                                      )
                                    }
                                  : module
                            )
                          })
                        }
                      />
                    </label>
                    <label className="module-climb-setting">
                      <span>最多连爬层数</span>
                      <input
                        type="range"
                        min="1"
                        max="10"
                        value={settingsModule.climbMaxSteps ?? 3}
                        onChange={(event) =>
                          void updateState({
                            customModules: currentState.customModules.map(
                              (module) =>
                                module.id === settingsModule.id
                                  ? {
                                      ...module,
                                      climbMaxSteps: Number(event.target.value)
                                    }
                                  : module
                            )
                          })
                        }
                      />
                      <input
                        type="number"
                        min="1"
                        max="10"
                        value={settingsModule.climbMaxSteps ?? 3}
                        onChange={(event) =>
                          void updateState({
                            customModules: currentState.customModules.map(
                              (module) =>
                                module.id === settingsModule.id
                                  ? {
                                      ...module,
                                      climbMaxSteps: Math.max(
                                        1,
                                        Math.min(
                                          10,
                                          Number(event.target.value) || 3
                                        )
                                      )
                                    }
                                  : module
                            )
                          })
                        }
                      />
                    </label>
                  </>
                )}
              </>
            )}
          </div>
          <div className="module-editor-actions">
            <button
              type="button"
              disabled={settingsModule.builtinType === "hunger-food"}
              onClick={() =>
                void (settingsModule.builtinType === "climb-platforms"
                  ? window.deskPet.triggerExternalModule(
                      settingsModule.id,
                      "preview"
                    )
                  : settingsModule.builtinType === "hunger-food"
                    ? Promise.resolve(false)
                    : window.deskPet.openExternalModule(settingsModule.id))
              }
            >
              {settingsModule.builtinType === "hunger-food"
                ? "随角色自动运行"
                : settingsModule.builtinType === "climb-platforms"
                ? "生成攀爬窗口"
                : "打开模组"}
            </button>
            <button
              type="button"
              onClick={() => setSettingsId("")}
            >
              关闭设置
            </button>
            <button
              type="button"
              onClick={() => {
                if (!window.confirm(`删除模组“${settingsModule.name}”？`)) return;
                void updateState({
                  customModules: currentState.customModules.filter(
                    (module) => module.id !== settingsModule.id
                  ),
                  pets: currentState.pets.map((pet) => ({
                    ...pet,
                    modulePlugins: pet.modulePlugins
                      ? {
                          ...pet.modulePlugins,
                          boundModuleIds: (
                            pet.modulePlugins.boundModuleIds || []
                          ).filter((id) => id !== settingsModule.id)
                        }
                      : pet.modulePlugins
                  }))
                });
                setSettingsId("");
              }}
            >
              <Trash2 size={15} />
              删除
            </button>
          </div>
        </section>
      )}

      <section className="module-format-help">
        <div className="module-help-head">
          <strong>模组格式与接口</strong>
          <div className="module-help-actions">
            <button type="button" onClick={() => void copyManifestTemplate()}>
              <Copy size={14} />
              复制 module.json 模板
            </button>
            <button type="button" onClick={() => void createExampleModule()}>
              <FolderPlus size={14} />
              生成示例模组
            </button>
          </div>
        </div>

        <p className="module-help-note">
          一个模组就是一个文件夹：根目录放 <code>module.json</code>，再放入口页面（默认{" "}
          <code>index.html</code>）。入口页面通过全局对象 <code>window.arkpet</code>{" "}
          调用软件能力，不能直接访问 Node 或文件系统。
        </p>

        <strong className="module-help-sub">module.json 完整字段</strong>
        <pre>{MODULE_MANIFEST_TEMPLATE}</pre>
        <div className="module-field-list">
          {MODULE_FIELDS.map((item) => (
            <div className="module-field-row" key={item.field}>
              <code>{item.field}</code>
              <em className={item.required ? "module-field-required" : ""}>
                {item.required ? "必填" : "可选"}
              </em>
              <span>{item.note}</span>
            </div>
          ))}
        </div>

        <strong className="module-help-sub">可用接口（window.arkpet）</strong>
        <div className="module-api-list">
          {MODULE_API_DOCS.map((item) => (
            <div className="module-api-row" key={item.signature}>
              <code>{item.signature}</code>
              <span>{item.note}</span>
            </div>
          ))}
        </div>

        <strong className="module-help-sub">最小可运行的入口页面</strong>
        <pre>{MODULE_HTML_SAMPLE}</pre>
      </section>
    </div>
  );
}
