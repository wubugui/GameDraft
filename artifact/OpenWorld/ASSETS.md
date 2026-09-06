# 本轮新增素材

- 工具：内置 imagegen。
- 产物：`public/resources/runtime/images/minigames/water/ow_wooden_bucket.png`。
- 原始文件：`C:/Users/wubugui/.codex/generated_images/01a06f97-7950-7db0-9c5c-9c9cfcb7b7dc/exec-da7370ef-0418-40da-af11-963a95d4f2b5.png`，保留原件，项目内为原样复制。
- 用途：河滩捞桶小游戏实体、背包道具图标。已在真实水面检查；水面参数纹理坐标修正后，无此前的错位轮廓。

木桶最终提示词：

> Create one game prop sprite on a genuinely transparent background, with alpha. Asset for a hand-painted realistic folk-horror adventure in an old southwest Chinese riverside town. A single small weathered wooden water bucket, handmade vertical dark brown timber staves, two dull black iron hoops, a bent wooden carrying handle. Three-quarter side view from slightly above so the oval open mouth and dark empty interior are visible; upright, centered, complete silhouette, about 80% canvas height, wide padding. Damp faded wood with a few scuffs, restrained desaturated umber colors, soft diffuse overcast lighting. Painterly detail that remains readable when displayed at 90px. No water plane, no ground, no cast ground shadow, no scenery, no people, no text, no labels, no glow, no modern plastic. Square canvas. Output only the isolated bucket with transparent exterior.

- 工衣工具：内置 imagegen；原始文件 `C:/Users/wubugui/.codex/generated_images/01a06f97-7950-7db0-9c5c-9c9cfcb7b7dc/exec-41709cf1-d300-4be2-b5f4-15333ffb77bb.png`。
- 项目原样复制：`public/resources/runtime/images/examine/ow_shore_coat.png`，RGBA 1536×1024，四角透明，未裁切、调色或改 alpha。
- 用途：C03 的可交互近景与待认工衣图标。成图补丁实际有两道长针脚，内容按成图写“两道”，不按提示词里的三道冒认；袖口油迹、补丁、衣摆分别配原生像素热区。`coat-examine.png` 是旧 HUD 遮挡画面；`coat-bag-clear.png` 已收起世界快捷栏，但还暴露了摸囊列表文本引用未解析的问题，不能作为最终完整视觉验收。

工衣最终提示词：

> Create one isolated game examination prop on a genuine transparent alpha background: a single worn indigo cotton work jacket from an early twentieth century southwest Chinese river port, lying spread flat and viewed straight down. Wide landscape canvas. Whole jacket visible with padding, sleeves bent slightly down, open collar at top center, three cloth frog fastenings down center. On viewer-left upper chest a clearly visible rectangular faded grey-blue mend patch sewn with exactly three conspicuous parallel long pale stitches; no writing. Viewer-right sleeve cuff has a small dark brown greasy tar stain, distinct from a narrow pale dried water tide mark across the bottom hem. Coarse woven fabric, realistic wear, subtle hand-painted game art, muted blue-grey, soft diffuse overcast light, readable inspection details, no dramatic light. No person, no body, no mannequin, no background or ground, no cast ground shadow, no text or numbers, no decorative symbols, no magic. Keep the chest patch, right cuff stain and lower hem apart so they can be clicked as separate hotspots. Output only the complete jacket with transparent exterior.

## 更梆

- 内置 imagegen 生成，原件 `C:/Users/wubugui/.codex/generated_images/01a06f97-7950-7db0-9c5c-9c9cfcb7b7dc/exec-79cbb9f5-9018-4611-aef7-b72a32113403.png`。
- 原样复制到 `public/resources/runtime/images/examine/ow_watch_clapper.png`，RGBA 1254×1254，alpha 范围 0—255；没有裁剪或改色。
- 用于备用梆检视、原梆水面实体及物件图标；原梆与备用梆复用同类旧木梆造型。已目视确认左板下部裂纹与上端穿绳位置，游戏内热区核验进行中。
- 巡更灯复用现有 `props/dream/dream_oil_lamp_table_prop.png`；画中火苗对应尚有余油，文案没有称其全灭。

最终提示词：

> Create one isolated game examination prop on a genuinely transparent alpha background: an old southwest Chinese night watchman's wooden clapper, two long slightly unequal rectangular dark hardwood slats laid side by side vertically, joined at their upper ends by a frayed hemp cord threaded through round holes. The left slat has a shallow lengthwise split in its lower third, clearly visible; the upper cord has a loose frayed end. Entire two-slat object, top-down orthographic view, centered with generous padding on a square canvas. Early twentieth-century handmade everyday tool, faded brown wood grain, rounded worn striking edges, subtle damp discoloration, no blood. Hand-painted realistic inventory and close-examination game art, neutral soft light with no cast ground shadow, subdued colors, readable at 100 pixels. No hands, people, background, table, scenery, water, text, symbols, labels, glow, modern parts. Output only the wooden clapper and connecting cord with a transparent exterior.

- 首次街头渲染发现缺少展示图法线派生物；使用项目 `tools.animation_pipeline.bake_normal_atlas.bake_image_file` 从同一成图 alpha 按既有算法烘焙，产物 `ow_watch_clapper.normal.png` 为 313×313（默认 1/4）。这是运行时法线数据，未改动成图。需重新进场确认无资源错误。
