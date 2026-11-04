# 桌宠单窗口移动性能原型

这个原型只验证一件事：每只桌宠各自拥有一扇透明窗口时，连续横向移动应当使用哪种调度方式。

它不会加载 ArkPet 状态，不会申请单实例锁，也不会改动 `src/**`、`electron/**` 或发布配置。

## 运行

在仓库根目录执行：

```powershell
node_modules\electron\dist\electron.exe prototypes\pet-window-movement\main.cjs --mode=electron
node_modules\electron\dist\electron.exe prototypes\pet-window-movement\main.cjs --mode=native
```

默认每次运行 15 秒。可以用 `--duration=30` 延长，例如：

```powershell
node_modules\electron\dist\electron.exe prototypes\pet-window-movement\main.cjs --mode=native --duration=30
```

Windows PowerShell 可能把 Electron 视为 GUI 程序而在测试完成前返回提示符。此时等待约 15 秒，看到对应 `results-<mode>.json` 更新即表示本次运行结束。如果需要命令同步等待完成和收集 stdout，可在仓库根目录执行：

```powershell
node -e "const{spawnSync}=require('child_process');const mode=process.argv[1];const r=spawnSync('node_modules/electron/dist/electron.exe',['prototypes/pet-window-movement/main.cjs','--mode='+mode],{encoding:'utf8',timeout:30000});process.stdout.write(r.stdout||'');process.stderr.write(r.stderr||'');if(r.status!==0||r.error)process.exit(1)" electron
```

窗口为 `260 x 340` 的透明、无边框、`skipTaskbar`、`focusable: false` 普通层级窗口。它不会调用 `alwaysOnTop`，也不会激活或关闭正在运行的 ArkPet。

## 两种模式

### `electron`

每次移动调用 `BrowserWindow.setBounds({ x, y }, false)`。这是 Electron 提供的窗口移动路径。

### `native`

首次启动一个常驻 PowerShell 进程。Electron 从 `BrowserWindow.getNativeWindowHandle()` 读取 64-bit HWND，把它和坐标按 JSON Lines 写入 helper 的 stdin。helper 通过 P/Invoke 调用：

```text
SetWindowPos(hwnd, IntPtr.Zero, x, y, 0, 0,
  SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE | SWP_ASYNCWINDOWPOS)
```

helper 只在启动时返回一次 `ready`，移动失败时返回 `error`。主进程不会等待每帧 ack，因此测量不会把 helper 的返回延迟算进移动调用耗时。

如果 helper 按预期退出，主进程正常结束；启动超时、stdout JSON 损坏、stdin 写入错误或意外退出都会计入 `nativeHelper.errorCount` 并打印到控制台。

## DPI 和坐标

Electron 的 `Bounds` 使用 DIP。Windows `SetWindowPos` 使用物理像素。原型通过：

```text
physical = DIP * screen.getPrimaryDisplay().scaleFactor
```

做转换。这个原型只以主显示器为测试目标，因为 Windows 多显示器可能具有不同的缩放比例和虚拟桌面原点；正式实现不能只用主显示器的 `scaleFactor` 换算所有显示器。

## 调度和指标

调度不使用裸 `setInterval`。主循环以 `process.hrtime.bigint()` 计算 60Hz 的绝对 deadline，用短 `setTimeout` 贴近 deadline；如果某一帧处理完成时已经越过后续 deadline，会直接跳到当前时间后的下一帧并累加 `skippedLateFrames`，避免迟到帧追赶造成突发移动。

每次调用移动 API 时记录 `process.hrtime.bigint()` 前后差：

- `frames`：实际执行移动的次数。
- `avgMs`、`p50Ms`、`p95Ms`、`maxMs`：移动调用耗时。
- `fps`：实际移动次数除以测量时长。
- `skippedLateFrames`：因迟到而跳过的目标帧数。
- `backpressureEvents`：native 模式 stdout/stdin 背压出现次数。
- `errorCount`：native helper 协议、写入或退出错误次数。

结果写入同目录的 `results-electron.json` 或 `results-native.json`。

在 native 模式中，`SetWindowPos` 带 `SWP_ASYNCWINDOWPOS`，因此测得的 `moveCall` 主要反映 helper 管道写入和调度提交成本，不等同于桌面合成器完成最终绘制的时间。判断闪烁和卡顿仍需配合录屏或高速摄像观察，并观察 `fps` 与 `skippedLateFrames` 是否稳定。

## 闪烁采样

