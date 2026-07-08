# Sugar Wheel Minigame 配置说明

转盘小游戏是数据驱动的。新增或更换转盘时，不需要改 TypeScript 代码：

1. 把背景图、转盘图、指针图放进 `public/resources/runtime/images/minigames/...`
2. 在本目录新增一个实例 JSON，例如 `my_wheel.json`
3. 在 `index.json` 中登记 `{ "id": "my_wheel", "label": "显示名", "file": "my_wheel.json" }`
4. 用 Action `{ "type": "startSugarWheelMinigame", "params": { "id": "my_wheel" } }` 打开

## 实例字段

```json
{
  "id": "my_wheel",
  "label": "我的转盘",
  "backgroundImage": "/resources/runtime/images/minigames/my/bg.png",
  "backgroundFit": "cover",
  "foregroundImage": "/resources/runtime/images/minigames/my/crowd_overlay.png",
  "foregroundFit": "cover",
  "wheelImage": "/resources/runtime/images/minigames/my/wheel.png",
  "pointerImage": "/resources/runtime/images/minigames/my/pointer.png",
  "pointerAnchorY": 0.9,
  "pointerScale": 1,
  "wheelScale": 1,
  "wheelMaxSizePercent": 0.72,
  "wheelMaxSizePx": 660,
  "sectorAngleOffsetDeg": 0,
  "sectorDirection": "clockwise",
  "powerChargeMs": 2600,
  "minLaunchPower": 0,
  "powerChargeCurve": 1.4,
  "spinLinearDragPerSec": 0.12,
  "spinChargeMaxVelocityRadPerSec": 11,
  "spinChargeMaxAccelRadPerSec2": 9,
  "spinWeightBiasStrengthRadPerSec2": 4.2,
  "sectors": [
    { "id": "a", "label": "甲", "weight": 1, "payload": { "tag": "custom" } },
    { "id": "b", "label": "乙", "weight": 1 }
  ]
}
```

## 字段含义

- `backgroundImage`：桌面/摊位背景图，可替换。
- `backgroundFit`：`cover` 铺满裁切，`contain` 完整显示。
- `foregroundImage`：可选前景叠图，例如围观人群，会画在转盘和指针之上、UI 按钮之下。
- `foregroundFit`：`cover` 铺满裁切，`contain` 完整显示。
- `wheelImage`：转盘盘面图，可替换。
- `pointerImage`：指针图，可替换。
- `pointerAnchorY`：指针旋转锚点的 Y 比例。`0` 是顶部，`1` 是底部；当前指针适合 `0.9`。
- `pointerScale` / `wheelScale`：单独缩放指针或轮盘。
- 指针起始角不是配置项，玩家进入小游戏后可以直接拖动指针决定从哪里开始拨。
- `wheelMaxSizePercent`：轮盘最大占屏幕宽度比例。
- `wheelMaxSizePx`：轮盘最大像素尺寸。
- `sectorAngleOffsetDeg`：格子角度校准。正数为顺时针，用于让抽中结果对齐美术。
- `sectorDirection`：格子顺序，`clockwise` 或 `counterclockwise`。
- `powerChargeMs`：按住开始多久蓄满力。
- `minLaunchPower`：轻点时的最低力度，`0` 到 `1`。
- `powerChargeCurve`：蓄力映射曲线，`1`=线性，`>1` 前段更细腻。
- `sectors`：格子列表。数量不限，代码会自动按数量等分。默认 `clockwise` 时，第一个格子对应正上方顺时针半格处的扇区，然后继续顺时针排列。
- `sectors[].weight`：**跑道高度倾向**，未填默认 `1`（平地）。越大=低谷越易停、越小=高坡越难停。**不是精确中奖率**——指针停在哪由物理积分（阻力/干摩擦/势能偏置/临界角速削弱）共同决定。想看实际落点占比，用主编辑器转盘面板的「试转分布…」按钮做蒙特卡洛近似。
- `sectors[].payload`：原样透传到结果事件，供外部奖励/剧情系统自行解释。

### 物理停针（运行时积分，编辑器「物理停针」分组可调）

松手后转盘按欧拉积分 `θ += ωΔt，ω += (α − k·ω + 偏置)·Δt` 减速直到停稳：`spinLinearDragPerSec`（阻力 k）、`spinDragLowSpeedThreshold/BoostRadPerSec`（低速段加阻）、`spinChargeMin/MaxVelocity/AccelRad*`（蓄力→初速/初加速度映射）、`spinAccelHalfLifeSec`（α 衰减）、`spinDryFrictionAccelRadPerSec2`（干摩擦收尾）、`spinStopSpeed/SettleSec`（停转判定）、`spinWeightBiasStrengthRadPerSec2`（weight 跑道高低的整体强度）、`spinWeightBiasCreepRefRadPerSec`（临界角速下削弱偏置，让盘能停在坡上而非被顶着慢转）。

> 旧字段 `spinDurationMs` / `minSpinDurationMs` / `maxSpinDurationMs` / `minFullSpins` / `maxFullSpins` / `sectorStopJitterNormalized` 已被物理模型取代，运行时忽略，残留也不再生效。

## 结果事件

停针后会发出：

```ts
minigame:sugarWheelResult
```

payload：

```ts
{
  instanceId,
  instanceLabel,
  sectorId,
  sectorLabel,
  sectorIndex,
  sectorPayload
}
```

小游戏本身不发奖励、不扣资源、不限制次数；这些逻辑由外部 Action、任务、热区或后续系统控制。
