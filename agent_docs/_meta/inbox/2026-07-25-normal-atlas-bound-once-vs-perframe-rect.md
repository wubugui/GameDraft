# 偏差记录:法线图集两处错位 —— 静止角色也闪 / 左右朝向不一致

**现象**:角色**完全静止**却逐帧闪烁(内部像素一会儿采这儿一会儿采那儿,不是边缘问题);
同一角色朝左站 vs 朝右站,法线可视化差别巨大(一张整体偏绿、一张整体偏黄)。

---

## 主因:烘焙器与运行时的**格边界约定不一致**(逐帧误差累积)

- **运行时**取帧用**浮点** stride:`strideW = texture.width / cols`(`SpriteEntity` 切帧 +
  `resolveAnimationSet.effectiveCellPixelSize`),帧 k 的归一化起点因此**正好是 k/cols**;
  着色器的 `uNrmRect` 又是按**源图集**尺寸归一化的。
- **烘焙器**(`bake_normal_atlas.py`)却用 `cw = w // cols` 再按 `k*cw` 铺放 —— **整数截断**。
  w 不能被 cols 整除时格子全部左靠、右侧留空,**误差随帧序号线性累积**。

后果正好对上现象:

- idle 动画一直在切帧 → **角色不用动**,内部像素就逐帧采到不同位置 = 闪烁;
- 镜像查表 `ul = 1-ul` 从另一端取,误差方向相反 → **朝左/朝右法线明显不同**。

**实测**:46 张在用图集中 **33 张中招**,最严重 `fx_patron_drinker` 偏移达**格宽的 42%**
(9.29 法线像素)。修法:格边界改按 `round(k*w/cols)` 定(格宽最多差 1px,但落点与运行时
采样点对齐)。重烘 46 张后全部收敛到 ≤0.5px 的取整极限,其中 downscale=1 的图集为 0 误差。

⚠ 改了 `cols/rows/downscale` 或换图集后**必须重烘**:`./dev.sh bake-normals -- --force --only-atlases`。
`anim.json` 的 `normalBake.downscale` 是每图集权威,不传 `--downscale` 时会被尊重。

---

## 次因:法线纹理"绑一次"对上"逐帧 rect"(换图集即错位)

`uNrm` 只在 `Game.attachPlayerSceneFilter` / NPC 附加滤镜时**绑一次**(`Game.ts:3099/3190/3231`),
而 `uNrmRect` 由 `driveBakedShading` **逐帧更新**。实体运行时换图集(玩家有 `player_anim` /
`player_carry_corpse_anim` / `player_taoist_anim`,法线图尺寸各不相同;NPC 可经 `setEntityField`
重载动画)后,**新图集的坐标被拿去查旧图集的法线图**。

修法:`CharShadingEntityInfo` 增 `sheetUrl`,在三条路径的公共入口 `driveBakedShading` 里逐帧
`setNormalTexture(...)`;`CharacterShadingFilter.setNormalTexture` 对同源短路,逐帧调用零开销。

---

## 排查中被证伪的假设(留档防重走)

1. **玩家/NPC flipX 不对称** —— 否。`Npc.getShadingFrameInfo`(`Npc.ts:302`)内部已异或容器镜像,
   `Npc.setFacing` 还会把 sprite 自身朝向复位为 +1;玩家在 `Game.ts:4817` 外部异或。两者都对。
2. **翻转时 `uCharW` 变负把 `ul` 炸掉** —— 否。`getWorldSize()` 不带 `facingX`,恒正。
3. **相机像素吸附导致 `uOutputFrame` 与 `uWorldContainerPos` 失步** —— 否。
   `Camera.applyTransform` 先吸附再写 `worldContainer.x/y`,`updatePerFrame` 读的是同一个已吸附值。
4. **法线图非等比缩放** —— 基本否。整图等比缩放**保持归一化坐标**,非整数比例本身无害;
   真正的错位来自上面那个**逐格 floor 铺放**。
5. **锚点不居中导致 `ul` 偏移** —— 否。`SpriteEntity` 是 `anchor.set(0.5, 1)` 底中锚。

## ⚠ 测量陷阱(浪费过一轮)

在内嵌浏览器面板里读运行时 uniform 会看到**全是初值、driveFilter 调用 0 次** ——
那是因为该标签页 `document.visibilityState === 'hidden'`,rAF 被暂停,**不是 bug**。
要测运行时逐帧状态,必须确认页面真的在前台渲染。

⚠ 本机制 2026-07-24 刚从"运行时现算"改为"离线烘焙 + 只加载"
(见 `2026-07-24-sprite-normal-atlas-moved-offline.md`),两处错位都是那次迁移的遗留面。
