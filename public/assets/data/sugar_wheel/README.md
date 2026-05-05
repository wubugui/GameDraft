# Sugar Wheel Minigame 配置说明

转盘小游戏是数据驱动的。新增或更换转盘时，不需要改 TypeScript 代码：

1. 把背景图、转盘图、指针图放进 `public/assets/images/minigames/...`
2. 在本目录新增一个实例 JSON，例如 `my_wheel.json`
3. 在 `index.json` 中登记 `{ "id": "my_wheel", "label": "显示名", "file": "my_wheel.json" }`
4. 用 Action `{ "type": "startSugarWheelMinigame", "params": { "id": "my_wheel" } }` 打开

## 实例字段

```json
{
  "id": "my_wheel",
  "label": "我的转盘",
  "backgroundImage": "/assets/images/minigames/my/bg.png",
  "backgroundFit": "cover",
  "foregroundImage": "/assets/images/minigames/my/crowd_overlay.png",
  "foregroundFit": "cover",
  "wheelImage": "/assets/images/minigames/my/wheel.png",
  "pointerImage": "/assets/images/minigames/my/pointer.png",
  "pointerAnchorY": 0.9,
  "pointerScale": 1,
  "wheelScale": 1,
  "wheelMaxSizePercent": 0.72,
  "wheelMaxSizePx": 660,
  "sectorAngleOffsetDeg": 0,
  "sectorDirection": "clockwise",
  "spinDurationMs": 4200,
  "minSpinDurationMs": 1700,
  "maxSpinDurationMs": 5200,
  "powerChargeMs": 1300,
  "minLaunchPower": 0.18,
  "minFullSpins": 5,
  "maxFullSpins": 9,
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
- `spinDurationMs`：兼容旧字段；未配置最大时长时作为默认最大旋转时长。
- `minSpinDurationMs` / `maxSpinDurationMs`：玩家轻拨/重拨时的旋转时长范围。
- `powerChargeMs`：按住开始多久蓄满力。
- `minLaunchPower`：轻点时的最低力度，`0` 到 `1`。
- `minFullSpins` / `maxFullSpins`：轻拨/重拨时的额外完整圈数范围。
- `sectors`：格子列表。数量不限，代码会自动按数量等分。默认 `clockwise` 时，第一个格子对应正上方顺时针半格处的扇区，然后继续顺时针排列。
- `sectors[].weight`：抽中权重，未填默认 `1`。只影响概率，不影响格子视觉宽度。
- `sectors[].payload`：原样透传到结果事件，供外部奖励/剧情系统自行解释。

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
