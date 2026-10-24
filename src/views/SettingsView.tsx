import {
  ArchiveRestore,
  FolderOpen,
  HardDriveDownload,
  Palette,
  Power,
  Radio,
  Save,
  Volume2
} from "lucide-react";
import { useEffect, useState } from "react";
import { useAppState } from "../state";
import type {
  ServiceConfig,
  ThemeName,
  UpdateStatus
} from "../types";

type SettingsSection =
  | "theme"
  | "services"
  | "data"
  | "app";

const themeOptions: Array<{
  id: ThemeName;
  name: string;
  description: string;
  colors: string[];
}> = [
  {
    id: "default",
    name: "默认工房",
    description: "当前版本的暖白与蓝色工作台。",
    colors: ["#f4f2ec", "#18243a", "#2f7df6", "#f59f38"]
  },
  {
    id: "violet",
    name: "紫苑",
    description: "取自紫红、樱粉与木槿色卡。",
    colors: ["#f8eef7", "#4b2850", "#a64a8d", "#d9699b"]
  },
  {
    id: "azure",
    name: "霜蓝",
    description: "取自月白、晴蓝与佛头青色卡。",
    colors: ["#eef4f9", "#12395f", "#3271ae", "#6e9bc5"]
  },
  {
    id: "jade",
    name: "青绿",
    description: "取自竹月、石绿与御台茶色卡。",
    colors: ["#eef4f2", "#1d3b3a", "#2f807d", "#83bfb8"]
  }
];

const sections: Array<{
  id: SettingsSection;
  label: string;
  description: string;
  icon: typeof Palette;
}> = [
  { id: "theme", label: "皮肤主题", description: "界面配色与皮肤", icon: Palette },
  { id: "data", label: "数据安全", description: "备份与数据位置", icon: HardDriveDownload },
  { id: "app", label: "应用控制", description: "启动与退出", icon: Power }
];

