
## 纸人修补近景与浆炉

- 工具均为内置 imagegen。纸人原图 exec-ad9920ea-f571-4d43-9d0e-f0417972826c.png；透明边缘复处理稿 exec-28ffa513-4ab0-456a-8dd3-6ab1032c914d.png。均保留在 C:/Users/wubugui/.codex/generated_images/01a06f97-7950-7db0-9c5c-9c9cfcb7b7dc/。
- 纸人采用复处理稿原样复制到 public/resources/runtime/images/examine/ow_paper_frame.png，RGBA 1024×1536。周边抽样 alpha 为 0，物件内部约 253—254；图片浏览器显示的褐色底是透明像素中的 RGB，须以游戏合成核验。左踝裂篾与右脚纸缝分别配独立像素热区。
- 浆炉源文件 exec-8d9ae9fc-0664-4022-ba6c-441e7574baa2.png，原样复制到 public/resources/runtime/images/examine/ow_paste_stove.png，1254×1254。
- 两图均按项目 bake_normal_atlas.bake_image_file 默认 alpha 派生流程烘焙 .normal.png；未以代码改动成图。纸人法线 256×384，浆炉法线 313×313。

## 交付成品图标

- 内置 imagegen 的两次透明成品稿 `exec-4e0593b1-9dcd-45df-a22b-c7ca0a190f53.png`、`exec-024768c2-2797-46bc-b3c4-266f12366939.png` 实际均为 RGB，棋盘格已烤进像素，未用于游戏。
- 最终选择深灰褐底的完整成品插画 `exec-7b3b9f9f-b2e1-485e-9286-1069216bff4a.png`，原样复制到 `public/resources/runtime/images/icons/ow_paper_finished.png`。仅用作两个交付成品的背包图标，不当作透明场景精灵；名称和说明区分重做与修旧。已检查完整头身、空脸与两只稳定的脚，没有烤入棋盘格。背包小尺寸实机显示仍待复核。

成品初次修补提示：

> Create a repaired version of this exact game prop, preserving the empty paper face, full head and body, both arms, paper clothing, bamboo craft material and the same framing. Repair ONLY the two damaged feet: on the viewer-left, trim the outward split bamboo end flush and brace that ankle with one slim bamboo splint held firmly by a neat cream paper binding; on the viewer-right, paste the peeled paper seam closed flat over the bamboo ankle. Both feet should now be complete, flat and stable. No exposed splinter jutting out, no torn flaps. Keep a natural handmade old-paper look, not a person. Transparent alpha background with all background pixels alpha zero. Entire object opaque, no brown haze, floor, ground shadow, glow, text, symbols, eyes or mouth. A finished, stable paper craft doll ready for delivery. This is an inventory sprite variant, not a change in scene composition.

透明重试提示：

> Background extraction edit only. Preserve this exact completed paper-and-bamboo doll, its blank face, all limbs, both intact feet and the small binding on its left ankle. Remove the checkerboard pattern completely: the squares are currently painted pixels, and must be replaced with REAL transparent alpha (RGBA PNG with alpha 0 outside the doll). Do not render a checkerboard, white background, shadow or any backdrop. Keep the opaque cream paper silhouette and natural edges. Do not redesign or crop the doll. Output a clean transparent game inventory sprite.

最终不透明图标提示：

> Edit this image into a compact square inventory illustration. Preserve the exact completed cream paper-and-bamboo doll with a blank oval face and both complete feet. Fit the entire doll vertically within a SQUARE canvas with a generous dark border. Replace ALL checkerboard pixels with one solid matte dark charcoal-brown background (#28231f), no texture, no gradient. The finished paper figure should be clearly readable at small scale with both hands and feet visible. This is an opaque inventory icon, no transparent background is requested. No grid, no squares, no text, no labels, no human facial features, no glow.

纸人初稿提示词：

> Create one isolated game examination prop on a genuine transparent alpha background: a small unfinished early twentieth-century southwest Chinese funeral paper servant, lying flat and viewed straight down, complete head, torso, two arms and two legs visible with generous padding, portrait layout on a square canvas. It is plainly a handmade paper-and-bamboo craft object, no human anatomy. Off-white coarse paper pasted over a thin bamboo framework, plain blank oval face with NO eyes, mouth or facial markings. Simple paper tunic, arms straight down beside body. Viewer-left ankle: an exposed thin bamboo strip visibly split and bent outward just above its flat rectangular paper foot. Viewer-right foot: a conspicuous loose torn paper seam peeling away from the bamboo. These two repair areas must be separate, large and readable for click hotspots. Restrained muted cream and weathered tan, realistic hand-painted adventure game art, soft neutral diffuse light. No decorative red marks, no writing, no labels, no magic, no glow, no person, no blood, no table, no scenery, no ground shadow. Output only the complete paper craft doll, transparent exterior.

纸人复处理提示词：

> Edit this exact paper craft doll image. Preserve the entire doll and its two readable damaged ankle areas, including the bent split bamboo strip on the viewer-left and the peeling paper seam on the viewer-right. Remove ALL surrounding brown haze, vignette, backdrop and ground shadow. Everything outside the actual paper and bamboo silhouette must be truly fully transparent (alpha 0), with a clean natural antialiased edge. The doll itself must be fully opaque. Keep the complete head and both feet visible, with ample clear transparent margin. No other changes; no added background, text, labels, glow, facial features or objects. This is a sprite for a game and must composite cleanly on any background.

浆炉提示词：

> One isolated early twentieth-century Chinese craft workshop prop, on a truly transparent alpha background: a squat dark weathered clay charcoal brazier with a small black iron cooking pot resting securely on its top, pale rice paste visible in the open pot and a worn short wooden stirring paddle leaning inside. No flames visible, just faint red embers deep in the lower vent. Three-quarter isometric game view from above, entire object centered, compact and readable, enough transparent padding. Handmade old southwest Chinese river-town folk-horror adventure art, realistic subdued grey-brown, soft neutral diffuse light, lightly painted texture. No floor, no scenery, no backdrop, no glow halo, no steam, no text, no writing, no person, no modern parts. Pixels outside the actual brazier/pot/paddle silhouette must be transparent, the object opaque. Square canvas.
