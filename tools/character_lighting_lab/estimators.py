"""蒙特卡洛估计器 —— 天穹遮蔽矩、逐像素 E(reference)、probe 的球谐/八面体投影。

2026-09-01。算法参考 `lighting-rebuild` 分支的 `tools/lightbake/gather.py`,
但**只搬估计器本身**:载荷布局、编码曲线、NEE/MIS 子系统、GUI 一概不搬
(本次收窄:只换 probe 与 skyao 的算法,形式不动)。

所有消费者一律长这样,没有第二种形态:

    w, pdf = <某个采样器>(...)
    r = trace(origins_q, w_q, field)          # 射线一律无限长,tracer 没有射程参数
    <把 r.escaped / r.hit_yx / r.t_hit 归约成要的量>

要「r 之内被挡了没」就对 `r.t_hit` 做事后过滤 —— 过滤写在调用方、看得见,
不会伪装成 tracer 的固有性质(制作人 2026-09-01 铁令)。

归约全部在 numpy 主线程按固定顺序做(float64 累加)=> 产物逐位与线程数无关。

## ⚠ 两个必须钉死的量纲约定(错一个,parity 会「稳定差 pi 倍」或被增益吸收掉)

**1. probe 图集存的 E 不除 pi。**
运行时 `CharacterShadingFilter.probeEvalFlat` 做 `E = sum_k coeff_k * Y_k(n)`,
而系数在烘焙期已卷过 `A_l = (pi, 2pi/3, pi/4)`(Ramamoorthi-Hanrahan)。
所以它收敛到的量是

    E_probe(n) = integral L(w) * max(n.w, 0) dw          【不除 pi】

**2. 余弦重要性采样的逐像素 gather 自然出的是 E/pi。**
pdf = cos/pi 时 `sum f/pdf/n` = `mean(L)`,而 `integral L cos dw = pi * mean(L)`。
所以 reference 必须乘回 pi 才能和 probe 比 —— `gather_scene_e` 里那一句
`* math.pi` 就是它,删了 parity 会稳定差 3.14 倍。

## 天穹遮蔽:矩表示

    M0 = integral_{w.up>0} vis(w) dw        M1 = integral_{w.up>0} vis(w)*w dw
    a0 = M0/4pi = <esc>/2                   a1 = M1/2pi = <esc*w>     (均匀上半球)

    T(N) = a0 + a1.N

`T(N)` 是「相对开阔平地的余弦加权天穹可见度」:vis 恒 1 时 `T(N) = (1+N.up)/2`,
**这不是近似而是精确** —— 倾斜面的天空视角系数解析真值就是 `(1+cos b)/2`
(朝上 1.000、45 度 0.854、竖直 0.500,逐个命中)。遮蔽越各向异性,截断误差才出现。

这正是被替换掉的旧实现算错的地方:它用 12 条定向射线(仰角只有 28/58 度)
做求积,分子乘 `(N.w)+` 而分母除 `sum (w.up)+` —— 分子分母不是同一个积分,
完全无遮挡的竖直墙面只给到 **0.310~0.358**(真值 0.5,偏低 28~38%),
而且随方位有 **15.5% 的 6 次对称起伏**(6 个方位采样点的指纹)。
"""
from __future__ import annotations

import math

import numpy as np

from .const import MOMENT_SPP, PROBE_SPP
from .sampling import (cosine_hemisphere, point_keys, tangent_basis,
                       uniform_sphere, uniform_upper_hemisphere)
from .trace import DepthField, trace

__all__ = ['sh_basis', 'A_L', 'octa_bin_normals', 'sky_moments',
           'sky_vis_of_normal', 'cap0', 'vis_of_dir', 'bent_of_moments',
           'gather_scene_e', 'gather_probe']

UP = np.array([0.0, 1.0, 0.0], np.float32)

