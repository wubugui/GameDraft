# 独立光照 Baker `tools/lightbake` — 实施方案

> 2026-08-23。给接手的 agent 用：读完这份就能实现，不需要回看对话。
> 所有公式、常量、数据来源、去向、以及踩过的坑都在里面。
> 凡是写着「实测」的数字都可复现，脚本路径在 §15。

---

## 0. 一句话

写一个**全新、独立、自带预览**的离线 baker，产出统一光影管线的全部烘焙产物；
预览是**单文件自包含 HTML**（图全部内联），结构上不可能看到浏览器缓存的旧图。

**交付是全量。** §13 的 P1..P6 是施工顺序，不是分期交付，不存在「先出个能跑的」。

---

## 1. 为什么要新写一个而不是改旧的

现有 `tools/scene_relight/` 是 **v2 重打光工作台**：围绕 `relight()` + 预设 + mask + 导出变体
建起来的，`bake_gbuffer.py` 是后来挂上去的（`POST /api/bake`）。三个后果：

1. **两套 tracer 长期并存**。场景侧已经换成蒙特卡洛无截断（`bake_gather`），
   实体侧还留着 `march_visibility_points` 的定长截断 march，而注释还写着
   「与场景侧 `bake_transport` 同一个分母」—— `bake_transport` 这个函数**早就不存在了**。
   实测后果见 §15：深遮蔽处实体比场景亮 **+0.4946**。
2. **预览走 dev server**，看到的可能是浏览器缓存的旧图，判读过好几次假。
3. `bake_gbuffer.py` 已经 96 KB，v2 的历史包袱（emissive、placeholder、4 通道纬向阶梯）
   以注释和死代码的形式留在里面，新人读不出哪些是现役。

新 baker 只做一件事：**从场景输入产出光照载荷，并把它渲染成可判读的预览**。

---

## 2. 边界

### 做

- 漫反射（Lambert）
- 遮蔽（sky occlusion）与 AO
- 天光：程序性天空（**不要真大气模型**）
- 环境光
- 色彩与曝光的标定量（写进 meta，运行时消费）
- 实体（角色）与场景走**同一条**光照管线

### 不做

- ✗ 任何阴影（投影、长投影、horizon 场、Occlusion Interval Maps、接触阴影、shadow map）
- ✗ 任何高光（roughness / metallic / 镜面 BRDF / 环境镜面 / split-sum / DFG LUT / GGX）
- ✗ 场景 GI 的多次弹射（实体 GI 通道保留，可 `--no-gi` 关）

### 不动

- `tools/scene_relight/` 整包原样保留（v2 工作台仍在用）
- 场景侧的**逐像素**产物精度**一点不降**（实体可以合理降低，场景不能有闪失）

---

## 3. 输入契约

### 3.1 数据从哪来

| 东西 | 路径 | 说明 |
|---|---|---|
| 原画 | `public/resources/runtime/scenes/<sid>/<bg_name>` | sRGB 8-bit PNG，尺寸即 `native` |
| 深度图 | `public/resources/runtime/scenes/<sid>/raw_depth_rg.png` | RG 双通道 16-bit 打包 |
| 深度标定 | 场景 JSON 的 `depthConfig` | `M.R` / `M.ppu` / `M.cx` / `M.cy` / `depth_mapping` |
| 角色尺度 | `character_band_wu(scene)` | `char_wu`（角色高，世界单位）、`band`、`scene_per_wu` |
| 天空（烘焙期） | 场景 JSON `lighting.bakeSky` 或 CLI `--sky` | 纯色或 skybox，**不进运行时** |

⚠ **`raw_depth_rg.png` 与 `collision.png` 是成对的**，git 可能把它俩拆散（见记忆
`depthconfig-png-pair-can-split`）。开工前跑一次尺寸一致性检查。

### 3.2 深度解码（逐字照抄，不许改）

```
rg  = imread('raw_depth_rg.png')  as uint16          # RGB 三通道，只用 R/G
raw = rg[...,0] * 256 + rg[...,1]                    # uint16
t   = raw / 65535
if depth_mapping.invert:  t = 1 - t
d   = t * depth_mapping.scale + depth_mapping.offset
若 d 的尺寸 ≠ 原画尺寸 → 重采样对齐原画
```

### 3.3 伪世界重建

工作分辨率 `WORK_W = 1024`（等比缩到宽 1024；`ppu/cx/cy` 按 `s = w/native_w` 同比缩放）。

```
px, py = 像素中心的整数坐标
qx = (px - cx) / ppu
qy = (cy - py) / ppu
q  = (qx, qy, d)                     # q 空间：屏幕对齐 + 深度
world = q @ Rᵀ                       # 即 world = R · q，R 正交
```

`R` 是 3×3 正交阵（`depthConfig.M.R`），把 q 空间转到世界。**转置即逆**，全程不要求逆。

### 3.4 法线

```
ps = gaussian_filter(world, σ=0.8)   # 该分辨率下的像素单位
n  = normalize( cross(∂ps/∂y, ∂ps/∂x) )
view = R · (0,0,1)                   # 指向场景深处
若 n·view > 0 → n *= -1              # 统一朝相机一侧
```

⚠ 现有 baker 用的是 `edge_safe_normals(world, R)` 而不是 `geo['normal']`——
它在**深度断崖**处做了额外处理，避免法线被断崖上的巨大梯度带飞。新 baker 必须
把这段逻辑带过来（读 `bake_gbuffer.py:edge_safe_normals`），并在文档里写清它做了什么。

⚠ **法线约定**：场景侧是**全值域世界法线**（`n = tex*2-1`）。角色侧历史上用过
视空间半值域（`-max(b, 0.05)`），两者混用踩过两次坑，实测中位角误差 23°–33°。
新 baker 只产全值域世界法线，编码 `tex = n*0.5 + 0.5`。

---

## 4. 输出契约

### 4.1 去哪

```
public/resources/runtime/scenes/<sid>/lighting3/
    base.png            原生分辨率
    irradiance.png      work 分辨率
    normal.png          work
    sky_occlusion.png   work
    vis_linear.png      work
    ao.png              work
    char_volume.bin     3D，见 §5.9
    meta.json
    preview/
        report.html     单文件自包含预览
```

⚠ 载荷版本 **v6**。三处常量必须同时改、且被测试钉死（历史上一天内漂过两次）：

| 位置 | 常量 |
|---|---|
| `tools/lightbake/payload.py` | `PAYLOAD_VERSION` |
| `src/core/SceneLightingSystem.ts` | `LIGHTING3_VERSION` |
| `tools/editor/validator.py` | `_LIGHTING3_VERSION` |

### 4.2 每个文件存什么

| 文件 | 通道 | 编码 |
|---|---|---|
| `base.png` | RGB | log2，`字节 0 = 精确 0` |
| `irradiance.png` | RGB | log2 |
| `normal.png` | RGB | `n*0.5+0.5`，线性 8-bit |
| `sky_occlusion.png` | RGBA | `rgb = Bdir*0.5+0.5`，`a = 余弦加权 V ∈ [0,1]` |
| `vis_linear.png` | RGBA | `rgb = b/(2·b_max)+0.5`，`a = a₀`（`V(ω)=clamp(a₀+b·ω,0,1)`） |
| `ao.png` | L | 线性 8-bit |
| `char_volume.bin` | 见 §5.9 | |

### 4.3 三条编码曲线，绝不能混用

8-bit PNG 限死了动态范围，所以三条曲线是**被显式设计出来的**，不是随手选的：

1. **对数**（`base` / `irradiance` / 体数据的 GI 幅度）：动态范围几百到上万倍
2. **`from_hdr`（正 Reinhard）**：只用于把 8-bit 原画展开成 HDR，甜区仅 0.1–3
3. **纯线性 8-bit**：只给本来就在 `[0,1]` 的可见性量（`V`、AO、`vis_linear`）

⚠ **升采样必须在编码域做**，不能解码后插值再编码。

