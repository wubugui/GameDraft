---
id: parallax-scene-runtime
title: parallaxScene 运行时语义
domain: runtime
type: mechanism
summary: 运行时只播 layers[].keyframes,camera/depth/sourceKeyframes 是编辑器工作态被完全忽略;烘出的帧必须 linear
status: active
authority:
  - src/rendering/CutsceneRenderer.ts#showParallaxScene
  - src/utils/keyframeSampler.ts
  - public/assets/data/parallax_scenes.json
triggers:
  paths: ["public/assets/data/parallax_scenes.json", "src/rendering/CutsceneRenderer.ts", "src/utils/keyframeSampler*", "tools/parallax_editor/**"]
  topics: [parallax, 视差, 分层, 过场镜头, 关键帧采样, 缓动]
verified_by:
  - src/utils/keyframeSampler.test.ts
last_governed: 2026-08-05
---

## 是什么(一句话)

过场 present 命令 `parallaxScene`:按 `parallax_scenes.json` 逐层贴图播关键帧动画,
fire-and-forget,靠 `hideImg(handle)` 收(缺省 handle = 场景 id;不写 handle 走匿名镜头位,
见 [cutscene-step-semantics](cutscene-step-semantics.md))。

## 权威源(读代码从哪进)

`CutsceneRenderer.showParallaxScene`(cover 映射与层调度);**插值数学已抽到
`src/utils/keyframeSampler.ts`**,渲染器那边只剩一层薄包装——照旧卡去读 `showParallaxScene`
只会读到包装。采样器现在是 parallax 与 [[entity-trajectory]] **共用**的一份,
边界/loop/缓动族/段长下限的语义都在那里,金标 `keyframeSampler.golden.json`(TS 与 Python 共用)。
数据在 `parallax_scenes.json`;可视化编辑在 `tools/parallax_editor/`。

## 硬契约(违反即 bug)

- **运行时只播 `layers[].keyframes`,完全忽略 `camera` / `depth` / `sourceKeyframes`**
  ——那些是编辑器工作态字段,保存时把"相机 × 自身运动"烘焙成密关键帧写回。
  手改 JSON 想动镜头,改的是 keyframes 不是 camera。
- 烘出的 keyframes **easing 必须 linear**(密集帧线性回放;写 easeInOut 会二次缓动)。
  这条是**跨烘焙式动画的通用条款**,实体轨迹的烘焙产物同样恒不写 `easing`
  (见 [[entity-trajectory]]);改任一侧的落盘形都要想着另一侧。
- 相机语义是**叠加**在各层自身运动之上,不是覆盖——改编辑器烘焙逻辑时守住这条。
- present 步字段三处一致:过场执行 / validator / timeline 编辑器。

## 已知坑

- 没有独立 action:触发链 = `startCutscene` → 过场 → parallaxScene(present 步)。
- **缓动函数目前有三份实现**:`keyframeSampler.ts`(运行时,权威)、轨迹工作台的 Python 烘焙机
  (`tools/trajectory_workbench/bake.py`,与金标对账)、以及 `tools/parallax_editor/main.ts` 里**未收编的第三份副本**。
  改缓动族时第三份不会有任何东西提醒你——它只影响 parallax 编辑器的预览手感。
- 预览页 rAF 被节流,编辑器里验轨迹用 scrub 直接设时间比 play 可靠。

## 怎么验证

素材审计自动覆盖 `layer.image`;改数据后 `validate-data`;真机播对应过场看层序与轨迹。