#: 卷积系数 A_l(Ramamoorthi & Hanrahan),l = 0,1,2。
#: ⚠ 与 `CharacterShadingFilter` 的 `float A[9]` 逐值对应,改一处必须改两处。
A_L = np.array([math.pi, 2.0 * math.pi / 3.0, math.pi / 4.0], np.float32)
_L_OF_K = np.array([0, 1, 1, 1, 2, 2, 2, 2, 2])
AK = A_L[_L_OF_K]                                    # (9,)


def sh_basis(dirs: np.ndarray) -> np.ndarray:
    """实球谐基 l<=2,dirs (N,3) -> (N,9)。

    ⚠ 系数与顺序必须与着色器的 `shY(int k, vec3 n)` 逐行一致 ——
    错一个顺序 = 光的方向整体拧了,画面上「有点怪」而不报任何错。
    """
    x, y, z = dirs[:, 0], dirs[:, 1], dirs[:, 2]
    return np.stack([
        np.full_like(x, 0.282095),
        0.488603 * y, 0.488603 * z, 0.488603 * x,
        1.092548 * x * y, 1.092548 * y * z,
        0.315392 * (3 * z * z - 1.0),
        1.092548 * x * z, 0.546274 * (x * x - y * y),
    ], -1).astype(np.float32)


def octa_bin_normals(ob: int = 8) -> np.ndarray:
    """八面体图的 (ob*ob, 3) 方向 —— 与着色器 `octaEnc` 的反变换同一套。"""
    uu, vv = np.meshgrid((np.arange(ob) + 0.5) / ob * 2 - 1,
                         (np.arange(ob) + 0.5) / ob * 2 - 1)
    nz = 1.0 - np.abs(uu) - np.abs(vv)
    nx = np.where(nz >= 0, uu, (1 - np.abs(vv)) * np.sign(uu))
    ny = np.where(nz >= 0, vv, (1 - np.abs(uu)) * np.sign(vv))
    nrm = np.stack([nx, ny, nz], -1).reshape(-1, 3)
    return (nrm / np.linalg.norm(nrm, axis=-1, keepdims=True)).astype(np.float32)


# =========================================================== 天穹遮蔽矩

def sky_moments(pts_q: np.ndarray, R: np.ndarray, field: DepthField,
                spp: int = MOMENT_SPP, progress=None
                ) -> tuple[np.ndarray, np.ndarray]:
    """任意一批空间点的遮蔽矩 (a0, a1) —— 逐像素与 3D 网格**同一个估计器**。

    点的属性、**与法线无关**;位置哈希种子 => 与批次/调用方/线程数无关。
    这两条合起来才保证「格点恰好落在某表面点上时,与该像素逐位相同」——
    角色能无缝隐没在场景的天穹遮蔽里,靠的是结构而不是碰巧调得像。

    射线无限长:**天在无穷远,任何有限射程都是错的**
    (旧实现截在 2.2 wu,约半个画幅 —— 再远的墙一律不挡光)。
    """
    n = len(pts_q)
    if n == 0:
        return np.zeros(0, np.float32), np.zeros((0, 3), np.float32)
    keys = point_keys(pts_q)
    m0 = np.zeros(n, np.float64)
    m1 = np.zeros((n, 3), np.float64)
    for s in range(spp):
        dirs, pdf = uniform_upper_hemisphere(keys, s, spp)
        res = trace(pts_q, np.ascontiguousarray(dirs @ R), field)
        f_over_pdf = res.escaped.astype(np.float64) / pdf.astype(np.float64)
        m0 += f_over_pdf
        m1 += f_over_pdf[:, None] * dirs.astype(np.float64)
        if progress:
            progress('moments', s + 1, spp)
    a0 = (m0 / spp / (4.0 * math.pi)).astype(np.float32)
    a1 = (m1 / spp / (2.0 * math.pi)).astype(np.float32)
    return a0, a1


