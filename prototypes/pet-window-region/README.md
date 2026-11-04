# 风险补充原型：让桌宠被任务栏挡住（Windows）

风险 2 的结论里留下了一个真问题：**topmost 的桌宠会盖住任务栏**。这个原型验证两种解决方案，结果两种都可用。

运行：

```powershell
& ".\node_modules\electron\dist\electron.exe" prototypes\pet-window-region\main.cjs
```

结果写入 `results-window-region.json`。

## 场景

透明、置顶、`WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW` 的桌宠窗口，用 `SetWindowPos` 摆到"角色方块中心正好压在任务栏上边缘"的位置（本机：窗口 `1056,1258 → 1509,1801`，任务栏上边缘 `y = 1528`，150% 缩放）。取两个探针点：

- `aboveEdge` = 上边缘上方 30px（应该永远能看到角色）
- `insideBand` = 上边缘下方 30px（应该永远看不到角色）

## 结果

| 检查 | 结果 | 关键数据 |
| --- | --- | --- |
| `baselineTopmostPetCoversTaskbar` | 通过（复现了问题） | 两个点像素都是 `#EE8031`（角色方块），`WindowFromPoint` 都返回桌宠窗口 |
| `nativeSetWindowRgnClipsTaskbarBand` | 通过 | 见下 |
| `rendererClipStillPaintsAboveTaskbar` | 通过 | 上边缘上方仍是角色像素 |
| `rendererClipHidesTaskbarBand` | 通过 | 任务栏带内像素变成 `#454545`（任务栏），角色不再覆盖 |
| `rendererClipCanBeCleared` | 通过 | 取消裁剪后任务栏带内又变回角色像素 |

### 方案 A：原生 `SetWindowRgn`（推荐）

把窗口区域设为"窗口矩形 − 任务栏矩形"（局部坐标 `0,270 → 453,342`）：

- `aboveEdge`：像素仍是角色 `#EE8031`，`WindowFromPoint` 仍是桌宠；
- `insideBand`：像素变成任务栏 `#454545`，`WindowFromPoint` 变成任务栏窗口（`131540`）；
- 700ms 后再测一次结果不变，说明 Chromium 不会在重绘时把自己的区域改回去。

推荐原因：它同时修正**显示**和**命中测试**——任务栏带里的点击会落到任务栏/任务栏上的软件，正好满足"被任务栏挡住的区域点击优先级低于任务栏"。

### 方案 B：渲染层裁剪（备用）

给渲染容器的 `clip-path` 加 `inset(0 0 180px 0)`（180 DIP = 窗口顶到任务栏上边缘）：

- 像素效果和方案 A 一致；
- 但窗口区域没变，`WindowFromPoint` 仍然返回桌宠窗口 → 任务栏带里的点击还是会被桌宠吃掉。

所以方案 B 只适合当兜底（例如某个平台拿不到窗口 region），主方案用 A。

## 注意

- 位置必须用 `SetWindowPos` 摆放后再测量。原型第一版直接在 `BrowserWindow` 构造里给坐标，结果窗口落点和预期差了几百像素，导致整轮测量全错。
- 任务栏矩形取自 `FindWindow("Shell_TrayWnd")`；主显示器之外的次级任务栏没有处理。