---

## 5. 算法全文

### 5.1 去霾（必须在 gather 之前）

霾是**被日光照亮的空气**，不是表面。把它喂进 final gather 等于让远处一片亮灰当光源，
近处会被它照亮；而重打光只处理表面项，夜里那片霾还会继续亮着（实测雾津街头远/近亮度比 **4.32**）。

**拟合**：

```
dn   = (d - d_min) / (d_max - d_min)               归一深度
y(dn)= 20 个深度分箱里 min_c(lin) 的统计量          最暗通道 ≈ 纯霾
拟合  haze(dn) = H · (1 - exp(-k·dn))              扫 k，闭式解 H = (b·y)/(b·b),  b = 1-exp(-k·dn)
色度  c = percentile(lin[dn ≥ 0.85], 5, axis=通道)  归一到均值 1
```

**应用**：

```
trans  = exp(-k · dn)
amount = color · strength · (1 - trans)
lin'   = lin - min(amount, lin·(1 - HAZE_KEEP))    # HAZE_KEEP = 0.1
```

⚠ **必须用「按自身留下限」而不是 `max(lin - amount, 0)`**。霾是有颜色的
（实测雾津街头 `color = (0.862, 1.009, 1.128)`，蓝减得最多），硬钳会在暗部
**非对称清零**：蓝绿先死、红活下来 ⇒ 画面一片红噪点。实测硬钳时 7.23% 像素被部分钳零、
**孤立零点 5.02%**；改成留下限后 **0.002%**，且钳住时整体按比例缩小 ⇒ **色度守恒**。

### 5.2 HDR 展开

```
to_hdr(y)   = y / max(1 - y, 1/HDR_MAX)        HDR_MAX = 200      逆 Reinhard
from_hdr(x) = x / (1 + x)                                          正 Reinhard
```

**这是整条链唯一的建模假设，其余全是积分。** 中间调几乎不动（y=0.2 → 0.25），
高光被拉开（y=0.9 → 10，y=0.99 → 100）。

⚠ **运行时的 `tonemap: reinhard` 就是它的精确反函数**，不是艺术选择。
`from_hdr(to_hdr(y)) ≡ y`。这是 `gi=1 ⇒ 画面精确等于原画` 成立的**机制**。
实测 29/29 场景都是 `reinhard`，**零个 `none`**。
⇒ **换 tonemap 曲线必须同时换 `to_hdr` 并全量重烘**，不是运行时开关。

### 5.3 逃逸辐射（烘焙期天空）

射线跑出伪世界之后带走多少辐射，**画面里没有任何东西能回答**——它已经离开画面了。

所以这是**烘焙期的自由输入**：纯色，或一张 skybox（equirect，`.hdr` RGBE 或 8-bit）。
来源优先级：CLI `--sky` > 场景 JSON `lighting.bakeSky` > `DEFAULT_SKY`。

⚠ **绝对不许从画面上取值**。历史上写过 `estimate_sky_radiance`：拿 `depth > p92`
那批像素的均值当逃逸辐射。室内场景那 8% 是后墙脚的地面（实测茶馆选中区亮度中位 0.130，
其余也是 0.130，**毫无区别**），而同一个掩码还被拿去把 `base` 钉成 0，画面少了一整块。
**整条判据已删，不要以任何形式复活。**

⚠ 同理不许发明 `sky_mask`。「哪些像素是天」这个问题在单视角伪世界里无解，
任何按深度分位切出来的掩码都和「是不是天」零关系。

### 5.4 唯一 tracer —— **独立通用组件**

`trace.py` 是**一个独立可迭代的组件**，不是 gather 的内部实现细节。它自己有 API、
自己有测试、自己有版本；上层怎么用都不影响它。

#### 铁律

> **本 baker 里任何需要"这根射线打不打得中"的地方，都必须调 `trace.py`。**
> **不许任何消费者自己写 march 循环。** 判据、bias、步长、出画语义只有一份。

历史教训就在这条上：场景侧换成蒙特卡洛无截断之后，实体侧、局部 AO、GI 三处
各自留着自己的 march，其中实体侧那份还带 `MARCH_LENGTH = 2.4` 的截断，
**而世界宽 4.54** —— 一半以上宽度外的遮挡物对角色不存在。
实测深遮蔽处偏 **+0.4946**（§15）。这不是某个参数调错了，是**同一件事被写了四遍**。

#### 职责边界：tracer 只管求交，不管采样

| 归 tracer | 不归 tracer |
|---|---|
| 射线推进、命中判据、bias、出画语义、终止条件 | **方向怎么生成**（余弦重要性 / 均匀半球 / 均匀球面） |
| 命中点坐标、行进距离 | 命中之后取什么值（辐射？只要 0/1？） |
| `max_distance` 的执行 | `max_distance` 取多少、**为什么** |

⚠ 「两个入口」那种写法是错的分解方式：`trace_pixels` 与 `trace_points` 的差别**只在方向
怎么采样**，而采样是调用方的事。把它塞进 tracer 会让每加一个消费者就要给 tracer 加一个入口。

#### API

```python
@dataclass(frozen=True)
class DepthField:
    """被追踪的那个场。一次构造、到处复用，不许每个消费者自己拼。"""
    depth: np.ndarray        # (h,w) float32，q 空间深度
    ppu: float; cx: float; cy: float
    d_min: float             # depth.min()，预算好，终止条件 3 要用

@dataclass
class TraceResult:
    escaped: np.ndarray      # (n,) bool —— True = 一路跑出去了
    hit_yx:  np.ndarray|None # (n,2) int32，命中像素（want_hit=True 时才有）
    t_hit:   np.ndarray|None # (n,) float32，命中处的行进距离

def trace(origins_q: np.ndarray,      # (n,3) q 空间起点
          dirs_q:    np.ndarray,      # (n,3) q 空间方向，单位长
          field:     DepthField,
          *,
          max_distance: float = math.inf,   # ★ 缺省无穷。见下方规矩
          want_hit: bool = False,
          ) -> TraceResult: ...
```

⚠ **`max_distance` 的缺省必须是 `inf`。** 任何有限值都得由调用方**显式传**，
并在调用处的注释里写明「**为什么这个积分本身就是有界的**」。
tracer 自己**不许有任何射程常量**——`MARCH_LENGTH` 这种东西在新 baker 里不存在。

这样「射程」就从"tracer 的一个可调参数"变成了"某个积分的定义的一部分"，
不会再出现「谁也说不清这个 2.4 是干嘛的」。

#### 谁在用它（全表，加消费者就往这加行）

| 消费者 | 起点 | 方向采样 | `max_distance` | `want_hit` |
|---|---|---|---|---|
| 场景 `E` gather | 像素表面 | 余弦重要性，绕 `N` | `inf` | ✔ 取原画辐射 |
| 天穹遮蔽 / `Bdir` / `vis_linear` | **同一趟，同一批光线** | 同上 | `inf` | ✘ 只要 0/1 |
| **场景局部 AO** | 像素表面 | 全球面均匀 | **`AO_RANGE`** | ✘ |
| 实体天穹遮蔽 | 空间格点 | 上半球均匀 | `inf` | ✘ |
| **实体局部 AO** | 空间格点 | 全球面均匀 | **`AO_RANGE`** | ✘ |
| 实体 GI | 空间格点 | 全球面均匀 | `inf` | ✔ |

⚠ 前两行是**同一趟 march**，不要为了「代码干净」拆成两趟——那是 2× 的成本，
而且两趟用的是不同的随机数，遮蔽与辐照度会对不上。

#### 方向采样（在 `sampling.py`，不在 tracer 里）

```python
def cosine_hemisphere(N, spp, rng)        -> ω    # 绕 N，pdf ∝ (N·ω)₊/π
def uniform_upper_hemisphere(spp, rng)    -> ω    # 绕 up，pdf = 1/2π
def uniform_sphere(spp, rng)              -> ω    # 全球面，pdf = 1/4π
```

