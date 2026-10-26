# 桌宠工房

一个只在本机运行的 Windows 桌宠应用。管理台使用本地网页技术，桌宠本体使用 Electron 透明置顶窗口。

## 使用说明 / User Guides

- [中文完整使用说明](docs/User-Guide.zh-CN.md)
- [English User Guide](docs/User-Guide.en-US.md)

## ArkPet 2.1.0

- 首页总览
- 桌宠唤醒与桌面行为测试
- 桌宠制作、图片素材导入和 Spine 3.8 骨骼角色导入
- 每只角色独立的小型交互区域，支持点击、拖动、双击和右键菜单
- 右键打开按角色独立的完整聊天页，自动文字继续使用紧凑气泡
- 个性化 AI 角色大脑、资料、记忆和对话测试
- 本地语音识别、语音合成接口
- 数据与设置、备份与恢复
- 基于 GitHub Releases 的自动更新检查与安装包暂存
- 透明置顶、鼠标穿透、拖动、重力、任务栏上沿落点和自动行走

## 启动

```powershell
npm.cmd install
npm.cmd run dev
```

正式构建并运行：

```powershell
npm.cmd run build
npm.cmd start
```

## 目录与数据位置

目录统一放在软件根目录下：

- 软件代码：`src/`、`electron/`、`scripts/`、`dist/`
- 启动器：`launcher/`
- Spine 素材源：`spine-source/`
- 软件数据：`data/`
- 用户数据：`data/user-data/`

正式安装包同样使用 `<软件目录>/data/user-data`。自动更新只替换程序文件，不修改 `data` 目录；如果安装目录不可写，才会回退到系统用户目录。

默认开发数据位于项目内的：

```text
data/user-data
```

主状态文件为 `data/user-data/desk-pet-state.json`，每个角色的独立存档位于 `data/user-data/pet-store`，图片和声音素材保存在 `data/user-data/assets`。软件关闭或重启后数据不会丢失。

## 发布种子

安装包里的初始数据来自 `release-seed/`，由下面这条命令生成：

```powershell
npm.cmd run seed
```

发行种子只保留三个名字以“黍”开头的桌宠、一个黍角色档案和一个黍语音模块，并清除本地模型、推理设置、服务地址与密钥、个人声音样本、对话记录、使用时间、训练模块和预设模组。因此用户需要在自己的电脑上配置模型和下载模组。

## 模组仓库

模组独立于软件版本，清单位于：

```text
module-registry/registry.json
module-registry/mods/<module-id>/
```

每个模组目录包含 `module.json`、入口页面和所需资源。`registry.json` 中的 `version` 用于安装与更新检测，`basePath` 指向模组目录，`files` 列出需要下载的全部文件。

发布模组更新时只需要提高对应模组的 `version`，修改模组文件并推送仓库，不需要重新发布软件安装包。正式版会从 GitHub 仓库读取清单和文件；开发版会优先读取本地 `module-registry` 便于测试。

## 后续需要提供的角色素材

第一版使用程序内临时小人验证行为。接入正式角色时，需要透明 PNG 序列帧：

- 基础形象
- 待机动作，建议 4 到 8 帧
- 行走动作，建议 4 到 8 帧
- 掉落动作，建议 2 到 4 帧
- 落地动作，建议 2 到 4 帧
- 拖拽动作，建议 2 帧
- 休眠与唤醒动作，各 2 帧
- 脚底落点和碰撞范围

图片使用统一画布尺寸、透明背景和一致朝向。左右移动可以先使用镜像。

如果使用 Spine 角色，需要同时提供：

- `.skel` 骨骼文件
- 同名 `.atlas` 图集文件
- 图集中第一行声明的纹理页 PNG，例如 `844 x 844`

制作页的“导入 Spine 角色”会同时复制这三份文件，并自动读取动画名称。

## 本地 AI 与语音

默认接口采用常见的 OpenAI 兼容格式：

- 对话模型：`http://127.0.0.1:11434/v1`
- 语音识别：`http://127.0.0.1:8000/v1`
- 语音合成：`http://127.0.0.1:9880/v1`

实际地址可以在“数据与设置”的“本地 AI”中修改。模型和语音引擎未启动时，界面仍可使用，角色对话会退回到内置角色回应。

声音样本和训练素材支持 WAV、MP3、M4A、FLAC、OGG 和 WEBM；软件生成的语音输出为 WAV。桌宠随机播放的预录角色语音目前只支持 WAV。
