---
id: character-animation-production
title: 角色动画生产工作法
domain: asset-pipeline
type: method
summary: 从"要一个会动的角色"到入库验收的全程形状:源确认→生成→程序产出→agent 裁决→升级阶梯→预览验收
status: active
triggers:
  paths: ["tools/animation_pipeline/**", "public/resources/runtime/animation/**"]
  tasks: [新角色动画, 新增动作state, 重扣角色, 修动画抠图]
  topics: [动画生产, 角色动画, 重扣]
last_governed: 2026-07-11
last_used: 2026-07-10
---

## 适用时机

给角色产新动画、补 state、或对已上线角色重扣/重生成。操作命令见
`.cursor/skills/animation-production/SKILL.md`;本卡管形状与判断,不重复步骤。

## 阶段骨架

1. **源确认**——锁定输入源。完成判据:源 = 游戏当前实际源,以 shipped
   `atlas.meta.json` 的 packMode/source 为准查证,不凭目录名猜。
2. **生成侧(LibTV 出视频)**——拿到各 state 的原地干净视频。完成判据:原地(跑步机式)、
   道具全程握持、身份画风一致。
3. **程序产出**——`produce.py` 一键(重扣单角色复用 `pipeline.build_character`)。
   完成判据:退出码 0 = 硬闸门全过。
4. **QA 裁决**——agent 读 `finals.json` 的 agent_flags,按 `AGENT_SCHEMA` 结构化裁决。
   完成判据:每条 flag 都有 accept/reject 结论。
5. **验收**——预览工具目验 + 素材审计。完成判据:动作/锚点/循环在游戏一致渲染下目视无缺陷。

## 判断点(拿什么证据判)

- **QA flag 定性**:调该 clip 的密排帧图目视,分"真缺陷"(枪头凭空漂浮+空手)与"良性"
  (躺姿时搁在身边的长枪被连通域 flag→accept)。
- **指标判读**:halo 指标不可信、holes 才可信;多扣必须源级测(见 [抠图判读铁律](../mechanisms/matting-toolbox.md))。
- **reject 后升级阶梯**:重摇 K 次(同参数)→ quality 升 high → 换生成模式(动作迁移↔单图)→ 叫人。

## 分工契约

程序驱动确定性流水并判死硬失败;agent 只做 QA 语义裁决、异常排查、改 `recipes.py` 配方数据
(不改逻辑);人拍生成模型选型与最终风格。

## 已知死路(链 decision)

- 源用"看名字像稳定化"的目录 → [2026-07-10 重扣源必须=游戏当前源](../decisions/2026-07-10-reprocess-source-must-match-shipped.md)
- 持械+位移动作用动作迁移生成 → [2026-07-02 单图生视频铁律](../decisions/2026-07-02-armed-locomotion-single-image-gen.md)
- agent 逐条驱动整条管线 → [2026-07-04 程序驱动、agent 当裁判](../decisions/2026-07-04-program-drives-agent-judges.md)

## 向下指针

**本工作法是组合层**,站在两个正交原语之上(而非内联它们):
[对抗验收抠图法](adversarial-matting.md) · [对抗验收拆帧法](adversarial-frame-decomposition.md)。

确定性产线与契约:
[动画一键产线](../mechanisms/animation-pipeline.md) /
[动画产物契约](../mechanisms/sprite-atlas-anim-contract.md) /
[动画预览工具](../mechanisms/anim-preview-tool.md) /
[LibTV 出图配方](../recipes/libtv-image-generation.md)