**余弦重要性**（有法线时用）：`pdf ∝ (N·ω)₊/π` ⇒ 估计量就是样本的**算术平均**，
没有权重表、没有"方位数×仰角节点"这种配比问题。

```
逐像素切线基（世界系，法线为 +Z）：
    up' = |N.y| < 0.9 ? (0,1,0) : (1,0,0)
    TA  = normalize(cross(up', N))
    TB  = cross(N, TA)
每个样本 s ∈ [0, spp)：
    u1 = (s + ξ₁)/spp            分层（ξ 跨样本），逐像素抖动
    u2 = ξ₂
    r  = √u1 ;  φ = 2π·u2
    ω  = TA·(r·cosφ) + TB·(r·sinφ) + N·√(1-u1)
```

**均匀上半球**（空间点没有法线时用；结果要对**任意运行时法线**求值，所以矩必须法线无关）：

```
    μ  = (s + ξ₁)/spp            分层，μ = ω·up ∈ [0,1]，dΩ = dφ·dμ ⇒ 均匀取 μ 即吸收立体角权重
    φ  = 2π·ξ₂
    ω  = (√(1-μ²)·cosφ,  μ,  √(1-μ²)·sinφ)
```

**均匀球面**（AO 用，要绕表面自己的法线积，而法线朝哪都有可能）：`μ ∈ [-1, 1]` 均匀。

#### 终止条件（三个，全精确）

```
1. 命中：  bias < pen < MARCH_THICKNESS          穿透进可见壳
2. 出画：  sx ∉ [0, w-1)  或  sy ∉ [0, h-1)
3. 前穿：  q_z ≤ d_min - 1e-3                    深度跑到全场景最前，再也不可能打中
(+ 调用方给了有限 max_distance 时，t > max_distance 也收工，按"逃逸"算)
```

实测旧法（96 方向均匀求积 + 2.4 截断）的**偏差 0.1346 > MC 16spp 的噪声 0.1120**——
偏差比只打 16 根随机光线的噪声还大。**离线计算没有任何理由默认截断。**

#### 推进循环（伪代码）

```
step = GATHER_STEP_PX / ppu                # GATHER_STEP_PX = 0.5 像素
t = 0
loop:
    t += step
    qx = ox + dx·t ;  qy = oy + dy·t ;  qz = oz + dz·t
    sx = qx·ppu + cx
    sy = cy - qy·ppu
    if sx ∉ [0,w-1) or sy ∉ [0,h-1) or qz ≤ d_min-1e-3:   → 逃逸，取天空辐射，收工
    xi = round(sx) ;  yi = round(sy)
    pen  = qz - depth[yi, xi]
    bias = MARCH_BIAS + MARCH_BIAS_GROWTH · t
    if t > max_distance:                                   → 收工，按"逃逸"算（缺省 inf ⇒ 永不触发）
    if bias < pen < MARCH_THICKNESS:                       → 命中，收工（want_hit 时带回 yi,xi）
```

⚠ **出画语义：钳到边缘继续判，不做任何启发式。** 曾经有个 `inside` 门：射线离开画幅
就默认「未被挡」。户外看不出问题；**室内画幅填满墙面**，射线从侧边出画照样算「看见天」，
本该最暗的墙根 `T₀` 反而最高——实测室内场景 `corr(log 亮度, T₀)` **变成负的**
（梦_里屋 −0.65、义庄 −0.52）。也试过「侧边/底边出画一律当挡住」：室内修好了但户外变差，
开阔处自检从 1.000 掉到 0.94。**一刀切的启发式两头不讨好。**
现在的做法是**没有 `inside` 门**：采样坐标本来就 `clip` 到边界，出画的射线继续拿
边缘那一列/行去判。室内边缘是墙 ⇒ 继续挡；户外顶部是天 ⇒ 顺利通过。**零自由参数。**

⚠ 还否掉过「只有底边算挡」：低仰角、朝相机方向的射线在 45° 伪世界里投影是**向下**的，
从底边出画不代表撞地，那是投影假象。

#### 契约测试（必须有，缺一不可）

1. **单一实现**：全包源码里 `depth[` 的下标访问只允许出现在 `trace.py`。
   静态扫一遍，别处出现就红。这条把「谁又偷偷写了一个 march」变成编译期问题。
2. **起点无关性**：同一批点、同一批**给定**方向，无论走哪条采样路径进来，
   `trace()` 给出的逃逸判定**逐位相同**。这是「角色贴得住背景」的构造性保证，
   不是靠两处代码碰巧写得一样。
3. **`max_distance` 单调性**：`max_distance` 越大，`escaped` 只会越少，不会变多。
4. **`max_distance = inf` 与省略参数** 结果逐位相同。
5. **构造性真值**：把 `depth` 设成一个解析平面 / 半空间，逐方向的逃逸判定
   与解析解一致（这条不依赖任何场景数据，CI 里能跑）。

#### 独立迭代

tracer 之后要动的方向（换 DDA、换保守上界场加速、换成半解析求交……）
全部落在 `trace.py` 内部：只要上面 5 条契约测试还绿，**上层一行都不用改**。
这正是把它拆出来的目的。

### 5.5 场景侧 gather

```
E(x) = ∫ L_in(x,ω)·(N·ω)₊ dω  ÷  ∫ (N·ω)₊ dω

L_in(x,ω) = HDR原画(命中像素)     射线打中表面
          = 天空(ω)               射线逃逸
```

余弦重要性采样下 `E = mean(L_in)`，一行。

**同一趟顺带出三样**（都是同一个积分的不同投影，不要另开一趟 march）：

```
天穹可见度   V(x) = ⟨ esc ∧ (ω·up > 0) ⟩ / cap₀(N)
             cap₀(N) = max( (1 + N·up)/2, 1/255 )
bent 方向    Bdir(x) = normalize( Σ_{esc ∧ ω·up>0} ω )
```

⚠ **分母用解析闭式 `cap₀` 而不是「朝上样本的计数」**：后者在竖直面上只有一半样本，
16 spp 时分母只剩 8，比值噪声翻倍。闭式没有噪声。

⚠ 一根都没逃出去的像素 `Bdir` 未定义 → 退回法线（那儿 `V=0`，方向不参与计算）。

**可见度的线性重建**（`vis_linear`）：定向光要问的是「**这个方向**挡不挡」，
而 `(Bdir, V)` 回答不了——归一化那一步把方向的置信度扔掉了，只剩一个「可见锥」，
而锥对 delta 光源的判据**天生是二值的**。实测 `α−θ` 的 std 有 24.8°，18° 的过渡带
让 **78%** 的像素直接饱和成 0/1，孤立黑点密度在 `V<0.15` 处是 `V>0.6` 处的 **300 倍**。

改成用**同一批光线**做加权最小二乘，把每根光线的「逃逸与否」当观测值：

```
[ Σ1    Σωᵀ  ] [a]   [ Σesc    ]
[ Σω    Σωωᵀ ] [b] = [ Σesc·ω  ]

岭正则：对角线的 (1,1)(2,2)(3,3) 各 += 1e-3·spp
V(ω) = clamp(a + b·ω, 0, 1)
```

四个未知数、每像素一个 4×4、闭式解，**没有任何自由参数**，天生连续。
换掉之后孤立黑点 **0.0000%**，代价是对 `base` 的解释力降约 2 个百分点。

⚠ 出锅后对 `V` / `Bdir` / `E` / `vfit` 各做 `gaussian_filter(σ=0.8)`，`Bdir` 滤完重新归一。

⚠ **命名冲突**：宏观可见度叫 `V(ω)`，而 BRDF 里的几何项也叫 `V`。两者语义无关
（微面自遮蔽 vs 宏观遮蔽）。新 baker 里宏观量一律叫 `macro_vis` / `vis`，
不要在同一个文件里同时出现两个 `V`。

### 5.6 直射光反解

