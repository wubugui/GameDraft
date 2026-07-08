---
name: animation-production
description: 把角色各 state 的稳定化视频产出为游戏可用的精灵图集(atlas.png + anim.json),抠图/锚点/循环/2K/QA 全走已验证的确定性脚本;agent 只在质检语义裁决与异常处理时入场。
---

# 动画生产 — agent 入口(SOP)

**主入口是程序,不是你。** 稳态生产走确定性脚本 `tools/animation_pipeline/produce.py`;
你(agent)只做三件事:**质检语义裁决、异常排查、配方调参**。别把循环/阈值/打包逻辑
搬进对话即兴执行——那会毁掉可复现性。方法为何这么定,见
`tools/animation_pipeline/README.md`(每个选择都有实测数据)。

## 一键产出(程序干活)

```bash
.tools/venv/bin/python -m tools.animation_pipeline.produce \
    --clips-dir <稳定化视频目录: idle.mp4 run.mp4 ...> \
    --out       public/resources/runtime/animation/<角色id> \
    --world-w <数> --world-h <数>
```

产物:`atlas.png` + `anim.json`(游戏可直接加载) + `finals.json`(质检结论 + 待裁决 flag)。
退出码 0 ⇔ 所有**硬**质检通过。

## 你的职责①:裁决 QA flag(最重要)

程序 QA 分两层(见 `qa_gate.py`):
- **硬闸门**(帧数/位移/裁切/atlas≤2K)——程序直接判死,不需要你。
- **软 flag**(漂浮碎片/剪影面积突变/抠图镂空)——程序**只报可疑**,交你定性。

拿到 `finals.json` 的 `agent_flags`,对每条:调出该 clip 的密排帧图,按
`qa_gate.AGENT_SCHEMA` 结构化回答:道具是否全程在手且完整、动作对不对、身份/画风/朝向、
可疑帧是否真缺陷 → `verdict: accept|reject`。**程序从不单独判"通过";硬失败从不花你的 token。**

## 你的职责②:失败升级阶梯(reject 后)

```
默认配方 → 重摇 K 次(同参数) → quality 升 high → 换生成模式(动作迁移↔单图) → 叫人
```
关键教训(已验证):**持械 + 位移动作(走/跑)必须用单图生视频(Seedance),不能用动作迁移**——
迁移会把手里的道具甩掉(官差长枪/铁环就是这么丢的)。生成侧规格见
`tmp/libtv_animation_batch_run_20260702/run_animation_batch.py`,提示词务必写死
"游戏精灵素材·原地·禁止位移·道具全程握持"。

## 你的职责③:接新角色 / 调配方

- 阈值、每 state 帧数、锚点模式、播放帧率 → 只改 `tools/animation_pipeline/recipes.py`(数据),不改逻辑。
- 抠图默认 `fusion`(BiRefNet+colorkey);torch 不可用自动降级 `rembg_isnet`。

## 别做
- 别让 agent 当整条管线的驱动逐条跑(慢/贵/飘)。批量与定时走程序入口。
- 别抄参数清单进 SKILL——以 `recipes.py` / 运行时代码为准(列举型内容会漂移)。
- 运行时图集模型若有疑问,核 `src/rendering/SpriteEntity.ts`(均匀网格 + anchor(0.5,1) 底中对齐)。