def cap0(normals: np.ndarray) -> np.ndarray:
    """完全无遮挡时 `T(N)` 的解析值 `(1+N.up)/2`。

    在本仓库里它**只用于诊断**(报告「这个面的遮蔽相对它朝向的上限是多少」)。
    ⚠ 不要拿它去除 `T(N)` 再写进 `skyvis.png`:那会把朝向归一掉,
    而运行时 `sDay = (1-hemi) + hemi*skyvis` 这一侧**没有**任何单独的朝向项
    (`day.sunIntensity` 全 28 个场景都是 0)。归一了就等于宣称
    「开阔天空下竖直墙面和地面收到一样多的天光」,albedo 反解整个塌掉。
    分支那边除 cap0 是因为它的运行时另有 `SkySH(N)` 算朝向,两条链不一样。
    """
    return np.maximum((1.0 + normals[..., 1]) * 0.5, 1.0 / 255.0).astype(np.float32)


def sky_vis_of_normal(a0: np.ndarray, a1: np.ndarray,
                      normals: np.ndarray) -> np.ndarray:
    """写进 `skyvis.png` 的那个标量:`clamp(T(N), 0, cap0(N))`。

    语义与旧实现**一致**(开阔地面 = 1.0,朝向的影响留在里面),
    只是把 12 方向定向求积换成了无偏 MC,顺带修掉:

    - 竖直墙面 0.310~0.358 -> 0.500(真值);
    - 绕方位 15.5% 的 6 次对称起伏 -> 消失;
    - 2.2 wu 射程截断 -> 无穷(天在无穷远);
    - 15.5 px 步长 -> 0.5 px(细结构不再被迈过去)。

    ## 上钳必须是 cap0(N) 而不是 1

    `T(N)` 是余弦加权可见度的 **L1(线性)截断**:vis 恒 1 时精确,
    遮蔽越各向异性截断误差越大。实测真实场景有 **1.8%(雾津街头)~
    9.1%(义庄)** 的像素 `T(N) > cap0(N)` —— 即「这个面看到的天
    超过了它朝向在完全无遮挡时的物理上限」,不可能。

    钳到 `cap0(N) = (1+N.up)/2` 就是钳到那条上限。
    ⚠ 是**钳**不是**除**:除以 cap0 会把朝向整个归一掉,而运行时
    `sDay = (1-hemi) + hemi*skyvis` 这一侧没有任何单独的朝向项
    (`day.sunIntensity` 全 28 个场景都是 0),归一了等于宣称
    「开阔天空下竖直墙面和地面收到一样多的天光」,albedo 反解整个塌掉。
    """
    t = a0 + np.einsum('...i,...i->...', a1, normals)
    return np.clip(t, 0.0, cap0(normals)).astype(np.float32)


def vis_of_dir(a0: np.ndarray, a1: np.ndarray, dw: np.ndarray) -> np.ndarray:
    """某个方向的宏观可见度 `V_dir(w) = clamp(alpha + beta.w, 0, 1)`。

        alpha = 8a0 - 6a1y    beta_y = 12a1y - 12a0    beta_x = 3a1x    beta_z = 3a1z

    vis 在上半球均匀测度下对基 {1, w} 的正交投影 —— Gram 矩阵是常数,
    一次求逆写死,零自由参数。构造性自检:vis 恒 1 => a0=0.5, a1y=0.5
    => alpha=1, beta=0 => V_dir 恒 1。
    """
    alpha = 8.0 * a0 - 6.0 * a1[..., 1]
    beta = np.empty(a1.shape, np.float32)
    beta[..., 0] = 3.0 * a1[..., 0]
    beta[..., 1] = 12.0 * a1[..., 1] - 12.0 * a0
    beta[..., 2] = 3.0 * a1[..., 2]
    d = np.asarray(dw, np.float32)
    dot = (np.einsum('...i,i->...', beta, d) if d.ndim == 1
           else np.einsum('...i,...i->...', beta, d))
    return np.clip(alpha + dot, 0.0, 1.0).astype(np.float32)