`gather` 出的 `E` **只有间接光**（天空 + 画面反弹）。画里由直射造成的大尺度明暗除不掉、
全留在 `base` 里，重打光时太阳不会跟着动。这一步把它反解出来补进 `E`。

**方向扫描**：仰角 × 方位 = `SUN_SCAN_EL × SUN_SCAN_AZ = 7 × 16`。
**先拟合再比较**，不是纯相关：

```
对每个候选方向 ω_s：
    S = (N·ω_s)₊ · clamp(a + b·ω_s, 0, 1)          用 vis_linear 拿这个方向的遮蔽
    用中位匹配解出一个标量辐亮度 L
    评分 = std( log( hdr / (E_间接 + L·S) ) )       越小越好
取 argmin 的方向与 L
色度：lit / shadow 区域的中位比值，钳到 SUN_CHROMA_CLAMP = [0.78, 1.28]
```

⚠ 色度必须钳。方向不准时逐通道求解会跑到边界（实测某次解出 `[2.49, 0.51, 0.00]`），
钳住让它露出来而不是悄悄污染 `base`。

⚠ **已知问题（待查）**：雾津街头解出来是仰角 **45.0°**、方位 **90.0°**——正好是
扫描网格的正中格，配上 `drop = 0.147`，很像扫描根本没找到偏好、落回了中心。
新 baker 必须在 meta 里记下**扫描的完整评分表**，让这种「落回中心」能被一眼看出来。

```
E = E_间接 + 太阳辐亮度 · (N·ω_s)₊ · clamp(a + b·ω_s, 0, 1)
```

### 5.7 整体增益与 base

```
ratio = max_c( hdr / max(E, 1e-4) )
gather_gain = clip( percentile(ratio, GATHER_GAIN_PERCENTILE), 1.0, GATHER_GAIN_MAX )
E *= gather_gain
```

**为什么有这一步**：`base = L_出射/E` 对朗伯面就是反射率，物理上 ≤ 1。实测 `gain=1` 时
temple 20.1%、mountain_pass 17.0% 的像素超过 1——那不是它们在发光，是 **`E` 被系统性低估**：
伪世界的 gather 没有太阳（被日光直射的岩面收到的光远超天穹 + 周围表面），也没有多次反弹。

`E` 的整体尺度**本来就是自由的**（`E` 放大 k 倍、`base` 缩小 k 倍，`gi=1` 时输出不变），
所以取 `k = p95(hdr/E)` 让 `base` 的 p95 落在 1。

⚠ **代价说清楚**：日照与阴影的**结构**差异因此被留在 `base` 里当「材质」，
重打光时太阳不会跟着动。伪世界没有太阳，这是诚实的边界，不是 bug。

⚠ 实测雾津街头 `gather_gain = 1.0`，**撞了下限，归一化没有生效**（因为 `p95(ratio) < 1`）。
所以那个场景 `p95(base) = 0.9130` 是**自然落点**，不是被摆上去的——而 0.90 正是
真实材质反照率的物理上限。**亮端是准的。**

```
base = hdr_native / E_native                # 纯除法，无钳位、无 emissive
```

⚠ **先量化 E，再据量化后的 E 反推 base**。顺序反过来的话运行时拿到的是量化过的 `E`，
而 `base` 是按精确 `E` 算的，`base·E_q ≠ 原画`——端到端就不再恒等。

⚠ `base` 出**原生分辨率**（它就是背景本体，运行时渲的是 `base × E_目标`，原画不再进渲染路径）。
`E` / 遮蔽 / 法线都是低频量，work 分辨率足够 ⇒ 把 `E` 升采样到原生再除。

⚠ **没有 emissive**。载荷里不存自发光，`base = I/E` 无钳位，`base·E ≡ 原画` 处处成立。
画里的发光体（灶口、灯笼）由作者摆真灯来出；`gi=1` 时它们比原画暗是已知且被接受的代价。
文档里若看到「已有 emissive buffer」，那是过期的，以代码为准。

### 5.8 局部 AO

**短程、全球面**，与天穹遮蔽是**两个不同的问题**：

- `V` 问「你能看见多少天」——室内处处 ≈ 0，**没有信号**
- `AO` 问「你有多封闭」——室内才是它发挥的地方，而多次反弹恰恰是室内唯一的光

⚠ 拿 `V` 当封闭度用，在室内直接失效。这是「一个量当两个用」，v2 犯过、v3 头几版也犯过。

#### 走**同一个 tracer**，一行都不许自己写

```python
ω  = uniform_sphere(spp, rng)                      # 全球面：AO 绕表面自己的法线积，法线朝哪都可能
r  = trace(origins_q, ω_q, field, max_distance=AO_RANGE)      # ★ 就是 trace.py，没有第二份
AO = weighted_mean(r.escaped, w=(N·ω)₊)            # 绕表面自己的法线加权
```

⚠ **`AO_RANGE` 不是「tracer 的截断」，是「AO 这个积分的定义的一部分」。**
两者的区别是实的：

| | 问的问题 | 有没有半径 |
|---|---|---|
| 天穹遮蔽 `V` | 你**能不能看见天** | **没有**。天在无穷远，任何射程都是错的 |
| 局部 AO | 你在**半径 r 之内**有多封闭 | **有，而且 r 就是问题的一部分** |

所以 AO 传一个有限的 `max_distance` 是**正确**的，而天穹遮蔽传任何有限值都是**错**的。
这也正是为什么 `max_distance` 必须是**调用方显式传的参数**、tracer 自己不许有射程常量
（§5.4）——把它做成参数之后，「这个 2.4 是干嘛的」这类问题在结构上就不会再出现。

⚠ 旧实现里 AO 有自己的 `AO_STEPS = 10` —— **删掉**。步长归 tracer 统一管
（`GATHER_STEP_PX = 0.5` 像素）。算一下代价：`step_q = 0.5/ppu = 0.00222`（ppu=225.28），
`AO_RANGE/step_q ≈ **113 步**`，而旧的是 10 步 —— **单根 AO 射线贵 11 倍**。

这个代价**认下**，理由有两条：

1. 10 步走完 0.25 q 意味着每步 **25 px**，和旧天穹 tracer 那 30 px 是同一个量级 ——
   而 §15 已经量出来那个粗步长会**同时**漏掉薄遮挡物、和报出根本没穿过的假命中。
   AO 用 10 步不会比它更可信，只是没人量过。
2. **要提速就去 `trace.py` 里提**（DDA、保守上界场、层级跳步），
   一次改**所有消费者一起受益**。这正是把 tracer 拆成独立组件的回报；
   给 AO 单开一个粗步长是把这个回报提前花掉，换回四份 march 的老问题。

⚠ 但这条要**实测**：P3 收工时记 AO 那一趟的墙钟时间。若它成了整个 bake 的瓶颈，
处理顺序是「先在 tracer 里优化」→ 「再考虑降 AO 的 spp」→ **最后**才轮到动步长，
而动步长必须连带给出「粗到什么程度还不失真」的实测曲线。

⚠ **AO 在收窄后的范围里没有别的合法归宿**：GTAO 论文自己的定义把 AO 限定为
「**均匀**环境光下的遮挡比例」。所以 AO **不该乘直接光**，**也不该乘天光**
（天光的遮挡已经由 `V` 逐方向管了，再乘一次是重复计）。它唯一的消费者是**环境光**
（近场多次反弹）。现在 `ao.png` 挂在默认强度为 0 的 ambient 槽位上等于没启用，
**这是范围收窄的自然结果，不是漏接**。

### 5.9 实体空间数据（`char_volume.bin`）—— 新东西集中在这

#### 为什么不能存标量

场景侧把法线烘进了产物（逐像素法线固定）；角色的法线**逐像素在变**。
喂给它一个标量等于把角色当成一块朝上的板，实测比它真正需要的偏高 **61%**（中位），
而且身上完全没有方向性。

#### 表示

