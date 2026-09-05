---
id: lighting-scale-reference
title: 光照参数的空间与单位(世界空间 wu ↔ 伪世界 q)
domain: runtime
type: mechanism
summary: 灯摆在世界空间、单位 wu(与 NPC/热区/spawn 同尺,角色高 150 wu 恒定);shader 里 march 走伪世界 q,两者差一个逐场景的 wuPerQUnit,transform 只在打包处折一次
status: active
authority:
  - src/rendering/lighting/lightPacking.ts
  - src/rendering/entityShadowBinding.ts
  - src/core/SceneLightingSystem.ts#wuPerQUnit
  - tools/editor/editors/scene_lights.py
  - tools/character_lighting_lab/scene_fields.py
triggers:
  paths:
    - "src/rendering/lighting/**"
    - "src/rendering/entityShadowBinding.ts"
    - "tools/editor/editors/scene_lights.py"
    - "tools/scene_relight/**"
  topics: [统一光影, 灯光参数, 世界空间, wu, 伪世界, ppu, 相机标定, 尺度, 摆灯]
  tasks: [加灯光参数, 调场景光照, 改光照 shader, 接光照旋钮, 摆灯]
verified_by:
  - src/rendering/lighting/lightPacking.test.ts
  - src/rendering/entityShadowBinding.test.ts
  - tools/editor/editors/tests/test_scene_lights.py
  - tools/editor/tests/test_shadow_bias_validation.py
last_governed: 2026-09-03
---

## 是什么(一句话)

灯摆在**世界空间**、单位 **wu** —— 与 NPC、热区、spawn、碰撞同一把尺;
shader 里 march 走的是**伪世界 q**(深度重建出来的),两者差一个**逐场景的比例**,
那次 transform 只在打包处折一次,作者不必知道。

光照模型本身(原画 + 加性实体灯、S_day 只当 albedo 除数)见 [[scene-lighting]] ——
本卡只管"参数住在哪个空间、用哪把尺"。

## 两个空间(定义见总表)

空间本身的定义、原点、住户、以及两个 M / 两套像素栅格那几条铁律,
一律以 [[coordinate-spaces]] 为准,本卡不复制。这里只讲**光照参数**这一面:

- 作者填 **wu**(世界空间,与 NPC 坐标同尺,角色高 150 wu)
- shader 里 march 走 **q**,着色走 **M-world**
- 两者差 `wuPerQUnit = worldWidth / (native_w / ppu)`,逐场景不同
  (雾津街头 **880**、teahouse **154**),取自 `lighting/<背景基名>/geometry.json` 的 `scale.scene_per_wu`
- **那次 transform 只在打包处折一次**

**判据:角色在 wu 里 28 个场景恒为 150。** 它在 q 里从 0.17 变到 0.97,
那是**相机标定**在变,不是世界单位在变。

## 权威源(读代码从哪进)

- `lightPacking.ts`:`packLights(def, wuPerQUnit)` / `packEmissive(def, wuPerQUnit)` /
  `packShadowBias(def, quPerWu)` —— **transform 就这三处**,别的地方不许再折。
- `SceneLightingSystem.wuPerQUnit`。
- `entityShadowBinding.ts`:CPU 侧的影子浓度估算,**在 q 里算**(见下 §③)。
- `scene_lights.SceneLightSpace`:编辑器侧的同一条链(`q_to_world` / `world_to_q`)。

## 硬契约(违反即 bug 的机制约束)

1. **作者面一律 wu**,字段不带单位后缀(`pos` / `range` / `size` / `softeningRadius`
   / `scaleHeight` / `shadowBias.thickness`),和 NPC 的 `x`/`y` 一个待遇。
2. **transform 只在打包处折一次**。别的地方看到 `* wuPerQUnit` 就要怀疑。
3. **原点不动**。折的是尺度,不是平移——零点仍是零点。
4. **缺省值按角色 150 wu 定**(作用半径 450 ≈ 3 个人高,发光体半径 10 ≈ 1/15 个人高,
   厚度窗 264 ≈ 1.76 个人高)。摆灯时对着角色比,别记绝对值。
5. **换单位的改动必须是零行为变化**。`shadowBias` 的缺省刻意不取整(30.8 / 264 而不是
   30 / 260),因为取整实测会让 0.14% 的像素变、阴影边界最大差 154(shadow acne 翻转)。
   要调阴影质量另开一次改动,别混在重构里。
