# 桌宠布局 v3 迁移原型

这个原型只验证一件事：**旧存档能不能一次性、可验证地迁移成 `PetDesktopLayout v3`，迁移过程不移动角色、不改变碰撞范围。**

它不加载 ArkPet 状态、不申请单实例锁、不写任何存档，也不改动 `src/**`、`electron/**`、`package.json` 或发布配置。全部是纯函数，可以在正式实现之前先把公式钉死。

## 运行

在仓库根目录执行：

```powershell
node prototypes/pet-layout-migration/test.cjs
```

预期输出 `7 passed, 0 failed`，同时在 `prototypes/pet-layout-migration/snapshots/` 下生成 7 个人工可比的快照。

## 目标结构

```jsonc
{
  "layoutVersion": 3,
  "displayFrame": { "width": 300, "height": 323 },              // 画面框，中心固定
  "collision":    { "width": 96, "height": 96, "offsetX": 20, "offsetY": 238.5 },
  "interaction":  { "width": 96, "height": 96, "offsetX": 20, "offsetY": 238.5 },
  "placement":    { "x": 838, "y": 1144, "direction": 1 }
}
```

坐标约定：

- 世界坐标 = 主显示器坐标，单位 px，原点在主显示器左上角。
- `offsetX/offsetY` 是相对 **displayFrame 中心** 的偏移。
- 基准朝向是朝右（`direction: 1`）；朝左（`direction: -1`）时 `collision.offsetX` 与 `interaction.offsetX` 在渲染时取反，**存储值始终按朝右写**。
- `placement.x/y` 保存**碰撞体中心**的世界坐标（规则 8）。

## 公式推导

### 1. 旧模型的几何

旧版本（2.2.0 / 1.1）里 host 元素就是 hitbox 矩形；Spine 画布（display frame）**水平居中于 host、底边与 host 底边对齐**。因此 display frame 中心相对 host 左上角是：

```text
centerX = hitboxWidth / 2                        // 与朝向无关
centerY = hitboxHeight - displayFrameHeight / 2   // 画面比 host 高时为负
```

旧碰撞框中心相对 host 左上角（已把朝向镜像算进去）：

```text
collisionCenterX = mirror(hitboxOffsetX) + hitboxWidth / 2
collisionCenterY = hitboxOffsetY + hitboxHeight / 2
```

### 2. 新偏移

`collision.offset = collisionCenter - displayFrameCenter`，代入后：

```text
offsetX = hitboxOffsetX                                  // mirror 只作用在 hitboxOffsetX 上
offsetY = hitboxOffsetY + displayFrameHeight / 2 - hitboxHeight / 2
```

也就是说 `offsetX` 直接复刻旧 `hitboxOffsetX`，`offsetY` 会因为 display frame 比 host 高而向上补偿。

### 3. 数值例子（fixture a）

```text
hitbox 96x96, displayFrame 300x323, hitboxOffset (20, 125), host (770, 971)
center            = (48, -65.5)          // 96/2 , 96 - 323/2
collisionCenter   = (68, 173)
collision.offset  = (20, 238.5)
placement         = (770 + 68, 971 + 173) = (838, 1144)
```

### 4. 新 display frame 尺寸

```text
displayFrame.width  = max(old displayWidth  || 260, old visualWidth  || 104)
displayFrame.height = max(old displayHeight || 320, old visualHeight || 134)
```

取 max 是为了让新画面框**至少**容纳旧画面和旧视觉范围，避免迁移瞬间把角色裁掉。

## 迁移不变量

测试逐条断言，任何一条被破坏都不能上线：

| 编号 | 不变量 | 含义 |
| --- | --- | --- |
| I1 | 碰撞框世界矩形不变 | 左/上/右/下和中心都不许动，这是"不能移动碰撞范围"的硬要求 |
| I2 | displayFrame 世界中心不变 | 角色视觉锚点不变，画面框不会整体位移 |
| I3 | `interaction === collision` | 交互范围默认复制碰撞体（后续才允许单独放大） |
| I4 | `placement.direction` 保留 | 旧存档方向不丢；字段缺失时默认 `1` |
| I5 | 幂等 | 已经是 `layoutVersion: 3` 的记录再跑一次结果完全一致，且忽略旧字段 |
| I6 | 纯函数 | 不修改输入、不依赖时间和随机数、数值最多 2 位小数 |

