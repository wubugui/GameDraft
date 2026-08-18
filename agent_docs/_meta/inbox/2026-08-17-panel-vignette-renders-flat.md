---
target: ui-panel-skin
date: 2026-08-17
session: UI 八项修（歪歌册配色 / 返回书架 / debug 闪烁 / 对话朝向 / 对话记录 / 关闭键帽 / HUD 方案 / 切换音）
---

# `createPanel` 的「暗角」在真机上是一整块平的黑纱，不是渐变

- **现象**：`SKINS.paperPage` 的纸底配 `0xdfd0ae`，游戏里实测渲染成 `#aea184`（暗两成、去饱和成卡其）。
  在真跑的游戏里把那层 vignette Graphics `visible=false` 再取一次帧：`215,198,163` —— 与配色算出来的值分毫不差。
- **根因**：`PanelSkin.createPanel` 里那层 `FillGradient`（`type:'radial'` + `textureSpace:'local'`
  + 归一化 `outerRadius: 0.72`）在面板尺寸下**不出渐变**：逐点采样中心与四角完全同值
  （`174,160,132` vs `174,161,132`），等效于铺了一层 ~19% 的均匀黑。
  标称值也对不上——skin 写 `vignette: 0.16`，实测有效遮蔽 ~0.19。
- **影响**：**全站每一块走 `createPanel` 的面板都比配色里写的暗一档**，且暗角这个设计意图从来没实现过。
  更麻烦的是暗底面板的底色（`UITheme.colors.panelBg` 那一组注释说"逐块量过设计稿"）
  是**连着这层黑纱一起量**定下来的——真去修渐变，全站暗面板会一起变亮，等于重调一遍配色。
- **本次处理**：只把纸页两档（`paper` / `paperPage`）改成 `vignette: 0` + 把目标色直接烘进 `fill`
  （`PAPER_FILL = 0xe3d5b4`，叠 13% 纤维纹后落到 ~`#dcccaa`），墨字五档按这个底重算过对比度。
  暗底面板一概没动。
- **待办**：ui-panel-skin 机制卡里「暗角」那一节按现实改写（要么修渐变并重调暗底面板底色，
  要么承认它是"整体压暗系数"并改名）；`PanelSkin.vignette` 的字段注释目前描述的是没发生的事。
