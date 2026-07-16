---
id: baked-figure-activation
title: 烤入背景人物活化工作法
domain: asset-pipeline
type: method
summary: 把画在场景原画里的人物做成会动实体:原画底+局部擦人+overlay 呼吸;逐人棋盘格+场内 zoom 双验收
status: active
triggers:
  paths: ["tools/animation_pipeline/ambient_fx/**", "public/assets/scenes/*.json"]
  tasks: [背景人物动起来, 场景群像活化, 环境动效]
  topics: [烤入背景, 呼吸动画, 擦人, overlay]
last_governed: 2026-07-11
last_used: 2026-07-04
---

## 适用时机

场景原画里烤死的人物/群像要"活"(呼吸/小动作),又不值得走完整角色动画产线。
首例:dev_teahouse_alive 茶馆五茶客(2026-07-04 定稿)。

## 阶段骨架

1. **选人分工**——定谁动谁静。判据:桌前露上半身/全身可见→动;趴桌肘撑、柜台后、
   与家具深度咬合→留原画静态(原画底方案下静态人零成本,别硬抠)。
2. **抠人**——得到每人完整透明抠图。判据:身体该有的部位全在、无漂浮碎片、无残留他人/家具。
3. **底图**——原画底 + 只擦被活化者剪影(用其抠图 alpha 当 mask、以 image2image 空背景
   对应像素填充、1~2px 羽化)。判据:擦出的洞恰好被 overlay 盖住。
4. **摆位**——模板匹配拿原图 bbox,换算实体坐标。判据:锚点=脚底(底中锚,见
   [动画产物契约](../mechanisms/sprite-atlas-anim-contract.md)),名字标签正浮在脚点。
5. **动作**——base-pinned"只向上"呼吸:`vscale=1+heave*(1-cos(phase))/2`,横向 sway=0,
   `extra_top`≥heave·H;幅度极淡(heave≈0.005~0.008),逐人错相位。判据:任何帧都不小于
   原尺寸→永远盖住擦洞。
6. **场内验收**——真场景里逐人 zoom 核对:①身体完整 ②落座位置对 ③无洞/无重影/无裁切。

## 判断点(拿什么证据判)

- 抠图完整性:**每人贴棋盘格 check 图逐条核对**;子 agent 自报 complete 会乐观,主流程必须复验。
- 呼吸幅度:用户口味极淡、只会往小调——先给小的。
- **绝不能只看抠图 check 图或全景截图宣布完成**——"缺部位/位置漂/被裁"连续三轮都是场内 zoom 才暴露的。

## 分工契约

程序(`ambient_fx/fx_build.py` 的 build_patron 等)做循环/图集/缓存;agent 画"包人排家具"
的保留多边形并裁决完整性;人拍幅度口味与最终验收。

## 已知死路(链 decision)

整图重画空背景当底 / 形态学开运算切家具 / 对称 sin 呼吸 / nebula 单独抠人——全部证伪,
见 [2026-07-04 茶客活化技术路线](../decisions/2026-07-04-baked-patron-activation-route.md)。

## 向下指针

[抠图路线与判读铁律](../mechanisms/matting-toolbox.md) /
[环境动效素材配方](../recipes/ambient-fx-production.md)(图集打包与装饰 NPC 放置,含
`renderRaw` 铁律)/ 无头预览验证的可见性伪造配方归 meta/runtime 域。
