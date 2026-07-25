# 偏差记录:角色照明从 filter 反推 UV 迁到 sprite 网格同 UV 双采样

**动机(用户拍板的架构判断,正确)**:color 是 Pixi 画 sprite 时用图集 UV 采的,filter 只能
拿到渲染结果,图集 UV 用完即弃 —— 于是法线被迫从世界坐标**反推 UV**(uFootQ/uCharW 逐帧驱动)。
驱动一缺席(实测 Cutscene 态整段跳过)就全身采边缘列:通体单色/镜像换色/uniform 跳变闪烁。
正解 = **法线跟 color 用同一个顶点 UV 采样**,反推这步从结构上删除。

**落地**(`src/rendering/CharacterLitSprite.ts` + SpriteEntity/Npc/Game/CharacterLightingSystem):

- 与 sprite 同 quad 的 `Mesh`,顶点带图集 UV(`texture.uvs`)+ 帧内局部坐标;
  `texture(uNrm, vUV)` 与 `texture(uColorTex, vUV)` **同一个 vUV**。
- **镜像零 uniform**:vertex 里 2×2 行列式 det<0 即镜像(几何自身事实),shader 翻 n.x;
  UV 随镜像几何自然对侧,无需 ul=1-ul。
- 脚点/世界坐标由顶点变换直出;ground 深度在 shader 里采 ground_d 纹理 —— **逐实体逐帧
  CPU 驱动全部消失**。共享帧组(worldContainer 位姿+参数)挂 **Pixi ticker**(LOW+1),
  不经任何游戏状态分支。
- 照明数学与 filter 共用 `CHAR_LIGHT_COMMON_GLSL`(FRAG 内 `__CLC_*__` 标记切片导出),
  同一份字符串零漂移;遮挡回归纯 `DepthOcclusionFilter`;hotspot 仍走 filter
  (静态图,uSpriteWorldRect 世界矩形版反推,driveFilter 已喂)。

**三个踩过的坑(每个都烧了真时间)**:

1. **Pixi v8 的 `Sprite` 子节点不渲染**。mesh 挂 sprite 下:bounds/visible/renderable 全正常、
   GLSL 编译通过、恒红调试 shader 也零像素;挂 `Container` 下立刻显示。修法:mesh 与 sprite
   做**兄弟节点**,syncLitQuad 复制 sprite 的 position(视觉抬升)+scale(含 facingX 符号)。
2. **`renderer.extract.pixels(container)` 不带 filter,但带 mesh 自定义 shader**。
   filter 时代 extract 拿到的是未着色 sprite(之前一次取证的结果全是无效数据);
   迁 mesh 后 extract 即真像素 —— 逐通道对账因此才可能。
3. **过场跳过的稳定配方**:window 派发 Escape keydown+keyup 连发(cutsceneManager.skip()
   只跳单步,链式演出跳不完);对话用 eventBus `dialogue:advance` 冲;
   实在链太长(茶馆听书)直接 `devLoadScene('bridge_underpass')` 换零演出场景最省事。

**验收数据(bridge_underpass,showNormals,extract 逐通道)**:

- 镜像精确:朝右 R=191.15 / 朝左 R=63.8(**和=255.0 精确互补**);G、B 两朝向逐像素相同
  (193.8/58.7)→ UV 镜像逐 texel 对齐 + n.x 精确取反。
- 静止连拍 4 帧 R/G/B 纹丝不动 → 闪烁消灭;**Cutscene 态下渲染正常**(老失效条件)。
- 半出屏数值与屏内完全一致 → 屏幕裁剪免疫(filter 时代 uOutputFrame 被裁的病没了)。

**⚠⚠ 第四层真因(制作人物理直觉抓出,上一版此处的"侧身立绘正确物理"结论是**错的**,已删)**:
"朝右通体黄/朝左通体绿"根本不是侧身立绘的正确读数 —— 鼓包法线是从 alpha 剪影烘的碗状场,
**平均法线必然≈(0,0,-1) 朝相机**,翻转后整体色调必须对称(圆柱体行为)。实测文件真值
帧均值 r=0.500(完美中性、平均法线 (0.001,-0.003,-0.857)),GPU 采到的却是 0.749 ——

**真凶:Pixi v8 装载器 `loadTextures.js` 用 `createImageBitmap(blob)` 不带选项解码,浏览器
默认 premultiply,rgb 在**解码期**就被 ×alpha(而法线图的 alpha 是鼓包 profile,是数据!)。**
GL 层 alphaMode 怎么设都救不回(实测 no-premultiply-alpha 与默认逐字节相同)。装载器里
**唯一**保留原始字节的通道是 `data.alphaMode === 'premultiplied-alpha'`(语义="已预乘别再动",
名字反直觉)。已在 `AssetManager.loadTexture` 对 `*.normal.png` 走此通道。

修后实测:朝右 R=127.0 / 朝左 R=127.3(**差 0.3/255,完全对称**),与文件真值 127.5 对齐。
⚠ 判据修正:法线可视化"两朝向整体色调对称 + 平均≈(127,127,低B)"才是健康态;
上一版写的"R 互补即正确"只在被污染的场里成立,勿再引用。
⚠ 泛化警惕:**任何"alpha 当数据用"的纹理**(载荷图、mask、打包场)经 Assets.load 默认
通道都会被解码期预乘毁掉 —— 新增此类资源必须走 'premultiplied-alpha'。

**遗留**:filter 里 uFootQ/uCharW/uCharH 等 quad 驱动 uniform 只剩 hotspot 在用,
后续 hotspot 也迁 mesh 后可整块删除;`heightScale` 参数在 mesh 路径已无消费(废弃候选);
filter 路径的 uNrm 同样吃到本修复(同一 AssetManager 通道)。