对钳位余弦做 L1 展开 `(N·ω)₊ ≈ ¼ + ½(N·ω)`：

```
M₀ = ∫_{ω·up>0} V(ω) dω        M₁ = ∫_{ω·up>0} V(ω)·ω dω

a₀ = M₀ / 4π = ⟨esc⟩ / 2                       均匀上半球采样 ⇒ M₀ = 2π·⟨esc⟩
a₁ = M₁ / 2π = ⟨esc·ω⟩

T(N)    = a₀ + a₁·N
V(N)    = T(N) / cap₀(N)                        与场景侧**同一个量**
Bdir    = normalize(a₁)
```

**构造性自检**：无遮挡时 `⟨esc⟩ = 1 ⇒ a₀ = 0.5`；`⟨esc·ω⟩ = (0, ½, 0) ⇒ a₁ = (0, ½, 0)`；
`T(up) = 1`。实测 `a₀ = 0.5000`、`T(up) = 1.0001`。

⚠ 无遮挡时 L1 展开**不是近似、是精确**：朝上 1.0、45° 0.854、竖直 0.5，逐个命中
解析真值 `(1+cos β)/2`——因为那个式子本身就是 L1 形式。遮蔽越各向异性，截断误差才出现。

#### 格密度：按**角色高度**定，不按场景尺寸定

要表达的结构（门洞、柱子、檐下、墙沿）是相对角色的，不是相对画幅的。

```
cell_xz = char_wu / CELLS_PER_CHAR_XZ
cell_y  = char_wu / CELLS_PER_CHAR_Y            # 纵向更密：V 沿高度变化比沿水平快
nx = round(span_x / cell_xz) ; nz = round(span_z / cell_xz) ; ny = round(span_y / cell_y)
若 nx·ny·nz > MAX_CELLS → 三维等比降密度（乘 (MAX/total)^(1/3)）
```

**网格范围**：

```
x0,x1 = percentile(world.x, [1, 99])
z0,z1 = percentile(world.z, [1, 99])
y0    = percentile(world.y, 2) - 0.02
y1    = max( percentile(world.y, 60) + band,  y0 + band·1.5 )
```

⚠ `y` 要覆盖「最低地面 → 较高地面 + 角色带」。地面起伏常常比角色还高，
不一并覆盖的话远处地面上的角色会落到网格外被钳到边界层。

**密度实测**（雾津街头，基准 = 逐点 MC 128 spp，评估在**角色头高**）：

| 每角色高 | 网格 | 格数 | \|Δ\|中位 | **深遮蔽偏差** | 天穹通道 |
|---|---|---|---|---|---|
| 现状（旧 tracer, 32×14×24） | — | 11k | 0.0767 | **+0.4946** | 0.04 MB |
| 1 | 26×9×24 | 5.6k | 0.0797 | +0.2253 | 0.02 MB |
| 2 | 52×18×48 | 45k | 0.0572 | +0.1047 | 0.18 MB |
| **3（选它）** | **78×27×71** | **150k** | **0.0480** | **+0.0555** | **0.60 MB** |
| 4 | 104×36×95 | 356k | 0.0416 | +0.0252 | 1.42 MB |

选 3：3→4 只再降 0.03，载荷却翻 2.4 倍。5 通道全量在密度 3 是 **3.0 MB**，
相对现有 ~10 MB 的载荷（`base.png` 一个就 5 MB）是可承受的比例。

#### validity + dilation（**必做，不是可选**）

新 tracer 对被埋格点给的是**精确的 0**（物理上对），而 41.6% 的格点是被埋的。
三线性会借到这些 0，把贴墙的角色压暗——实测新体数据在表面偏 **−0.0755** 就是这个。

```
pen₀    = q_z(格点) - depth[格点投影像素]
invalid = pen₀ > MARCH_BIAS                       # 埋在可见壳后面
dilation：反复用 6-邻域**有效**格点的均值填 invalid，
          直到没有 invalid 与 valid 相邻（或达到迭代上限）
meta 记 validity 覆盖率；低于阈值报警
```

这是 AAA 探针体系的标准手段（Unity Probe Volume 的 Virtual Offset / Dilation、
UE 的 validity）。**不做就是把「精确的 0」直接漏进画面。**

#### 通道与打包

| 通道 | 内容 | 编码 |
|---|---|---|
| 0 | 天穹遮蔽 `(a₀, a₁)` | `R = a₀`，`GBA = a₁·0.5 + 0.5` |
| 1 | 局部 AO `(a₀, a₁)` | 同上 |
| 2..4 | 烘焙 GI 的 RGB `(a₀, a₁)` | `R = log2 编码的 a₀`；`GBA = a₁/(4a₀) + 0.5` |

GI 解码：`a₀ = decode_log(R)`，`a₁ = (GBA·2 - 1)·2·a₀`，`E(N) = a₀ + a₁·N`。

⚠ GI 通道换一套编码是因为它是 HDR（灶口旁边到几十），用全局 scale 线性存会把典型值
压到十几个量化档（实测 teahouse `scale=19.2`、典型 0.87 ⇒ **12 档**）。
幅度走**对数**，跨度按数据定（固定 16 档时灯边上的格点最高 4.87% 撞顶）。

⚠ **GI 通道不是可选项**（除非 `--no-gi`）。场景侧默认 `gi = 1`（画面 ≡ 原画），
角色若拿不到同一份辐照度就只剩天光和灯——而未重打光的场景那两项都是 0，角色于是**全黑**。
v2 那个 `placeholder` 开关造成过这个症状（27 个场景角色零响应）。

⚠ **辐射场要和场景侧同一个尺度**：场景那边是 `E · gather_gain`，所以喂进体数据的辐射
也要整体乘 `gain`。只乘天空不乘原画会让角色与背景差一个 `gain` 倍，而 `gain` 逐场景不同
（实测 1–12），症状是「角色在有些场景偏亮、有些偏暗」，**极难查**。

⚠ 打包后必须做**编解码自检**：GI 通道的编码与其余通道不同，两边任一处漂了都不会报错，
只是角色亮度整体偏掉。指标用**软化的相对误差** `|err| / (|ref| + typ)`（`typ = median|ref|`）——
纯相对误差被暗格点主导（sRGB 近 0 处每档就是 6–18%），纯绝对误差被亮格点主导
（实测 temple 报出 2134%）。

#### 布局

Z 切片横向平铺，列 = `x + z·nx`。运行时三线性，与 `ucSkyAt` 逐字同一套（clamp 到边界）。

### 5.10 编码

```
pick_log_params(x, one_sided):
    pos  = x[x > 0]
    hi   = 1.0 if one_sided else max(pos)
    lo   = percentile(pos, HDR_LOG_FLOOR_PCT)
    lo   = clamp(lo, hi·2^(-HDR_LOG_SPAN_MAX), hi)
    span = clip( ceil(log2(hi/lo)), HDR_LOG_SPAN_MIN, HDR_LOG_SPAN_MAX )
    scale= hi·2^(-span/2)  if one_sided  else  sqrt(lo·hi)

encode_log_hdr(x, scale, span) = round( clip( log2(max(x,1e-30)/scale)/span + 0.5, 0, 1 ) · 255 )
decode_log_hdr(u8, scale, span)= scale · 2^( (u8/255 - 0.5)·span )
decode_base(u8, ...)           = decode_log_hdr(...) · (u8 > 0)     # 字节 0 = 精确 0
```

`one_sided=True` 用于 `base`：它有物理上界 1，把 1.0 钉在量程上端、往下覆盖到数据下界。

⚠ **`base` 的字节 0 必须表示精确的 0，不是编码下限。** `base` 的下端会真的撞到下限：
极亮场景 `E` 到 1000 量级，而近黑像素的 `hdr/E` 能小到 5e-6。把它们抬到下限之后
`base·E` 已经**超过**原画，画面上就是一片本该全黑的地方发灰
（实测梦_醒来土路 往返 p99 **12.1/255**，误差 99 分位像素的 `base` 恰好是编码下限）。

