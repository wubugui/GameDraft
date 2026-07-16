---
id: animation-pipeline
title: 动画/静态阶段适配器与旧一键产线(tools/animation_pipeline)
domain: asset-pipeline
type: mechanism
summary: 工作台 E/F/G/R/H/H_STATIC 的无覆盖确定性适配器；旧 build_character 产线保留兼容但不定义新人工 R 语义
status: active
authority:
  - tools/animation_pipeline/produce.py
  - tools/animation_pipeline/pipeline.py#build_character
  - tools/animation_pipeline/qa_gate.py#AGENT_SCHEMA
  - tools/animation_pipeline/workbench_stages.py
  - tools/animation_pipeline/README.md
triggers:
  paths: ["tools/animation_pipeline/**"]
  topics: [动画管线, produce, QA闸门, 图集产出]
  tasks: [产出角色动画, 重扣角色, 调抠图配方]
last_governed: 2026-07-16
---

## 是什么(一句话)

为统一动画资源工作台提供 E/F/G/R/H/H_STATIC 的确定性、只写新目录适配器；原有
`build_character` 仍保留为旧视频→atlas 批产兼容入口。新工作流的图、人工审查和版本语义以
[统一动画资源工作台](anim-preview-tool.md)为准，格式契约见
[动画产物契约](sprite-atlas-anim-contract.md)。

## 权威源(读代码从哪进)

- `produce.py` 一键入口 / `pipeline.py` 的 `build_character` 核心(重扣单角色也复用它)
- `matting.py` 抠图 / `form_align.py` 逐帧原地锁 / `matte_illustration.py` 插画抠人
- `qa_gate.py` 质检(含 `AGENT_SCHEMA` 裁决结构)/ `recipes.py` 每角色配方数据
- `workbench_stages.py`:E 显式抽帧、F 固定 union crop、G 几何不变抠图、把人工 R calibration
  烘焙到共同 cell、H staging 图集，以及 C PNG→H_STATIC 的逐字节 staging；所有输出目录已存在时
  一律拒绝覆盖
- `README.md`:**每个环节为何这么定的实测数据都在这**,调方法前先读,别拍脑袋换算法
- 只 import 复用 `tools/video_to_atlas/atlas_core.py`,不改现网代码

## 硬契约(违反即 bug)

- **QA 三态**:硬闸门(帧数/位移/裁切/atlas≤2K)程序直接判死不花 agent;软 flag(漂浮碎片/剪影突变/镂空)只报可疑、交 agent 定性;**程序从不单独判"通过"**。
  分工的立法见 [决策:程序驱动、agent 当裁判](../decisions/2026-07-04-program-drives-agent-judges.md)。
- **调参只改 `recipes.py`(数据),不改逻辑**:阈值、每 state 帧数、锚点模式、播放帧率全在配方里。
- 多 clip 分辨率常不同,必须 per-clip 缩放归一后再进统一像素框。
- 旧 `build_character` 的跨 state 自动对齐仍由配方控制；**新工作台不得复用这条自动语义替代 R**。
  新 R 的 root 可由人自定义，不固定为脚/骨盆；每动作只允许一个等比 scale，所有动作对准共同 root。
- `workbench_stages.py` 只产 staging，不发布到 `public/resources/runtime`；H/H_STATIC adapter 会主动拒绝 runtime 目标。
- H_STATIC 的文件名只能来自工作区人工配置的完整静态目标，适配器不猜目录、不改像素、不改消费端 JSON。
- E/F/G/R/H/H_STATIC 都只写全新输出目录；阶段产物由 Agent 再提交为工作台 candidate，适配器本身不推进图。

## 已知坑

- 锚点不能用 bbox 极值(脚会抖),用质心X+稳健脚线Y(p98);`form_align` 逐帧重锁能把源里的残留晃动一并消掉。
  这只描述旧一键产线；新 F 明令禁止逐帧重锁，新 R 才负责人工跨动作装配。
- QA 的 halo 指标不可信、holes 才可信;连通域指标会把"躺姿搁在身边的长枪"误报——良性,agent 判 accept(判读铁律见 [抠图路线与判读铁律](matting-toolbox.md))。
- 抠图默认 fusion;torch 不可用自动降级 rembg_isnet。
- 依赖装在 `.tools/venv`;BiRefNet 在 MPS 上要 `.float()`,否则 half/float bias 报错。

## 怎么验证

- 旧产线:`<out>/finals.json` 硬闸门全过(退出码 0)+ agent 按 `AGENT_SCHEMA` 裁决全部 flag。
- 新适配器:`.tools/venv/bin/python -m pytest -p no:cacheprovider tools/animation_pipeline/tests/test_workbench_stages.py -q`，
  再在[统一动画资源工作台](anim-preview-tool.md)逐阶段人工目验。
