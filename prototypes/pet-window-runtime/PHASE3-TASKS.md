# 第三阶段任务书：每角色窗口的渲染 + 物理（Backend / Frontend 接口契约）

前置：`docs/桌宠最终规格.zh-CN.md`（唯一权威规格）、`prototypes/pet-window-runtime/PLAN.md`（已验证的原生能力）。
本阶段目标：**让桌面上真正跑起来** —— 每只角色一个独立窗口，窗口里画角色，物理用碰撞体积，任务栏挡住角色。

## 0. 写集（禁止越界）

- Backend：`electron/**`、`scripts/**`、`vite.config.ts`（如需新增渲染入口）
- Frontend：`src/**`
- 主 Agent：集成、配置、评审

## 1. 窗口几何（Backend 定，Frontend 用）

窗口覆盖范围 = `union(displayFrame, collision, interaction)` 的包围盒（归一化单位 × scale），
这样"交互范围超出显示框"部分也能点击（规格 §2）。

Backend 计算并向渲染进程下发：

```jsonc
{
  "petId": "pet_xxx",
  "scale": 1.0,                    // pet.scale * overlay.scale
  "windowSize": { "w": 320, "h": 420 },        // 物理像素，窗口尺寸
  "frameOffsetInWindow": { "x": 10, "y": 0 },  // 显示框左上角在窗口内偏移（物理像素）
  "collisionInWindow": { "x": 20, "y": 100, "w": 104, "h": 134 },  // 同上
  "interactionInWindow": { "x": 20, "y": 100, "w": 104, "h": 134 },
  "metrics": {
    "bounds":   { "x": 0, "y": 0, "w": 2560, "h": 1600 },  // 物理像素
    "workArea": { "x": 0, "y": 0, "w": 2560, "h": 1528 },
    "taskbar":  { "x": 0, "y": 1528, "w": 2560, "h": 72 } // 无任务栏则 null
  }
}
```

`placement` 是**碰撞体中心的屏幕坐标（物理像素）**；窗口左上角 =
`placement - (collisionInWindow + size/2)`。

## 1.5 渲染入口（两边都要按这个来，避免改 vite 配置）

现有渲染入口是单页 + `?view=` 查询参数（`electron/main.cjs` 的 `rendererUrl(view)`）。
每角色窗口统一用：`rendererUrl("pet-window")` 再附加 `&petId=<petId>`。

- Frontend 负责：`src/main.tsx` 里按 `view=pet-window` 挂载新的单宠视图组件；
- Backend 负责：创建窗口时用这个 URL，并把 `petId` 带进去；
- 因此本阶段**不需要**改 `vite.config.ts`。

## 2. IPC 契约（双方必须一致）

Backend → Frontend：

| 通道 | 载荷 | 说明 |
| --- | --- | --- |
| `pet-window:init` | 上面那段 geometry + layout | 窗口加载完成后下发一次 |
| `pet-window:metrics` | `{ bounds, workArea, taskbar }` | 显示器/任务栏变化时 |
| `pet-window:peers` | `{ peers: [{ petId, rect: {x,y,w,h}, direction }] }` | 其他角色碰撞体（物理像素），用于互撞 |
| `pet-window:platforms` | `{ platforms: [{ id, rect, kind }] }` | 模组平台（第四阶段用，本阶段可留空） |
| `pet-window:set-ignore-mouse` | — | 由 Frontend 请求，见 §4 |

Frontend → Backend：

| 通道 | 载荷 | 说明 |
| --- | --- | --- |
| `pet-window:ready` | `{ petId }` | 渲染完成，开始收状态 |
| `pet-window:target` | `{ petId, x, y }` | 目标窗口左上角（物理像素），每帧最多一次 |
| `pet-window:ignore-mouse` | `{ petId, ignore: boolean }` | 点击穿透控制 |
| `pet-window:focus` | `{ petId, take: boolean }` | 临时抢焦点（文字对话/自动文字），实现用「去 WS_EX_NOACTIVATE + ALT 解锁 + SetForegroundWindow + 用完恢复」 |

## 3. 物理（Frontend 负责，规格 §4）

- 唯一物理身体 = 碰撞体积；重力、落地、屏幕四边、任务栏都是**实心矩形：顶面可站、侧面阻挡**。
- 屏幕四边 = `metrics.bounds`；任务栏 = `metrics.taskbar`（不可见时按规格**仍保留**）。
- 显示（角色画面）可以超出屏幕、被窗口遮挡、被裁掉。
- 渲染进程每帧算碰撞体世界坐标 → 通过 `pet-window:target` 把窗口目标位置发给主进程；
  **不要**每帧 `setBounds`（主进程走原生 `SetWindowPos`）。
- 物理动画在被遮挡时继续运行（不要用 `visibility` 暂停）。

## 4. 点击穿透（Frontend 判定，Backend 执行）

窗口比可点区域大，必须做到「不在交互范围内 = 点击穿透到桌面/其他软件」：

- 渲染根节点 `pointer-events: none`；交互范围元素 `pointer-events: auto`。
- 监听 `mousemove`，用 `document.elementFromPoint` 判断当前点是否落在交互范围上：
  不在 → `pet-window:ignore-mouse { ignore: true }`；在 → `{ ignore: false }`。
- Backend 收到后调用 `win.setIgnoreMouseEvents(ignore, { forward: true })`。

## 5. 分层与焦点（Backend 负责，规格 §7）

- 每角色窗口用已验证的原生样式：`WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE`，topmost，任务栏 region 裁剪。
- 点击角色 → 只把它带到普通窗口层最前，**不抢键盘焦点**。
- 文字对话/自动文字 → 临时抢焦点；点击其他窗口立刻被抢回。
- 每角色一个窗口，各自参与前后层级。

## 6. 验收（做完必须能演示）

1. `npm run check` 通过；`node electron/native-window.test.cjs`、`node electron/pet-layout.test.cjs` 全绿。
2. 打开开关后：角色出现在自己的窗口里，尺寸/位置与旧版一致（A 口径迁移不位移）。
3. 拖到任务栏附近：**身体被任务栏挡住**，任务栏区点击落到任务栏。
4. 点别的窗口 → 该窗口盖住角色；点角色 → 角色回到最前且键盘焦点没变。
5. 重启后位置与碰撞体位置一致。
6. 关掉开关 → 完全回到旧行为（回归保险）。