## 重点说明：碰撞框不动，但旧 `offsetX/offsetY` 被丢弃

**这是原型里最需要产品确认的一点。**

旧 `renderConfig.offsetX/offsetY` 是"角色在画布内部再额外挪一下"的视觉补正，它不参与上面 1-3 节的几何推导。v3 把角色本体重新对齐到 displayFrame 中心，所以这两个值**不会**被迁移。

实际表现是：

- 画面框（displayFrame）**留在原地**，位置不变；
- 角色在框内从"补正后的位置"滑回"框中心"；
- 位移量正好是 `direction * offsetX` 和 `offsetY`。

fixture a 的 `offsetX=5, offsetY=10`，所以迁移后角色会向左 5px、向下 10px 回到框中心。快照里的 `droppedVisualOffset` 记录了这个量，`a)` 的快照可以直接核对。

如果产品要求"迁移瞬间连角色像素都不许闪一下"，那只有两种做法，而且都会破坏某条不变量：

1. 把旧视觉偏移吸收进 `collision/interaction` → 碰撞框形状或位置会变（破坏 I1 的语义）；
2. 把 displayFrame 一起平移 → 画面框会整体移动（破坏 I2）。

所以默认选择"丢弃 + 记录"，并把它作为上线前的确认项。

## 待决策点

### D1 旧视觉 offset 丢弃 vs 吸收

见上一节。默认按规范丢弃。

### D2 朝左角色的 placement 基准（规则 8 修正，重要）

规则 8 的字面写法是 `placement.x = old.x + collisionCenterX`，其中 `collisionCenterX` 用的是**未镜像**的 `hitboxOffsetX`。但旧渲染器在朝左时会把 `hitboxOffsetX` 取反，于是：

```text
字面规则 8：placement.x = 770 + 20 + 48 = 838   // 朝左也按朝右算
镜像版本：  placement.x = 770 - 20 + 48 = 798   // 与旧的实际碰撞框一致
```

两者相差 `2 * hitboxOffsetX`（fixture e 里是 40px）。也就是说**字面规则 8 会把朝左的角色整体平移一段**，恰好违反"不能移动角色"这条首要要求。

本原型默认使用镜像版本（`placementFormula: "mirrored-collision-center"`），因为它同时保住 I1 和 I2；字面版本通过 `migratePetLayoutWithOptions(pet, { directionAwarePlacement: false })` 保留下来做对照，差值写进了 `05-direction-left.json`。

需要确认的是：v3 运行时的镜像模型是否与原型一致（即 `direction: -1` 时对 `collision.offsetX` 取反）。如果 v3 决定连角色本体一起镜像、不再单独镜像碰撞 offset，那么这里要跟着改。

### D3 没有 renderConfig 的旧角色

全部字段回落到默认值（display 260x320 / visual 104x134 / hitbox 104x134 / offset 0,0），并在 `warnings` 里写 `missing-render-config`；只缺部分字段时写 `partial-render-config`，`defaultsUsed` 会列出具体字段名。是否需要额外弹一次"请确认角色大小"的提示，待定。

### D4 没有 desktopPosition 的旧角色

没有可保留的世界位置。原型退化为"host 原点 (0,0)"，即角色出现在主显示器左上角，并写 `missing-desktop-position` 警告。备选是放到屏幕中心，或者标记为"待用户放置"。

### D5 placement 到底锚在哪个中心