`index.html` 左上角有一个固定 `16 x 16` 的纯 `#ff00ff` 标记，正常情况下每一帧都应存在。`capture-flicker.ps1` 以 30Hz 连续抓取 8 秒，并统计标记缺失帧。

先在一个终端启动 native POC：

```powershell
node_modules\electron\dist\electron.exe prototypes\pet-window-movement\main.cjs --mode=native --duration=20
```

再在另一个终端运行：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File prototypes\pet-window-movement\capture-flicker.ps1
```

也可以从仓库根目录用一条命令启动、采样并等待退出：

```powershell
$poc = Start-Process -FilePath (Resolve-Path 'node_modules\electron\dist\electron.exe') -ArgumentList @((Resolve-Path 'prototypes\pet-window-movement\main.cjs'), '--mode=native', '--duration=20') -PassThru
try {
  Start-Sleep -Milliseconds 1500
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File prototypes\pet-window-movement\capture-flicker.ps1 -DurationSeconds 8
  Wait-Process -Id $poc.Id -Timeout 20 -ErrorAction SilentlyContinue
} finally {
  if (-not $poc.HasExited) { Stop-Process -Id $poc.Id -Force }
}
```

默认会在采样前调用一次 `SetWindowPos(HWND_TOP, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE)`，把目标提升到普通窗口层级顶部，降低被其他窗口遮挡导致 fallback 误判的概率。它不会激活窗口，也不会设置为 `HWND_TOPMOST`。可以用 `-RaiseWindow:$false` 关闭该行为。

结果写入 `results-flicker-native.json`。脚本优先通过 `GetWindowRect + PrintWindow(PW_RENDERFULLCONTENT)` 获取窗口位图；如果 `PrintWindow` 失败，或者返回成功但左上扫描区没有标记，则只对目标窗口矩形调用 `Graphics.CopyFromScreen`，不会抓取全屏截图。

需要排查抓取内容时可加：

```powershell
-DebugImagePath prototypes\pet-window-movement\diagnostic-frame
```

脚本会保存首帧的 `diagnostic-frame.printwindow.png`（如果 `PrintWindow` 返回成功）和 `diagnostic-frame.fallback.png`（如果走了 `CopyFromScreen`）。

`CopyFromScreen` 抓的是屏幕合成结果。如果目标窗口被其他窗口遮挡，这一帧可能因为遮挡而缺失标记，因此 JSON 会分别记录 `capturePath = "PrintWindow"` 和 `capturePath = "CopyFromScreen"` 的帧数。只有 `PrintWindow` 路径能直接证明窗口内容帧存在；fallback 路径的结论必须同时考虑遮挡情况。

## macOS 后续方案

macOS 不能使用 `SetWindowPos`。后续需要一个常驻原生 helper，在主线程对对应 `NSWindow` 调用 `setFrameOrigin:` 或 `setFrame:display:`，并处理坐标原点从左上到左下、屏幕缩放和菜单栏/Dock 的坐标系差异。不要让 helper 每帧创建进程，也不要依赖 Electron `alwaysOnTop` 完成普通窗口的前后层级语义。


## 抓取标定修复（风险 1 收尾）

早期结果里 `detectedMarkerFrames: 0` 并不是闪烁，而是**判定阈值写错了**：

- 标记在页面里是 `#ff00ff`，但经过透明窗口合成后，屏幕/`PrintWindow` 抓到的实际像素是 `R=234 G=51 B=247`（例如 `diagnostic-frame.fallback.png` 左上角那一小块）。
- 原来的容差是 `24`，`|51 - 0| = 51 > 24`，所以每一帧都被判成"标记缺失"。

修复方式：把容差放宽（`-Tolerance 96`）。修复后同一次运行的结果：

| 项目 | 数值 |
| --- | --- |
| 目标采样率 | 60 Hz |
| 实际采样帧数 | 392 |
| 检测到标记的帧 | 392 |
| 缺失标记的帧 | 0 |
| 抓取失败帧 | 0 |
| 平均采样间隔 | 20.4 ms |
| 最大采样间隔 | 80.5 ms |

结论：`SetWindowPos` 原生移动在 8 秒 60 Hz 采样期间**没有出现空白/掉帧**，风险 1 通过。

另外，抓取前需要让 POC 窗口真正位于其他窗口之上，否则抓到的会是别的应用的内容（本机上会被 Trae 等窗口盖住）。`main.cjs` 新增了 `--topmost=1`，用于把 POC 窗口临时放进 topmost 层，只在测量期间生效。