6. 加了字段/uniform 就要**两头都有**(写入方 + 消费者),否则别声明。

## 已知坑

### ① 造了一个游戏里不存在的单位

一度给所有光照长度加了 `*Meters` 后缀,换算系数取 `meters_per_wu`,而那个值是
`bake.py` 里写死的 **`1.7 / char_wu`**——「假设角色 1.7 米高」。
**游戏里没有米**。整层已推倒,`meters_per_wu` 从烘焙产物里删掉了。

> 制作人 2026-08-21:「我这个游戏里哪来的叫作米的单位,只有一个世界单位叫作 wu」

### ② 然后把伪世界 q 单位叫成了 wu

推倒①之后,又把灯住的那个 q 空间当成了 wu,并据此声称「同一个 wu 数值在不同场景
差 5.7 倍」,还加了个按场景折算起始值的 `seed_length`。**同一个错误的第二层:
把相机变换当成了世界单位的变化。**

> 制作人 2026-08-21:「你看到的缩放是否可能是相机 ppu 导致的。不要混为一谈,
> 世界空间单位是 wu,最终渲染出来的东西是经过了相机变换的啊!」
>
> 「灯肯定要在世界空间摆放测量,那个深度恢复的叫作伪世界空间,
> 他还需要 transform 才能和世界空间对齐!」

`seed_length` 已删。判据见上表:**角色在 wu 里恒为 150**。

### ③ intensity 的量纲绑在距离单位上

照度 = `I / r²`。shader 里 march 走 q,所以 `intensity` 是**相对 q 定义**的。
`entityShadowBinding` 那份 CPU 估算因此也必须**在 q 里算**——一度把它改成在 wu 里算,
同一个 `intensity` 给出的照度差了 `wuPerQUnit²`(雾津街头 **774400 倍**),
影子浓度会整片归零,**而且不报错**。

### ④ 两套标定别混用:`meta.cal` 是 **work** 分辨率的

`geometry.json` 里有两个分辨率:`work`(512×288)与 `native`(2048×1152),
而 `meta.cal` 是**给 work 用的**(雾津街头 ppu 112.64、cx 256、cy 144)。
native 那套在 `depthConfig.M` 里(ppu 450.56、cx 1024、cy 576),shader 用的是它。

`backgroundWu` 一度写成 `native.w / cal.ppu`,正好差 **4 倍**(报 16000 而不是 4000)。
判据现成:`backgroundWu` 应当**恰好等于场景的 `worldWidth`**,对不上就是混了标定。

### ⑤ 缺省参数在重放 / 缓存路径上是隐形陷阱

与③同族(**尺度错不报错,只是全灭**),但更难抓,因为出错的不是某次外部调用而是**内部重放**。
一个"没标定时的合理缺省"(比如「q 即 wu」的比例 1)一旦被内部重放/缓存/重建路径吃到,
就把**已经标定好的值悄悄踩回缺省**:没有报错、没有日志,JS 侧读什么都正常,
只有 GPU 上的真值是错的。而且**触发条件常常是必然的**——只要真实时序注定要走一次重放,
它就每次都错,于是"从来没工作过"被误读成"这个功能就是这样"。

两条规矩:**重放/缓存类的内部调用一律显式传全参**(宁可多写);
**取证要读 GPU 真值**,别信 JS 侧的镜像变量与日志。

### ⑥ 「看着像旋钮的常量」

同一类缺陷在本系统出现过五次:声明了字段/uniform,但没有写入方或没有消费者。

| 字段 | 病灶 | 处置 |
|---|---|---|
| `uShadowBias` | uniform 有初值,`applyParams` 从不写 | 接通 + F2 旋钮 |
| `LightDef.twoSided` | GLSL 真按它裁半空间,但两处调用点硬传 `false` | 接通(`D.w` 位标志) |
| `LightDef.shadowSamples` | 面光软阴影没实现,零消费者 | 删 |
| `LightDef.dynamic` | "每帧重算"那一档没实现,写 `true` 不会让烛火闪 | 删 |
| `uMetersPerWu` | shader 里只声明没使用 | 删 |

删掉/改名的字段要进 `scene_lights.REMOVED_LIGHT_FIELDS` / `RENAMED_LIGHT_FIELDS`,
让残留数据被校验器点名——静默失效不能靠人记得。

