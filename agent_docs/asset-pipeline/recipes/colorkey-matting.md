---
id: colorkey-matting
title: 纯色底色键抠图配方
domain: asset-pipeline
type: recipe
summary: 洋红/纯色底出图→无 halo 抠图:逐图测键色、YCbCr 色度距离、un-mix、despill、补洞铁坑、三底质检
status: active
authority:
  - tools/animation_pipeline/matte_illustration.py
  - public/resources/runtime/images/parallax
triggers:
  topics: [色键, 洋红底, colorkey, chroma key]
  tasks: [抠纯色底图, 分层抠图]
last_governed: 2026-07-11
---

**实测环境与日期**:2026-07-05,寻狗记神仙岭 11 张插画 27 个分层,可见洋红像素全 0
(macOS 本地 Python:PIL/numpy/scipy;当次脚本 colorkey.py 在会话 scratchpad,未持久化——本卡即参数权威)。

适用:LibTV 等出的"主体保留、其余填纯色(洋红/黑)"分层图。对象级抠图(灰底/复杂底)走
[抠图路线图](../mechanisms/matting-toolbox.md) 的 fusion,不走本配方。

## 步骤

1. **键色逐图检测**:取图像边界环的众数色;饱和度 > 0.4 才算键色,否则判为不透明背景板
   (近黑边的夜景背景要保留不透明)。**每张洋红 RGB 都不同**(实测 (248,8,216)~(200,8,168)),
   禁止硬编码键色。
2. **alpha = YCbCr 色度距离**(不是 RGB 欧氏):抓"同色相不同亮度",暗处洋红也能扣掉。
   阈值 t0≈35 全透明 / t1≈85 全不透明。
3. **边缘 un-mix(消 halo 的关键)**:半透明像素还原真前景色 `F=(P-(1-a)K)/a`,剔除键色 fringe。
4. **despill**:键色的两个高通道相对第三通道的超出量按 0.6 收回,中和残留;主体本身无该色相
   时几乎不动(金符纸/蓝袍不伤)。
5. **补洞铁坑**:`binary_fill_holes` 只填 `cdist>t1`(确属主体色度)的洞;
   **键色口袋(肢体/背带间透出的填充色)cdist 小,必须留透明**——填了会复活成一块洋红斑(踩过)。

## 质检

- 白/黑/绿三底并排看边缘(绿底上洋红最跳)。
- 量化:"可见洋红像素"(alpha>0.3 且 `(R+B)/2-G>60`)应 = 0。

## 关联

洋红渐变底(如窗帘光影)色键去不掉紫灰雾——那种改走 fusion + 去溢色,见
[环境动效配方](ambient-fx-production.md);出洋红底图的 prompt 坑见
[LibTV 出图配方](libtv-image-generation.md)。