按当前规范，`placement` 存的是**碰撞体中心**，displayFrame 中心由 `placement - mirror(collision.offset)` 反推（原型里的 `resolveDisplayFrameCenter()` 就是这个函数）。但前面产品讨论里出现过"角色中心与舞台中心重合"的说法。如果最终决定 `placement` 直接存 displayFrame 中心，迁移只需要换一行（`placement = 旧 displayFrame 中心`），I1/I2 仍然成立，其余代码不需要动。

### D6 scale 放哪里

需求里提到"改角色大小后碰撞体积和显示框同步改变，但软件里显示的框不变、实际变大"。这属于 **base 尺寸 + 全局 scale** 的建模问题。原型目前只有 base 尺寸（旧字段都是缩放前的值），没有 `scale` 字段，需要明确是放进 layout 还是留在 pet 上。

## 风险

1. **视觉跳变**：`offsetX/offsetY` 被丢弃，角色会滑回框中心（见上节），需要一个明确的验收口径。
2. **朝左平移**：若采用字面规则 8，朝左角色会平移 `2 * hitboxOffsetX`。默认已规避，但必须确认运行时镜像模型。
3. **旧几何前提必须实测核对（最高优先级）**：1-3 节假设"host = hitbox 矩形，画布水平居中 + 底边对齐"，这是本次任务给出的前提。但现有代码 `src/lib/renderConfig.ts::getHitboxPosition()` 是另一套表述：把 hitbox 放在画面框内部 `(displayWidth - hitboxWidth)/2 + hitboxOffsetX`、`(displayHeight - hitboxHeight)/2 + hitboxOffsetY` 处（即 host = 画面框）。这两种视角在**水平方向结果相同**，但**垂直方向差一个常量**：

   ```text
   前提模型（host = hitbox，底对齐）：  centerY = hitboxHeight - displayFrameHeight / 2
   代码模型（host = display，居中）：   centerY = hitboxHeight / 2
   offsetY 分别是 hitboxOffsetY + displayFrameHeight / 2 - hitboxHeight / 2  vs  hitboxOffsetY
   ```

   用 fixture a 代入：前者 `offsetY = 238.5`，后者 `offsetY = 125`，相差 `displayFrameHeight / 2 - hitboxHeight / 2 = 113.5px`。猜错的话每只角色都会整体上下跳 113.5px，而且很容易被误判成"重力/任务栏问题"。上线前必须用 2.2.0 的真实 DOM 实测：如果迁移后角色垂直方向跳了约 `displayFrameHeight/2 - hitboxHeight/2`，说明要用代码模型，把 `centerY` 改成 `hitboxHeight/2` 并重跑全部快照。
4. **画面框变大**：`max(display, visual)` 可能比旧的实际画面更大。画面不会裁切，但透明命中区域会变大，渲染开销和"看起来更大"的错觉需要实测。
5. **2 位小数与镜像**：四舍五入必须对 0 对称（half away from zero），否则朝左/朝右会差 0.01px。原型用 `round2()` 实现并测试。
6. **迁移时机**：本原型是纯函数，不涉及"什么时候写盘"。正式实现必须保证迁移只跑一次、且在位置写回（`desktopPosition` → `placement`）之前完成，否则会被旧的 `desktopPosition` 覆盖。

## 文件

| 文件 | 说明 |
| --- | --- |
| `migrate.cjs` | 迁移纯函数：`migratePetLayout` / `migratePet` / `migratePets` / 几何解析辅助函数 |
| `test.cjs` | 7 组 fixture 断言 + 快照生成 |
| `snapshots/*.json` | 迁移前后几何快照，供人工比对 |

## 导出函数

```js
const M = require("./migrate.cjs");

M.migratePetLayout(pet)                    // { changed, layout, warnings, defaultsUsed, before, placementFormula }
M.migratePetLayout(pet, options)           // options: { directionAwarePlacement?: boolean }
M.migratePet(pet, options)                 // { changed, pet, result }
M.migratePets(pets, options)               // [{ changed, pet, result }]
M.readLegacyLayout(pet)                    // 归一化后的旧字段 + defaultsUsed
M.computeLegacyGeometry(legacy, direction) // 旧几何中心/偏移
M.resolveLayoutRects(layout)               // v3 布局的世界矩形（调试用）
M.resolveLegacyCollisionRect(pet)          // 旧的在屏碰撞矩形（已镜像）
M.resolveLegacyDisplayFrameCenter(pet)     // 旧的画面框世界中心
M.resolveDisplayFrameCenter(layout)        // v3 的画面框世界中心
M.mirrorOffsetX(offsetX, direction)        // 镜像辅助
M.round2(value)                            // 对称 2 位小数
```

