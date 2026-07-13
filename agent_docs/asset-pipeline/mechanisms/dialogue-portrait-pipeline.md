---
id: dialogue-portrait-pipeline
title: 对话立绘管线
domain: asset-pipeline
type: mechanism
summary: 立绘 3×3 表情图→切片抠图的契约:flood-fill 灰底结构上无镂空、dehalo 已内建、产物 gitignored 改前必备份
status: active
authority:
  - tools/dialogue_portrait_pipeline.py#gray_key_to_rgba
  - tools/dialogue_portrait_pipeline.py#dehalo
  - public/resources/runtime/images/dialogue_portraits
triggers:
  paths: ["tools/dialogue_portrait_pipeline.py", "public/resources/runtime/images/dialogue_portraits/**"]
  topics: [立绘, 头像, portrait, 表情图]
  tasks: [重生成立绘, 修立绘抠图, 加新角色立绘]
last_governed: 2026-07-11
---

## 是什么(一句话)

把生成的 3×3 表情大图切片、抠灰底、产出
`public/resources/runtime/images/dialogue_portraits/<slug>/<slug>_<emotion>.png` 的管线
(运行时如何选用立绘归 runtime 域,这里只管素材生产)。

## 权威源(读代码从哪进)

`tools/dialogue_portrait_pipeline.py`:`_flood_bg`/`gray_key_to_rgba` 是抠图本体,
`dehalo` 在 `process_sheet` resize 后无条件调用。源 3×3 大图在
`tmp/dialogue_portraits_work/generated_sheets/`。

## 硬契约(违反即 bug)

- **抠图 = 边缘 flood-fill 灰底**,结构上不会掏内部洞;它的失败模式是"背景灰被当主体留成灰块",不是镂空——排查方向别搞反。
- **dehalo 已内建(2026-07-07 根治)**:相对**局部前景**判定、只压"比邻域更亮且低彩"的边缘污染;对白发/灰头巾角色实测安全。重跑管线不应再产 halo,若再现先查是否绕过了 `process_sheet`。
- 就地修单张 PNG 时 **alpha 必须逐字节不变**(轮廓与 meta.alphaBboxes 依赖它),只动 RGB。
- **立绘 PNG 是 gitignored 生成物**:改前必须自行备份,git 救不回来。

## 已知坑

- 量化 gray_rim 指标会把白发/灰头巾(合法内容)误报成 halo——必目视复核,判读铁律见
  [抠图路线与判读铁律](matting-toolbox.md)。
- 死资源 `player_taoist_anim_v1/`(无引用、坏得最凶)用户拍板**留着别动**。

## 怎么验证

重生成后看各 slug 的 QA sheet;量化"halo%"只当线索,目视白底边缘定裁决。