def bent_of_moments(a1: np.ndarray, normals: np.ndarray) -> np.ndarray:
    """bent normal = normalize(a1);|a1| 约等于 0 时退回 N(那儿 V 约等于 0,方向不参与)。"""
    ln = np.linalg.norm(a1, axis=-1, keepdims=True)
    return np.where(ln > 1e-6, a1 / np.maximum(ln, 1e-9), normals).astype(np.float32)


# 2026-09-01 删除:`local_ao` —— 它是唯一带射程钳制(AO_RANGE)的估计器,
# 而它在本仓库**没有任何消费者**。制作人铁令「所有 trace 的射线都无限长,
# 不准去钳制长度」;留着一个专门用来钳制的函数,就是留着一条随时会被抄走的错误示范。
# 真要做局部 AO 的那天,判据写成对返回值 `t_hit` 的事后过滤,不许回到 tracer 里加参数。

# =================================== 逐像素 E(reference,**不进游戏**)

def clamp_rows(contrib: np.ndarray, clamp: float | None) -> np.ndarray:
    """Cycles「Clamp Indirect」同款(有偏,可开关):单样本贡献的**亮度**上限,
    超限整行等比缩(保色度)。clamp=None 原样返回 —— 关闭路径逐位不变。
    (lighting-rebuild 分支 gather.clamp_rows 逐字搬运。)"""
    if clamp is None:
        return contrib
    from .nee import LUMA
    lum = contrib @ LUMA.astype(np.float64)
    fmul = np.minimum(1.0, clamp / np.maximum(lum, 1e-9))
    return contrib * fmul[:, None]


def gather_scene_e(q_pts: np.ndarray, normals_q: np.ndarray, R: np.ndarray,
                   field: DepthField, hdr: np.ndarray, escape_of,
                   spp: int, progress=None,
                   nee_ctx=None, clamp: float | None = None) -> np.ndarray:
    """逐像素 final gather。**只作为 probe 的 parity 参照,不进运行时载荷。**

        E(x,N) = integral L_in(x,w) * (N.w)+ dw
        L_in   = HDR 原画(命中像素) / 逃逸辐射(射线跑出去)

    余弦重要性采样(pdf = cos/pi)下 `sum f/pdf/n = mean(L_in)`,
    **再乘 pi** 才是上式 —— 见模块文档的量纲约定 2。这一句是 parity 的成败所在。

    `normals_q` 是 q 空间法线(与 `Scene.geometry()['normal']` 同空间);
    采样在 q 空间做,trace 直接吃,不需要来回转。
    """
    n = len(q_pts)
    keys = point_keys(q_pts)
    basis = tangent_basis(normals_q)
    acc = np.zeros((n, 3), np.float64)
    for s in range(spp):
        dirs, pdf = cosine_hemisphere(normals_q, keys, s, spp, basis=basis)
        if s == 0 and n:
            k = min(n, 1024)
            cos = np.maximum(np.einsum('ij,ij->i', dirs[:k], normals_q[:k]), 0.0)
            assert np.allclose(pdf[:k], cos / math.pi, atol=1e-6), (
                'cosine_hemisphere 的 pdf != cos/pi —— E = pi*mean(L) 的特例失效,'
                '换了采样器要改回 sum f/pdf/n 的通式')
        res = trace(q_pts, np.ascontiguousarray(dirs), field)
        hit = ~res.escaped
        # f_hit 与 f_esc 分账:MIS 只作用于 march 半;天空半单策略全权(分支同口径)
        Lh = np.zeros((n, 3), np.float64)
        if hit.any():
            Lh[hit] = hdr[res.hit_yx[hit, 0], res.hit_yx[hit, 1]]
        if nee_ctx is not None and hit.any():
            from .nee import pdf_light
            hit_idx = np.where(hit)[0]
            pl = pdf_light(nee_ctx, q_pts[hit_idx], dirs[hit_idx])
            nz = pl > 0.0
            if nz.any():
                rows = hit_idx[nz]
                pb = pdf[rows].astype(np.float64)
                Lh[rows] *= (pb / np.maximum(pb + pl[nz], 1e-300))[:, None]
        Le = np.zeros((n, 3), np.float64)
        if res.escaped.any():
            # 逃逸方向要给世界系的取样器(天空盒按世界方向查)
            dw = dirs[res.escaped] @ R.T
            Le[res.escaped] = np.asarray(escape_of(dw), np.float64)
        acc += clamp_rows(Lh, clamp) + Le
        if nee_ctx is not None:
            # 光源样本:第二方向采样器,march 打到哪取哪(逃逸=合法零样本)。
            # 量纲:本函数尾部 xpi,BSDF 样本贡献=L ⇒ 光源样本= w_L*L*cos/(pi*pdf_L)。
            from .nee import sample_light
            _j, dl, _r, pl = sample_light(nee_ctx, q_pts, keys, s, spp)
            cos_r = np.maximum(np.einsum('ij,ij->i', dl, normals_q), 0.0
                               ).astype(np.float64)
            ok = (pl > 0.0) & (cos_r > 0.0)
            if ok.any():
                idx = np.where(ok)[0]
                vres = trace(np.ascontiguousarray(q_pts[idx]),
                             np.ascontiguousarray(dl[idx]), field)
                vis = ~vres.escaped
                if vis.any():
                    rows = idx[vis]
                    Ll = hdr[vres.hit_yx[vis, 0], vres.hit_yx[vis, 1]
                             ].astype(np.float64)
                    pb = cos_r[rows] / math.pi
                    w_l = pl[rows] / np.maximum(pl[rows] + pb, 1e-300)
                    light = np.zeros((n, 3), np.float64)
                    light[rows] = Ll * (w_l * cos_r[rows]
                                        / (math.pi * pl[rows]))[:, None]
                    acc += clamp_rows(light, clamp)
        if progress:
            progress('scene_e', s + 1, spp)
    return (acc / spp * math.pi).astype(np.float32)


