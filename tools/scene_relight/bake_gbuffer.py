"""G-buffer 烘焙 —— 伪世界 final gather 出辐照度 `E`，再把原画拆成基底 + 自发光。

## 这是什么（先把它跟"反解 albedo"划清界限）

整条重打光是一个**比例式**，不是物理反演：

```
I_out = I_原画 × E_目标 / E
base := I_原画 / E            ← 本模块的产物之一
```

`base` 是**比例基底**，一个工程中间量。数值上它落在反射率的量级（因为 `E` 是
真的辐照度），但它**不是**"解出来的材质"，也不该叫 albedo —— 叫 albedo 会带来
"我们反演出了物理量"的错误预期。

## `E` 怎么来的：伪世界 final gather

    E(x) = ∫ L_in(x,ω)·max(N·ω,0) dω  ÷  ∫ max(N·ω,0) dω

    L_in(x,ω) = HDR(原画) @ 命中点     射线在伪世界深度里打到表面
              = 天空辐射              射线逃逸

**画本身就是辐射缓存** —— 一张画画的就是"每个表面朝相机发出多少光"，这正是
final gather 需要的输入。所以这一步：

- **没有拟合系数**，没有判据，没有网格搜索；
- **不需要检测画里的灯**：灶口的 HDR 辐射本来就高，附近地面在积分里自然被照亮；
- **天穹遮蔽是顺带出的**（同一趟 march 里"朝上且逃逸"的加权占比），不是另算的。

⚠ 上一版走的是另一条路：把 `E_est` 拟合成 `flat + sky·T₀ + ao·AO + src·S_local`，
四个系数在单纯形上搜索。那条路错在方向上 —— `S_local`（从原画自己检测的亮斑）
对任何图都近乎自解释，在拟合里**永远压过 `sky`**，28 个场景里 23 个天穹系数被挤到
0，连画里根本没有灯的山口都拿到 0.75 的权重。而残留指标全程漂亮（0.06–0.23）。
**分数低不等于机制分对了。**

## 反射 / 自发光的拆分是**定义**

表面反射不可能超过它收到的光，超出的那部分按定义是自发光：

```
base     = min(I / E, 1)
恒等:  base·E ≡ min(I, E)             ← 烘焙期断言，未被钳住的像素往返 ≤ 1.1/255
```

画里"发出的比收到的多"的像素（灶口、灯笼、天）被上限钳住，**载荷不替它记账** ——
它们在 `gi=1` 时会比原画暗，由作者在那儿摆真灯（制作人：「光都是单独打」）。
不需要阈值，也不会把水面高光误当光源。

## 唯一的建模假设

8-bit 原画的高光是被压过的（灶口和白墙线性化后都贴在 1.0 附近，真实辐射差两个
数量级）。本模块假设它按 Reinhard `y = x/(1+x)` 压过，逆映射展开回 HDR。
其余全是积分。

## 与 tmp/relight_ratio_experiment 的关系

算法骨架取自那个实验；两处刻意不同：

- **深度用工程自己的** `depthConfig` / `raw_depth_rg.png`，不跑 Depth Anything。
  那个实验刻意不接工程才自己推理深度；我们的深度是作者标定的，还要跟碰撞、
  脚点、影子对齐，换一份就全错位。
- **`E` 是 gather 积出来的**，不是 `0.16·AO项 + 0.58·T₀ + 0.42·T₁` 那组固定系数。
  实验那组常数是对一张图调的；本工程 28 张原画从正午码头到墓穴内景都有，
  一组常数盖不住 —— 而 gather 对两类画是同一个式子，不需要给场景标类型。

产物落 `runtime/scenes/<id>/lighting3/`。
"""
from __future__ import annotations

import argparse
import io
import json
import math
import os
import sys
from pathlib import Path

import numpy as np
from PIL import Image
from scipy.ndimage import gaussian_filter

_ROOT = Path(__file__).resolve().parents[2]
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

from tools.atomic_io import retry_transient                       # noqa: E402

from .geometry import (Scene, linear_to_srgb, resize_f, resize_rgb,  # noqa: E402
                       srgb_to_linear)

#: 载荷代次。**改产物布局必须 +1**，并同步 `SceneLightingSystem.LIGHTING3_VERSION`
#: 与 `validator._LIGHTING3_VERSION`。
#:
#: 2 (2026-08-23)：`albedo.png` → `base.png`；新增 `irradiance.png` / `emissive.png`（4 已删）；
#:   角色网格 5 → 8 通道（+GI 的 RGB）。⚠ 最后这条是**静默**的：旧网格声明 5 通道、
#:   文件大小也自洽，校验器查不出来，而运行时去取第 5..7 通道会拿到 0 ⇒ 角色全黑。
#:   代次闸就是为这种"格式变了但看着仍然合法"的情况存在的。
#:
#: ⚠ **不是**所有改动都要 +1。同一天改的 `TRANSPORT_MAX`（1.8→1.0）与求积密度
#:   （48→96 方向）就没有：前者逐场景写在 meta 里、新旧载荷各自自洽，后者只影响数值。
#:   判据是"旧消费端读新文件会不会静默读错"，不是"数值变没变"。
#:
#: 5 (2026-08-23)：E 补上**直射光**（gather 只有间接光，画里的大尺度明暗因此
#:   全留在 base 里）。新增 `vis_linear.png`：可见度对方向的线性重建，
#:   任意方向的遮蔽都用它，运行时换太阳方向不用重烘。meta 新增 `direct_light`。
#:
#: 4 (2026-08-23)：**删掉 `emissive.png`**。制作人：「现在不需要任何的自发光了，
#:   光都是单独打」。于是恒等式从 `base·E + emissive ≡ I` 变成 `base·E ≡ min(I,E)`：
#:   画里发出的比收到的多的像素（灶口、灯笼、天）在 gi=1 时会比原画暗，
#:   由作者在那儿摆真灯。载荷少一张原生分辨率的 RGB 图。
#:
#: 3 (2026-08-23)：`transport.png`（4 个纬向通道）→ `sky_occlusion.png`
#:   （RGB = bent 方向，A = 余弦加权可见度）；角色网格 8 → **5** 通道。
#:   起因是同一个天穹遮蔽被存了**两种参数化**（场景 4 通道精确求积 / 角色 4 通道
#:   SH-L1），实测在角色典型法线处两边差 10%–15%、竖直面差一倍。
#:   现在两侧存同一个 (bent 方向, 可见度)、进同一个 `sc3SkyIrradiance`，
#:   天空改成运行时全局 SH —— 与 UE `SkyLighting.usf` 同一套。
PAYLOAD_VERSION = 5

#: 烘焙工作分辨率（宽）。传输是低频量，不需要原生分辨率；albedo 也跟着这个走
#: ——它要和 `E_est` 逐像素配对，两者分辨率必须一致，否则比值在边缘处错位。
WORK_W = 1024

#: 天穹方位数 × sin(仰角) 上的 Gauss-Legendre 节点数。
#:
#: `dΩ = dφ · d(sinθ)`，所以在 μ=sinθ 上做 Gauss 求积正好把立体角权重吸收进节点权重
#: —— 这是"权重对"的全部含义。
#:
#: **配比是量出来的，不是猜的。** 拿 48 方位 × 10 节点（480 方向）当参考，
#: 在 teahouse 上比 `T₀` 的误差（值域 0..1）：
#:
#: | 配置 | 方向数 | RMS | p99 | max |
#: |---|---|---|---|---|
#: | 12 × 4（旧） | 48 | 0.0244 | 0.0709 | 0.1236 |
#: | 24 × 4 | 96 | 0.0167 | 0.0524 | 0.1026 |
#: | 12 × 8 | 96 | 0.0175 | 0.0508 | 0.0920 |
#: | **16 × 6** | **96** | **0.0147** | **0.0436** | **0.0890** |
#: | 24 × 8 | 192 | 0.0091 | 0.0277 | 0.0610 |
#:
#: 同样 96 个方向，**两个维度均摊**比把预算全砸在一边好（0.0147 vs 0.0167/0.0175）。
#:
#: ⚠ 旧的 12×4 那 0.024 RMS 不是白噪声，是**十二边形刻面** —— 方位对齐让相邻像素
#:   成片地跳同一档，平地上肉眼可见。除掉余弦看纯可见度时最明显（见 sc3SkyVisibility）。
#: ⚠ 试过"每环转个相位"想靠错位掩掉刻面：RMS 只从 0.0192 到 0.0176（同一组实验，
#:   参考换成 48×4）。没用的原因是主要误差来自**贴地那一环自己**方位太疏，
#:   环间错位并不给那一环加分辨率。也试过等弧长分配 `N_j ∝ sinθ_j`：
#:   74 方向 RMS 0.0135、98 方向 0.0089，**并不优于同预算的均匀分配**。
SKY_AZIMUTHS = 16
SKY_GAUSS_NODES = 6

#: 角色网格的通道数：0 = 天穹遮蔽（y⁰ 传输的 SH-L1），1 = 局部 AO，2..4 = 烘焙 GI 的 RGB。
#:
#: ⚠ 2026-08-23 从 8 降到 5：原来通道 0..3 是 y⁰/y¹/y²/y⁴ 四个纬向传输，
#:   那是把**天空**烤进了载荷。天空现在是运行时的全局 SH（`src/rendering/lighting/skySh.ts`），
#:   遮蔽只需要一个 (bent 方向, 可见度)，一个通道就够。
GRID_CHANNELS = 5

#: 蒙特卡洛 gather 的每像素样本数。**误差是无偏噪声，按 √spp 退**，
#: 所以这是一个可以随时调的质量/时间旋钮，不是需要调对的参数。
#: 实测（雾津街头 512 宽，以 512 spp 为参考）|Δ log E| 中位：
#: 16 spp 0.112 · 64 spp 0.056 · 256 spp 0.025，正好每 4 倍采样减半。
GATHER_SPP = 16

#: gather 的行进步长（像素）。0.5 px ⇒ 不会跳过薄遮挡物。
#: ⚠ 与旧的 `MARCH_STEPS` 不是一回事：那个是"整条射线分几段"，射线一长步长就变粗；
#:   这个是**固定的像素步长**，射线多长都一样细。
GATHER_STEP_PX = 0.5

#: gather 的随机种子。**必须固定** —— 产物要字节可复现（test_deterministic_bytes）。
GATHER_SEED = 20260823

#: 短程 march 参数（AO / 角色网格仍在用；gather 已经不用了）。⚠ thickness 0.75 而不是现行的 2.0 —— 2.0 覆盖了场景深度全域
#: （实测改成 ∞ 结果一模一样），等于"可见壳背后一律实心"。
MARCH_STEPS = 18
MARCH_LENGTH = 2.4
MARCH_BIAS = 0.025
MARCH_BIAS_GROWTH = 0.015
MARCH_THICKNESS = 0.75

#: 局部 AO 的 march 参数。**刻意比天穹短一个数量级**：
#: 天穹问的是"你能看见多少天"（长程、只朝上半球），
#: AO 问的是"你有多封闭"（短程、绕自己的法线全向）。
#: 两个不同的问题 —— v2 与 v3 的头几版都拿 T₀ 一个量当两个用，
#: 后果是室内场景两边都没有信号（T₀ 处处≈0），拟合只能塌成常数。
AO_STEPS = 10
AO_LENGTH = 0.25
AO_AZIMUTHS = 12
AO_GAUSS_NODES = 8

#: 逆色调映射的上限。**这是整条链唯一的建模假设**。
#:
#:   8-bit 原画的高光是被压过的：线性化之后灶口和白墙都贴在 1.0 附近，
#:   而它们的真实辐射差着两个数量级。直接拿线性化的图当辐射场做 final gather，
#:   灶口就照不亮任何东西。
#:
#:   假设原画是按 Reinhard 式 `y = x/(1+x)` 压进 8 bit 的，逆映射就是
#:   `x = y/(1−y)`；分母加下限 `1/HDR_MAX` 把 y=1 的像素钳在这个值。
#:   中间调几乎不动（y=0.2 → 0.25），高光被拉开（y=0.9 → 10，y=0.99 → 100）。
HDR_MAX = 200.0

#: 逃逸辐射的缺省取法。**烘焙期输入，不进运行时载荷**（见 make_sky_sampler）。
#:
#: ⚠ `intensity` 是相对**原画的 HDR 辐射**而言的（原画经逆 Reinhard 展开后
#:   中间调落在 0.02–0.05 量级）。这个值决定室内画有多少 E 来自"画幅外"，
#:   是个真正影响画面的旋钮 —— 逐场景可在 `lighting.bakeSky` 里覆盖。
DEFAULT_SKY = {'mode': 'color', 'color': [1.0, 1.0, 1.0], 'intensity': 0.05}

#: 对数编码跨度的上下界（以 2 为底的档数）。**实际跨度逐载荷按数据定**，
#: 见 `pick_log_params`。
#:
#:   `enc = clamp(log2(x/scale)/span + 0.5, 0, 1)`，解码 `x = scale·2^((enc−½)·span)`。
#:
#:   ⚠ 为什么不能沿用 `from_hdr` + sRGB8（自发光那条仍在用）：那条曲线的甜区只有
#:     0.1–3（相对误差 <2%），到 10 就 5%、30 就 9%、200 直接截断。而辐照度 `E`
#:     与角色网格的 GI 动态范围是 400 倍量级（烛火旁 vs 暗角），怎么选 scale 都
#:     顾此失彼 —— 除以 p99.9 把典型值推到甜区**下方**（实测往返从 0.56 炸到 40）。
#:     对数编码的相对精度**全程恒定**：跨度 S 时每级 `ln2·S/255`。
#:
#:   ⚠ 跨度也不能写死。固定 ±8 档（S=16）试过：**11/28 个场景饱和**，灯边上的
#:     格点最高 4.87% 撞顶 —— 那些点的角色受光直接偏掉，而往返指标看不见
#:     （`base` 是按量化后的 `E` 反推的，会把误差吸收进去）。按数据定之后多数
#:     场景只需 9–12 档（精度 2.4–3.3%，**比固定 16 还好**），少数才给到上界。
#:
#:   自发光**不用**这条：它大部分像素恰好是 0，log 表达不了 0。
HDR_LOG_SPAN_MIN = 8.0
HDR_LOG_SPAN_MAX = 24.0
#: 挑下界时丢掉的分位（这一小撮会钳到编码下端）。
HDR_LOG_FLOOR_PCT = 0.1