复查办法:按 `SceneLightingDef`/`LightDef` 的字段表逐个 grep「运行时消费者 / F2 /
编辑器」三面,任一字段运行时那面为空 = 死字段。

## 已知坑:光晕(灯体自发光)

### ① 拿「表面点到灯的距离」当大气光晕

原来写的是 `dd = dot(P - A.xyz, ...)` 再 `exp(-dd/R²)` —— 那不是光晕,是
「离灯近的**表面**会发亮」。制作人 2026-08-21 一眼看出两个症状:

> 「光晕为什么还会有不完整的,我看你那些阴影区域既没有光也没有光晕。」

实测:离灯等距的圆环上只有 **13%–66%** 是亮的 —— 它本来就不是个圆。
根因是一遇深度断层(屋檐、墙沿)光晕就被切一刀;阴影区的表面在深处、离灯远,所以也没有。

**大气光晕是空气散射的,与背后是什么表面无关。** 正确模型是沿视线积分 point light 的 1/r²
(airlight)。伪世界 q 里视线就是 z 轴,于是有闭式解:

```
∫dt/(r⊥² + (t−lz)²) = (1/r⊥)·[atan((t−lz)/r⊥)]
```

从近平面积到**该像素的真实表面深度** —— 挡在灯**前面**的东西截断积分(遮挡仍成立),
挡在灯**后面**的东西不再切光晕。改完圆环完整度 36.7% → **97.1%**。

### ② 只积分不加包络 ⇒ 1/r⊥ 长尾把整张画淹了

闭式解在 `r⊥ ≫ R` 时退化成 `Δθ·R/(π·r⊥)`,**没有任何衰减**。实测:光晕在
**≈100%** 的像素上非零、中位发光亮度是中位表面亮度的 **277 倍**、机位整帧平均
RGB 从 48.3 涨到 **162.0**,而且 `haloRadius` 只剩幅度语义、框不住光。
其中 **55%** 来自 `core` 项——灯体变成了第二圈更紧的光晕,不是灯泡。

同一个教训 `lcFalloff` 的注释里已经写过一次:
「截断是必须的:没有它,夜景里一盏灯会把整张图都染暖(实测过)」。

**分工:积分管遮挡与深度,高斯包络管范围**,两者相乘。加了包络之后:
非零像素 100% → **31.3%**,均值倍数 ≫1 → **0.34×**,整帧平均 162.0 → **58.4**
(gain 0 是 48.3,即光晕的贡献从 +113.7 收到 **+10.1**),`haloRadius` 70/140/280 wu
对应轮廓半径 24/34/54 px —— 单调了。

### ③ 灯体自发光的增益与灯强度是**同一个工作点**上标的

光晕增益随 `intensity` **线性**放大,而它的缺省是按当时那批灯的强度量级调的。
把某盏灯的强度往上抬一两个量级,光晕会先于照明轰成一颗太阳 ——
看着像"光晕代码坏了",其实是两个旋钮的缺省绑在同一个工作点上。
**重调灯强度就要连着重调它的自发光增益**,别只动一个。

### ④ 验光晕完整度要**单盏隔离**

加了包络之后本灯远处的值降了两个数量级,而邻灯的近域仍是 1e-1 量级,于是
「环上 > 该环最大值 10% 的像素占比」这个判据会被邻灯霸占环最大值而塌。
六盏全开时它报 80.9%,**单盏隔离才是 98.3%**。
决定性反证:lamp_3 最近的邻灯在 443 px 外,它在全开条件下四个环全是 100%。

## 怎么验证

- `npx vitest run src/rendering/lighting/lightPacking.test.ts src/rendering/entityShadowBinding.test.ts`
  ——含「位置也折且原点不动」「同一份灯参在两个尺度不同的场景打出的 q 差 wuPerQUnit 的比」。
- `sh scripts/py.sh -m pytest tools/editor/editors/tests/test_scene_lights.py
  tools/editor/tests/test_shadow_bias_validation.py -p no:cacheprovider`
  ——含 `test_角色高度在所有场景都是_150_wu`(直接从 28 个场景的烘焙产物复算)。
  (`-p no:cacheprovider` 见 `_meta/inbox/2026-08-19-pytest-shutdown-hang-*`)
- 真机:F2 改一个 wu 数值,读对应 uniform,应当等于 `填的值 / wuPerQUnit`。
