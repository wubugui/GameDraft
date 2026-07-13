---
id: animation-pipeline
title: 动画一键产线(tools/animation_pipeline)
domain: asset-pipeline
type: mechanism
summary: 视频→atlas+anim.json 的确定性产线:程序驱动、QA 三态(程序从不单独判通过)、每个环节的方法都是实测选出的
status: active
authority:
  - tools/animation_pipeline/produce.py
  - tools/animation_pipeline/pipeline.py#build_character
  - tools/animation_pipeline/qa_gate.py#AGENT_SCHEMA
  - tools/animation_pipeline/README.md
triggers:
  paths: ["tools/animation_pipeline/**"]
  topics: [动画管线, produce, QA闸门, 图集产出]
  tasks: [产出角色动画, 重扣角色, 调抠图配方]
last_governed: 2026-07-11
---

## 是什么(一句话)

把各 state 的角色视频一键产成游戏可加载的 `atlas.png + anim.json`(格式契约见
[动画产物契约](sprite-atlas-anim-contract.md))的确定性产线;agent 入口(操作步骤)在
`.cursor/skills/animation-production/SKILL.md`。

## 权威源(读代码从哪进)

- `produce.py` 一键入口 / `pipeline.py` 的 `build_character` 核心(重扣单角色也复用它)
- `matting.py` 抠图 / `form_align.py` 逐帧原地锁 / `matte_illustration.py` 插画抠人
- `qa_gate.py` 质检(含 `AGENT_SCHEMA` 裁决结构)/ `recipes.py` 每角色配方数据
- `README.md`:**每个环节为何这么定的实测数据都在这**,调方法前先读,别拍脑袋换算法
- 只 import 复用 `tools/video_to_atlas/atlas_core.py`,不改现网代码

## 硬契约(违反即 bug)

- **QA 三态**:硬闸门(帧数/位移/裁切/atlas≤2K)程序直接判死不花 agent;软 flag(漂浮碎片/剪影突变/镂空)只报可疑、交 agent 定性;**程序从不单独判"通过"**。
  分工的立法见 [决策:程序驱动、agent 当裁判](../decisions/2026-07-04-program-drives-agent-judges.md)。
- **调参只改 `recipes.py`(数据),不改逻辑**:阈值、每 state 帧数、锚点模式、播放帧率全在配方里。
- 多 clip 分辨率常不同,必须 per-clip 缩放归一后再进统一像素框。
- 跨 state 必须尺度归一到统一站立身高 + 脚接触点统一枢轴,否则切动画时角色跳位。

## 已知坑

- 锚点不能用 bbox 极值(脚会抖),用质心X+稳健脚线Y(p98);`form_align` 逐帧重锁能把源里的残留晃动一并消掉。
- QA 的 halo 指标不可信、holes 才可信;连通域指标会把"躺姿搁在身边的长枪"误报——良性,agent 判 accept(判读铁律见 [抠图路线与判读铁律](matting-toolbox.md))。
- 抠图默认 fusion;torch 不可用自动降级 rembg_isnet。
- 依赖装在 `.tools/venv`;BiRefNet 在 MPS 上要 `.float()`,否则 half/float bias 报错。

## 怎么验证

`<out>/finals.json` 硬闸门全过(退出码 0)+ agent 按 `AGENT_SCHEMA` 裁决全部 flag +
[动画预览工具](anim-preview-tool.md) 目验。