**GLSL 侧解码**（`shadeCore3.glsl`，`px` 已归一到 `[0,1]`）：

```glsl
vec3 sc3DecodeLogHdr(vec3 px, float scale, float span) { return scale * exp2((px - 0.5) * span); }
vec3 sc3ToHdr  (vec3 y) { return y / max(vec3(1.0) - y, vec3(1.0/200.0)); }
vec3 sc3FromHdr(vec3 x) { return x / (vec3(1.0) + x); }
```

---

## 6. 运行时契约（产物怎么被消费）

### 6.1 着色式（收窄后）

```
out      = base · E_目标 + 灯体自发光
E_目标   = gi·E_烘焙 + E_天光 + E_环境 + E_太阳 + E_灯

E_天光   = SkySH( normalize(mix(Bdir, N, w)) ) · V ,     w = 1 - (1-V)²
E_环境   = 环境色·强度·clamp(0.28 + 0.72·AO, 0, 1.2)
E_太阳   = 日色·强度·(N·ω_s)₊·clamp(a + b·ω_s, 0, 1)
```

场景与实体在 `sc3Shade` 会合，两侧**只差 G-buffer 怎么填**。
收窄后无阴影 / 无镜面 / 无 GI 弹射 ⇒ 解析光不带任何遮挡项。

### 6.2 天光公式的出处（已核实）

`w = 1-(1-V)²`、`n = lerp(Bdir, N, w)`、`E = SkySH(n)·V·G` 逐字出自 UE 的
**`BasePassPixelShader.usf::GetSkyLighting`**（362 / 368 / 381 行）。

⚠ **我们代码注释里写的 `SkyLighting.usf` 是错的**——那条路（Movable Sky Light,
`SkyLightDiffusePS`）用的是**线性权重 `w = V`**。UE 自己这两条路互相矛盾。
⚠ **我们漏了 UE 原式里的 `G` 项**，是什么、漏掉的后果多大，待查。

⚠ UE 保证静态表面与动态物体天光一致，靠的是**共享同一份全局 SH-L2**，
**不是**统一遮蔽混合公式。所以我们的架构方向是对的，全部负担在「两个遮蔽来源算出同一个数」。

---

## 7. 程序性天空

### 7.1 为什么不要真大气模型

**我们从来不渲染天空本身**——画面被原画铺满，天在画外。天空只以一份 SH-L2 存在，
而 L2 能被看见的只有三样：

| 阶 | 装的是什么 | 画面上表现为 |
|---|---|---|
| l=0（1 个数） | 天空总亮度 | 整体明暗 |
| l=1（3 个数） | 天光的**净方向** | 明暗往哪边偏 —— **时刻感的本体** |
| l=2（5 个数） | 一点形状 | 天顶/地平的软对比 |

Hosek–Wilkie 那类模型的价值是把**天空的样子**算对，而那部分信息在投影到 L2 的那一步
就全丢了。要的不是物理，是**能直接操纵 l=0 / l=1 的、每个旋钮都看得见的剖面**。

### 7.2 剖面

```
上半球  μ = ω·up ≥ 0:
    L(ω) = 天顶色 · μ^profile
         + 地平色 · horizonGain · (1-μ)^horizonSharp
         + 辉光色 · glowGain    · max(ω·s, 0)^glowTight        s = 太阳方向
下半球  μ < 0:
    L(ω) = 地面色 · groundGain
```

四个分量各自带颜色，gain 全部以「天顶剖面 = 1」为标度。
**三个 gain 全为 0 时逐位回到旧行为**（28 个场景一个字不用改）。

### 7.3 投影

```
c_k = Σ_{全球面求积} L(ω)·Y_k(ω) · dΩ · Â_{l(k)}
dΩ  = (2/N_ELEV)·(2π/N_AZIM)          μ ∈ [-1, 1] 均匀，φ 均匀
Â   = [π, 2π/3, π/4]                  Ramamoorthi–Hanrahan 卷积系数，l=0,1,2
```

基函数顺序（与 `sc3SkyShIrradiance` 逐行对应）：

```
[ 0.2820948,
  0.4886025·y,  0.4886025·z,  0.4886025·x,
  1.0925484·x·y, 1.0925484·y·z, 0.3153916·(3z²-1), 1.0925484·x·z, 0.5462742·(x²-y²) ]
```

**归一**：天顶剖面单独归一到 `E(up) = 1`，其余分量以那个因子为标度。
这样作者面的 `sky.intensity` 语义一个字没变。

⚠ **上半球的求积节点必须与旧版逐位相同**，否则 28 个场景会漂：
`N_ELEV = 128` 全球面时，`μ = -1 + 2(i+0.5)/128` 在 `i = 64..127` 上正好等于
旧版上半球 `N_ELEV = 64` 的 `μ = (i+0.5)/64`，`dΩ` 也相同。**已验证。**

⚠ L2 截断对**很窄的瓣**表达不全：`profile = 4` 时无遮挡传输与解析真值的最大偏差
实测 **0.028**；`profile ≤ 2` 时 ≤ 0.011。这不是能调好的参数，是 L2 的能力上限。

### 7.4 效果实测

| | 朝西 | 朝东 | 比值 | 朝下 |
|---|---|---|---|---|
| 旧模型 profile=1 | 0.3189 | 0.3189 | **1.000**（绕 up 旋转对称，数学必然） | 0.0000 |
| 新·黄昏 | 1.6446 | 0.6522 | **2.52** | 0.2801 |

黄昏朝西色度 `[2.02, 0.72, 0.26]`，朝东 `[1.54, 0.83, 0.63]`。

### 7.5 给美术的话术

**别给四个独立滑杆，给一个「时刻」**，其余全部派生。

| 名字 | 管什么 |
|---|---|
| `horizonGain` / `horizonSharp` | 地平线那圈有多亮、多窄。抬 gain 把 l=1 压低（光更多从侧面来）；阴天把 sharp 调小让它糊开 |
| `glowGain` / `glowTight` | **黄昏的灵魂**。把 l=1 拉向太阳方位，一侧暖亮一侧冷暗 |
| `groundGain` | 朝下的面（下巴、屋檐内侧、裙摆）从地面收到多少反弹。0 = 死黑（旧行为） |

物理锚点（**不追求精确，只要比例对**）：

| | 照度 lx | 色温 K |
|---|---|---|
| 正午直射太阳 | 100,000 | 5,500 |
| 晴天天光（不含太阳） | 10,000–20,000 | ~10,000 |
| 阴天（全散射） | 1,000–25,000 | 6,500–7,500 |
| 日出 / 日落 | ~400 | 2,000–3,000 |
| 满月 | 0.05–0.3 | 物理上 ≈ 日光 |

三条必须纠正的直觉：

1. **阴天不是「太阳调弱」，是太阳 = 0、全部变天光。** 晴天 太阳:天光 ≈ 5:1 ~ 10:1。
2. **月光物理上是日光色。** 夜晚要蓝应该走**显示变换/分级**；填在光源色温上会让**所有材质的色度一起错**。
3. **色温和强度不独立。** 黄昏变暖和变暗是同一个原因（大气路径变长）。

**工作流顺序**：先锁曝光 → 只动「时刻」→ 需要更冷/更闷才动 turbidity 与地面反照率 →
**解析光最后加**，只讲叙事重点（灶口、灯笼、窗），**不要用它救氛围**。

---

## 8. 模块划分

