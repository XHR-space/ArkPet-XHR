# 风险 2 / 3 原型：真实窗口前后层级与临时焦点（Windows）

这个目录验证"每只角色一个独立窗口"方案里最危险的两件事：

- 风险 2：桌宠要能处在普通软件窗口之上、被任务栏挡住，并按"最后点了谁"动态改变前后层级。
- 风险 3：自动文字需要临时抢到焦点，而其它时候绝不抢焦点。

原型只放在 `prototypes/`，不加载 ArkPet 状态、不碰 `src/**`、`electron/**`，也不会启动或关闭正在运行的 ArkPet。

## 运行

```powershell
& ".\node_modules\electron\dist\electron.exe" prototypes\pet-window-zorder\main2.cjs
```

结果写入 `results-zorder-focus.json`。`main.cjs` / `results.json` 是第一版原型，结论已被下面的方法学修复推翻，仅作留档。

## 之前结论错误的原因（重要）

第一版原型量到的失败绝大部分是**测量方法错**，不是产品能力不行：

1. **PowerShell helper 没有声明 DPI 感知**。本机是 2560×1600 / 150% 缩放，非 DPI 感知进程拿到的坐标会被系统虚拟化到 1707×1067。于是"在角色方块中心取像素""在重叠点做 `WindowFromPoint`"全都在错误的物理位置上采样。修复：helper 启动时调用 `SetProcessDpiAwarenessContext(PER_MONITOR_AWARE_V2)`。
2. **窗口根本没在最上层**。后启动的普通窗口不一定能盖过当前前台应用（这里是 Trae），于是抓到的像素是 Trae 的内容。修复：抓取类检查先把桌宠窗口临时放进 topmost 层（`SetWindowPos(HWND_TOPMOST, SWP_NOACTIVATE)`），取样后再还原。
3. **`WS_EX_NOACTIVATE` 的窗口不能被激活**。焦点检查必须先临时清掉 `WS_EX_NOACTIVATE`，再调 `SetForegroundWindow`，用完后恢复。
4. **Windows 前台锁**。后台进程直接 `SetForegroundWindow` 会返回 false。需要先合成一次 ALT 按键（`keybd_event(0x12,...)`）再调用，才能拿到前台。

## 实测结果（`results-zorder-focus.json`）

| 检查 | 结果 | 说明 |
| --- | --- | --- |
| `petWindowIsToolWindowAndNoActivate` | 通过 | `exStyle = 0x08000080`，即 `WS_EX_NOACTIVATE \| WS_EX_TOOLWINDOW`；不进任务栏、不进 Alt+Tab、不会自己抢焦点 |
| `topmostPetVisibleOverOtherApps` | 通过 | 置顶后，方块中心的像素与 `WindowFromPoint` 都指向桌宠窗口本身，说明确实盖在别的应用之上 |
| `raisedNormalWindowCoversPet` | 通过 | 普通窗口提升后 `CompareZ` 判定它在桌宠之上 |
| `raiseNoActivatePutsPetBackOnTop` | 通过 | `SetWindowPos(HWND_TOP, SWP_NOACTIVATE)` 能把桌宠提回普通窗口之上，且前台窗口没有变化（不抢焦点） |
| `temporaryFocusCanActivatePet` | 通过 | 清掉 `WS_EX_NOACTIVATE` + ALT 解锁 + `SetForegroundWindow`，桌宠能临时拿到焦点 |
| `focusCanBeTakenBackAndDoesNotBounce` | 通过 | 把焦点还给普通窗口后 1.5 秒内没有被桌宠抢回去 |
| `taskbarOccludesTopmostPet` | **失败（真实问题）** | 见下 |

## 关键结论：topmost 的桌宠会盖住任务栏

把桌宠放进 topmost 层、并把它的方块移到任务栏中心后：

- 该点像素 = `#EE8031`（桌宠的橙色方块），不是任务栏；
- `WindowFromPoint` 返回桌宠窗口，而不是 `Shell_TrayWnd`。

也就是说：**任务栏不会自动压住 topmost 窗口**。而"所有普通软件窗口之上"在 Windows 上只能用 topmost 稳定实现（后台进程的 `HWND_TOP` 提升会被前台窗口压制）。

因此实现时必须自己解决遮挡，可选方案：

1. 用 `SetWindowRgn` 把任务栏矩形从桌宠窗口区域里挖掉（推荐，和"碰撞体不能进入任务栏"天然一致）；
2. 渲染时按任务栏矩形裁剪画布（CSS clip / 画布偏移）。

方案确定后需要补一个原型验证 `SetWindowRgn` 在透明分层窗口上的表现。

## macOS 备注

macOS 没有 `SetWindowPos`，层级要用 `NSWindow` 的 `setLevel:` / `orderFront:`，任务栏（Dock）按需求不参与遮挡，只按屏幕底部边界处理。这一个原型只覆盖 Windows。