def pick_log_params(x: np.ndarray, one_sided: bool = False) -> tuple[float, float]:
    """给一批非负 HDR 值挑对数编码的 (中心, 跨度)，**按数据定、保证不饱和**。

    `one_sided=True` 用于比例基底：它有物理上界 1，把 1.0 钉在量程上端、
    往下覆盖到数据的下界。其余载荷取几何中点居中。
    """
    pos = x[x > 0]
    if pos.size == 0:
        return 1.0, HDR_LOG_SPAN_MIN
    hi = 1.0 if one_sided else float(pos.max())
    lo = float(np.percentile(pos, HDR_LOG_FLOOR_PCT))
    lo = min(max(lo, hi * 2.0 ** -HDR_LOG_SPAN_MAX), hi)
    span = float(np.clip(math.ceil(math.log2(hi / max(lo, 1e-30))),
                         HDR_LOG_SPAN_MIN, HDR_LOG_SPAN_MAX))
    scale = hi * 2.0 ** (-span / 2.0) if one_sided else float(math.sqrt(lo * hi))
    return scale, span


def encode_log_hdr(x: np.ndarray, scale: float, span: float) -> np.ndarray:
    """HDR → u8 对数编码。`scale` 落在量程正中（字节 127.5）。"""
    v = np.log2(np.maximum(x, 1e-30) / max(scale, 1e-30)) / span + 0.5
    return np.round(np.clip(v, 0.0, 1.0) * 255.0).astype(np.uint8)


def decode_log_hdr(u8: np.ndarray, scale: float, span: float) -> np.ndarray:
    return (scale * np.exp2((u8.astype(np.float32) / 255.0 - 0.5) * span)
            ).astype(np.float32)


def decode_base(u8: np.ndarray, scale: float, span: float) -> np.ndarray:
    """比例基底的解码。与 `decode_log_hdr` 只差一条：**字节 0 表示精确的 0**。

    ⚠ 这条不是修饰。`base` 的下端会真的撞到编码下限：极亮场景的 `E` 到 1000
    量级，而近黑像素的 `hdr/E` 能小到 5e-6。把它们抬到下限之后 `base·E` 已经
    **超过**原画（历史注释：那时还有 emissive 兜底，恒等式
    在那里破掉，画面上就是一片本该全黑的地方发灰。实测梦_醒来土路 往返 p99
    12.1/255，误差 99 分位像素的 base 恰好是编码下限。

    天空那批（`base = 0`）走的也是这条路，顺带一起对了。
    """
    return decode_log_hdr(u8, scale, span) * (u8 > 0)


#: 整体增益的上限与取样分位。见 `bake()` 里 `gather_gain` 那段的推导：
#: 增益吸收的是"伪世界里没有的光"（太阳、多次反弹），一个被日光直射的表面
#: 收到的光大约是天光的 5–10 倍，所以 12 是宽松但有界的天花板。
GATHER_GAIN_PERCENTILE = 95.0
GATHER_GAIN_MAX = 12.0




def _atomic_bytes(dest: Path, data: bytes) -> None:
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_suffix(dest.suffix + '.tmp')
    tmp.write_bytes(data)
    retry_transient(os.replace, tmp, dest)


def _png_bytes(arr: np.ndarray, mode: str) -> bytes:
    buf = io.BytesIO()
    Image.fromarray(arr, mode=mode).save(buf, format='PNG', optimize=True)
    return buf.getvalue()


# --------------------------------------------------------------------- 几何

def edge_safe_normals(world: np.ndarray, R: np.ndarray) -> np.ndarray:
    """伪世界高度场的法线，**不跨深度断层**。

    中心差分会横跨前景/背景的深度断层，把每一条剪影都变成一圈假倒角
    （现行 `geometry.py` 正是高斯平滑 + `np.gradient` 中心差分，有这个病）。

    这里前向与后向切线**都指向图像轴正方向**，取更短的那条：只要有一侧还落在
    同一个可见表面上，导数就留在那个面上。
    """
    fx = np.roll(world, -1, axis=1) - world
    bx = world - np.roll(world, 1, axis=1)
    use_fx = np.linalg.norm(fx, axis=-1) <= np.linalg.norm(bx, axis=-1)
    dx = np.where(use_fx[..., None], fx, bx)
    dx[:, 0] = fx[:, 0]
    dx[:, -1] = bx[:, -1]

    fy = np.roll(world, -1, axis=0) - world
    by = world - np.roll(world, 1, axis=0)
    use_fy = np.linalg.norm(fy, axis=-1) <= np.linalg.norm(by, axis=-1)
    dy = np.where(use_fy[..., None], fy, by)
    dy[0] = fy[0]
    dy[-1] = by[-1]

    n = np.cross(dx, dy)
    n /= np.maximum(np.linalg.norm(n, axis=-1, keepdims=True), 1e-8)
    # 朝相机一侧：相机看向 +z（q 空间），世界里是 R 的第三列
    facing = -R[:, 2]
    flip = (n @ facing) < 0
    n[flip] *= -1.0
    return n.astype(np.float32)


def sky_directions() -> list[tuple[np.ndarray, float]]:
    """上半球的**立体角求积**：12 方位 × 4 个 Gauss 节点（在 sin(仰角) 上）。

    `dΩ = dφ · d(sinθ)`。在 μ = sinθ 上做 Gauss-Legendre，节点权重就是立体角权重
    ——不需要再手工乘 cos。现行 `_SKY_ELEVS`（两环等权）缺的正是这一步：
    仰角 [0°,43°] 那一带占上半球立体角 68.2% 却只分到 50% 权重。
    """
    out: list[tuple[np.ndarray, float]] = []
    nodes, weights = np.polynomial.legendre.leggauss(SKY_GAUSS_NODES)
    mus = (nodes + 1.0) * 0.5           # [-1,1] → [0,1]
    mu_w = weights * 0.5
    for mu, w in zip(mus, mu_w, strict=True):
        y = float(mu)
        horiz = math.sqrt(max(1.0 - y * y, 0.0))
        for k in range(SKY_AZIMUTHS):
            a = 2.0 * math.pi * k / SKY_AZIMUTHS
            out.append((
                np.array([horiz * math.sin(a), y, horiz * math.cos(a)], np.float32),
                float(w),
            ))
    return out


def sphere_directions() -> list[tuple[np.ndarray, float]]:
    """**全球面**的立体角求积：12 方位 × 8 个 Gauss 节点（在 cos(极角) 上）。

    与 `sky_directions` 的两处不同，都是有意的：

    - 覆盖整个球面而不是上半球 —— AO 要绕**表面自己的法线**求积，而法线朝哪都有可能；
    - 节点在 μ ∈ [−1, 1] 上而不是 [0, 1]。

    归一化时分子分母用**同一个 N**（见 `bake_local_ao`），于是无遮挡时任何朝向
    都恰好给 1 —— 这正是我在审计 v2 的 `sky_field` 时指出它做错的那一步
    （它分子用 N、分母用 up，只有朝上的面才对）。AO 是"半球开了多少"，
    与朝向无关，所以这里必须同权。
    """
    out: list[tuple[np.ndarray, float]] = []
    nodes, weights = np.polynomial.legendre.leggauss(AO_GAUSS_NODES)
    for mu, w in zip(nodes, weights, strict=True):
        y = float(mu)
        horiz = math.sqrt(max(1.0 - y * y, 0.0))
        for k in range(AO_AZIMUTHS):
            a = 2.0 * math.pi * k / AO_AZIMUTHS
            out.append((
                np.array([horiz * math.sin(a), y, horiz * math.cos(a)], np.float32),
                float(w),
            ))
    return out


def _march_short(q: np.ndarray, dir_q: np.ndarray, depth_q: np.ndarray,
                 ppu: float, cx: float, cy: float) -> np.ndarray:
    """短程 march（AO 用）。逐像素版本，返回 1 = 未被挡。

    ⚠ 出画语义与天穹 march **刻意不同**：这里出画一律算**未被挡**。
    天穹问的是"能不能看到天"，画幅外未知就该保守当挡住；AO 问的是
    "有多封闭"，而一个像素并不会因为我们看不到画幅外就变得封闭。
    而且 AO 只走 0.25 q ≈ 28 px，能出画的只有紧贴边框那一圈。
    """
    h, w = depth_q.shape
    blocked = np.zeros((h, w), np.bool_)
    step = AO_LENGTH / AO_STEPS
    for i in range(1, AO_STEPS + 1):
        t = step * i
        px = (q[..., 0] + dir_q[0] * t) * ppu + cx
        py = cy - (q[..., 1] + dir_q[1] * t) * ppu
        inside = (px >= 0) & (px < w) & (py >= 0) & (py < h)
        xi = np.clip(np.rint(px), 0, w - 1).astype(np.int32)
        yi = np.clip(np.rint(py), 0, h - 1).astype(np.int32)
        pen = (depth_q + dir_q[2] * t) - depth_q[yi, xi]
        bias = MARCH_BIAS + MARCH_BIAS_GROWTH * t
        blocked |= inside & (pen > bias) & (pen < MARCH_THICKNESS)
    return ~blocked


def bake_local_ao(q: np.ndarray, normal: np.ndarray, R: np.ndarray,
                  ppu: float, cx: float, cy: float,
                  progress: bool = True) -> np.ndarray:
    """局部环境遮蔽（**多次反弹的几何代理**）。

        AO(p) = Σᵢ wᵢ·Vᵢ(p)·max(N·ωᵢ, 0) / Σᵢ wᵢ·max(N·ωᵢ, 0)

    分子分母同一个 N ⇒ **无遮挡时任何朝向恒为 1**（这是 AO 的定义：半球开了多少，
    与朝向无关）；凹角、檐下、室内墙根压下去。

    ## 为什么必须有它，而不能继续用 T₀

    `T₀` 是**天穹**传输：室内它处处≈0，等于没有信号。实测 10 个室内/夜景场景的
    `E_est` 分层残留卡在 0.42–0.65，拟合只能把 `c₁` 收到 0 退化成常数
    —— 那些画就此完全不参与重打光。

    环境反弹项同理：`0.28 + 0.72·T₀` 拿天穹可见性当"封闭度"用，是同一个错误的
    另一面。室内反弹的结构来自**几何封闭**，不来自看不看得见天。
    """
    dirs = sphere_directions()
    depth_q = q[..., 2]
    num = np.zeros(q.shape[:2], np.float64)
    den = np.zeros(q.shape[:2], np.float64)
    for idx, (dw, w) in enumerate(dirs, 1):
        dq = (R.T @ dw).astype(np.float32)
        cos = np.clip(normal @ dw, 0.0, 1.0)
        if cos.max() <= 1e-6:
            den += w * cos
            continue
        vis = _march_short(q, dq, depth_q, ppu, cx, cy).astype(np.float64)
        num += w * vis * cos
        den += w * cos
        if progress and idx % 24 == 0:
            print(f'    AO 方向 {idx:02d}/{len(dirs)}', flush=True)
    ao = (num / np.maximum(den, 1e-9)).astype(np.float32)
    ao = gaussian_filter(ao, 0.8)
    return np.clip(ao, 0.0, 1.0)


# ------------------------------------------------------- 角色侧：SH-L1 网格

#: 角色网格分辨率。比上一代 (24,10,16) 密：那一版的单元是 170×60×238 wu，
#: 而角色高 150 wu、宽约 70 wu —— **横向不到一个单元**，走进门洞根本表达不出来。
CHAR_GRID = (32, 14, 24)


#: 角色空间数据的采样数。空间点没有法线、只能均匀采样上半球，收敛比场景侧的
#: 余弦重要性采样慢，所以给得比 `GATHER_SPP` 高。
CHAR_VOL_SPP = 64

#: 空间数据的格密度，按**角色高度**定（`scale.char_wu`）而不是按场景尺寸定 ——
#: 要表达的结构（门洞、柱子、檐下）是相对角色的，不是相对画幅的。
#: 纵向给得更密：`V` 沿高度变化比沿水平快（贴着墙往上抬 30 cm 就能看见天）。
#:
#: 密度实测（雾津街头，基准 = 逐点 MC 128spp，评估在**角色头高**）：
#:
#: | 每角色高 | 网格 | 格数 | \|Δ\|中位 | 深遮蔽偏差 | 天穹通道 |
#: |---|---|---|---|---|---|
#: | 1（≈现状） | 26×9×24 | 5.6k | 0.0797 | **+0.2253** | 0.02 MB |
#: | 2 | 52×18×48 | 45k | 0.0572 | +0.1047 | 0.18 MB |
#: | **3（选它）** | **78×27×71** | **150k** | **0.0480** | **+0.0555** | **0.60 MB** |
#: | 4 | 104×36×95 | 356k | 0.0416 | +0.0252 | 1.42 MB |
#:
#: 对照：**旧 tracer + 32×14×24 的现状是 +0.4946** —— 深遮蔽处几乎把黑的算成灰的。
#: 选 3 是因为收益在这里开始明显递减（3→4 只再降 0.03，载荷却翻 2.4 倍），
#: 而 5 个通道全量在密度 3 是 3.0 MB，相对现有 ~10 MB 的载荷（base.png 一个就 5 MB）
#: 是可以承受的比例。要更准就把这两个常数调到 4/8 重烘，没有别的开关。
CHAR_VOL_CELLS_PER_CHAR_XZ = 3.0
CHAR_VOL_CELLS_PER_CHAR_Y = 6.0

#: 单场景格点总数上限。超了就整体等比降密度 —— 宁可粗一点，不要让载荷炸掉。
CHAR_VOL_MAX_CELLS = 200_000