export function SettingsView() {
  const { state, updateState } = useAppState();
  const [activeSection, setActiveSection] = useState<SettingsSection>("theme");
  const [serviceResults, setServiceResults] = useState<Record<string, string>>({});
  const [paths, setPaths] = useState<{
    dataPath: string;
    statePath: string;
    assetsPath: string;
    petStorePath: string;
    softwarePath: string;
    softwareDataPath: string;
    appPath: string;
    updateCachePath: string;
  } | null>(null);
  const [backupBusy, setBackupBusy] = useState(false);
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus | null>(null);

  useEffect(() => {
    window.deskPet.getDataPaths().then(setPaths);
    window.deskPet.updateStatus().then(setUpdateStatus);
    return window.deskPet.onUpdateStatus(setUpdateStatus);
  }, []);

  if (!state) return null;
  const currentState = state;

  async function saveTheme(theme: ThemeName) {
    await updateState({
      settings: {
        ...currentState.settings,
        appearance: {
          ...currentState.settings.appearance,
          theme
        }
      }
    });
  }

  async function saveService(
    service: "llm" | "asr" | "tts",
    patch: Partial<ServiceConfig>
  ) {
    await updateState({
      settings: {
        ...currentState.settings,
        services: {
          ...currentState.settings.services,
          [service]: {
            ...currentState.settings.services[service],
            ...patch
          }
        }
      }
    });
  }

  async function testService(service: "llm" | "asr" | "tts") {
    setServiceResults((current) => ({ ...current, [service]: "正在连接..." }));
    const result = await window.deskPet.testService(service);
    setServiceResults((current) => ({
      ...current,
      [service]: result.ok ? "连接正常" : result.error || "无法连接"
    }));
  }

  async function exportBackup() {
    setBackupBusy(true);
    try {
      await window.deskPet.exportBackup();
    } finally {
      setBackupBusy(false);
    }
  }

  async function importBackup() {
    if (!window.confirm("导入备份会替换当前状态，确定继续吗？")) return;
    setBackupBusy(true);
    try {
      const result = await window.deskPet.importBackup();
      if (result.ok === false) {
        window.alert(result.error || "导入备份失败。");
      }
    } finally {
      setBackupBusy(false);
    }
  }

  return (
    <div className="settings-layout">
      <aside className="settings-nav">
        {sections.map((section) => {
          const Icon = section.icon;
          return (
            <button
              className={
                activeSection === section.id
                  ? "settings-nav-item settings-nav-item--active"
                  : "settings-nav-item"
              }
              key={section.id}
              type="button"
              onClick={() => setActiveSection(section.id)}
            >
              <Icon size={18} />
              <div>
                <strong>{section.label}</strong>
                <span>{section.description}</span>
              </div>
            </button>
          );
        })}
      </aside>

      <section className="settings-content">
        {activeSection === "theme" && (
          <div className="settings-section">
            <div className="section-heading">
              <span className="section-kicker">皮肤主题</span>
              <h2>选择整套界面配色</h2>
              <p>主题会保存在本机，重新打开软件后继续使用当前选择。</p>
            </div>
            <div className="theme-grid">
              {themeOptions.map((theme) => {
                const selected =
                  (state.settings.appearance?.theme || "default") === theme.id;
                return (
                  <button
                    className={
                      selected ? "theme-card theme-card--active" : "theme-card"
                    }
                    key={theme.id}
                    type="button"
                    onClick={() => saveTheme(theme.id)}
                  >
                    <div className="theme-swatches">
                      {theme.colors.map((color) => (
                        <span
                          key={color}
                          style={{ background: color }}
                        />
                      ))}
                    </div>
                    <div className="theme-card-copy">
                      <strong>{theme.name}</strong>
                      <span>{theme.description}</span>
                    </div>
                    <span className="theme-card-state">
                      {selected ? "当前使用" : "点击切换"}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {activeSection === "services" && (
          <div className="settings-section">
            <div className="section-heading">
              <span className="section-kicker">本地 AI</span>
              <h2>连接本机运行的服务</h2>
              <p>地址只在本机使用，默认接口采用常见的 OpenAI 兼容格式。</p>
            </div>
            {(["llm", "asr", "tts"] as const).map((service) => {
              const labels = {
                llm: "对话模型",
                asr: "语音识别",
                tts: "语音合成"
              };
              const config = state.settings.services[service];
              return (
                <div className="service-config" key={service}>
                  <div className="service-config-heading">
                    <div>
                      {service === "llm" && <Radio size={18} />}
                      {service === "asr" && <ArchiveRestore size={18} />}
                      {service === "tts" && <Volume2 size={18} />}
                      <strong>{labels[service]}</strong>
                    </div>
                    <span>{serviceResults[service] || "未测试"}</span>
                  </div>
                  <div className="service-fields">
                    <label>
                      <span>服务地址</span>
                      <input
                        defaultValue={config.baseUrl}
                        key={`${service}-${config.baseUrl}`}
                        onBlur={(event) => saveService(service, { baseUrl: event.target.value })}
                      />
                    </label>
                    <label>
                      <span>模型或声线 ID</span>
                      <input
                        defaultValue={service === "tts" ? config.voiceId || "" : config.model}
                        key={`${service}-${config.model}-${config.voiceId || ""}`}
                        onBlur={(event) =>
                          saveService(
                            service,
                            service === "tts"
                              ? { voiceId: event.target.value }
                              : { model: event.target.value }
                          )
                        }
                      />
                    </label>
                    <button type="button" onClick={() => testService(service)}>
                      测试连接
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {activeSection === "data" && (
          <div className="settings-section">
            <div className="section-heading">
              <span className="section-kicker">数据安全</span>
              <h2>管理本机保存的数据</h2>
              <p>状态文件、图片素材和声音样本都保存在当前电脑的数据目录中。</p>
            </div>
            <div className="data-path">
              <FolderOpen size={20} />
              <div>
                  <strong>软件数据目录</strong>
                  <code>{paths?.softwareDataPath || "正在读取..."}</code>
              </div>
            </div>
              <div className="data-path">
                <FolderOpen size={20} />
                <div>
                  <strong>用户数据子目录（更新时保留）</strong>
                  <code>{paths?.dataPath || "正在读取..."}</code>
                </div>
              </div>
              <p className="idle-help">
                用户数据放在软件目录下的 data/user-data 中。自动更新只替换程序文件，保留 data 目录。
              </p>
            <div className="settings-actions">
              <button type="button" onClick={() => window.deskPet.openDataFolder()}>
                <FolderOpen size={16} />
                  打开用户数据
                </button>
                <button type="button" onClick={() => window.deskPet.openSoftwareFolder()}>
                  <FolderOpen size={16} />
                  打开软件目录
              </button>
              <button
                type="button"
                onClick={async () => {
                  const result = await window.deskPet.syncPetStore();
                  window.alert(`已保存 ${result.count} 个独立角色文件。`);
                }}
              >
                <Save size={16} />
                保存独立角色文件
              </button>
              <button type="button" onClick={() => window.deskPet.openPetStore()}>
                <FolderOpen size={16} />
                打开角色存档
              </button>
              <button type="button" disabled={backupBusy} onClick={exportBackup}>
                <HardDriveDownload size={16} />
                导出备份
              </button>
              <button type="button" disabled={backupBusy} onClick={importBackup}>
                <ArchiveRestore size={16} />
                导入备份
              </button>
            </div>
          </div>
        )}

        {activeSection === "app" && (
          <div className="settings-section">
            <div className="section-heading">
              <span className="section-kicker">应用控制</span>
              <h2>本地运行状态</h2>
                <p>除检查更新外，应用不需要登录或联网。关闭管理台时会隐藏到后台，桌宠继续运行。</p>
            </div>
              <div className="update-panel">
                <div>
                  <span className="section-kicker">自动更新</span>
                  <strong>
                    当前版本 {updateStatus?.currentVersion || "读取中"}
                    {updateStatus?.latestVersion
                      ? ` · 最新版本 ${updateStatus.latestVersion}`
                      : ""}
                  </strong>
                  <p>
                    {updateStatus?.status === "ready"
                      ? "新版本已下载，退出软件时自动替换；也可以立即更新。"
                      : updateStatus?.status === "downloading"
                        ? `正在下载更新 ${updateStatus.progress}%`
                        : updateStatus?.status === "checking"
                          ? "正在检查更新..."
                          : updateStatus?.status === "up-to-date"
                            ? "当前已经是最新版本。"
                            : updateStatus?.status === "development"
                              ? "开发运行模式不自动安装更新。"
                              : updateStatus?.status === "error"
                                ? updateStatus.error || "检查更新失败。"
                                : "软件会在后台自动检查新版本，并保留全部用户数据。"}
                  </p>
                </div>
                <div className="update-actions">
                  <button
                    type="button"
                    disabled={
                      updateStatus?.status === "checking" ||
                      updateStatus?.status === "downloading"
                    }
                    onClick={() =>
                      void window.deskPet.checkForUpdates().then(setUpdateStatus)
                    }
                  >
                    检查更新
                  </button>
                  {updateStatus?.status === "ready" && (
                    <button
                      className="primary-small"
                      type="button"
                      onClick={() => void window.deskPet.installUpdate()}
                    >
                      立即更新并退出
                    </button>
                  )}
                </div>
                {updateStatus?.status === "downloading" && (
                  <div className="update-progress">
                    <span style={{ width: `${updateStatus.progress}%` }} />
                  </div>
                )}
              </div>
            <div className="app-control-list">
              <div>
                <strong>运行位置</strong>
                <span>仅限当前 Windows 电脑</span>
              </div>
              <div>
                <strong>应用数据</strong>
                <span>关闭和重启后保留</span>
              </div>
            </div>
            <div className="danger-zone">
              <div>
                <strong>退出 ArkPet</strong>
                <span>结束管理台、桌宠悬浮层和后台服务连接。</span>
              </div>
              <button
                className="danger-button"
                type="button"
                onClick={() => {
                  if (window.confirm("确定退出 ArkPet 吗？")) window.deskPet.quit();
                }}
              >
                <Power size={16} />
                退出应用
              </button>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
