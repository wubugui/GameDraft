"""逃逸辐射 —— 射线跑出伪世界之后带走多少辐射。**烘焙器里可选的一个模块。**

制作人 2026-09-01 定:「这个值可以是一个天空盒,也可以是常数颜色,也可以是一个
从场景推导出来的分布,都是在 baker 里可以选择的,**默认就是黑色纯色**」。

## 为什么这是自由输入而不是算出来的

射线已经离开画面了 —— **画面里没有任何东西能回答它带走多少辐射**。
`lighting-rebuild` 分支的设计文档记了一次翻车:历史上写过 `estimate_sky_radiance`,
拿 `depth > p92` 那批像素的均值当逃逸辐射。室内场景那 8% 是后墙脚的地面
(实测茶馆选中区亮度中位 0.130,其余也是 0.130,**毫无区别**),而同一个掩码还被
拿去把 base 钉成 0,画面少了一整块。所以 `scene_derived` 模式在这里是**显式的、
带警告的选项**,不是缺省,更不是自动推断。

同理:「哪些像素是天」这个问题在单视角伪世界里无解,任何按深度分位切出来的掩码
都和「是不是天」零关系。别发明 sky_mask。

## 它替换掉的是什么

旧 probe 管线的 `fold=1`:朝相机的射线把 qz 取**绝对值**掰到背面,
于是「正面的光 = 背面的光镜像」。角色站在亮窗户前面,脸上是身后墙的颜色。
那不是近似,是编造。删掉 fold 之后,朝相机的射线老老实实逃逸,拿这里给的值。

## 接口

`make_escape_sampler(spec) -> radiance(dirs_world) -> (n,3) 或 (3,)`

`spec` 形如:

    {'mode': 'black'}                                   # 缺省
    {'mode': 'color', 'color': [r,g,b], 'intensity': k}
    {'mode': 'skybox', 'file': '...', 'intensity': k}   # equirect,.hdr 或 8-bit
    {'mode': 'scene_derived', 'percentile': 92, ...}    # ⚠ 见上面的翻车记录

方向无关的取法(black/color)在取样器上打 `constant_rgb` 标记 —— 消费者可以走
「逃逸计数 x 常色」的快路,免去逐样本重生成方向。
"""
from __future__ import annotations

import math
from pathlib import Path

import numpy as np
from PIL import Image

__all__ = ['DEFAULT_ESCAPE', 'make_escape_sampler', 'describe']

#: 缺省:纯黑。逃逸 = 不带走任何辐射。
DEFAULT_ESCAPE: dict = {'mode': 'black'}


def _constant(c: np.ndarray):
    c = np.ascontiguousarray(c, np.float32)
    c.flags.writeable = False          # 与 constant_rgb 共享,禁原地改

    def sample(dw: np.ndarray) -> np.ndarray:
        return np.broadcast_to(c, dw.shape) if dw.ndim > 1 else c

    sample.constant_rgb = c
    return sample


def load_skybox(path: Path) -> np.ndarray:
    """读一张 equirect(lat-long)天空图,返回线性 (h,w,3) float32。

    `.hdr`(Radiance RGBE,仅 flat 非 RLE)自己解;普通 8-bit 图走 sRGB->线性。
    """
    if path.suffix.lower() == '.hdr':
        raw = path.read_bytes()
        try:
            nl = raw.index(b'\n\n')
        except ValueError as exc:
            raise ValueError(f'{path.name}: 不是合法 Radiance HDR(无头部空行)'
                             ) from exc
        rest = raw[nl + 2:]
        eol = rest.index(b'\n')
        dims = rest[:eol].split()
        # 只接受标准 `-Y H +X W` 轴序:其余轴序会静默转置/上下翻,拒绝猜
        if len(dims) != 4 or dims[0] != b'-Y' or dims[2] != b'+X':
            raise ValueError(f'{path.name}: 分辨率行 {rest[:eol]!r} 非标准 '
                             f'-Y H +X W 轴序,暂不支持')
        h, w = int(dims[1]), int(dims[3])
        data = np.frombuffer(rest[eol + 1:], np.uint8)
        # new-style RLE 扫描线头是 02 02 (w>>8) (w&0xff) —— 显式探测拒绝。
        # ⚠ 不能只靠尺寸判:RLE 对不可压数据会**膨胀**,单边 < 挡不住,
        #   会把 RLE 字节流当 flat 解出 1e19 量级的假辐射。
        if data.size >= 4 and data[0] == 2 and data[1] == 2 \
                and (int(data[2]) << 8 | int(data[3])) == w:
            raise ValueError(f'{path.name}: RLE 压缩的 .hdr 暂不支持 —— '
                             f'导出为非压缩(flat)RGBE,或用 8-bit 图')
        if data.size < w * h * 4:
            raise ValueError(f'{path.name}: 数据不足 flat RGBE 尺寸 '
                             f'({data.size} < {w * h * 4})')
        rgbe = data[:w * h * 4].reshape(h, w, 4).astype(np.float32)
        f = np.where(rgbe[..., 3:4] > 0, 2.0 ** (rgbe[..., 3:4] - 136.0), 0.0)
        return (rgbe[..., :3] * f).astype(np.float32)
    img = np.asarray(Image.open(path).convert('RGB'), np.float32) / 255.0
    return np.where(img <= 0.04045, img / 12.92,
                    ((img + 0.055) / 1.055) ** 2.4).astype(np.float32)