def char_grid_for(world: np.ndarray, char_wu: float, band: float) -> tuple[int, int, int]:
    """按**角色尺寸**定格密度，不按场景尺寸定。

    要表达的结构（门洞、柱子、檐下、墙沿）是相对角色的，不是相对画幅的。
    旧的写死 `(32, 14, 24)` 在雾津街头上是每格 0.144 世界单位，而角色高 0.170
    —— **横向一格比一个角色还宽**，门洞和柱子在网格里根本不存在，而那些结构
    逐像素的 `sky_occlusion.png` 上全都有。分工是反的。

    纵向给得更密（`CELLS_PER_CHAR_Y` > `_XZ`）：`V` 沿高度变化比沿水平快 ——
    贴着墙往上抬三分之一个身位就能看见天。
    """
    px_, py_, pz_ = (world[..., i].ravel() for i in range(3))
    sx = float(np.percentile(px_, 99) - np.percentile(px_, 1))
    sz = float(np.percentile(pz_, 99) - np.percentile(pz_, 1))
    y0 = float(np.percentile(py_, 2)) - 0.02
    y1 = max(float(np.percentile(py_, 60)) + band, y0 + band * 1.5)
    cell_xz = max(char_wu / CHAR_VOL_CELLS_PER_CHAR_XZ, 1e-4)
    cell_y = max(char_wu / CHAR_VOL_CELLS_PER_CHAR_Y, 1e-4)
    nx = max(4, int(round(sx / cell_xz)))
    nz = max(4, int(round(sz / cell_xz)))
    ny = max(4, int(round((y1 - y0) / cell_y)))
    # 超上限就整体等比降密度（三维等比 ⇒ 开立方根）
    total = nx * ny * nz
    if total > CHAR_VOL_MAX_CELLS:
        s = (CHAR_VOL_MAX_CELLS / total) ** (1.0 / 3.0)
        nx = max(4, int(nx * s)); ny = max(4, int(ny * s)); nz = max(4, int(nz * s))
    return nx, ny, nz


def mc_sky_moments(pts_q: np.ndarray, R: np.ndarray, dep: np.ndarray,
                   ppu: float, cx: float, cy: float,
                   spp: int = CHAR_VOL_SPP, seed: int = GATHER_SEED,
                   progress: bool = False, label: str = '') -> tuple[np.ndarray, np.ndarray]:
    """任意一批**空间点**的天穹可见度矩 —— 与 `bake_gather` 逐字同一条射线。

        M₀ = ∫_{ω·up>0} V(ω) dω          M₁ = ∫_{ω·up>0} V(ω)·ω dω
        a₀ = M₀ / 4π                      a₁ = M₁ / 2π
        T(N) = a₀ + a₁·N                  V(N) = T(N) / cap₀(N)

    无遮挡时 `M₀ = 2π`、`M₁ = π·up` ⇒ `T(N) = (1 + N·up)/2 = cap₀(N)` ⇒ `V ≡ 1`，
    **构造性精确**，与场景侧同一约定。

    ## 终止条件三个，全精确，没有"射程"

    1. 穿透进可见壳（打中）；
    2. 出画幅；
    3. 深度跑到全场景最前面之前 —— 再也不可能打中任何东西。

    这正是 `bake_gather` 的三条。⚠ 旧的 `march_visibility_points` 用的是
    `MARCH_LENGTH = 2.4` 截断 + `sky_directions()` 固定求积，而这个场景世界宽
    4.54 —— **一半以上宽度外的遮挡物对角色直接不存在**。实测同一批世界点上，
    旧法比场景侧亮：|Δ| 中位 0.066、p90 0.217，而且偏差集中在遮得最狠的地方
    （场景 V<0.2 那一箱偏 **+0.118**，相对高估 59%）。角色因此在巷子里、
    檐下、墙根**吃到过多天光** —— 正是"角色贴不住背景"最刺眼的那一档。

    ## 为什么这里是**均匀**半球采样

    空间点没有法线。余弦重要性采样绕的是 N，这里没有 N 可绕；而 `T` 要对**任意**
    运行时法线求值，所以矩必须是法线无关的。均匀采样上半球（pdf = 1/2π）之后
    两个矩就是样本均值乘 2π，没有权重表。
    """
    P = len(pts_q)
    if P == 0:
        return np.zeros(0, np.float32), np.zeros((0, 3), np.float32)
    Q = np.ascontiguousarray(pts_q, np.float32)
    step = np.float32(GATHER_STEP_PX / ppu)
    bias = np.float32(MARCH_BIAS)
    grow = np.float32(MARCH_BIAS_GROWTH)
    dmin = float(dep.min())
    h, w = dep.shape
    Rf = np.asarray(R, np.float32)
    rng = np.random.default_rng(seed)

    m0 = np.zeros(P, np.float64)
    m1 = np.zeros((P, 3), np.float64)
    for s in range(spp):
        # 均匀上半球：μ = ω·up 在 [0,1] 上均匀（dΩ = dφ·dμ），分层 + 抖动
        u1 = ((s + rng.random(P)) / spp).astype(np.float32)
        u2 = rng.random(P).astype(np.float32)
        mu = u1
        sr = np.sqrt(np.maximum(1.0 - mu * mu, 0.0))
        phi = np.float32(2.0 * math.pi) * u2
        dw = np.stack([sr * np.cos(phi), mu, sr * np.sin(phi)], 1).astype(np.float32)
        dq = dw @ Rf

        idx = np.arange(P)
        ox, oy, oz = Q[:, 0].copy(), Q[:, 1].copy(), Q[:, 2].copy()
        dx, dy, dz = dq[:, 0].copy(), dq[:, 1].copy(), dq[:, 2].copy()
        escaped = np.ones(P, np.bool_)
        tc = np.zeros(P, np.float32)
        while idx.size:
            tc += step
            zq = oz + dz * tc
            sx = (ox + dx * tc) * ppu + cx
            sy = cy - (oy + dy * tc) * ppu
            keep = ((sx >= 0) & (sx < w - 1) & (sy >= 0) & (sy < h - 1)
                    & (zq > dmin - 1e-3))
            if not keep.all():
                idx = idx[keep]
                if idx.size == 0:
                    break
                ox, oy, oz, dx, dy, dz, tc = (a[keep] for a in (ox, oy, oz, dx, dy, dz, tc))
                zq, sx, sy = zq[keep], sx[keep], sy[keep]
            xi = np.rint(sx).astype(np.int32)
            yi = np.rint(sy).astype(np.int32)
            pen = zq - dep[yi, xi]
            hit = (pen > bias + grow * tc) & (pen < MARCH_THICKNESS)
            if hit.any():
                escaped[idx[hit]] = False
                k = ~hit
                idx = idx[k]
                if idx.size == 0:
                    break
                ox, oy, oz, dx, dy, dz, tc = (a[k] for a in (ox, oy, oz, dx, dy, dz, tc))
        e64 = escaped.astype(np.float64)
        m0 += e64
        m1 += e64[:, None] * dw
        if progress and (s + 1) % 16 == 0:
            print(f'    {label}空间采样 {s + 1:03d}/{spp} spp', flush=True)

    # 均值 × 2π 得矩，再按上面的定义化成 (a₀, a₁)
    a0 = (m0 / spp) * (2.0 * math.pi) / (4.0 * math.pi)
    a1 = (m1 / spp) * (2.0 * math.pi) / (2.0 * math.pi)
    return a0.astype(np.float32), a1.astype(np.float32)


def march_visibility_points(q0: np.ndarray, dir_q: np.ndarray, depth: np.ndarray,
                            ppu: float, cx: float, cy: float,
                            steps: int = MARCH_STEPS,
                            length: float = MARCH_LENGTH) -> np.ndarray:
    """从空间中**任意一批点**出发 march，返回逐点 1 = 未被挡。

    与 `march_visibility`（逐像素、从自己的表面出发）同一套判据，只是起点不同。
    """
    h, w = depth.shape
    blocked = np.zeros(len(q0), np.bool_)
    step = length / steps
    for i in range(1, steps + 1):
        t = step * i
        p = q0 + dir_q[None, :] * t
        px = p[:, 0] * ppu + cx
        py = cy - p[:, 1] * ppu
        # 与逐像素版同一条出画语义：钳到边缘继续判（见 march_visibility 的推导）
        xi = np.clip(np.rint(px), 0, w - 1).astype(np.int32)
        yi = np.clip(np.rint(py), 0, h - 1).astype(np.int32)
        pen = p[:, 2] - depth[yi, xi]
        bias = MARCH_BIAS + MARCH_BIAS_GROWTH * t
        blocked |= (pen > bias) & (pen < MARCH_THICKNESS)
    return ~blocked


def march_gather_points(q0: np.ndarray, dir_q: np.ndarray, depth: np.ndarray,
                        ppu: float, cx: float, cy: float,
                        steps: int = MARCH_STEPS,
                        length: float = MARCH_LENGTH):
    """`march_visibility_points` 的取样版：额外带出**第一次命中**的像素坐标。

    角色侧的 final gather 要在命中点取辐射 —— 与场景侧 `march_gather` 同一件事，
    只是起点是网格点而不是像素自己的表面。
    """
    h, w = depth.shape
    n = len(q0)
    blocked = np.zeros(n, np.bool_)
    hit_y = np.zeros(n, np.int32)
    hit_x = np.zeros(n, np.int32)
    step = length / steps
    for i in range(1, steps + 1):
        t = step * i
        px = (q0[:, 0] + dir_q[0] * t) * ppu + cx
        py = cy - (q0[:, 1] + dir_q[1] * t) * ppu
        xi = np.clip(np.rint(px), 0, w - 1).astype(np.int32)
        yi = np.clip(np.rint(py), 0, h - 1).astype(np.int32)
        pen = (q0[:, 2] + dir_q[2] * t) - depth[yi, xi]
        bias = MARCH_BIAS + MARCH_BIAS_GROWTH * t
        now = (pen > bias) & (pen < MARCH_THICKNESS)
        first = now & ~blocked
        np.copyto(hit_y, yi, where=first)
        np.copyto(hit_x, xi, where=first)
        blocked |= now
    return ~blocked, hit_y, hit_x