```
tools/lightbake/
    __init__.py
    __main__.py     CLI（§12）
    input.py        场景 → (深度, 原画, R/ppu/cx/cy, world, normal, char_wu, band)
                    ★ 唯一的外部依赖面。不许别的模块直接碰 tools/scene_relight
    trace.py        ★★ 独立通用组件：DepthField / trace() / TraceResult
                    只管求交，不管采样、不管命中后取什么值。
                    **全包唯一允许出现 depth[...] 下标访问的地方**（§5.4 契约测试 1）
    sampling.py     方向采样：cosine_hemisphere / uniform_upper_hemisphere / uniform_sphere
                    ★ 与 trace 分开：加消费者时加采样器，不动 tracer
    gather.py       E / base / Bdir / V / vis_linear / 局部 AO / 直接光反解 / gather_gain
    volume.py       实体空间数据：天穹 / AO / GI 三类通道、密度、validity、dilation、打包
    sky.py          程序性天空的 CPU 镜像（与 src/rendering/lighting/skySh.ts 同式）
    encode.py       三条编码曲线 + 往返自检
    payload.py      原子写 + meta.json + PAYLOAD_VERSION
    check.py        自检断言（§10）
    report.py       自包含 HTML 预览（§11）
    tests/
```

**签名草案**：

```python
# input.py
@dataclass
class SceneInput:
    sid: str
    native: tuple[int, int]
    work: tuple[int, int]
    bg_srgb: np.ndarray        # (h,w,3) 原生分辨率
    depth: np.ndarray          # (h,w) work
    world: np.ndarray          # (h,w,3) work
    normal: np.ndarray         # (h,w,3) work，全值域世界法线，edge-safe
    q: np.ndarray              # (h,w,3) work
    R: np.ndarray; ppu: float; cx: float; cy: float
    char_wu: float; band: float; scene_per_wu: float
def load(sid: str, work_w: int = 1024) -> SceneInput: ...

# trace.py —— 独立组件，签名见 §5.4
def trace(origins_q, dirs_q, field, *, max_distance=math.inf, want_hit=False) -> TraceResult: ...

# sampling.py
def cosine_hemisphere(N, spp, rng) -> np.ndarray: ...        # (n,spp,3) 或逐 spp 生成
def uniform_upper_hemisphere(n, spp, rng) -> np.ndarray: ...
def uniform_sphere(n, spp, rng) -> np.ndarray: ...

# gather.py / volume.py 里的消费者一律长这样，没有第二种形态：
#     ω = <某个采样器>(...)
#     r = trace(origins_q, ω @ R, field, max_distance=<inf 或有理由的有限值>, want_hit=<要不要辐射>)
#     <把 r.escaped / r.hit_yx 归约成自己要的量>
```

---

## 9. 常量表

| 常量 | 值 | 依据 |
|---|---|---|
| `WORK_W` | 1024 | 遮蔽/E/法线是低频量，够用 |
| `GATHER_SPP` | 16 | 实测偏差 0.1120 < 旧法偏差 0.1346 |
| `GATHER_STEP_PX` | 0.5 | 亚像素，避免跨过薄壳 |
| `GATHER_SEED` | 20260823 | 固定种子，产物必须字节可复现 |
| `MARCH_BIAS` | 0.025 | 自遮挡护栏 |
| `MARCH_BIAS_GROWTH` | 0.015 | 随距离放宽 |
| `MARCH_THICKNESS` | 0.75 | 可见壳厚度 |
| `HDR_MAX` | 200 | 逆 Reinhard 的分母下限 |
| `HDR_LOG_SPAN_MIN / MAX` | 8 / 24 | 编码跨度的钳位 |
| `HDR_LOG_FLOOR_PCT` | 0.1 | 编码下界取样分位 |
| `HAZE_KEEP` | 0.1 | 去霾按自身留下限，保色度 |
| `GATHER_GAIN_PERCENTILE` | 95 | 让 `base` 的 p95 落在 1 |
| `GATHER_GAIN_MAX` | 12 | 日照/天光 ≈ 5–10 倍，12 是宽松但有界的天花板 |
| `SUN_SCAN_EL × AZ` | 7 × 16 | |
| `SUN_CHROMA_CLAMP` | [0.78, 1.28] | 防止逐通道解跑到边界 |
| `AO_RANGE` | 0.25 | AO 问的就是「半径 r 内有多封闭」，**r 是问题的一部分**，不是 tracer 截断。以 `max_distance` 显式传给 `trace()`。⚠ 旧的 `AO_STEPS = 10` **删掉**，步长归 tracer 统一管 |
| `CHAR_VOL_SPP` | 64 | 均匀采样收敛比余弦重要性慢 |
| `CELLS_PER_CHAR_XZ / _Y` | 3 / 6 | §5.9 的密度扫描 |
| `CHAR_VOL_MAX_CELLS` | 200,000 | 载荷上限 |
| `PAYLOAD_VERSION` | 6 | 三处同时改，测试钉死 |

---

## 10. 自检（`check.py`，`bake` 结束必跑，红就非零退出）

| # | 检查 | 阈值 |
|---|---|---|
| 1 | 无遮挡格点 `a₀` | `0.5 ± 1e-3` |
| 2 | 无遮挡格点 `T(up)` | `1.0 ± 2e-3` |
| 3 | 往返 `from_hdr(base_q · E_q)` vs 原画 | p99 ≤ 2/255 |
| 4 | **tracer 单一实现**：全包 `depth[...]` 下标只出现在 `trace.py` | 静态扫描，别处出现即红 |
| 4b | tracer 的 5 条契约（起点无关 / `max_distance` 单调 / `inf` 等价 / 解析真值） | 见 §5.4 |
| 4c | **每个消费者的 `max_distance`** | 要么是 `inf`，要么在调用处有注释说明「这个积分为什么有界」 |
| 5 | 体数据在表面 vs `sky_occlusion.png` | 偏差中位、**深遮蔽偏差 ≤ 0.06** |
| 6 | validity 覆盖率 | 报警阈值待定 |
| 7 | 三条编码曲线各自往返 | p99 ≤ 1/255（可见性量）/ 2/255（HDR 量） |
| 8 | 字节可复现 | 同参数两次跑出同样字节 |
| 9 | GI 通道编解码 | 软化相对误差 p99 |
| 10 | 天空 SH：三个 gain 全 0 时 | 与旧路**逐位相同** |
| 11 | `base` 残留相关 | 对 `V` / `AO` / `log E` 的 \|corr\| 显著非零就报警（见 §15） |

⚠ **`base·E ≡ 原画` 恒真是零信息量的**——它是乘性歧义本身的复述，对**任何**正的 `E` 都成立。
它只能当**非回归护栏**（数值链路无溢出、无双 gamma、无通道错位），
**不能**当「`E` 对」的证据。真正的判据是 #11 的残留相关，以及**换光重渲染**。

---

## 11. 预览 —— 这条直接回答「没有浏览器 cache」

`preview/report.html`：**单文件，所有图 base64 内联成 `data:` URI，零外部请求。**
浏览器没有可缓存的对象，文件变了内容就变了，**结构上不可能看到旧图**。

面板：

1. 每张产物 + 分位统计 + 越界比例
2. `原画 / E / base` 三联 + `base·E − 原画` 误差图
3. 遮蔽：`V`、`Bdir`、`vis_linear` 重建 vs 直接积分的差图
4. 实体体数据：若干高度的水平切片 + 与场景表面的一致性图 + **validity 图**
5. 程序性天空：天穹辐亮度球、9 个 SH 系数、若干法线方向的辐照度、朝西/朝东比值
6. 直射光扫描的**完整评分表**（用于看出「落回中心」）
7. 自检表（绿/红）

`--serve` 可选，只是把这个文件用 `Cache-Control: no-store` 吐出去，**不是另一套渲染**。

---

## 12. CLI

```bash
sh scripts/py.sh -m tools.lightbake bake --scene 雾津街头
```

```
bake   --scene X | --all   [--spp 16] [--vol-density 3] [--no-gi] [--sky <json|path>]
check  --scene X                    只跑自检，不写盘
report --scene X [--open]           只出预览
diff   --scene X --against DIR      两次产物逐项对比
```

`bake` 结束自动出 report。

---

## 13. 施工顺序（交付是全量，这只是先后）