def make_escape_sampler(spec: dict | None = None, root: Path | None = None,
                        hdr: np.ndarray | None = None,
                        depth: np.ndarray | None = None):
    """按 spec 造 `radiance(dirs_world) -> rgb` 的取样器。

    取样器要能吃 (3,) 单方向也能吃 (n,3) 一批 —— MC 每根光线方向都不同。
    ⚠ 契约:方向必须已单位化;返回值只读(常色分支返回 broadcast 视图),
      消费者要改就自己拷。
    """
    spec = dict(spec or DEFAULT_ESCAPE)
    mode = spec.get('mode', 'black')
    gain = float(spec.get('intensity', 1.0))

    if mode == 'black':
        return _constant(np.zeros(3, np.float32))

    if mode == 'color':
        c = np.asarray(spec.get('color', [1.0, 1.0, 1.0]), np.float32) * gain
        return _constant(c)

    if mode == 'skybox':
        f = Path(spec['file'])
        img = (load_skybox(f if f.is_absolute() or root is None else root / f)
               * gain).astype(np.float32)
        ih, iw = img.shape[:2]

        def sample_s(dw: np.ndarray) -> np.ndarray:
            a = np.atleast_2d(dw)
            u = (np.arctan2(a[:, 0], a[:, 2]) / (2.0 * math.pi) + 0.5) % 1.0
            v = np.arccos(np.clip(a[:, 1], -1.0, 1.0)) / math.pi
            out = img[np.minimum((v * ih).astype(np.int32), ih - 1),
                      np.minimum((u * iw).astype(np.int32), iw - 1)]
            return out if dw.ndim > 1 else out[0]
        return sample_s

    if mode == 'scene_derived':
        # ⚠ 显式选项,不是缺省。见模块文档记的翻车:室内场景「最远那批像素」
        #   是后墙脚的地面,与其余像素亮度**毫无区别**,推出来的天空是假的。
        #   只在明知场景确实有大片天、且人工确认过的情况下用。
        if hdr is None or depth is None:
            raise ValueError('scene_derived 需要 hdr 与 depth')
        pct = float(spec.get('percentile', 92.0))
        thr = float(np.percentile(depth, pct))
        m = depth >= thr
        if m.sum() < 64:
            raise ValueError(f'scene_derived: depth>=p{pct:g} 只有 {int(m.sum())} 个像素,'
                             f'样本不足以代表天空')
        c = (np.median(hdr[m].reshape(-1, 3), axis=0) * gain).astype(np.float32)
        s = _constant(c)
        s.derived_note = (f'scene_derived p{pct:g}: {int(m.sum())} px, '
                          f'median={c.round(4).tolist()} —— 未经人工确认不要采信')
        return s

    raise ValueError(f'未知的逃逸辐射取法 {mode!r}'
                     f'(可选 black / color / skybox / scene_derived)')


def describe(spec: dict | None) -> str:
    """一行人话,进 meta 与烘焙日志 —— 逃逸辐射取了什么必须留痕。"""
    spec = dict(spec or DEFAULT_ESCAPE)
    mode = spec.get('mode', 'black')
    if mode == 'black':
        return 'black(纯黑,缺省)'
    if mode == 'color':
        c = spec.get('color', [1, 1, 1])
        return f'color {list(np.round(c, 4))} x{spec.get("intensity", 1.0):g}'
    if mode == 'skybox':
        return f'skybox {spec.get("file")!r} x{spec.get("intensity", 1.0):g}'
    if mode == 'scene_derived':
        return f'scene_derived p{spec.get("percentile", 92)} ⚠ 从画面反推,慎用'
    return f'{mode}?'