def bake_sky_sh_grid(depth: np.ndarray, R: np.ndarray, ppu: float, cx: float, cy: float,
                     world: np.ndarray, band: float,
                     hdr: np.ndarray, sky_of,
                     grid: tuple[int, int, int] = CHAR_GRID,
                     progress: bool = True) -> dict:
    """3D **方向性**天穹传输网格（SH-L1 / bent-normal 形式）。

    ## 为什么不能存标量

    场景侧把法线烘进了 `T_k`（逐像素法线固定）；角色的法线是**逐像素在变**的。
    喂给它一个标量，「角色和场景走同一套光照计算」就不可能成立 —— 现行网格正是
    标量 `V(x, up)`，等于把角色当成一块朝上的板，实测比它真正需要的
    `V̄(x, n_c)` 偏高 61%（中位），而且身上完全没有方向性。

    ## 表示

    对钳位余弦做 L1 展开 `(N·ω)₊ ≈ ¼ + ½(N·ω)`，于是

        T_k(N) = a₀ₖ + a₁ₖ · N

        a₀ₖ = Σᵢ wᵢVᵢyᵢᵏ      / (4 · normₖ)
        a₁ₖ = Σᵢ wᵢVᵢyᵢᵏ ωᵢ   / (2 · normₖ)      normₖ = Σᵢ wᵢyᵢyᵢᵏ

    ⚠ 天穹通道（0）**不再走上面这个求积**，它走 `mc_sky_moments`（见下方）。
      上式只剩 AO / GI 通道在用。旧注释说的「与场景侧 `bake_transport` 同一个分母」
      早就过期了：`bake_transport` 这个函数**已经不存在**，场景侧换成 `bake_gather`
      之后两边就是两套 tracer 了，而注释还在宣称同尺度 —— 那正是这次要修的问题。

    ⚠ 无遮挡时这个近似**不是近似、是精确**：朝上 1.0、45° 0.854、竖直 0.5，
      逐个命中解析真值 `(1+cos β)/2` —— 因为那个式子本身就是 L1 形式。
      遮蔽越各向异性，L1 截断的误差才开始出现（低频量，可接受）。

    ## 存储

    `a₀ ∈ [0, ½]`、`a₁ 分量 ∈ [−½, ½]` ⇒ 正好装进 **RGBA8**：
    `R = 2a₀`、`GBA = a₁ + ½`。每格每通道 4 字节，量化步长 ~0.002。
    布局与现行 skyvis_grid 同规则：Z 切片横向平铺，列 = `x + z·nx`。
    """
    nx, ny, nz = grid
    px_ = world[..., 0].ravel()
    py_ = world[..., 1].ravel()
    pz_ = world[..., 2].ravel()
    x0, x1 = np.percentile(px_, [1, 99])
    z0, z1 = np.percentile(pz_, [1, 99])
    # y：覆盖「最低地面 → 较高地面 + 角色带」。地面起伏常常比角色还高，
    # 不一并覆盖的话远处地面上的角色会落到网格外被钳到边界层。
    y0 = float(np.percentile(py_, 2)) - 0.02
    y1 = float(np.percentile(py_, 60)) + band
    y1 = max(y1, y0 + band * 1.5)

    gx = np.linspace(x0, x1, nx)
    gy = np.linspace(y0, y1, ny)
    gz = np.linspace(z0, z1, nz)
    X, Y, Z = np.meshgrid(gx, gy, gz, indexing='ij')
    pts_world = np.stack([X.ravel(), Y.ravel(), Z.ravel()], -1).astype(np.float32)
    pts_q = (pts_world @ R).astype(np.float32)      # R 正交 ⇒ 转置即逆

    # 通道 0..3 = 纬向传输基（天穹，长程上半球）；通道 4 = 局部 AO（短程全球面）；
    # 通道 5..7 = **烘焙 GI 的 RGB**（伪世界 final gather，全球面长程）。
    #
    # ⚠ 5..7 不是可选项。场景侧默认 `gi = 1`（画面 ≡ 原画），角色若拿不到同一份
    #   辐照度就只剩天光和灯 —— 而未重打光的场景那两项都是 0，角色于是**全黑**。
    #   这正是 v2 那个 `placeholder` 开关造成的症状（27 个场景角色零响应），
    #   换个形式又会犯一遍。角色要"融入场景"，吃的就是这一份。
    nch = GRID_CHANNELS
    n_pts = len(pts_q)
    n_sky_ch = 1
    m0 = np.zeros((n_sky_ch, n_pts), np.float64)
    m1 = np.zeros((n_sky_ch, n_pts, 3), np.float64)
    norm = np.zeros(n_sky_ch, np.float64)

    # ★ 天穹遮蔽走 `mc_sky_moments` —— 与场景侧 `bake_gather` **逐字同一条射线**。
    #
    # ⚠ 旧法是 `sky_directions()` 固定求积 + `march_visibility_points` 的
    #   `MARCH_LENGTH = 2.4` 截断。而雾津街头世界宽 4.54 ⇒ **一半以上宽度外的
    #   遮挡物对角色直接不存在**。实测同一批世界点上两边的差：
    #   |Δ| 中位 0.066、p90 0.217、max 0.795，相关 0.861，且偏差**集中在遮得最狠处**
    #   —— 场景 V<0.2 那一箱偏 +0.118（相对高估 59%），开阔地几乎为 0（−0.003）。
    #   也就是巷子里、檐下、墙根的角色吃到过多天光，正是"角色贴不住背景"最刺眼的一档。
    #   只有 y⁰ 一个天穹通道：天空是运行时的全局 SH，遮蔽只要 (bent 方向, 可见度)。
    sky_a0, sky_a1 = mc_sky_moments(pts_q, R, depth, ppu, cx, cy,
                                    progress=progress, label='char-sky ')
    # 下面统一按 `a₀ = m₀/(4·norm)`、`a₁ = m₁/(2·norm)` 解包，所以把结果反推回矩。
    m0[0] = sky_a0 * 4.0
    m1[0] = sky_a1 * 2.0
    norm[0] = 1.0

    # ---- 通道 4：局部 AO（短程、全球面）----
    ao_dirs = sphere_directions()
    ao_m0 = np.zeros(n_pts, np.float64)
    ao_m1 = np.zeros((n_pts, 3), np.float64)
    ao_norm = 0.0
    for idx, (dw, w) in enumerate(ao_dirs, 1):
        dq = (R.T @ dw).astype(np.float32)
        vis = march_visibility_points(pts_q, dq, depth, ppu, cx, cy,
                                      steps=AO_STEPS, length=AO_LENGTH).astype(np.float64)
        ao_m0 += w * vis
        ao_m1 += (w * vis)[:, None] * dw[None, :].astype(np.float64)
        ao_norm += w
        if progress and idx % 48 == 0:
            print(f'    角色网格 AO 方向 {idx:02d}/{len(ao_dirs)}', flush=True)
    # 全球面上 Σw·(N·ω)₊ 与 N 无关（恒为 Σw/2），所以 a₀/a₁ 的归一是个常数：
    # L1 重建 ¼m₀ + ½m₁·N 在 V≡1 时给 ¼Σw = ½·(Σw/2) ⇒ 除以 Σw/2 后恒为 ½…
    # 直接按"无遮挡 = 1"定标：V≡1 时 m₀ = Σw、m₁ = 0 ⇒ a₀ = m₀/Σw。
    m0 = np.vstack([m0, (ao_m0 / max(ao_norm, 1e-9))[None, :]])
    m1 = np.concatenate([m1, (ao_m1 / max(ao_norm, 1e-9))[None, :, :]], axis=0)
    norm = np.append(norm, 1.0)

    # ---- 通道 5..7：烘焙 GI（与场景侧 `bake_gather` 同一个积分，起点换成格点）----
    #   L_in = HDR原画(命中点) / 天空辐射(逃逸)，绕全球面积，SH-L1 表示。
    gi_dirs = gather_directions()
    gi_m0 = np.zeros((n_pts, 3), np.float64)
    gi_m1 = np.zeros((n_pts, 3, 3), np.float64)
    gi_norm = 0.0
    for idx, (dw, w, _up) in enumerate(gi_dirs, 1):
        dq = (R.T @ dw).astype(np.float32)
        vis, hy, hx = march_gather_points(pts_q, dq, depth, ppu, cx, cy)
        rad = np.where(vis[:, None], sky_of(dw)[None, :], hdr[hy, hx]).astype(np.float64)
        gi_m0 += w * rad
        gi_m1 += (w * rad)[:, :, None] * dw[None, None, :].astype(np.float64)
        gi_norm += w
        if progress and idx % 48 == 0:
            print(f'    角色网格 GI 方向 {idx:03d}/{len(gi_dirs)}', flush=True)
    # 与 AO 同一个定标法：辐射恒为 L₀ 时必须给回 L₀。
    gi_a0 = gi_m0 / max(gi_norm, 1e-9) * 4.0
    gi_a1 = gi_m1 / max(gi_norm, 1e-9) * 2.0
    m0 = np.vstack([m0, (gi_a0 / 4.0).T])
    m1 = np.concatenate([m1, (gi_a1 / 2.0).transpose(1, 0, 2)], axis=0)
    norm = np.append(norm, [1.0, 1.0, 1.0])

    a0 = m0 / (4.0 * norm[:, None])
    a1 = m1 / (2.0 * norm[:, None, None])

    # ---- 分通道归一：无遮挡朝上面必须给 1，与场景侧同一个约定 ----
    # ⚠ L1 截断 `(N·ω)₊ ≈ ¼ + ½(N·ω)` 只对 y⁰ 通道恰好落在 1；越往天顶集中
    #   （y¹ 0.875、y² 0.833、y⁴ 0.800）偏得越多——L1 表达不了窄瓣。
    #   这里除掉一个**只由通道决定的常数**（V≡1 时的取值），所以遮蔽信号原样保留，
    #   只把两边的尺度对齐。剩下的形状误差随通道升高而增大，见 skyTransport.test。
    k_norm = np.empty(nch, np.float64)
    # 天穹通道（0）：`mc_sky_moments` 自己就精确归一 —— 无遮挡时 a₀ = 0.5、
    # a₁ = up/2 ⇒ T(up) = 1（实测 a₀=0.5000、T(up)=1.0001）。
    # ⚠ 旧的 `k_norm[0]` 是拿 `sky_directions()` 自己的权重去抵消**固定求积的离散
    #   误差**；MC 没有那个误差，再除一次就是无中生有。
    k_norm[0] = 1.0
    # AO 通道：V≡1 ⇒ m₀ = 1、m₁ = 0 ⇒ a₀ = ¼、a₁·N = 0，故常数是 ¼。
    # 除完之后无遮挡恒给 1，与其余通道同一约定。GI 三通道同理（辐射恒定时给回该值）。
    k_norm[1:] = 0.25
    a0 = (a0 / k_norm[:, None]).astype(np.float32)
    a1 = (a1 / k_norm[:, None, None]).astype(np.float32)

    # ---- RGBA8 打包：R = a₀ ∈ [0,1]，GBA = a₁·½+½（a₁ ∈ [−1,1]）----
    # ⚠ 归一之后 a₁ 会超过 ½（y⁴ 通道实测 0.625），不能再用旧的 ±½ 值域。
    packed = np.empty((nch, n_pts, 4), np.uint8)
    packed[..., 0] = np.round(np.clip(a0, 0.0, 1.0) * 255.0)
    packed[..., 1:] = np.round(np.clip(a1 * 0.5 + 0.5, 0.0, 1.0) * 255.0)

    # ---- GI 三通道换一套编码：**幅度与方向分开** ----
    # 天穹/AO 通道是 [0,1] 的可见性，线性 8-bit 够用。GI 是 HDR（灶口旁边到几十），
    # 拿一个全局 scale 线性存会把典型值压到十几个量化档（实测 teahouse
    # scale=19.2、典型 0.87 ⇒ 12 档）。
    #
    #   R   = srgb8(from_hdr(a₀))      幅度，无需 scale，精度分布跟显示域一致
    #   GBA = a₁/(2a₀)·½+½             方向，纯方向量天然有界（单方向光时 |a₁/a₀| = 2）
    #
    # 解码：a₀ = to_hdr(srgb2lin(R))，a₁ = (GBA·2−1)·2a₀，E(N) = a₀ + a₁·N。
    gi_slice = slice(2, nch)
    g0 = a0[gi_slice]
    g1 = a1[gi_slice]
    # ⚠ 幅度走**对数**，理由同场景侧的 E：动态范围 400 倍，from_hdr 盖不住。
    #   跨度按数据定 —— 固定 16 档时灯边上的格点最高 4.87% 撞顶。
    gi_scale, gi_span = pick_log_params(np.maximum(g0, 0.0))
    packed[gi_slice, :, 0] = encode_log_hdr(np.maximum(g0, 0.0), gi_scale, gi_span)
    rel = g1 / np.maximum(g0, 1e-6)[..., None] * 0.5      # → [-1,1] 名义
    packed[gi_slice, :, 1:] = np.round(np.clip(rel * 0.5 + 0.5, 0.0, 1.0) * 255.0)
    # ★ 编解码自检。**必须在这里做**：GI 通道的编码与其余通道不同，
    #   两边任一处漂了都不会报错，只是角色亮度整体偏掉。
    dec_a0 = decode_log_hdr(packed[gi_slice, :, 0], gi_scale, gi_span)
    dec_rel = (packed[gi_slice, :, 1:].astype(np.float32) / 255.0 - 0.5) * 2.0
    dec_a1 = dec_rel * 2.0 * dec_a0[..., None]
    up_v = np.array([0.0, 1.0, 0.0], np.float32)
    ref = g0 + g1 @ up_v
    got = dec_a0 + dec_a1 @ up_v
    # ⚠ 指标形状踩过两次坑，都是被这个网格的巨大动态范围（烛火旁 vs 暗角）坑的：
    #   · 逐点相对误差 `|err|/|ref|` —— 暗格点天然 6–18%（sRGB 在近 0 处每档就这么大），
    #     可那里的绝对误差微不足道，角色站过去根本看不出来；
    #   · 绝对误差 ÷ 中位 —— 反过来被亮格点主导，temple 报出 2134%。
    #   软化的相对误差两头都不失真：亮处趋近真·相对误差，暗处被典型值兜住。
    typ = max(float(np.median(np.abs(ref))), 1e-6)
    gi_err = float(np.percentile(np.abs(got - ref) / (np.abs(ref) + typ), 99))

    packed = packed.reshape(nch, nx, ny, nz, 4)

    # 自检：无遮挡格点（a₀ 最大的那一批）应当复现解析真值
    up = np.array([0.0, 1.0, 0.0], np.float32)
    t_up = a0[0] + a1[0] @ up
    horiz = np.array([0.0, 0.0, 1.0], np.float32)
    t_hz = a0[0] + a1[0] @ horiz
    # ⚠ 用 argsort 取 top-1%，不用 `> percentile`：可见性高度量化，最开阔那一批
    #   常常整批并列在同一个值上，严格大于会把它们全排除掉（返回空切片 → NaN）。
    k = max(1, len(t_up) // 100)
    open_idx = np.argsort(t_up)[-k:]
    return {
        'packed': packed,
        'bounds': {'x0': float(x0), 'x1': float(x1),
                   'y0': float(y0), 'y1': float(y1),
                   'z0': float(z0), 'z1': float(z1)},
        'grid': {'nx': nx, 'ny': ny, 'nz': nz},
        'gi_scale': gi_scale, 'gi_span': gi_span,
        'selfcheck': {
            # GI 通道编解码往返的 p99 相对误差（朝上法线处求值）。
            'gi_codec_p99_rel': gi_err,
            'open_T_up': float(t_up[open_idx].mean()),
            'open_T_horizontal': float(t_hz[open_idx].mean()),
            'T_up_min': float(t_up.min()), 'T_up_max': float(t_up.max()),
            'T_up_mean': float(t_up.mean()),
        },
    }


# --------------------------------------------------- 伪世界 final gather

def to_hdr(lin: np.ndarray) -> np.ndarray:
    """线性化的 8-bit 原画 → HDR 辐射场。

    原画**就是出射辐射的图** —— 一张画画的就是"每个表面朝相机发出多少光"，
    这正是 final gather 需要的输入。但 8-bit 把高光压掉了：线性化之后灶口、
    窗、白墙全挤在 1.0 附近，而它们的真实辐射差着两个数量级。不展开的话
    灶口照不亮任何东西，室内画等于没有光源。

    逆 Reinhard：`y = x/(1+x)` ⇒ `x = y/(1−y)`，分母加下限 `1/HDR_MAX`。
    中间调几乎不动（y=0.2 → 0.25），高光被拉开（y=0.9 → 10，y=0.99 → 100）。

    ⚠ 这是整条链**唯一**的建模假设，其余全是积分。
    """
    return (lin / np.maximum(1.0 - lin, 1.0 / HDR_MAX)).astype(np.float32)


def from_hdr(x: np.ndarray) -> np.ndarray:
    """`to_hdr` 的逆（Reinhard 正向），只用于往返自检与预览。"""
    return (x / (1.0 + x)).astype(np.float32)


# ------------------------------------------------- 逃逸辐射（天空）：烘焙期输入
#
# ⚠ **这是烘焙期的自由输入，不进运行时载荷。** 射线跑出伪世界之后带走多少辐射，
#   画面里没有任何东西能回答 —— 它已经离开画面了。
#
# ⚠ 曾经这里写的是 `estimate_sky_radiance`：拿 `depth > p92`（视深最远的 8%）
#   那批像素的均值当逃逸辐射。**那是错的，而且错得很直白** —— 逃逸射线取的是
#   画面上的像素。室内场景更荒谬：那 8% 是后墙脚的地面（实测茶馆选中区的原画
#   亮度中位 0.130，其余也是 0.130，两者毫无区别），而同一个掩码还被拿去把
#   `base` 钉成 0，画面因此少了一整块。整条判据已删。


def _load_skybox(path: Path) -> np.ndarray:
    """读一张 equirect（lat-long）天空图，返回线性 HDR 的 (h,w,3)。

    支持两种：
    · `.hdr`（Radiance RGBE）—— 自己解，PIL 不认；
    · 普通 8-bit 图 —— sRGB→线性→`to_hdr` 展开（与原画同一条逆 Reinhard）。
    """
    if path.suffix.lower() == '.hdr':
        raw = path.read_bytes()
        # 头部到空行为止，然后是分辨率行
        nl = raw.index(b'\n\n')
        hdr_head, rest = raw[:nl], raw[nl + 2:]
        del hdr_head
        eol = rest.index(b'\n')
        dims = rest[:eol].split()
        h, w = int(dims[1]), int(dims[3])
        data = np.frombuffer(rest[eol + 1:], np.uint8)
        # 只支持 flat RGBE（非 RLE）—— RLE 的话这里会尺寸对不上，直接报错更好
        if data.size < w * h * 4:
            raise ValueError(f'{path.name}: 只支持非 RLE 的 flat RGBE .hdr')
        rgbe = data[:w * h * 4].reshape(h, w, 4).astype(np.float32)
        f = np.where(rgbe[..., 3:4] > 0, 2.0 ** (rgbe[..., 3:4] - 136.0), 0.0)
        return (rgbe[..., :3] * f).astype(np.float32)
    img = np.asarray(Image.open(path).convert('RGB'), np.float32) / 255.0
    return to_hdr(srgb_to_linear(img))


def make_sky_sampler(spec: dict, root: Path):
    """按 spec 造一个 `radiance(dir_world) -> rgb` 的取样器。

    三种取法（制作人指定）：

    1. `{'mode': 'color', 'color': [r,g,b], 'intensity': k}` —— 手动纯色；
    2. `{'mode': 'skybox', 'file': '...', 'intensity': k}` —— equirect 贴图，
       按逃逸方向采样（`.hdr` 或普通 8-bit 图都行）；
    3. `{'mode': 'derived', ...}` —— 由原画推导天光分布（**待定，见下**）。

    ⚠ 逃逸辐射与原画辐射的**比值**决定了室内画有多少 E 来自"画幅外"，
      它不会被 `gather_gain` 吸收（那个是整体缩放）。所以 `intensity` 是一个
      真正影响画面的旋钮，不是随便填的。
    ⚠ 取样器要能吃 **(3,) 单方向** 也能吃 **(n,3) 一批方向** —— 蒙特卡洛那条路
      每根光线的方向都不同，逐根调 Python 函数会慢两个数量级。
    """
    mode = spec.get('mode', 'color')
    gain = float(spec.get('intensity', 1.0))
    if mode == 'color':
        c = np.asarray(spec.get('color', [1.0, 1.0, 1.0]), np.float32) * gain

        def sample_c(dw: np.ndarray) -> np.ndarray:
            return np.broadcast_to(c, dw.shape) if dw.ndim > 1 else c
        return sample_c
    if mode == 'skybox':
        f = Path(spec['file'])
        img = (_load_skybox(f if f.is_absolute() else root / f) * gain).astype(np.float32)
        ih, iw = img.shape[:2]

        def sample_s(dw: np.ndarray) -> np.ndarray:
            a = np.atleast_2d(dw)
            u = (np.arctan2(a[:, 0], a[:, 2]) / (2.0 * math.pi) + 0.5) % 1.0
            v = np.arccos(np.clip(a[:, 1], -1.0, 1.0)) / math.pi
            out = img[np.minimum((v * ih).astype(np.int32), ih - 1),
                      np.minimum((u * iw).astype(np.int32), iw - 1)]
            return out if dw.ndim > 1 else out[0]
        return sample_s
    raise ValueError(f'未知的天空取法 {mode!r}（可选 color / skybox）')


def gather_directions() -> list[tuple[np.ndarray, float, bool]]:
    """全球面求积，**上半球那 48 个与 `sky_directions()` 逐位相同**。

    构造：把 `sky_directions()` 的 μ 节点（Gauss 在 [0,1] 上，权重和为 1）
    连同其镜像 −μ 一起用，权重相同 ⇒ 全球面权重和 = 2 ✓。这是在 [−1,0] 与
    [0,1] 上各做一次 Gauss 的**复合求积**，比在 [−1,1] 上做一次 Gauss-8 更准
    （每半球各有一簇节点；实测竖直面 0.48956 vs 0.48337，解析值 0.5）。

    这么构造的目的是**共用同一趟 march**：`E` 要绕全球面积（反弹光从下方来
    也要吃），天穹传输只数上半球逃逸。传输那一半的求积权重与 `sky_directions()`
    完全一致，所以解析锚点（无遮挡朝上 = 1.0、竖直 = 0.5）原封不动。

    第三个返回值 = 是否属于上半球（传输只累加这一半）。
    """
    out: list[tuple[np.ndarray, float, bool]] = []
    for dw, w in sky_directions():
        out.append((dw, w, True))
    for dw, w in sky_directions():
        d = dw.copy()
        d[1] = -d[1]
        out.append((d.astype(np.float32), w, False))
    return out


def march_and_gather(q: np.ndarray, dir_q: np.ndarray, ppu: float, cx: float, cy: float,
                     hdr: np.ndarray, acc: np.ndarray, wcos: np.ndarray) -> np.ndarray:
    """march + **命中即就地累加辐射**，返回未被挡的掩码。

    ## 出画语义：**钳到边缘继续判**，不做任何启发式

    ⚠ 这条曾经是真 bug。原来的判据带一个 `inside` 门：射线一旦离开画幅就默认
    **未被挡**。户外画面顶部本来就是天，看不出问题；**室内画幅填满墙面**，
    射线从侧边/底边出画照样被算成"看见天"，于是本该最暗的墙根 `T₀` 反而最高
    ——实测 `corr(log 亮度, T₀)` 在室内场景**变成负的**（梦_里屋 −0.65、义庄 −0.52）。

    试过"侧边/底边出画一律当挡住"：室内确实修好了，但 march 长 2.4 q ≈ 270 px，
    512 宽的画左右各半幅都会侧向出画，户外跟着变差，开阔处传输自检也从 1.000
    掉到 0.94。一刀切的启发式两头不讨好。

    现在的做法是**没有 `inside` 门**：采样坐标本来就 `clip` 到边界，于是出画的射线
    继续拿**边缘那一列/行**去判。室内边缘是墙 ⇒ 继续挡；户外顶部是天（深度最远）
    ⇒ 顺利通过。**没有自由参数，让数据决定。**

    ⚠ 还否掉过"只有底边算挡"：低仰角、朝相机方向的射线在这个 45° 伪世界里
    投影是**向下**的，从底边出画不代表撞地，那是投影假象。

    ⚠ 为什么把累加融进 march，而不是先把命中坐标取回来再统一采样：
      先取坐标的版本每步都要对**全图**写两张命中图（96 方向 × 18 步 ×
      两张 786k int32 ≈ 21 GB 内存流量）。而每一步真正**新命中**的只有一小撮
      像素 —— 只碰那一撮就够了。实测单场景 101s → 见下方 bake_gather。
    """
    h, w = q.shape[:2]
    depth_q = q[..., 2]
    blocked = np.zeros((h, w), np.bool_)
    step = MARCH_LENGTH / MARCH_STEPS
    for i in range(1, MARCH_STEPS + 1):
        t = step * i
        px = (q[..., 0] + dir_q[0] * t) * ppu + cx
        py = cy - (q[..., 1] + dir_q[1] * t) * ppu
        xi = np.clip(np.rint(px), 0, w - 1).astype(np.int32)
        yi = np.clip(np.rint(py), 0, h - 1).astype(np.int32)
        pen = (depth_q + dir_q[2] * t) - depth_q[yi, xi]
        bias = MARCH_BIAS + MARCH_BIAS_GROWTH * t
        now = (pen > bias) & (pen < MARCH_THICKNESS)
        newly = now & ~blocked
        if newly.any():
            acc[newly] += wcos[newly][:, None] * hdr[yi[newly], xi[newly]]
        blocked |= now
    return ~blocked


def bake_gather(q: np.ndarray, normal: np.ndarray, R: np.ndarray, ppu: float,
                cx: float, cy: float, hdr: np.ndarray, sky_of,
                progress: bool = True, spp: int = GATHER_SPP) -> tuple:
    """伪世界 final gather —— **蒙特卡洛 + 余弦重要性采样 + 不截断的射线**。

        E(x) = ∫ L_in(x,ω)·(N·ω)₊ dω  ÷  ∫ (N·ω)₊ dω

        L_in(x,ω) = HDR原画(命中点)   射线在伪世界里打到表面
                  = 天空(ω)          射线逃逸（烘焙期输入，见 make_sky_sampler）

    ## 为什么是蒙特卡洛而不是固定方向求积

    按 `pdf ∝ (N·ω)₊/π` 采样，估计量**就是样本的算术平均** —— 没有求积节点、
    没有权重表、没有"方位数×仰角节点"这种配比问题。误差是无偏噪声，按 √spp 退；
    而固定方向求积的误差是**结构性偏差**，加密方向也只是换一组偏差。

    实测（雾津街头 512 宽，以 512 spp 为参考）：

    | 方法 | 与参考的 \|Δ log E\| 中位 |
    |---|---|
    | 旧：96 方向均匀求积 + 射程 2.4 截断 | **0.1346** |
    | MC 16 spp | 0.1120 |
    | MC 64 spp | 0.0558 |
    | MC 256 spp | 0.0250 |

    **旧方法的偏差比只打 16 根随机光线的噪声还大。**

    ## 射线不截断

    终止条件只有三个，全是精确的，**没有"射程"这个参数**：

    1. 穿透进可见壳（打中）；
    2. 出画幅（离开重建出来的世界，之后没有任何信息）；
    3. 深度跑到全场景最前面之前 —— 再也不可能打中任何东西，提前收工（精确，不是近似）。

    ⚠ 旧的 `MARCH_LENGTH = 2.4 q` 在 ppu 112 下只有 **270 px**，而画就有 512 px 宽。
      超过这个距离的遮挡物**直接不算**，于是每个物体外围有一道不连续 —— 就是
      E 上肉眼可见的那一圈。离线计算没有任何理由截断。

    ## 天穹遮蔽同一趟出

        V(x)    = ⟨[逃逸 且 ω·up>0]⟩ ÷ cap₀(N)      cap₀(N) = (1+N·up)/2
        Bdir(x) = normalize( Σ_{逃逸且朝上} ω )

    ⚠ 分母用**解析闭式**而不是"朝上样本的计数"：后者在竖直面上只有一半样本，
      16 spp 时分母只剩 8，比值噪声会翻倍。闭式没有噪声。

    ## 第四个返回值：可见度的**线性重建** V(ω) ≈ a + b·ω

    定向光要问的是"**这个方向**挡不挡"，而 `(Bdir, V)` 回答不了 —— 归一化那一步
    把方向的置信度扔掉了，只剩一个"可见锥"，而锥对 delta 光源的判据**天生是二值的**
    （在锥内/锥外），过渡带宽度纯属人为。实测 `α−θ` 的 std 有 24.8°，18° 的过渡带
    让 78% 的像素直接饱和成 0/1 —— 那些"黑点"就是这么来的。

    改成用**同一批光线**做加权最小二乘：把每根光线的"逃逸与否"当观测值，
    对方向做一次线性拟合。矩阵就是样本自己的矩：

        [ Σ1    Σωᵀ ] [a]   [ Σesc    ]
        [ Σω    Σωωᵀ] [b] = [ Σesc·ω  ]

    四个未知数、每像素一个 4×4，闭式解。**没有任何自由参数**，天生连续，
    而且对"可见度确实随方向线性变化"的情形是精确的。
    """
    h, w = q.shape[:2]
    P = h * w
    Nf = normal.reshape(-1, 3).astype(np.float32)
    Q = q.reshape(-1, 3).astype(np.float32)
    dep = np.ascontiguousarray(q[..., 2], np.float32)
    img = hdr.astype(np.float32)
    # 逐像素切线基（世界系，法线为 +Z）
    upv = np.where(np.abs(Nf[:, 1:2]) < 0.9,
                   np.array([[0.0, 1.0, 0.0]], np.float32), np.array([[1.0, 0.0, 0.0]], np.float32))
    TA = np.cross(upv, Nf)
    TA /= np.maximum(np.linalg.norm(TA, axis=1, keepdims=True), 1e-8)
    TA = TA.astype(np.float32)
    TB = np.cross(Nf, TA).astype(np.float32)
    Rt = R.T.astype(np.float32)
    step = np.float32(GATHER_STEP_PX / ppu)
    bias = np.float32(MARCH_BIAS)
    grow = np.float32(MARCH_BIAS_GROWTH)
    dmin = float(dep.min())
    # ⚠ 固定种子：产物必须字节可复现（test_deterministic_bytes 锁着）。
    rng = np.random.default_rng(GATHER_SEED)

    acc = np.zeros((P, 3), np.float64)
    vis_num = np.zeros(P, np.float64)
    bent = np.zeros((P, 3), np.float64)
    # 可见度线性重建用的样本矩（S1/S2 是样本自己的，与逃逸无关）
    m_s1 = np.zeros((P, 3), np.float64)
    m_s2 = np.zeros((P, 6), np.float64)          # 对称阵的上三角 xx,yy,zz,xy,xz,yz
    m_t0 = np.zeros(P, np.float64)
    m_t1 = np.zeros((P, 3), np.float64)
    for s in range(spp):
        # 分层（ξ₁ 跨样本）+ 逐像素抖动的余弦重要性采样
        u1 = ((s + rng.random(P)) / spp).astype(np.float32)
        u2 = rng.random(P).astype(np.float32)
        r = np.sqrt(u1)
        phi = np.float32(2.0 * math.pi) * u2
        dw = (TA * (r * np.cos(phi))[:, None] + TB * (r * np.sin(phi))[:, None]
              + Nf * np.sqrt(np.maximum(1.0 - u1, 0.0))[:, None])
        dq = dw @ Rt.T
        idx = np.arange(P)
        ox, oy, oz = Q[:, 0].copy(), Q[:, 1].copy(), Q[:, 2].copy()
        dx, dy, dz = dq[:, 0].copy(), dq[:, 1].copy(), dq[:, 2].copy()
        rad = sky_of(dw).astype(np.float32).copy()      # 缺省：逃逸
        escaped = np.ones(P, np.bool_)
        tc = np.zeros(P, np.float32)
        while idx.size:
            tc += step
            xq = ox + dx * tc
            yq = oy + dy * tc
            zq = oz + dz * tc
            sx = xq * ppu + cx
            sy = cy - yq * ppu
            keep = ((sx >= 0) & (sx < w - 1) & (sy >= 0) & (sy < h - 1)
                    & (zq > dmin - 1e-3))
            if not keep.all():
                idx = idx[keep]
                if idx.size == 0:
                    break
                ox, oy, oz, dx, dy, dz, tc = (a[keep] for a in (ox, oy, oz, dx, dy, dz, tc))
                zq, sx, sy = zq[keep], sx[keep], sy[keep]
            xi = np.rint(sx).astype(np.int32)
            yi = np.rint(sy).astype(np.int32)
            pen = zq - dep[yi, xi]
            hit = (pen > bias + grow * tc) & (pen < MARCH_THICKNESS)
            if hit.any():
                hid = idx[hit]
                rad[hid] = img[yi[hit], xi[hit]]
                escaped[hid] = False
                k = ~hit
                idx = idx[k]
                if idx.size == 0:
                    break
                ox, oy, oz, dx, dy, dz, tc = (a[k] for a in (ox, oy, oz, dx, dy, dz, tc))
        acc += rad
        up_esc = escaped & (dw[:, 1] > 0.0)
        vis_num += up_esc
        bent += up_esc[:, None] * dw
        e64 = escaped.astype(np.float64)
        m_s1 += dw
        m_s2[:, 0] += dw[:, 0] * dw[:, 0]; m_s2[:, 1] += dw[:, 1] * dw[:, 1]
        m_s2[:, 2] += dw[:, 2] * dw[:, 2]; m_s2[:, 3] += dw[:, 0] * dw[:, 1]
        m_s2[:, 4] += dw[:, 0] * dw[:, 2]; m_s2[:, 5] += dw[:, 1] * dw[:, 2]
        m_t0 += e64
        m_t1 += e64[:, None] * dw
        if progress and (s + 1) % 4 == 0:
            print(f'    gather {s + 1:03d}/{spp} spp', flush=True)

    e = (acc / spp).reshape(h, w, 3).astype(np.float32)
    cap0 = np.maximum((1.0 + Nf[:, 1]) * 0.5, 1.0 / 255.0)
    vis = np.clip(vis_num / spp / cap0, 0.0, 1.0).reshape(h, w).astype(np.float32)
    bn = bent / np.maximum(np.linalg.norm(bent, axis=1, keepdims=True), 1e-9)
    # 一根都没逃出去的像素：方向未定义，退回法线（那儿 V=0，方向不参与计算）
    dead = np.linalg.norm(bent, axis=1) < 1e-9
    bn[dead] = Nf[dead]
    bn = bn.reshape(h, w, 3).astype(np.float32)

    # ---- 可见度的线性重建：逐像素解 4×4 ----
    A = np.empty((P, 4, 4), np.float64)
    A[:, 0, 0] = spp
    A[:, 0, 1:] = m_s1; A[:, 1:, 0] = m_s1
    A[:, 1, 1] = m_s2[:, 0]; A[:, 2, 2] = m_s2[:, 1]; A[:, 3, 3] = m_s2[:, 2]
    A[:, 1, 2] = A[:, 2, 1] = m_s2[:, 3]
    A[:, 1, 3] = A[:, 3, 1] = m_s2[:, 4]
    A[:, 2, 3] = A[:, 3, 2] = m_s2[:, 5]
    rhs = np.empty((P, 4), np.float64)
    rhs[:, 0] = m_t0; rhs[:, 1:] = m_t1
    # ⚠ 岭正则：spp 小时 S2 会接近奇异（样本都挤在 N 附近）。λ 很小，
    #   作用是把无信息的方向拉回"各向同性"，不是调出来的旋钮。
    A[:, 1, 1] += 1e-3 * spp; A[:, 2, 2] += 1e-3 * spp; A[:, 3, 3] += 1e-3 * spp
    vfit = np.linalg.solve(A, rhs[..., None])[..., 0].astype(np.float32).reshape(h, w, 4)

    vis = gaussian_filter(vis, 0.8)
    for c in range(3):
        bn[..., c] = gaussian_filter(bn[..., c], 0.8)
        e[..., c] = gaussian_filter(e[..., c], 0.8)
    for c in range(4):
        vfit[..., c] = gaussian_filter(vfit[..., c], 0.8)
    bn /= np.maximum(np.linalg.norm(bn, axis=-1, keepdims=True), 1e-9)
    return e, np.clip(vis, 0.0, 1.0), bn.astype(np.float32), vfit


#: 直射光方向扫描的分辨率（仰角 × 方位）。**先拟合再比较**，不是纯相关。
SUN_SCAN_EL, SUN_SCAN_AZ = 7, 16

#: 直射光解出来之后，色度允许偏离中性的范围。方向不准时逐通道求解会跑到边界
#: （实测某次解出 [2.49, 0.51, 0.00]），钳住让它露出来而不是悄悄污染 base。
SUN_CHROMA_CLAMP = (0.78, 1.28)


def direct_visibility(vfit: np.ndarray, dw: np.ndarray) -> np.ndarray:
    """某个方向的可见度 `V(ω) ≈ clamp(a + b·ω, 0, 1)`。

    ⚠ **这是定死的做法，不要再换。** 曾经用过"可见锥"：把 bent 方向归一化、
      锥半角由 `sin²α = V` 给、锥内锥外加一段人为宽度的 smoothstep。那条错在
      两点：① 归一化把方向的**置信度**扔了，低可见度的像素（逃逸样本只有一两根）
      bent 方向方差极大；② 锥对 delta 光源的判据**天生二值**，过渡带宽度纯属人为。
      实测 `α−θ` 的 std 24.8° 而过渡带 ±9° ⇒ 78% 的像素饱和成 0/1，
      低 V 处冒出成片椒盐黑点（V<0.15 的区间黑点密度是 V>0.6 的 **300 倍**）。

    现在用 `bake_gather` 顺带解出的线性重建，天生连续、无自由参数，
    实测孤立黑点 **0.0000%**。代价：线性模型表达不了陡的遮蔽，
    对 base 的解释力比锥体低约 2 个百分点。这个交换是**故意**的。
    """
    return np.clip(vfit[..., 0] + vfit[..., 1:] @ np.asarray(dw, np.float32), 0.0, 1.0)


def solve_direct_light(normal: np.ndarray, vfit: np.ndarray, hdr: np.ndarray,
                       e_ind: np.ndarray, progress: bool = True) -> dict:
    """从原画反解一个**直射光**：方向、强度、颜色。

    ## 为什么需要它

    gather 出来的 `E` 只有天空 + 画面反弹，**没有任何一项是"光源直接照到 x"**。
    于是画里由直射光造成的大尺度明暗除不掉，全留在 `base` 里。实测：户外场景
    "开阔处比天穹可见度能解释的亮 41%"，无论天空开多大都补不上；室内场景没有
    这个缺口（本来就没直射光）。

    ## 方向：先拟合再比较

    每个候选方向都用**同一个自由度**（一个标量 L，由中位匹配解出），再比拟合后
    `std(log base)`。方向不对时 L 会解成 0、原样返回基线 —— 于是"有解的方向"
    自己聚成一个连贯盆地。⚠ 不要退回纯相关判据：那个在高仰角处会被余弦项和
    AO 项冒充（`V·(N·ω)₊ ≈ N·up` 正是天空剖面能给的东西），峰会飘到天顶。
    """
    lw = np.array([0.2126, 0.7152, 0.0722], np.float32)
    Il = (hdr @ lw).astype(np.float64)
    El = (e_ind @ lw).astype(np.float64)
    base0 = Il / np.maximum(El, 1e-6)
    sd0 = float(np.std(np.log(np.maximum(base0, 1e-9))))
    best = None
    for ie in range(SUN_SCAN_EL):
        el = (ie + 0.5) / SUN_SCAN_EL * (math.pi / 2)
        for ia in range(SUN_SCAN_AZ):
            az = 2 * math.pi * ia / SUN_SCAN_AZ
            dw = np.array([math.cos(el) * math.sin(az), math.sin(el),
                           math.cos(el) * math.cos(az)], np.float32)
            cosn = np.clip(normal @ dw, 0.0, None).astype(np.float64)
            S = cosn * direct_visibility(vfit, dw).astype(np.float64)
            band = (cosn > 0.35) & (cosn < 0.95)
            lit = band & (S > np.percentile(S[S > 0], 70) if (S > 0).any() else band)
            sha = band & (S < np.percentile(S[S > 0], 30) if (S > 0).any() else band)
            if lit.sum() < 2000 or sha.sum() < 2000:
                continue
            def ratio(v: float) -> float:
                b = Il / np.maximum(El + v * S, 1e-6)
                return float(np.median(b[lit]) / max(np.median(b[sha]), 1e-12))
            if ratio(0.0) <= 1.0:
                continue
            lo, hi = 0.0, 64.0
            while ratio(hi) > 1.0 and hi < 1e5:
                hi *= 2
            for _ in range(40):
                m = 0.5 * (lo + hi)
                if ratio(m) > 1.0:
                    lo = m
                else:
                    hi = m
            L = 0.5 * (lo + hi)
            b = Il / np.maximum(El + L * S, 1e-6)
            sd = float(np.std(np.log(np.maximum(b, 1e-9))))
            if best is None or sd < best['sd']:
                best = dict(sd=sd, dir=dw, el=math.degrees(el), az=math.degrees(az), S=S, cosn=cosn)
        if progress:
            print(f'    直射光扫描 仰角 {math.degrees(el):4.1f}°', flush=True)
    if best is None:
        return dict(found=False, note='没有任何方向能解出直射光（阴天 / 室内）',
                    dir=[0.0, 1.0, 0.0], radiance=[0.0, 0.0, 0.0],
                    std_before=sd0, std_after=sd0, drop=0.0)
    S = best['S']
    # 强度：一维极小，不是中位匹配 —— 后者对"无阴影"的变体无解，这个对谁都有定义
    def cost(v: float) -> float:
        b = Il / np.maximum(El + v * S, 1e-6)
        return float(np.std(np.log(np.maximum(b, 1e-9))))
    lo, hi = 0.0, 64.0
    while cost(hi) < cost(hi * 0.5) and hi < 4096:
        hi *= 2
    for _ in range(60):
        a1 = lo + (hi - lo) * 0.382
        b1 = lo + (hi - lo) * 0.618
        if cost(a1) < cost(b1):
            hi = b1
        else:
            lo = a1
    lum = 0.5 * (lo + hi)
    cosn = best['cosn']
    vis = S / np.maximum(cosn, 1e-6)
    lit = (cosn > 0.3) & (vis > 0.8)
    sha = (cosn > 0.3) & (vis < 0.4)
    if sha.sum() > 500 and lit.sum() > 500:
        r = np.array([np.median(hdr[..., c][lit]) / max(np.median(hdr[..., c][sha]), 1e-12)
                      for c in range(3)])
        ch = r / max(r.mean(), 1e-9)
    else:
        ch = np.ones(3)
    ch = np.clip(ch, *SUN_CHROMA_CLAMP)
    ch = ch / ch.mean()
    L = (lum * ch / max(float(ch @ lw), 1e-9)).astype(np.float32)
    sd = cost(lum)
    return dict(found=True, dir=[float(v) for v in best['dir']],
                elevation_deg=best['el'], azimuth_deg=best['az'],
                radiance=[float(v) for v in L], chroma=[float(v) for v in ch],
                std_before=sd0, std_after=sd, drop=float(1 - sd / max(sd0, 1e-9)),
                lit_frac=float(np.mean(vis > 0.8)))


def fit_runtime_lights(e: np.ndarray, t0: np.ndarray, ao: np.ndarray) -> dict:
    """求运行时的默认灯光强度，使 `E_目标 ≈ E`（未调过的场景画面因此≈原画）。

        E_目标 = sky·T₀ + ambient·(0.28 + 0.72·AO)      T₀ = V·(1+N·up)/2

    ⚠ 这**不是**在拟合原画 —— `E` 已经被 final gather 算定了，这里只问：
      运行时那两个可调项要设成多少，才能重现这份**已经算好的**辐照度。
      两个基、非负最小二乘、闭式解；没有网格搜索，没有自定义判据。
      （我先前那套「拿四个系数去回归原画」正是错在把这两件事混成一件。）
    """
    from scipy.optimize import nnls
    sub = (slice(None, None, 3), slice(None, None, 3))
    b1 = t0[sub].ravel().astype(np.float64)
    b2 = np.clip(0.28 + 0.72 * ao[sub], 0.0, 1.2).ravel().astype(np.float64)
    lum = (e[sub] @ np.array([0.2126, 0.7152, 0.0722], np.float32)).ravel().astype(np.float64)
    A = np.stack([b1, b2], 1)
    coef, _res = nnls(A, lum)
    pred = A @ coef
    rgb = e.reshape(-1, 3).mean(axis=0)
    return {
        'sky': float(coef[0]), 'ambient': float(coef[1]),
        'rel_err': float(np.abs(pred - lum).mean() / max(float(lum.mean()), 1e-9)),
        'e_rgb_mean': [float(v) for v in rgb],
        'e_chroma': [float(v / max(float(rgb.mean()), 1e-9)) for v in rgb],
    }


# -------------------------------------------------------------------- 去霾

#: 去霾时**每个通道至少留下**的比例。
#:
#: 存在的唯一理由：让减法结构上不可能把某个通道钳到 0。霾是**有颜色**的
#: （实测雾津街头 hazeColor = (0.835, 1.021, 1.144)，蓝减得最多、红最少），
#: 绝对量的减法配上有颜色的霾，会在暗部把通道**非对称地清零**：蓝绿先死、
#: 红活下来 ⇒ 画面上一片红色噪点。实测该场景 7.23% 的像素被部分钳零
#: （其中 84% 只剩红通道）、**孤立零点（肉眼看到的噪点）占 5.02%**。
#:
#: 改成按自身设下限后：孤立零点 5.02% → **0.002%**，且钳住时是整体按比例缩小
#: ⇒ **色度守恒**，不会凭空冒出彩点。
#:
#: ⚠ 这段算术从 v2 的运行时 shader **搬过来**的（v3 运行时不再有原画，
#:   去霾必须在产出等价 albedo 之前做完）。搬的时候务必用**下限法**，
#:   不要退回 `max(x − haze, 0)` 那种硬钳 —— 那正是上面那串数字的来源。
HAZE_KEEP = 0.1


def fit_haze(lin: np.ndarray, depth: np.ndarray) -> dict:
    """拟合原画里的**白天大气散射**（aerial perspective）。

    `原画 = 表面辐射 × T(d) + 白天的霾 × (1−T(d))`。霾**不是表面**，是被日光照亮的
    空气。重打光只处理表面项，霾就会在夜里继续亮着 —— 实测雾津街头远景比近景亮
    **4.32 倍**，而"远处一片亮灰"正是大脑判定「这是白天」最强的信号之一。
    不除掉它，无论怎么压暗调冷，看着永远像**低亮度的白天**。

    判据是**暗通道先验**：黑表面上剩下的就是霾。按视深分层取暗通道低分位，
    拟合 `haze(d) = H·(1 − exp(−k·d))`。
    """
    d_lo, d_hi = float(depth.min()), float(depth.max())
    dn = ((depth - d_lo) / max(d_hi - d_lo, 1e-6)).ravel()
    dark = lin.min(-1).ravel()
    edges = np.linspace(0.0, 1.0, 21)
    xs, ys = [], []
    for i in range(20):
        m = (dn >= edges[i]) & (dn < edges[i + 1])
        if m.sum() < 300:
            continue
        xs.append((edges[i] + edges[i + 1]) * 0.5)
        ys.append(float(np.percentile(dark[m], 3)))
    if len(xs) < 4:
        return {'k': 0.0, 'strength': 0.0, 'color': [1.0, 1.0, 1.0],
                'depth_min': d_lo, 'depth_max': d_hi, 'residual': 0.0}
    xs_a = np.asarray(xs, np.float64)
    ys_a = np.asarray(ys, np.float64)
    best = (1e18, 0.0, 0.0)
    for k in np.arange(0.2, 8.001, 0.05):
        b = 1.0 - np.exp(-k * xs_a)
        H = float((b @ ys_a) / max(b @ b, 1e-12))
        r = float(((H * b - ys_a) ** 2).mean())
        if r < best[0]:
            best = (r, float(k), H)
    residual, k, H = best
    far = dn >= 0.85
    if far.sum() > 200:
        c = np.percentile(lin.reshape(-1, 3)[far], 5, axis=0)
    else:
        c = np.array([1.0, 1.0, 1.0], np.float32)
    c = c / max(float(c.mean()), 1e-6)                 # 归一色度
    return {'k': k, 'strength': max(H, 0.0), 'color': [float(v) for v in c],
            'depth_min': d_lo, 'depth_max': d_hi, 'residual': residual}


def apply_dehaze(lin: np.ndarray, depth: np.ndarray, haze: dict) -> np.ndarray:
    """把拟合出来的白天散射从线性原画里除掉。**逐通道下限法，不是硬钳**。"""
    if haze['strength'] <= 0:
        return lin
    dn = np.clip((depth - haze['depth_min'])
                 / max(haze['depth_max'] - haze['depth_min'], 1e-5), 0.0, 1.0)
    trans = np.exp(-haze['k'] * dn)[..., None]
    amount = np.asarray(haze['color'], np.float32)[None, None, :] * (
        haze['strength'] * (1.0 - trans))
    # ★ 每个通道最多拿走自身的 (1−HAZE_KEEP) —— 结构上保证非负且色度守恒
    return ((lin - np.minimum(amount, lin * (1.0 - HAZE_KEEP)))
            / np.maximum(trans, 0.15)).astype(np.float32)


# ------------------------------------------------------------------ 产物

def preview_gray(x: np.ndarray, lo: float | None = None, hi: float | None = None) -> bytes:
    if lo is None or hi is None:
        lo, hi = (float(v) for v in np.percentile(x, [1, 99]))
    v = np.clip((x - lo) / max(hi - lo, 1e-6), 0.0, 1.0)
    return _png_bytes(np.round(v * 255).astype(np.uint8), 'L')


def resize_encoded(u8: np.ndarray, size: tuple[int, int]) -> np.ndarray:
    """对**编码字节**做双线性升采样，返回浮点字节值（还没解码）。

    ⚠ 必须在编码域插值，不能先解码再插值 —— 因为**运行时就是这么做的**：
    GPU 的线性过滤作用在纹理字节上，之后 shader 才解码。对数编码下这两条路
    不等价（编码域的线性插值 = 线性域的**几何平均**）。

    烘焙侧若按"先解码再插值"算 `E`，据此反推的 `base` 就与运行时实际拿到的
    `E` 对不上，而**往返指标测不出来**（它用的是烘焙自己那份 E）—— 典型的
    "指标全绿但画面偏一点点"的盲点。所以这里逐字照抄 GPU 的顺序。
    """
    return np.stack([resize_f(np.ascontiguousarray(u8[..., c].astype(np.float32)), size)
                     for c in range(u8.shape[-1])], -1)


# -------------------------------------------------------------------- 主流程

def resolve_sky_spec(scene, override: dict | None = None) -> dict:
    """这个场景烘焙时用哪种逃逸辐射。优先级：命令行 > 场景 JSON > 缺省。

    场景 JSON 里写在 `lighting.bakeSky`，**运行时不读它** —— 那是烘焙期输入。
    """
    if override:
        return dict(override)
    from .geometry import scene_paths
    blk = (scene_paths(scene.sid)['data'].get('lighting') or {}).get('bakeSky')
    return dict(blk) if blk else dict(DEFAULT_SKY)


def bake(sid: str, work_w: int = WORK_W, progress: bool = True,
         sky: dict | None = None) -> dict:
    scene = Scene(sid)
    if scene.depth_native is None:
        raise RuntimeError(f'{sid}: 没有 depthConfig / 深度图，无法烘 G-buffer')
    nw, nh = scene.native
    w = min(work_w, nw)
    h = max(1, round(nh * w / nw))

    geo = scene.geometry((w, h), normal_sigma=0.8)
    R = geo['R']
    ppu, cx, cy = geo['ppu'], geo['cx'], geo['cy']
    d = geo['depth']
    px = np.arange(w, dtype=np.float32)[None, :].repeat(h, 0)
    py = np.arange(h, dtype=np.float32)[:, None].repeat(w, 1)
    q = np.stack([(px - cx) / ppu, (cy - py) / ppu, d], -1).astype(np.float32)
    world = geo['pos'].astype(np.float32)

    if progress:
        print(f'  [{sid}] work {w}x{h}  ppu={ppu:.2f}', flush=True)
    normal = edge_safe_normals(world, R)

    bg_work = resize_rgb(scene.bg_srgb, (w, h)) if (w, h) != scene.native else scene.bg_srgb
    lin_work = srgb_to_linear(bg_work)
    # ⚠ **必须先去霾**：霾是被日光照亮的空气，不是表面。把它喂进 final gather
    #   等于让远处一片亮灰当光源用，近处会被它照亮 —— 而重打光只处理表面项，
    #   夜里那片霾还会继续亮着（实测雾津街头远/近亮度比 4.32）。
    haze = fit_haze(lin_work, d)
    lin_work = apply_dehaze(lin_work, d, haze)
    hdr_work = to_hdr(lin_work)
    sky_spec = resolve_sky_spec(scene, sky)
    sky_of = make_sky_sampler(sky_spec, _ROOT)

    # ★ 一趟 march 同时出辐照度与天穹传输 —— 两者是同一个积分的两个投影
    e_ind, sky_vis, bent, vfit = bake_gather(q, normal, R, ppu, cx, cy, hdr_work, sky_of, progress)
    # ★ 直射光。gather 出的 E **只有间接光**（天空 + 画面反弹），画里由直射造成的
    #   大尺度明暗除不掉、全留在 base 里。这一步把它反解出来补进 E。
    sun = solve_direct_light(normal, vfit, hdr_work, e_ind, progress)
    if sun['found']:
        sdir = np.asarray(sun['dir'], np.float32)
        S = (np.clip(normal @ sdir, 0.0, None) * direct_visibility(vfit, sdir)).astype(np.float32)
        e = e_ind + np.asarray(sun['radiance'], np.float32)[None, None, :] * S[..., None]
    else:
        e = e_ind
    # 无遮挡时的 y⁰ 传输，解析闭式 cap₀ = (1+N·up)/2。运行时是 sc3SkyShIrradiance
    # 干这件事，这里只为把默认灯光解出来（两边同一个式子）。
    t0 = sky_vis * ((1.0 + normal[..., 1]) * 0.5)
    ao = bake_local_ao(q, normal, R, ppu, cx, cy, progress)
    rt_fit = fit_runtime_lights(e, t0, ao)

    # ---- 比例基底出**原生分辨率** ----
    # ⚠ 它不是辅助图，它**就是背景**（运行时渲的是 基底 × E_目标，原画不再进渲染
    #   路径）。烘在 work 分辨率等于把背景降采样 4 倍，画面直接糊。
    #   `E` / 传输 / 法线都是低频量，work 分辨率足够 ⇒ 把 `E` 升采样到原生再除。
    # ★ 整体增益：把"伪世界里没有的光"吸收进 E 的尺度。
    #
    #   `base = L_出射 / E` 对朗伯面**就等于反射率**，物理上 ≤ 1。实测 k=1 时
    #   temple 20.1%、mountain_pass 17.0% 的像素超过 1 —— 那不是它们在发光，
    #   是 **E 被系统性低估**：伪世界的 gather 只有天穹 + 周围表面的辐射，
    #   没有太阳（被日光直射的岩面收到的光远超这两者），也没有多次反弹。
    #
    #   `E` 的整体尺度**本来就是自由的**：E 放大 k 倍、base 缩小 k 倍，
    #   `gi=1` 时输出 `base·E` 完全不变。于是取
    #   `k = p95(L/E)`（见 GATHER_GAIN_PERCENTILE），让 base 的 p95 落在 1：
    #   · 超出的那 ~5% 被上限钳住 —— 真正发光的灯 / 火 / 天就在这一档，
    #     它们现在由作者摆真灯来出
    #   · base 铺满 [0,1]，编码量程不浪费
    #
    #   ⚠ 代价说清楚：日照与阴影的**结构**差异因此被留在 base 里当"材质"，
    #     重打光时太阳不会跟着动。伪世界没有太阳，这是诚实的边界，不是 bug。
    #   ⚠ 天必须排除：天不是表面，`L/E` 在那里冲到几百，会把增益整个带偏。
    ratio = (hdr_work / np.maximum(e, 1e-4)).max(-1)
    gather_gain = float(np.clip(np.percentile(ratio, GATHER_GAIN_PERCENTILE),
                                1.0, GATHER_GAIN_MAX))
    e = (e * gather_gain).astype(np.float32)

    # ★ **先量化 E，再据量化后的 E 反推 base**。
    #   顺序反过来的话，运行时拿到的是量化过的 E，而 base 是按精确 E 算的，
    #   `base·E_q ≠ 原画` —— 端到端就不再恒等。
    #   编码走**对数**（见 HDR_LOG_SPAN）：E 的动态范围是 400 倍量级，
    #   只有对数编码能全程保住相对精度。
    e_scale_enc, e_span = pick_log_params(e)
    e8 = encode_log_hdr(e, e_scale_enc, e_span)
    e_q = decode_log_hdr(e8, e_scale_enc, e_span)
    e_native = (decode_log_hdr(resize_encoded(e8, scene.native), e_scale_enc, e_span)
                if (w, h) != scene.native else e_q)
    d_native = resize_f(d, scene.native) if (w, h) != scene.native else d
    lin_native = apply_dehaze(srgb_to_linear(scene.bg_srgb), d_native, haze)
    hdr_native = to_hdr(lin_native)
    # ★ 比例基底。**一个除法，没有别的**：
    #
    #       base = I / E              恒等:  base·E ≡ I     （处处成立，无例外）
    #
    #   ⚠ 这里**没有"自发光"这个概念**（2026-08-23，制作人原话：「现在不需要任何的
    #     自发光了，光都是单独打」「把自发光的概念都删掉」）。历史上试过两种，
    #     都被否了，写在这里防止有人再加回来：
    #
    #     1. 拆出一张 `emissive.png` 存 `max(I − base·E, 0)`，运行时原样加回。
    #        后果：那批像素**永远不跟着灯变**（实测 7%–12% 的画面）。
    #     2. 只保留上限 `base = min(I/E, 1)`、把超出的部分丢掉，外加
    #        `base[sky] = 0`（"天是光不是表面"）。后果：**天空区直接变成一块死黑**，
    #        灶口/灯笼也凭空暗一截。上限和那个天空特判**本身就是自发光的概念**，
    #        换了个说法而已。
    #
    #   所以现在就是一条除法：画里多亮，`base·E` 就多亮，`E` 变了整张图一起变。
    base = hdr_native / np.maximum(e_native, 1e-4)
    # ★ base 走**对数**编码。
    #
    #   ⚠ 不设上限之后动态范围是真的大（实测 teahouse 跨 22 档、max 1541），
    #     而对数编码的相对精度**全程恒定**（跨度 S 时每级 ln2·S/255），
    #     正好是这种量该用的编码 —— 换成 sRGB8 或线性，暗端一档就是 100% 相对误差。
    #   ⚠ 跨度按数据定（见 pick_log_params），不写死。
    scale, base_span = pick_log_params(base)
    enc = encode_log_hdr(base, scale, base_span)
    base_q = decode_base(enc, scale, base_span)

    # ---- 定义性质断言：E_目标 = E 时输出必须等于原画 ----
    # 量的是**存储精度** —— 恒等式本身没有近似，误差只可能来自 base 与 E 的量化。
    #
    # ⚠ 比的是**去霾后**的原画：去霾是刻意的信息移除（把空气从表面里拿掉），
    #   拿它跟原始 PNG 比等于把"该去掉的东西"算成误差。
    round_lin = from_hdr(base_q * e_native)
    err_all = np.abs(linear_to_srgb(round_lin) - linear_to_srgb(lin_native)) * 255.0
    err = err_all
    rt = {
        'mean_255': float(err.mean()),
        'p99_255': float(np.percentile(err, 99)),
        'max_255': float(err.max()),
    }

    # ---- 角色侧：方向性天穹传输网格 ----
    from .bake import character_band_wu
    band = character_band_wu(scene)
    # ⚠ 辐射场要和场景侧**同一个尺度**：场景那边是 `e * gather_gain`，
    #   所以这里喂进去的辐射也整体乘 gain。只乘 sky_rgb 不乘 hdr 会让角色
    #   与背景差一个 gain 倍 —— 而 gain 逐场景不同（实测 1–12），
    #   症状是"角色在有些场景偏亮、有些偏暗"，极难查。
    char_grid = char_grid_for(world, band['char_wu'], band['band'])
    if progress:
        print(f'  [{sid}] 角色空间数据 {char_grid[0]}x{char_grid[1]}x{char_grid[2]}'
              f' = {char_grid[0] * char_grid[1] * char_grid[2]} 格'
              f'（旧的写死 {CHAR_GRID[0]}x{CHAR_GRID[1]}x{CHAR_GRID[2]}）', flush=True)
    sh = bake_sky_sh_grid(d, R, ppu, cx, cy, world, band['band'],
                          hdr_work * gather_gain,
                          lambda dw, f=sky_of, g=gather_gain: f(dw) * g,
                          grid=char_grid, progress=progress)

    out = scene.rt_dir / 'lighting3'
    _atomic_bytes(out / 'base.png', _png_bytes(enc, 'RGB'))
    # 天穹遮蔽一张 RGBA8：RGB = bent 方向·½+½，A = 余弦加权可见度。低频量，
    # 量化步长 0.007，比 f32 小 4 倍且 GPU 直接能采。
    occ8 = np.empty(bent.shape[:2] + (4,), np.uint8)
    occ8[..., :3] = np.round(np.clip(bent * 0.5 + 0.5, 0, 1) * 255.0)
    occ8[..., 3] = np.round(np.clip(sky_vis, 0, 1) * 255.0)
    _atomic_bytes(out / 'sky_occlusion.png', _png_bytes(occ8, 'RGBA'))
    # ★ 可见度的线性重建 `V(ω) ≈ clamp(a + b·ω, 0, 1)`：**任意方向**的遮蔽都靠它，
    #   运行时换太阳方向不需要重烘，也不需要 march。见 direct_visibility 的注释。
    vb_max = float(max(np.abs(vfit[..., 1:]).max(), 1e-3))
    vf8 = np.empty(vfit.shape[:2] + (4,), np.uint8)
    vf8[..., :3] = np.round(np.clip(vfit[..., 1:] / (2.0 * vb_max) + 0.5, 0, 1) * 255.0)
    vf8[..., 3] = np.round(np.clip(vfit[..., 0], 0, 1) * 255.0)
    _atomic_bytes(out / 'vis_linear.png', _png_bytes(vf8, 'RGBA'))
    # 局部 AO 单独一张 R8。⚠ 它**不是** sky_occlusion 的第五个通道：RGBA 已排满，
    # 而且两者语义不同（长程天穹 vs 短程封闭度），混在一张图里迟早有人拿错通道。
    _atomic_bytes(out / 'ao.png',
                  _png_bytes(np.round(np.clip(ao, 0, 1) * 255).astype(np.uint8), 'L'))
    # ★ 烘焙 GI。**这是正式载荷，不是调试图**：运行时的 `E_目标` 默认就是它
    #   （`gi = 1` ⇒ 输出 = base·E ≡ min(原画, E)，精确到量化）。
    #   作者要重打光就把 `gi` 调低、把天光/灯加上去 —— 这是一条连续的路，
    #   不是"要么原画要么全新"的开关。角色可选择吃同一份（用户明确要的
    #   "融入场景"），当前按要求关着。
    e_lum = e_q @ np.array([0.2126, 0.7152, 0.0722], np.float32)
    _atomic_bytes(out / 'irradiance.png', _png_bytes(e8, 'RGB'))
    nrm8 = np.round(np.clip(normal * 0.5 + 0.5, 0, 1) * 255).astype(np.uint8)
    _atomic_bytes(out / 'normal.png', _png_bytes(nrm8, 'RGB'))
    _atomic_bytes(out / 'sky_sh_grid.bin', sh['packed'].tobytes())

    prev = out / 'preview'
    _atomic_bytes(prev / 'base.png', _png_bytes(enc, 'RGB'))
    _atomic_bytes(prev / 'normal.png', _png_bytes(nrm8, 'RGB'))
    _atomic_bytes(prev / 'irradiance.png', preview_gray(e_lum, 0.0, float(np.percentile(e_lum, 99))))
    # 载荷里存的那两个量，各出一张：
    #   sky_visibility —— 余弦加权可见度 V，与 `ao.png` 同口径可以直接并排比
    #   bent_normal    —— 平均未遮挡方向，遮蔽重的地方光实际是从哪进来的
    # 运行时同一对量在 F2 的 4 号 / 5 号视图（见 shadeCore3.sc3SkyIrradiance）。
    _atomic_bytes(prev / 'sky_visibility.png', preview_gray(sky_vis, 0.0, 1.0))
    _atomic_bytes(prev / 'bent_normal.png', _png_bytes(occ8[..., :3].copy(), 'RGB'))
    # 传输 T₀ = V·cap₀(N)：**只是给人看"为什么某处亮"的中间量**，不进载荷。
    # ⚠ 直接看它看到的主要是法线明暗（cap₀ 实测中位 0.70、值域 0.15–1.0）——
    #   桥洞底下和开阔水面一样亮。判断遮蔽对不对要看 sky_visibility。
    _atomic_bytes(prev / 'sky_transport_y0.png', preview_gray(t0, 0.0, 1.0))
    _atomic_bytes(prev / 'ao.png', preview_gray(ao, 0.0, 1.0))
    _atomic_bytes(prev / 'roundtrip_err_x16.png',
                  _png_bytes(np.round(np.clip(err_all.mean(-1) * 16, 0, 255)).astype(np.uint8), 'L'))

    meta = {
        'version': PAYLOAD_VERSION,
        'background_sha1': None,
        'work': {'w': w, 'h': h},
        'native': {'w': nw, 'h': nh},
        'cal': {'ppu': float(ppu), 'cx': float(cx), 'cy': float(cy)},
        'M': [[float(v) for v in row] for row in R],
        # ★ 刻度链。**运行时靠 scene_per_wu 把作者面的 wu 折进 march 的 q 空间**
        #   （`SceneLightingSystem.wuPerQUnit`），少了它整包装载即抛。
        #   ⚠ 我第一版漏了这一节：TS 类型声明了 `scale`，`tsc` 因此全绿，
        #     数据里却没有 —— 只有真机跑起来才炸。类型声明不是数据契约。
        'scale': {'char_wu': band['char_wu'], 'scene_per_wu': band['scene_per_wu']},
        'vis_linear': {
            'file': 'vis_linear.png',
            'encoding': 'rgba8; rgb = b/(2*b_max)+0.5, a = a0. V(w) = clamp(a0 + b.w, 0, 1)',
            'b_max': vb_max,
            'note': '可见度对方向的线性重建（同一批光线做的加权最小二乘）。'
                    '任意方向的遮蔽都用它 —— 不用 march、无自由参数、天生连续。'
                    '曾用"可见锥 + 人为过渡带"，对 delta 光源天生二值、低可见度处成片黑点，已废弃。',
        },
        'direct_light': dict(sun),
        'sky_occlusion': {
            'file': 'sky_occlusion.png',
            'encoding': 'rgba8; rgb = bent_dir*0.5+0.5, a = cosine-weighted visibility',
            'directions': SKY_AZIMUTHS * SKY_GAUSS_NODES,
            'quadrature': 'gauss-legendre in sin(elevation) x uniform azimuth',
            'note': '与 irradiance 同一趟 march 出（上半球逃逸那一半）；'
                    '天空不在载荷里，是运行时的全局 SH（src/rendering/lighting/skySh.ts）',
        },
        'march': {
            'steps': MARCH_STEPS, 'length': MARCH_LENGTH,
            'bias': MARCH_BIAS, 'bias_growth': MARCH_BIAS_GROWTH,
            'thickness': MARCH_THICKNESS,
        },
        'ao': {'file': 'ao.png', 'encoding': 'r8',
               'min': float(ao.min()), 'max': float(ao.max()), 'mean': float(ao.mean())},
        'irradiance': {
            'file': 'irradiance.png',
            'note': '烘焙 GI —— 正式载荷。gi=1 时 base·E ≡ min(原画, E)',
            'method': 'pseudo-world final gather; L_in = HDR(painting) at hit, sky radiance on escape',
            'encoding': ('u8 log2; decode: scale * 2^((px/255 - 0.5) * log_span)'),
            'scale': e_scale_enc, 'log_span': e_span,
            'w': w, 'h': h,
            'hdr_max': HDR_MAX,
            'gather_gain': gather_gain,
            'sky_source': dict(sky_spec),
            'directions': len(gather_directions()),
            'min': float(e_lum.min()), 'max': float(e_lum.max()), 'mean': float(e_lum.mean()),
        },
        # 运行时默认灯光：让 `E_目标 ≈ E`，于是未调过的场景画面≈原画。
        # ⚠ 这是拿运行时的参数化去逼近**已经算好的 E**，不是去回归原画。
        'runtime_fit': rt_fit,
        'base': {
            'file': 'base.png',
            'encoding': ('u8 log2, byte 0 means exactly 0; '
                         'decode: px>0 ? scale * 2^((px/255 - 0.5) * log_span) : 0'),
            'log_span': base_span,
            'w': nw, 'h': nh,
            'note': 'I_原画 / E —— 比例式的中间因子，不是 albedo；'
                    'native 分辨率，它替代 background.png 进渲染路径',
            'scale': scale,
            'median': float(np.median(base)),
            'p99_9': float(np.percentile(base, 99.9)),
            # ⚠ 逐通道除以有色的 E 会把照明的颜色从 base 里拿走 —— 这正是想要的
            #   （换个色温的光才能真的换色），但**除过头**时重打光会发怪色。
            #   实测 temple：原画 1.32:0.95:0.72（暖），base 0.48:1.10:1.42（蓝）。
            #   `gi=1` 时输出仍精确等于原画，色度怎么分只在重打光时才显现。
            'chroma': [float(v) for v in (base.reshape(-1, 3).mean(0)
                                          / max(float(base.mean()), 1e-9))],
        },
        'haze': {**haze, 'keep': HAZE_KEEP},
        'roundtrip': rt,
        'char_grid': {
            'file': 'sky_sh_grid.bin',
            'format': 'u8 RGBA, C order (channel, x, y, z, rgba)',
            'encoding': ('T_k(N) = a0_k + a1_k . N (clamped-cosine L1). '
                         'sky/ao channels: R=a0, GBA=a1*0.5+0.5. '
                         'gi channels: R=u8 log2 of a0 (see gi_scale/log_span), '
                         'GBA=a1/(4*a0)+0.5 => a1=(GBA*2-1)*2*a0'),
            'channels': (['sky_occlusion_l1']
                         + ['local_ao', 'gi_r', 'gi_g', 'gi_b']),
            **sh['grid'], **sh['bounds'],
            # GI 通道的幅度对数编码参数（解码必需）。
            'gi_scale': sh['gi_scale'], 'gi_log_span': sh['gi_span'],
            'char_wu': band['char_wu'], 'band': band['band'],
            'selfcheck': sh['selfcheck'],
        },
    }
    _atomic_bytes(out / 'meta.json',
                  (json.dumps(meta, ensure_ascii=False, indent=1) + '\n').encode('utf-8'))
    return meta


def main() -> None:
    ap = argparse.ArgumentParser(description='烘 G-buffer（final gather 出 E + 传输基 + 比例基底）')
    ap.add_argument('--scene', action='append', help='场景 id，可重复；缺省全烘')
    ap.add_argument('--work-w', type=int, default=WORK_W)
    ap.add_argument('--quiet', action='store_true')
    # 逃逸辐射（天空）。**只在烘焙期用，不进运行时载荷** —— 射线跑出画面之后
    # 带走多少辐射，画面里没有任何东西能回答，所以它是这里的自由输入。
    ap.add_argument('--sky-color', metavar='R,G,B',
                    help='纯色天空，线性 RGB，例如 0.6,0.75,1.0')
    ap.add_argument('--sky-hdr', metavar='FILE',
                    help='equirect 天空贴图（.hdr 或普通 8-bit 图），按逃逸方向取样')
    ap.add_argument('--sky-intensity', type=float, default=None,
                    help='天空强度（相对原画的 HDR 辐射；缺省见 DEFAULT_SKY）')
    args = ap.parse_args()

    sky: dict | None = None
    if args.sky_hdr:
        sky = {'mode': 'skybox', 'file': args.sky_hdr}
    elif args.sky_color:
        sky = {'mode': 'color', 'color': [float(v) for v in args.sky_color.split(',')]}
    if args.sky_intensity is not None:
        sky = dict(sky or DEFAULT_SKY)
        sky['intensity'] = args.sky_intensity

    from .geometry import list_scenes
    ids = args.scene or [s['id'] for s in list_scenes() if s['depth'] and s['bg_ok']]

    print(f'{"场景":<20}{"E均值":>8}{"天光":>8}{"环境":>8}{"逼近误差":>9}{"基底中位":>10}'
          f'{"base跨度":>9}{"往返p99":>9}{"开阔朝上":>9}{"开阔竖直":>9}')
    for sid in ids:
        try:
            m = bake(sid, args.work_w, progress=not args.quiet, sky=sky)
        except Exception as exc:                                  # noqa: BLE001
            print(f'{sid[:20]:<20}  跳过: {type(exc).__name__}: {exc}')
            continue
        ir, f, b, rt = m['irradiance'], m['runtime_fit'], m['base'], m['roundtrip']
        print(f'{sid[:20]:<20}{ir["mean"]:>8.3f}{f["sky"]:>8.3f}{f["ambient"]:>8.3f}'
              f'{f["rel_err"]:>9.3f}{b["median"]:>10.4f}'
              f'{m["base"]["log_span"]:>9.0f}'
              f'{rt["p99_255"]:>9.3f}'
              f'{m["char_grid"]["selfcheck"]["open_T_up"]:>9.3f}'
              f'{m["char_grid"]["selfcheck"]["open_T_horizontal"]:>9.3f}')


if __name__ == '__main__':
    main()