# ===================================================== probe 的方向投影

def gather_probe(pts_q: np.ndarray, R: np.ndarray, field: DepthField,
                 rad_fields: dict, escape_of, spp: int = PROBE_SPP,
                 bin_normals: np.ndarray | None = None,
                 progress=None,
                 nee_ctx=None, clamp: float | None = None,
                 seed: int | None = None) -> dict:
    """一批 probe 点的 SH-L2 / 八面体 bin 投影。

    `rad_fields` = {名字: (h,w,3) 辐射图},一次 trace 同时投影多张
    (base / emit 走同一批射线,零额外成本 —— 旧实现也是一次 trace 两次取值)。
    逃逸方向的辐射另开一个名字 `'esc'` 返回,对应载荷里的 amb 分账槽。

    输出 `{名字: {'sh': (P,9,3), 'bins': (P,B,3)}}` 外加 `'cov'`(命中率的
    同型投影,载荷 alpha 槽用)与 `'hit_rate'`。

    ## 与旧实现的差别(为什么画面会变)

    1. **没有 fold**。旧写法把朝相机的射线 qz 取绝对值掰到背面,于是「正面的光
       = 背面的光镜像」。现在朝相机的射线老老实实逃逸,拿 `escape_of` 给的值。
    2. **不走体素**。旧写法在 192x107x64 的占据体素里 DDA(步长 0.9 体素 +
       round 采样,1 体素厚的墙会被跳过);现在直接 march 深度场,亚像素步长。
    3. **方向是分层 + 位置抖动的 QMC**,不是所有 probe 共用的一组 Fibonacci ——
       后者让相邻 probe 的误差强相关,表现为块状而不是可平滑的噪声。
    """
    n = len(pts_q)
    names = list(rad_fields)
    nb = octa_bin_normals() if bin_normals is None else bin_normals
    B = len(nb)
    keys = point_keys(pts_q) if seed is None else point_keys(pts_q, seed=seed)
    sh = {k: np.zeros((n, 9, 3), np.float64) for k in [*names, 'esc']}
    bins = {k: np.zeros((n, B, 3), np.float64) for k in [*names, 'esc']}
    cov_sh = np.zeros((n, 9), np.float64)
    cov_bin = np.zeros((n, B), np.float64)
    # base 流 DC 亮度的逐样本一阶/二阶累计 -> 均值方差(重建层的 SVGF 引导)
    dc_s1 = np.zeros(n, np.float64)
    dc_s2 = np.zeros(n, np.float64)
    hits = 0
    for s in range(spp):
        dirs, pdf = uniform_sphere(keys, s, spp)   # q 空间(probe 的 SH 就在 q 空间)
        res = trace(pts_q, np.ascontiguousarray(dirs), field)
        hit = ~res.escaped
        hits += int(hit.sum())
        inv_pdf = (1.0 / pdf).astype(np.float64)              # = 4pi
        Y = sh_basis(dirs).astype(np.float64) * inv_pdf[:, None]        # (n,9)
        C = (np.maximum(dirs @ nb.T, 0.0).astype(np.float64)
             * inv_pdf[:, None])                                        # (n,B)
        # MIS:BSDF 命中射线按光源池化密度降权(full-MIS,对每根命中射线求,
        # 不按命中像素过滤 —— 分支验尸:过滤=阴影区 +15% 漏光)。
        w_mis = np.ones(n, np.float64)
        if nee_ctx is not None and hit.any():
            from .nee import pdf_light
            hit_idx = np.where(hit)[0]
            pl_b = pdf_light(nee_ctx, pts_q[hit_idx], dirs[hit_idx])
            nz = pl_b > 0.0
            if nz.any():
                pb = pdf[hit_idx[nz]].astype(np.float64)      # = 1/4pi
                w_mis[hit_idx[nz]] = pb / np.maximum(pb + pl_b[nz], 1e-300)
        for k in names:
            L = np.zeros((n, 3), np.float64)
            if hit.any():
                L[hit] = rad_fields[k][res.hit_yx[hit, 0], res.hit_yx[hit, 1]]
            L = clamp_rows(L, clamp) * w_mis[:, None]
            sh[k] += Y[:, :, None] * L[:, None, :]
            bins[k] += C[:, :, None] * L[:, None, :]
            if k == 'base':
                from .nee import LUMA as _LU
                dc_smp = Y[:, 0] * (L @ _LU.astype(np.float64))
                dc_s1 += dc_smp
                dc_s2 += dc_smp * dc_smp
        if nee_ctx is not None:
            # 光源样本:同一根射线服务所有辐射流(MIS 权只看 pdf,与流无关)。
            # 逃逸的光源样本 = f_hit 的合法零样本;esc 流不吃光源样本(单策略)。
            from .nee import sample_light
            _j, dl, _r, pl = sample_light(nee_ctx, pts_q, keys, s, spp)
            ok = pl > 0.0
            if ok.any():
                idx = np.where(ok)[0]
                vres = trace(np.ascontiguousarray(pts_q[idx]),
                             np.ascontiguousarray(dl[idx]), field)
                vis = ~vres.escaped
                if vis.any():
                    rows = idx[vis]
                    pb_l = np.float64(1.0 / (4.0 * math.pi))
                    w_l = pl[rows] / (pl[rows] + pb_l)
                    fw = (w_l / pl[rows])                     # f/pdf 权
                    Yl = sh_basis(dl[rows]).astype(np.float64)
                    Cl = np.maximum(dl[rows] @ nb.T, 0.0).astype(np.float64)
                    for k in names:
                        Lk = rad_fields[k][vres.hit_yx[vis, 0],
                                           vres.hit_yx[vis, 1]].astype(np.float64)
                        Lk = clamp_rows(Lk, clamp) * fw[:, None]
                        sh[k][rows] += Yl[:, :, None] * Lk[:, None, :]
                        bins[k][rows] += Cl[:, :, None] * Lk[:, None, :]
                        if k == 'base':
                            from .nee import LUMA as _LU
                            dc_l = Yl[:, 0] * (Lk @ _LU.astype(np.float64))
                            dc_s1[rows] += dc_l
                            dc_s2[rows] += dc_l * dc_l
        Le = np.zeros((n, 3), np.float64)
        if res.escaped.any():
            dw = dirs[res.escaped] @ R.T          # q -> world,给天空盒查
            Le[res.escaped] = np.asarray(escape_of(dw), np.float64)
        sh['esc'] += Y[:, :, None] * Le[:, None, :]
        bins['esc'] += C[:, :, None] * Le[:, None, :]
        hf = hit.astype(np.float64)
        cov_sh += Y * hf[:, None]
        cov_bin += C * hf[:, None]
        if progress:
            progress('probe', s + 1, spp)
    out: dict = {}
    for k in [*names, 'esc']:
        # SH 卷 A_l 成辐照度系数(与着色器 shY*coeff 的求值约定配套);
        # bins 存的直接就是余弦叶积分,不再卷。
        out[k] = {'sh': (sh[k] / spp * AK[None, :, None]).astype(np.float32),
                  'bins': (bins[k] / spp).astype(np.float32)}
    out['cov'] = {'sh': (cov_sh / spp * AK[None, :]).astype(np.float32),
                  'bins': (cov_bin / spp / math.pi).astype(np.float32)}
    out['hit_rate'] = float(hits) / max(n * spp, 1)
    # 均值的方差(x AK0^2 与 sh 系数同尺度):Var(mean) = (E[x^2]-E[x]^2)/(spp-1)
    m1 = dc_s1 / spp
    m2 = dc_s2 / spp
    out['dc_var'] = (np.maximum(m2 - m1 * m1, 0.0) / max(spp - 1, 1)
                     * float(AK[0]) ** 2).astype(np.float64)
    return out


