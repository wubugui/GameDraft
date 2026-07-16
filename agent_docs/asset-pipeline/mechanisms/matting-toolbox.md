---
id: matting-toolbox
title: 抠图路线与判读铁律
domain: asset-pipeline
type: mechanism
summary: 仓库四条抠图路线的入口与适用域;halo 根因=无 despill;量化指标不可单独裁决(halo 误报白发、多扣须源级测)
status: active
authority:
  - tools/animation_pipeline/matting.py#matte_rgba
  - tools/animation_pipeline/matte_illustration.py#clean_matte
  - tools/dialogue_portrait_pipeline.py#dehalo
triggers:
  paths: ["tools/animation_pipeline/matting.py", "tools/animation_pipeline/matte_illustration.py", "tools/dialogue_portrait_pipeline.py"]
  topics: [抠图, matting, halo, despill, 色键, 镂空]
  tasks: [抠图, 换底, 修halo, 审查抠图质量]
last_governed: 2026-07-11
---

## 是什么(一句话)

仓库全部抠图能力的路线图:按"源是什么底"选路线,别为新任务另起炉灶写第五套。

## 权威源(读代码从哪进)

| 源 | 路线 | 入口 |
|---|---|---|
| 摄影棚灰底动画帧 | **fusion**(BiRefNet 定物体范围 + color-key 给利边) | `matting.py#matte_rgba` |
| 复杂背景插画抠人物 | fusion + 定向清理(去杂散/背景渗入清零/只补实心暗洞/收软边) | `matte_illustration.py#clean_matte` |
| 纯色底(洋红/黑) | 色键(逐图测键色 + YCbCr + un-mix) | [配方:纯色底色键抠图](../recipes/colorkey-matting.md) |
| 立绘灰底 3×3 表情图 | 边缘 flood-fill(结构上不掏内部洞) | [对话立绘管线](dialogue-portrait-pipeline.md) |

抠不干净的兜底路线:让 LibTV 把"人物以外的整个背景"换纯洋红底,再回本地色键
(prompt 要写死"山/地/碑/树全部",否则模型只换天空;见 [LibTV 出图配方](../recipes/libtv-image-generation.md))。

## 硬契约(违反即 bug)

- **halo 根因 = 边缘无 despill/un-mix**:半透明边必须做 `F=(P-(1-a)K)/a` 还原真前景色;任何新抠图路径不带这步就会重蹈立绘发梢白边。
- **多扣(把主体扣掉)必须源级测**:`(a_bir>0.7 & final_a<0.1) / (a_bir>0.7)`;`fill_holes` 会把飞袍/持械与身体间的真背景空隙误报成洞,不用于裁决。
- **封闭过扣洞按 BiRefNet alpha 均值回填**:均值>0.15(灰衣被抠穿)→填;≈0(腿间/持械三角真空隙)→留。

## 已知坑(指标判读)

- **halo 量化指标不可信**:分不清灰衣 vs 灰背景,会把白发/灰头巾(合法内容)误报;**holes(封闭镂空)指标才可信**。
- 每次抠完**必目检**:白/黑/绿三底并排(绿底看洋红最跳)或棋盘格底;只看数字宣布通过是已知翻车模式。
- 激进的全局 alpha 硬化会把半透背景区留成灰色块,别用。

## 怎么验证

三底/棋盘格目视 + holes 指标 + 源级多扣率;动画帧走 `qa_gate.py` 三态(见 [动画一键产线](animation-pipeline.md))。