| | 内容 | 完成判据 |
|---|---|---|
| P1 | `input` + **`trace`（独立组件）** + `sampling` + 契约测试 | 自检 #1 #2 **#4 #4b #4c** 绿。⚠ **P1 结束时 `trace.py` 就要是完成态**：后面 P2/P3 只准调它，不准改它的判据。真要改，改完必须重跑 P2/P3 的全部数值判据 |
| P2 | `gather`（E/base/occ/vis_linear/**局部 AO**/直接光）+ `encode` | 自检 #3 #7 #8 绿；与现有 v5 产物逐项比对，**每处差异都要能解释**。AO 走 `trace(max_distance=AO_RANGE)`，与天穹遮蔽同一条判据 |
| P3 | `volume`（天穹 + AO + GI）+ validity/dilation | 自检 #5 #6 #9 绿；深遮蔽偏差 ≤ 0.06；贴墙不再压暗。**记 AO 那一趟的墙钟时间**（§5.8 的代价条） |
| P4 | `report` | §11 全部面板 |
| P5 | `sky` | 自检 #10 绿；与 `skySh.ts` 逐系数对齐 |
| P6 | `diff` + 全场景重烘 + 运行时接 v6 | 28/28 装载成功 |

---

## 14. 已知陷阱（都真的踩过）

| 坑 | 症状 | 对策 |
|---|---|---|
| **`pathlib.write_text` 在 Windows 写 CRLF** | 对 `.md` 无害（`.gitattributes` 是 `text=auto eol=lf`，入库归一、检出 CRLF，全仓库如此）；**但对被 `?raw` 导入做逐行断言的源码文件是真炸** —— `git diff` 看不见，断言莫名失配 | 写**源码**一律 `newline='\n'`；写文档随仓库 |
| **GBK 控制台** | 中文 `print` 直接 `UnicodeEncodeError` 崩掉 | `PYTHONIOENCODING=utf-8`；日志写文件不写 stdout |
| **`python` 是 Python 2** | `io.open(..., encoding=)` 报 TypeError | 一律走 `sh scripts/py.sh` |
| **GLSL 模板字符串里的反引号** | 打包期炸 | `glslTemplateLint.test.ts` 的文件清单要跟着新文件更新 |
| **`TaskStop` 留下 python 子进程** | 「已停止」但还在跑，两个进程并发写同一批产物且都合法 | 停完确认进程真没了 |
| **载荷版本三处漂移** | 验证器停在旧版 / 运行时静默回落 | `test_payload_version.py` 钉死三处 |
| **`extract.pixels` 读不了浮点 RT** | 恒全 0 且不报错，两次险些误判「这一级没在跑」 | 用别的通道取证 |
| **`switchScene` 静默 no-op** | 场景切不过去 | 用 `loadScene` |
| **RAF 在隐藏标签页被节流** | 调试截图字节完全相同 | 显式 `markDirty()` + `update()` |
| **拟合代替物理推导** | 指标好看但机制是错的 | 中间量不许借用物理量的名字；先推导再拟合 |

⚠ 还有一条**现存缺陷**待清：`src/rendering/lighting/RawPatchRelightFilter.ts:157` 引用了
两个已随自发光删除、且**未声明**的 uniform（`uEmissiveTex` / `uBakedEmissive`），
GLSL ES 3.00 下编译失败——这个滤镜大概率一帧都没正常画出来过。
而 `src/rendering/lighting/gatherPipeline.test.ts:202` 还在断言它必须 `toContain` 这个坏形态。

---

## 15. 实测基线数字（雾津街头，v5 载荷）

复现脚本在会话 scratchpad：`cmp_tracers.py` / `measure_base.py` / `decorr.py` /
`freq.py` / `vol_compare.py` / `res_sweep.py` / `old_tracer.py`。

### `base` 的分布

| | 值 |
|---|---|
| p95 | **0.9130**（物理反照率上限 0.90 ⇒ **亮端准**） |
| p50 / p1 | 0.0681 / 0.00072 |
| `< 0.03` 比例 | **36.4%**（比沥青还黑 ⇒ 暗端塌） |
| `std(log2)` | **2.736 档**（合理 albedo 约 1.30 档 ⇒ 宽 2.1 倍） |
| `gather_gain` | **1.0（撞下限，未生效）** |

### `base` 的残留相关（`E` 若对应为 0）

```
depth  +0.205    ← 最大：大气透视漏进来
N·y    +0.197    ← 只解出一盏太阳的方向性残差
N·x    -0.116
V      -0.079    ← 基本除干净
AO     -0.014    ← 完全除干净
log E  +0.034    ← 无全局乘性泄漏
```

频率拆分：128 px 尺度低频只占 **13.3%** 方差（σ_low = 1.0 档）
⇒ `base` 的方差主体是高频纹理，**正是 albedo 该有的样子**。

### 旧 tracer 为什么「看着好」

参数：步长 **30.0 px**（新 MC 0.5 px，粗 60 倍）；射程 541 px（画幅 1024，覆盖 53%）；
命中判据 `bias < pen < 0.75 q` 是一层**壳**，**深过壳算作没挡**。

| 格点在哪 | 占比 | 旧 T | 新 T | 差 |
|---|---|---|---|---|
| 空气里 | 58.3% | 0.8073 | 0.9024 | **−0.095 偏暗** |
| 壳内 | 34.6% | 0.1686 | 0.0000 | +0.169 偏亮 |
| 墙肚子里 | 7.0% | 0.1805 | 0.0000 | +0.181 偏亮 |

埋在墙里的格点朝正上打射线，旧法判「看得见天」的比例 **43.2%**。

三线性在表面同时借空气格点和被埋格点，两个反向错误抵消 ⇒ 表面 |Δ|中位 0.0575 看着最好；
到角色头高抵消没了 ⇒ 深遮蔽偏 **+0.4946**，p90 **0.6125 全场最差**。
**中位好看 + p90 崩掉 = 靠抵消不是靠算对的指纹。**

### 头高处各方法的深遮蔽偏差

| 方法 | 偏差中位 |
|---|---|
| 现状（旧 tracer + 32×14×24） | **+0.4946** |
| 直接复用表面 2D 图 | +0.3647 |
| 只换 tracer（保持 32×14×24） | +0.2050 |
| 「表面图 × 体数据比值」 | +0.0428 |
| **新 tracer + 密度 3** | **+0.0555** |
| 新 tracer + 密度 4 | +0.0252 |

⚠ **「表面图 × 体数据比值」这条路是错的**，不要复活：2D 图是表面切片，
头顶那点空间的遮蔽与脚下地面的遮蔽**没有可推导关系**（人站在檐下，脚被挡、头可能在檐外）。
它数字上比现状好，只是因为现状太差；比直接产空间数据差，且多依赖一张图。

### 天光两项的表达力上限

`runtime_fit = { sky: 0.907, ambient: 0.0059, rel_err: 0.517 }`
—— 两项加起来只解释 `E` 的 **48%**，`ambient` 解出来基本是 0。
**美术调这两个旋钮够不到目标音**，不是没调好，是基不够（旧天空绕 up 旋转对称、
只有上半球、整个天空一个颜色）。

### 色彩管线

- 29/29 场景都是 `tonemap: reinhard`，**零个 `none`**
- 28/29 场景四个分级算子全恒等（`whiteKelvin=6500` 即 `(1,1,1)`）⇒ 顺序前移是 no-op
- **例外只有雾津街头**：`whiteKelvin=7200 / contrast=0.70 / saturation=0.85 / lift=0.02`
  —— 而它是**唯一跑在 v5 上的场景**
- 白平衡是逐通道对角乘，不是 CAT，饱和色误差 22%–41%
- `ev` 是裸 `exp2(ev)` 档位倍率，不是 EV100

### 载荷现状

28 个场景：**26×v2、1×v4、1×v5（只有雾津街头）**，其余在版本闸处被整包拒绝、
回落成普通 Sprite 背景。**也就是说这套管线目前只在 1/28 的场景上真正跑着。**