def probe_eval_sh(coeff: np.ndarray, normals: np.ndarray) -> np.ndarray:
    """按着色器 `probeEvalFlat` 的口径从 SH 系数重建 E。coeff (P,K,3)。

    K=4 走 L1、K=9 走 L2。**parity 判据用它** —— 与运行时同一段数学,
    自己另写一份就等于在验证两份代码碰巧写得一样,不是在验证 probe 对不对。
    """
    k = coeff.shape[1]
    Y = sh_basis(normals)[:, :k]                        # (P,k)
    return np.maximum(np.einsum('pk,pkc->pc', Y, coeff), 0.0)


def probe_eval_bins(coeff: np.ndarray, normals: np.ndarray,
                    ob: int = 8) -> np.ndarray:
    """按着色器的八面体双线性口径从 bin 系数重建 E。coeff (P,ob*ob,3)。"""
    n = normals / np.maximum(np.linalg.norm(normals, axis=1, keepdims=True), 1e-9)
    a = np.abs(n).sum(1, keepdims=True)
    p = n[:, :2] / np.maximum(a, 1e-9)
    neg = n[:, 2] < 0
    p[neg] = ((1.0 - np.abs(p[neg][:, ::-1]))
              * np.where(p[neg] >= 0, 1.0, -1.0))
    uv = (p * 0.5 + 0.5) * ob - 0.5
    b0 = np.clip(np.floor(uv), 0, ob - 2).astype(np.int32)
    f = np.clip(uv - b0, 0.0, 1.0)
    def tap(dx, dy):
        return coeff[np.arange(len(n)), (b0[:, 1] + dy) * ob + (b0[:, 0] + dx)]
    c = ((tap(0, 0) * (1 - f[:, :1]) + tap(1, 0) * f[:, :1]) * (1 - f[:, 1:2])
         + (tap(0, 1) * (1 - f[:, :1]) + tap(1, 1) * f[:, :1]) * f[:, 1:2])
    return np.maximum(c, 0.0)
