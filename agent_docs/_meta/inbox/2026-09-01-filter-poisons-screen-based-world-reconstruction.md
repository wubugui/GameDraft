---
target: character-lighting
date: 2026-09-01
session: 制作人质疑角色 probe 采样位置 → 单点双管线对测 → 根因实锤并修复
---

**根因（制作人怀疑属实）**：角色 lit mesh 挂在带 DepthOcclusionFilter 的 container 里，
Pixi 滤镜先把子树渲进**按包围盒对齐的临时 RT**——那一趟里 VERT 的 screen 是临时 RT
局部坐标。`vWorld=(screen−uWCPos)/uWCScale` 的世界重建被整体平移（gl_Position 不受
影响，**画面位置一直是对的，只有采样位置错**）。活体实测雾津街头：shader 里
vFootWorld=(1568,1518)，真值 (2083,2205)——差 500+ wu，probe 全在错处采样，
且误差随镜头/包围盒漂 ⇒ "角色强度怎么调都和场景对不齐"。

**修复**：世界坐标不再从 screen 反推，CPU 每帧喂 local→sceneWorld 仿射
（entityShade 组 uL2W0/uL2W1；SpriteEntity.syncLitQuadWorld 从换帧/走动/挂件三处喂）。
修后实测：vFootWorld 逐位归位；同点同方向下角色/地面比值 0.42→1.16。

**测量方法论沉淀**：
- `extract.pixels({target: mesh})` 隔离渲染会把目标平移到包围盒原点——
  **一切依赖 screen/世界重建的输出在隔离抽取下全是假的**（本次三轮"方向无关/
  spp 无关"的错误结论全由此来）。位置类取证必须整舞台抽取。
- shader 取证子档（CharacterLitSprite uEOnly=2..6：raw probeE / gridT 染色 /
  valid 角数 / 脚点 q / vFootWorld，lv6 B=127 作掩码标记）**留在代码里**，下轮直接用。

**连锁账（未闭合，重要）**：
1. **beta=4.2 是在带病采样下标定的**——采样位置修对后角色底光整体变了，
   雾津街头日夜的 beta 需要重标（很可能明显小于 4.2）。
2. "probe E 偏暗 16×"的旧账至少一部分是本 bug 贡献的，重查。
3. 残余 ~16% 人地差 + 跨加载的绝对亮度不一致（同条件 bg 143 vs 31，疑测量
   协程/时序，未定位）+ fixedN=1(水平) 反而比朝上亮的方向语义疑点——
   幂等自检(⓪==②)已过，机制自洽，但量级要对 CPU 真值再核。
