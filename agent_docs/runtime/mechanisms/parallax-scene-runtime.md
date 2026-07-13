---
id: parallax-scene-runtime
title: parallaxScene 运行时语义
domain: runtime
type: mechanism
summary: present 步播 parallax_scenes.json 的分层关键帧动画;运行时只认 layers[].keyframes,camera/depth/sourceKeyframes 是编辑器专用被完全忽略
status: active
authority:
  - src/rendering/CutsceneRenderer.ts#showParallaxScene
  - public/assets/data/parallax_scenes.json
triggers:
  paths: ["public/assets/data/parallax_scenes.json", "src/rendering/CutsceneRenderer.ts", "tools/parallax_editor/**"]
  topics: [parallax, 视差, 分层, 过场镜头]
last_governed: 2026-07-11
---

## 是什么(一句话)

过场 present 命令 `parallaxScene`:`{type:"parallaxScene", id:<注册表id> | scene:<内联对象>, handle?}`,按 `parallax_scenes.json` 逐层贴图播关键帧动画,fire-and-forget 靠 `hideImg(handle)` 收(缺省 handle=场景 id;不写 handle 走匿名镜头位,见 [cutscene-step-semantics](cutscene-step-semantics.md))。

## 权威源(读代码从哪进)

- `CutsceneRenderer.showParallaxScene`(cover 映射 `k=max(sw/widthRef, sh/heightRef)`、多关键帧线性插值)
- 数据:`public/assets/data/parallax_scenes.json`;可视化编辑:`tools/parallax_editor/`(Web,采样函数与运行时镜像)

## 硬契约(违反即 bug)

- **运行时只播 `layers[].keyframes`,完全忽略 `camera`/`depth`/`sourceKeyframes`**——那些是编辑器工作态字段;编辑器保存时把"相机×自身运动"烘焙成密关键帧写回 keyframes。手改 JSON 想动镜头,改的是 keyframes 不是 camera。
- 烘焙出的 keyframes **easing 必须 linear**(密集帧线性回放;写 easeInOut 会二次缓动)。
- 相机语义是**叠加**在各层自身运动之上(层放进摄像机坐标),不是覆盖——改编辑器烘焙逻辑时守住这条。
- present 步字段三处一致:CutsceneManager.executePresent / validator / timeline_editor。

## 已知坑

- 没有独立 action:触发链 = `startCutscene`(action)→ 过场 → parallaxScene(present 步)。
- 预览页 rAF 被节流,编辑器里验轨迹用 scrub 直接设时间,比 play 可靠。

## 怎么验证

素材审计自动覆盖 layer.image;改数据后 validate-data;真机播对应过场看层序与轨迹。