## 与真实 2.2.0 DOM 的对账（2026-11 修订）

早期版本的迁移公式把 `hitboxOffsetX/Y` 当成"碰撞体相对宿主的世界偏移"。对照 2.2.0 源码后确认这是错的，会让升级后的角色**整整平移 `hitboxOffsetY`**（fixture a 里是 125px）。

### 源码证据

- `src/components/PetOverlay.tsx:1447-1460`：`hostRef.style.transform = translate3d(entity.x, entity.y, 0)`，并且 `hostRef.style.width/height = hitboxWidth*scale / hitboxHeight*scale` —— **宿主元素就是碰撞盒本身**，位置就是 `desktopPosition`。
- `src/styles.css`：`.multi-pet-visual { inset: 0 }`、`.multi-pet-spine { bottom: 0; left: 50%; translateX(-50%) }` —— 显示画布**水平居中、底边贴着碰撞盒底边**。
- `src/components/PetOverlay.tsx:1774 / 2196 / 2325`：落地判定用的是 `bounds.floor - (entity.y + height)`，也就是宿主矩形，`hitboxOffsetX/Y` 完全不参与物理。
- `src/components/PetOverlay.tsx:1463-1477`：`hitboxOffsetX/Y` 只被写进 `.multi-pet-hitbox`（点击区域）的 `left/top`。
- `src/views/WorkshopView.tsx:876`：编辑器预览用的是 `getHitboxPosition()`（先把盒子在显示框里居中，再加 offset）——**和运行时不是同一套算法**，2.2.0 本身就存在这个不一致。

### 修正后的规则

| 项目 | 公式 |
| --- | --- |
| 显示框尺寸 | `max(displayWidth, visualWidth) × max(displayHeight, visualHeight)` |
| 显示框中心（相对宿主） | `(hitboxWidth/2, hitboxHeight − displayFrameHeight/2)` |
| 碰撞体 | 宿主矩形 `(hitboxWidth, hitboxHeight)`，中心 `(hitboxWidth/2, hitboxHeight/2)` |
| `collision.offset`（相对显示框中心） | `(0, displayFrameHeight/2 − hitboxHeight/2)` |
| `placement`（碰撞体世界中心） | `desktopPosition + (hitboxWidth/2, hitboxHeight/2)`，**不做方向镜像** |
| `interaction` | 与碰撞体完全一致 |

方向不再参与迁移：2.2.0 里被镜像的只有 `hitboxOffsetX` 那个点击区域，宿主和显示画布都不镜像。

### fixture a 的数字对比

| | 修正前（错误） | 修正后 |
| --- | --- | --- |
| `collision.offsetX` | 20 | 0 |
| `collision.offsetY` | 238.5 | 113.5 |
| `placement` | (838, 1144) | (818, 1019) |
| 物理/点击矩形 | (790,1096)–(886,1192) | (770,971)–(866,1067) = **旧的宿主矩形** |
| 显示框中心 | (818, 905.5) | (818, 905.5)（不变） |

`legacyOffsetPlacement` 仍然写在快照里，方便复核"如果沿用旧公式会偏多少"（fixture a 是向下偏 125px）。

### 测试

`node prototypes/pet-layout-migration/test.cjs` → **7 passed, 0 failed**。fixture a / e / g 的期望值已按新基准更新，并新增 `geometryBasis: "legacy-offset"` 选项用于并排对比。

顺带修掉一个 `-0` 泄漏：`mirrorOffsetX(0, -1)` 以前返回 `-0`。
