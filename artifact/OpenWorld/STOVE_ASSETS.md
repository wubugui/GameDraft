# 街摊冷灶

- 内置 imagegen 源：`C:/Users/wubugui/.codex/generated_images/01a06f97-7950-7db0-9c5c-9c9cfcb7b7dc/exec-adcc2805-fb45-4a71-ae40-756ccb1e90d1.png`。
- 原样复制至 `public/resources/runtime/images/examine/ow_noodle_stove.png`，另用项目默认法线烘焙工具派生法线。图中前下方灰口、右前方缺脚分别作为实际检视用料位置。未用脚本修改颜色图；透明度与游戏合成另行核验。

原图精确提示：

> Create a single game inspection prop: a small early-twentieth-century southwest Chinese street vendor's unlit clay cooking stove, three-quarter front view from above. A squat dark terracotta cylindrical brazier, open top with a removable black iron pot ring, clearly visible oval air intake LOW on the FRONT clogged with loose pale grey cold ash. The stove stands on three short clay feet; the VIEWER-RIGHT front foot is chipped and visibly short, leaving an obvious gap under it, while the left foot is intact. No pot on top, no flame, no smoke. Entire object centered in a square canvas with generous transparent margin; actual RGBA transparency outside its solid silhouette, no painted checkerboard and no floor. Hand-painted realistic adventure game art, worn earthy clay and soot, legible shapes, neutral diffuse light, no dramatic black shadow, no text or symbols, no extra tools or objects.


- 修后参考编辑稿 `exec-524a10ec-5c03-4e67-a161-8f4c3a562d55.png` 为 RGB，棋盘格被画进背景；复处理稿 `exec-40fa017a-1e85-4935-ac9c-e3219d9f6210.png` 还误把灶口内部挖空，两稿均未上线。后者即使透明也不采用。

修后参考编辑稿提示：

> Repair this exact small clay cooking stove for a game before/after sprite. Preserve the entire stove, camera view, framing, worn clay, iron rim, and transparent background. Make only two visible repair changes: (1) clear the pale loose ash out of the lower front oval air intake so the opening is dark and unobstructed; (2) place a small solid dark wood wedge directly UNDER the viewer-right chipped front foot, supporting the short foot firmly from below. Keep the chip visible and show the wooden support clearly. The iron grate visible inside stays intact. No fire, smoke, glow, pot, extra objects, text, floor or cast shadow. Output real RGBA alpha-zero transparency outside the stove plus wedge silhouette, never painted checkerboard. Use neutral readable diffuse lighting as in the source.

未采用的复处理提示：

> Extract the stove AND the little wooden wedge under its right foot as one clean cutout. The checkerboard surrounding them in the supplied image is unwanted painted background. Erase every checkerboard square and output a transparent RGBA PNG with alpha zero outside the stove and wedge. Preserve the exact source colors, shape, perspective and complete object. Do not draw a transparency pattern or any replacement background, floor, shadow, text, border, smoke, or new detail. The empty space under the stove between the feet must also be alpha transparent.

- 修后场景小图改用独立生成的同类灶具 `exec-3cddb5a2-472b-4728-8d92-7509dd376fd6.png`，原样复制为 `ow_noodle_stove_repaired.png`。它与原图的锅圈形态略有差别，仅用于小尺寸场景反馈，不拿来替换修前检视的逐像素热点。清通灰口、右脚下的楔木可见，法线使用项目默认烘焙。场景合成仍须目视判定。

修后场景小图提示：

> A clean RGBA PNG game sprite of one repaired small clay brazier on a TRANSPARENT BACKGROUND. Isolated object only; all pixels outside the stove and wood support have alpha zero. A squat cylindrical handmade terracotta Chinese street cooking stove seen three-quarter from above, with worn warm reddish-brown clay walls, a dark iron top pot ring with three small raised pot supports, and a dark metal grate visible deep in the open top. The LOW FRONT wall has one oval air intake that is cleared of loose ash: the hole looks into the dark opaque interior of the stove, it is NOT transparent through the whole object. Three small clay feet support the stove; the viewer-right front foot has a chipped lower edge and rests firmly on a small dark brown wedge of wood. All materials solid and readable in soft diffuse light. Muted hand-painted realistic adventure-game asset. Full object centered, ample empty transparent margin, square canvas. No flame, smoke, glow, scenery, floor, shadows, checkerboard squares, writing, border, pot, or tools.
