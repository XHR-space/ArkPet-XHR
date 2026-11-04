# 每角色独立窗口运行时：实现计划（基于四个风险原型的结论）

状态：设计已定稿，尚未动 `src/**` 与 `electron/**`。

## 1. 不变量（改错任何一条都算回归）

1. 视觉位置固定：显示框中心 == 角色舞台中心，任何时候不因碰撞体重力位移而改变相对关系。
2. 只有碰撞体参与物理：不能出屏、不能进入任务栏、不能穿模到地面以下。
3. 交互范围只影响鼠标命中，不影响物理。
4. 显示框只影响画布/裁剪，不影响物理；允许裁掉角色。
5. `pet.scale` / `overlay.scale` 等比缩放显示、碰撞、交互；编辑器里一律显示归一化几何。
6. 旧存档迁移后，角色的**宿主矩形（物理体 + 显示锚点）在世界坐标里不许移动**。

## 2. 窗口模型

- 每个角色一个独立窗口，尺寸 = 显示框尺寸 × scale（不是旧的全屏 overlay）。
- 角色窗口：`frame:false` + `transparent:true` + `skipTaskbar:true` + `focusable:false`
  + 原生 `WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE`（已验证 `exStyle = 0x08000080`）。
- 多角色 = 多窗口，各自参与前后层级；聊天窗（文字/语音）仍是独立窗口。
- 主显示器限定：窗口只在 primary display 的 bounds 内活动；任务栏取 `Shell_TrayWnd`。

## 3. 坐标与 DPI（踩过的坑）

- 所有原生调用（移动、命中测试、取像素、设区域）都必须由 **PerMonitorV2 DPI 感知**的进程发起：
  `SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2)`。
- Electron 的 `screen.getPrimaryDisplay().bounds` 是 DIP；本机 2560×1600 / 150% 时返回 1707×1067。
  原生坐标 = DIP × scaleFactor。
- 落地判定之前先在原型里被 DPI 虚拟化坑过一次：非 DPI 感知进程看到的坐标是 96dpi 虚拟坐标，
  两个进程混用会导致"点在 A、实际在 B"。
- 窗口位置必须用 `SetWindowPos` 摆放后再测量；`BrowserWindow` 构造参数在 150% 缩放下落点不可靠。

## 4. 原生能力清单（Windows）

| 能力 | 实现 | 验证结论 |
| --- | --- | --- |
| 每帧移动 | `SetWindowPos(..., SWP_NOSIZE \| SWP_NOZORDER \| SWP_NOACTIVATE)` | 60Hz 采样 392 帧，缺帧 0；平均 0.057ms，远优于 `setBounds` |
| 置顶（高于普通窗口） | `SetWindowPos(HWND_TOPMOST, SWP_NOACTIVATE)` | 置顶后像素与 `WindowFromPoint` 都指向本窗口 |
| 被任务栏挡住 | `SetWindowRgn(窗口矩形 − 任务栏矩形)` | 任务栏带内像素变回任务栏，命中测试也回到任务栏；700ms 后仍稳定 |
| 不进 Alt+Tab / 不抢焦点 | `WS_EX_TOOLWINDOW \| WS_EX_NOACTIVATE` | 通过 |
| 无激活提升 | `SetWindowPos(HWND_TOP, SWP_NOACTIVATE)` | 通过，且前台窗口不变 |
| 临时抢焦点 | 清 `WS_EX_NOACTIVATE` → ALT 键解锁 → `SetForegroundWindow` → 用完恢复 | 通过；随后焦点可被别的窗口抢回且 1.5s 内不反弹 |

## 5. 任务栏策略

- 任务栏矩形来自 `FindWindow("Shell_TrayWnd")`，只在主显示器上取。
- 桌宠窗口区域 = 窗口矩形 − 任务栏矩形（局部坐标用 `CombineRgn(RGN_DIFF)`）。
- 任务栏位置/尺寸变化（切换显示器、改任务栏位置、自动隐藏）后要重算区域；
  任务栏不可见时按用户最终确认：**仍然保留任务栏碰撞体积**。
- 备选方案：渲染层 `clip-path` 裁剪（只改显示，不改命中测试），仅在拿不到 region 的平台使用。

## 6. 物理归属

建议保持现有分工：**物理在渲染进程算，主进程只做原生窗口操作**。

- 渲染进程每帧算碰撞体位置 → 通过 IPC 把"目标物理窗口位置"发给主进程 → 主进程调原生移动。
- 不要每帧 `setBounds`（已测：平均 2.90ms、p95 4.63ms、有掉帧）。
- 原生 helper 常驻（一次启动、stdin/stdout JSON 协议），不要每帧起新进程。
- 需要背压处理：主进程写 stdin 不成功时丢帧计数，不要阻塞渲染。

## 7. 模块

- 桌面图标、其他软件窗口、攀爬落脚点：只有装了对应模组才存在。
- 它们只提供"可以站在上面"的顶面支撑，不做侧面阻挡。
- 多角色相遇：`passThroughChance` 每次相遇只掷一次；通过则允许碰撞体重叠且不改层级；不通过则只反向，不强行分离。

## 8. macOS

- 不能用 `SetWindowPos` / `SetWindowRgn`：用常驻 helper 在主线程调用 `NSWindow.setFrameOrigin:` /
  `orderFront:` / `setLevel:`；坐标原点左下、缩放、菜单栏差异都要处理。
- Dock 不参与遮挡（按需求只按屏幕底部边界处理）。

## 9. 验收清单

1. `npm run check` 绿（基线已确认是绿的）。
2. `node electron/pet-layout.test.cjs` 覆盖 7 个 fixture 且全绿。
3. 手动：改大小后显示/碰撞/交互同步缩放；缩放前后中心不动。
4. 手动：拖到任务栏附近，身体被任务栏挡住，点击落在任务栏；任务栏区点不到角色。
5. 手动：点别的窗口 → 该窗口到最前并盖住角色；点角色 → 角色回最前且不抢焦点。
6. 手动：文字对话出现时临时激活，点别的窗口能立刻抢回。
7. 重启后位置与碰撞体位置完全一致（不再出现"改了但拖一下就弹回去"）。
