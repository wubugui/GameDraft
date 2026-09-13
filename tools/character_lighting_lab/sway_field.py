"""背景草木随风动的离线拆层(v2)—— 一张背景图的派生物,与几何场同住 ``lighting/<背景基名>/``。

v1 是整张原画做 UV 扭曲:相邻像素被拖着走,石头、树干跟着变形(制作人 2026-09-12:"树干应该整体
摇晃,石头应该不动")。单层扭曲在结构上做不到这两条——被植物盖住的背景没有像素,植物一动只能拖邻居。
v2 拆成两层:

- **静态底板** ``sway_plate.png``:原画里可动植被沿轮廓**往里一条带**(宽 ``margin`` 像素)补成背景
  (带外的植物本体永远被植被层盖着,不用补)。石头、崖壁、路面都在底板上,永远不动。
  运行时把每株的最大位移压在这条带里,所以露出来的只可能是补过的内容。
  补法:带里的点关于最近轮廓点**镜像**到外面取原画纹理(越过植物毛边圈),落到别的植被上 / 出画才用
  OpenCV Telea 兜底;**作者可以手修这张图**(``plate.authored`` 标记后重烘跳过它,与 albedo 同规则)。
- **植被层**:一株一个实例(文本提示分割的实例掩码,去重、按优先级分像素,去掉石头):
  - ``plant``(树,或认出了木质部分的那株):整株绕根部**刚体转动**,树干不变形;
  - ``field``(灌丛 / 竹丛 / 草):根部钉住、越往梢越自由的平滑弯曲(铺开的一大片绕一个根点刚转不对);
  - 叶片颤动只作用在**叶**像素上(木质像素不颤)。

产物:
- ``sway_plate.png`` —— RGB,底板;
- ``sway_matte.png`` —— RGB:R = 植被 alpha(软边)、G = 叶度(0 木质 → 1 叶 / 草)、B = 自由度(场用:下沿 0 → 梢 1);
- ``sway_rigid.png`` —— 灰度:**刚体度**(作者画的:竹竿 / 树干这类只能整体摇、不许跟着扭的部位);
- ``sway_ids.png`` —— RGB:R/G = 实例 id 低 / 高字节(0 = 不属于任何实例)、B = 种类(1 plant / 2 field);
- ``sway.json`` —— 版本、边带宽、实例表(根的画面点与世界点、株高、透视系数、包围盒、到根的最远距离)、
  ``depthScale``(视深 → 透视系数表:沿作者的透视轴采出来,整张画按视深查——轴外的远山也对)。

作者的手动出口(分割认不出"这丛看着怪"时):

- ``sway_lock.png`` —— **烘焙的输入**,作者手画:白 / 不透明 = 这块永远不动。锁掉的像素当石头处理
  (不属于任何实例、也不补底板,原画那块原样留在底板上)。留在开发树、不进发行包(与 ``skyvis.png`` 同类)。
  想锁"画面上那一丛"最省事的办法是拿它的实例 id::

      sh scripts/py.sh -m tools.character_lighting_lab.sway_field --scene 跑马梁 --lock-ids 4

  (把那几株的像素并进 ``sway_lock.png`` 再重烘;之后想改形状直接用图像软件画那张图。
  **id 是上一次烘焙的**——重烘后编号会变,要再锁别的株先看新的 ``sway.json``。)

全时段共用主背景那一份(草木长在哪是结构;暗的夜图分割不出来),只写进已有照明载荷的时段目录。
分割用本机 HF 缓存里的 SAM3-LiteText(**只离线读**,不下载)。

用法::

    sh scripts/py.sh -m tools.character_lighting_lab.sway_field --scene 跑马梁
"""
from __future__ import annotations

import hashlib
import io
import json
import os
import sys
from pathlib import Path

import numpy as np
from PIL import Image

_ROOT = Path(__file__).resolve().parents[2]
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

from tools.atomic_io import retry_transient                        # noqa: E402
from tools.editor.shared.entity_transform_math import perspective_axis_data  # noqa: E402

from .scene_geometry import Scene, scene_backgrounds, scene_paths   # noqa: E402

#: 载荷版本 —— 与 ``src/rendering/backgroundSway.ts`` 的 ``SWAY_MAP_VERSION`` 同步
SWAY_VERSION = 3

SAM_MODEL = 'vil-uob/sam3-litetext-s0'

#: 植被提示词 → (优先级, 当"场"时的株高 wu)。优先级高的实例在重叠处拿走像素。
#: **整株刚动(plant)只给树或认出了木质部分的那株**;灌丛 / 竹丛 / 草一律是"场":根部钉住、
#: 越往梢越自由的平滑弯曲——铺开的一大片灌丛绕一个根点刚转,边缘会整块上下翻,不对。
VEG_PROMPTS: dict[str, tuple[int, float]] = {
    'tree': (3, 300.0),
    'shrub': (2, 85.0),              # ≈ 1 m
    'bush': (2, 85.0),
    'plant': (2, 70.0),
    'grass': (1, 60.0),              # ≈ 0.7 m(山脊上的野草)
}
#: 一株里木质像素占比超过它,就算"有主干"(整株刚动)
WOODY_PLANT_FRACTION = 0.02
#: 木质部分(整株刚动、不颤叶)
WOODY_PROMPTS = ('tree trunk', 'branch', 'stem')
#: 永远不动的东西(从植被里扣掉)
ROCK_PROMPTS = ('rock', 'stone')

SCORE_THRESHOLD = 0.3
#: 同一株被几个提示词各分出一次:掩码 IoU 超过它就并成一个实例
DEDUP_IOU = 0.5
#: plant 实例太小就当噪点并进最近的场 / 丢掉(原生像素)
MIN_INSTANCE_PIXELS = 300
#: 底板往植物轮廓里补的带宽(原生像素)——运行时每株最大位移压在它的 80% 以内。
#: ⚠ 原画没有风:风一直在,草木就**一直斜着**,带宽要兜得住那份持续的斜度,不只是晃动的起伏。
#: 12 是按"原画画的是平均风姿态、只画起伏"那个编出来的假定定的(2026-09-11,已删),
#: 跑马梁松树梢平均风下就要顺风斜约 10 像素、阵风到约 30 像素,12 带(封顶 9.6)会把它压扁。
#: 48(封顶 38.4)实测平均斜度保住 92%、阵风峰值保住八成。
PLATE_MARGIN = 48
#: 植被 alpha 的软边(高斯 σ,原生像素)
MATTE_SOFT_SIGMA = 1.2
#: 自由度往轮廓外延多远(原生像素):≥ 运行时网格一格(24)+ 补带宽,轮廓外的网格顶点才带得上本株的位移
#: (运行时网格按补带宽外扩;两个数一起改,`test_layers_and_serve` 钉着这条不等式)
FREEDOM_EXTEND_PX = 72
#: 视深 → 透视系数表沿透视轴采多少个点
DEPTH_SCALE_SAMPLES = 96
#: 作者手画的**锁定不动**掩码(旧版单文件,仍然认;白 = 这块永远不动,整块留在底板上)
LOCK_FILE = 'sway_lock.png'
#: 作者在草木工作台点的逐株设置(烘焙的输入,不进发行包):锚点(刚体绕它转)、整体摆
#: 存的是**原画像素位置**,不是实例 id —— id 每次重烘都会变,位置不会
OVERRIDES_FILE = 'sway_overrides.json'
#: 点没落在任何一株上时,往外找最近一株的半径(原画像素):锚点常点在竿底 / 树干底,恰好在轮廓边上
OVERRIDE_SNAP_PX = 24
#: 作者手画的涂层(烘焙的输入,烘焙器只读不写):
#: R = 强制算植被(分割漏掉的补上) / G = 强制不动(与 LOCK_FILE 并集) / B = 加刚体 / A = 减刚体(去掉自动判的)
PAINT_FILE = 'sway_paint.png'
#: 补画的植被离已有实例多近就并进去(原生像素);再远的自成一株
PAINT_MERGE_PX = 10
#: 自成一株的补画植被至少要这么多像素
PAINT_MIN_PIXELS = 200


def _atomic_bytes(dest: Path, data: bytes) -> None:
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_suffix(dest.suffix + '.tmp')
    tmp.write_bytes(data)
    retry_transient(os.replace, tmp, dest)


def _png(arr: np.ndarray) -> bytes:
    buf = io.BytesIO()
    Image.fromarray(arr, 'RGBA' if arr.shape[-1] == 4 else 'RGB').save(buf, format='PNG', optimize=True)
    return buf.getvalue()


# ---------------------------------------------------------------------------- 分割


class Segmenter:
    """SAM3-LiteText 文本提示实例分割(一次装模型,多次提示)。"""

    def __init__(self, status=print):
        os.environ.setdefault('HF_HUB_OFFLINE', '1')
        try:
            import torch
            from transformers import AutoModel, AutoProcessor
        except ImportError as e:                            # pragma: no cover - 环境问题
            raise SystemExit(f'sway_field 需要 torch + transformers:{e}')
        try:
            self.model = AutoModel.from_pretrained(SAM_MODEL).eval()
            self.proc = AutoProcessor.from_pretrained(SAM_MODEL)
        except Exception as e:                               # noqa: BLE001
            raise SystemExit(
                f'本机没有分割模型 {SAM_MODEL}(只离线读 HF 缓存,不自动下载):{type(e).__name__}: {e}')
        self.torch = torch
        self.dev = 'cuda' if torch.cuda.is_available() else 'cpu'
        self.model = self.model.to(self.dev)
        self.status = status

    def instances(self, img: Image.Image, prompt: str) -> list[tuple[float, np.ndarray]]:
        inputs = self.proc(images=img, text=prompt, return_tensors='pt').to(self.dev)
        with self.torch.no_grad():
            res = self.model(**inputs)
        r = self.proc.post_process_instance_segmentation(
            res, threshold=SCORE_THRESHOLD, mask_threshold=0.5,
            target_sizes=inputs.get('original_sizes').tolist())[0]
        scores = r.get('scores')
        out = []
        for k in range(len(r['masks'])):
            m = r['masks'][k].cpu().numpy().astype(bool)
            if m.sum() < 16:
                continue
            out.append((float(scores[k]) if scores is not None else 1.0, m))
        self.status(f'  分割「{prompt}」:{len(out)} 个实例')
        return out

    def union(self, img: Image.Image, prompts) -> np.ndarray:
        w, h = img.size
        m = np.zeros((h, w), bool)
        for p in prompts:
            for _, mk in self.instances(img, p):
                m |= mk
        return m


class CachedSegmenter:
    """同一张原画 + 同一组提示词的分割结果缓存在系统临时目录(不进仓库):调拆层参数时不用每次重跑模型。"""

    def __init__(self, img_bytes: bytes, status=print):
        import tempfile
        self.key = hashlib.sha1(img_bytes + SAM_MODEL.encode() + str(SCORE_THRESHOLD).encode()).hexdigest()[:16]
        self.dir = Path(tempfile.gettempdir()) / 'gamedraft_sway_seg'
        self.status = status
        self._seg: Segmenter | None = None

    def _real(self) -> Segmenter:
        if self._seg is None:
            self._seg = Segmenter(self.status)
        return self._seg

    def instances(self, img: Image.Image, prompt: str) -> list[tuple[float, np.ndarray]]:
        f = self.dir / f'{self.key}_{hashlib.sha1(prompt.encode()).hexdigest()[:8]}.npz'
        if f.is_file():
            z = np.load(f)
            out = [(float(s), m) for s, m in zip(z['scores'], z['masks'])] if len(z['scores']) else []
            self.status(f'  分割「{prompt}」:{len(out)} 个实例(缓存)')
            return out
        out = self._real().instances(img, prompt)
        self.dir.mkdir(parents=True, exist_ok=True)
        w, h = img.size
        np.savez_compressed(f, scores=np.array([s for s, _ in out], np.float32),
                            masks=np.array([m for _, m in out], bool).reshape(len(out), h, w))
        return out

    def union(self, img: Image.Image, prompts) -> np.ndarray:
        w, h = img.size
        m = np.zeros((h, w), bool)
        for p in prompts:
            for _, mk in self.instances(img, p):
                m |= mk
        return m


# ---------------------------------------------------------------------------- 透视


def perspective_field(cfg: dict | None, native: tuple[int, int], world: tuple[float, float]) -> np.ndarray:
    """逐像素的透视系数(与 TS ``perspectiveScaleAt`` / Python ``perspective_scale_at`` 同口径)。"""
    nw, nh = native
    a = perspective_axis_data(cfg)
    if a is None:
        return np.ones((nh, nw), np.float32)
    nx, ny, ax, ay, len_sq, stops = a
    sx = (np.arange(nw, dtype=np.float64) + 0.5) * (world[0] / nw)
    sy = (np.arange(nh, dtype=np.float64) + 0.5) * (world[1] / nh)
    X, Y = np.meshgrid(sx, sy)
    t = np.clip(((X - nx) * ax + (Y - ny) * ay) / len_sq, 0.0, 1.0)
    pos = np.array([p for p, _ in stops], np.float64)
    val = np.array([s for _, s in stops], np.float64)
    return np.maximum(0.01, np.interp(t, pos, val)).astype(np.float32)


def read_lock(bake_dir: Path, native: tuple[int, int], status=print) -> np.ndarray | None:
    """读作者手画的锁定掩码(``sway_lock.png``):白 / 不透明 = 这块不许动。

    分割认不出"这丛看着怪"——作者要能直接圈掉。锁掉的像素在拆层里当石头处理:不属于任何实例、
    也不补底板,原画那块原样留在底板上(所以锁一丛竹子不会在它周围留下一圈补过的痕迹)。
    这是**烘焙的输入**,烘焙器只读不写(与 ``skyvis.png`` 同一类:留在开发树、不进发行包)。
    """
    p = bake_dir / LOCK_FILE
    if not p.is_file():
        return None
    a = np.asarray(Image.open(p).convert('RGBA'))
    nw, nh = native
    if a.shape[:2] != (nh, nw):
        status(f'  ⚠ {LOCK_FILE} 尺寸 {a.shape[1]}×{a.shape[0]} 与原画 {nw}×{nh} 不同,忽略')
        return None
    alpha = a[..., 3]
    lum = a[..., :3].max(axis=2)
    # 透明底上画白 ⇒ 看 alpha;不透明的整张图 ⇒ 看亮度(黑底白块)
    m = (alpha > 16) if alpha.min() < 250 else (lum >= 128)
    return m if m.any() else None


def read_paint(bake_dir: Path, native: tuple[int, int], status=print) -> dict[str, np.ndarray] | None:
    """读作者手画的涂层(``sway_paint.png``):R 补植被 / G 锁死不动 / B 加刚体 / A 减刚体。

    分割认不出的事一律走这张图——它是**烘焙的输入**,烘焙器只读不写(与 ``skyvis.png`` 同一类:
    留在开发树、不进发行包)。四个通道各存 0..255 的权重,软边照用(刚体度是连续值,竿与叶的交界不会撕开)。
    作者面是草木工作台(``tools/sway_workbench``),它是这张图的唯一写入者。
    """
    p = bake_dir / PAINT_FILE
    if not p.is_file():
        return None
    a = np.asarray(Image.open(p).convert('RGBA'))
    nw, nh = native
    if a.shape[:2] != (nh, nw):
        status(f'  ⚠ {PAINT_FILE} 尺寸 {a.shape[1]}×{a.shape[0]} 与原画 {nw}×{nh} 不同,忽略')
        return None
    return {'veg': a[..., 0], 'freeze': a[..., 1], 'rigid': a[..., 2], 'unrigid': a[..., 3]}


def read_overrides(bake_dir: Path) -> dict:
    """读作者的逐株设置(``sway_overrides.json``):``anchors`` 与 ``coherent`` 都是原画像素点 ``[x, y]`` 的列表。

    坏文件 / 坏条目一律丢掉并当作没设(烘焙不因为作者输入的一处笔误整批失败),合法的照用。
    """
    out = {'anchors': [], 'coherent': []}
    p = bake_dir / OVERRIDES_FILE
    if not p.is_file():
        return out
    try:
        raw = json.loads(p.read_text(encoding='utf-8'))
    except (OSError, ValueError):
        return out
    for key in out:
        for pt in (raw.get(key) or []) if isinstance(raw, dict) else []:
            if isinstance(pt, (list, tuple)) and len(pt) == 2 and all(isinstance(v, (int, float)) for v in pt):
                out[key].append([float(pt[0]), float(pt[1])])
    return out


def owner_at(owner: np.ndarray, x: float, y: float, snap: int = OVERRIDE_SNAP_PX) -> int:
    """原画像素点属于哪一株(1 起);正好不在任何一株上就往外找 ``snap`` 像素内最近的一株,找不到 0。"""
    h, w = owner.shape
    xi, yi = int(round(x)), int(round(y))
    if not (0 <= xi < w and 0 <= yi < h):
        return 0
    if owner[yi, xi]:
        return int(owner[yi, xi])
    y0, y1 = max(0, yi - snap), min(h, yi + snap + 1)
    x0, x1 = max(0, xi - snap), min(w, xi + snap + 1)
    win = owner[y0:y1, x0:x1]
    ys, xs = np.nonzero(win)
    if ys.size == 0:
        return 0
    d = (ys + y0 - yi) ** 2 + (xs + x0 - xi) ** 2
    k = int(np.argmin(d))
    return int(win[ys[k], xs[k]]) if d[k] <= snap * snap else 0


def apply_overrides(rows: list[dict], owner: np.ndarray, masks: list[np.ndarray], ov: dict,
                    world: tuple[float, float], status=print) -> dict:
    """把作者点的锚点 / 整体摆落到对应的株上(就地改 ``rows``)。返回统计,落不到任何一株的点单独报。

    锚点:刚体部分绕**离它最近的**锚点转(运行时逐顶点取),所以一丛竹子可以每根竿点一个;
    有锚点的株 ``reach`` 按"像素到最近锚点"的最远距离重算(刚体转角的封顶按它压)。
    """
    nh, nw = owner.shape
    sx, sy = world[0] / nw, world[1] / nh
    stat = {'anchors': 0, 'coherent': 0, 'lost': 0}
    for x, y in ov.get('anchors') or []:
        i = owner_at(owner, x, y)
        if not i:
            stat['lost'] += 1
            status(f'  ⚠ 锚点 ({x:.0f},{y:.0f}) 附近 {OVERRIDE_SNAP_PX} 像素内没有任何一株,忽略')
            continue
        rows[i - 1].setdefault('anchors', []).append([round(x * sx, 1), round(y * sy, 1)])
        stat['anchors'] += 1
    for x, y in ov.get('coherent') or []:
        i = owner_at(owner, x, y)
        if not i:
            stat['lost'] += 1
            status(f'  ⚠ 整体摆的点 ({x:.0f},{y:.0f}) 不在任何一株上,忽略')
            continue
        rows[i - 1]['coherent'] = True
        stat['coherent'] += 1
    px_per_wu = nw / world[0]
    for r in rows:
        an = r.get('anchors')
        if not an:
            continue
        ys, xs = np.nonzero(masks[r['id'] - 1])
        ap = np.array([[a[0] * px_per_wu, a[1] * (nh / world[1])] for a in an], np.float32)
        best = np.full(xs.shape, np.inf, np.float32)
        for ax, ay in ap:
            best = np.minimum(best, np.hypot(xs - ax, ys - ay))
        r['reach'] = round(max(float(r['reach']), float(best.max()) / px_per_wu), 1)
    return stat


def view_depth(scene: Scene, data: dict) -> np.ndarray | None:
    """原画逐像素视深(q 单位)——与运行时 ``loadBackgroundSwayInput`` 解码的同一张图、同一组映射。"""
    dc = data.get('depthConfig') or {}
    dm = dc.get('depth_mapping')
    p = scene.rt_dir / (dc.get('depth_map') or 'raw_depth_rg.png')
    if not dm or not p.is_file():
        return None
    a = np.asarray(Image.open(p).convert('RGB'), np.float32)
    raw = (a[..., 0] * 256.0 + a[..., 1]) / 65535.0
    if dm.get('invert'):
        raw = 1.0 - raw
    d = raw * float(dm.get('scale', 1.0)) + float(dm.get('offset', 0.0))
    nw, nh = scene.native
    if d.shape != (nh, nw):
        d = np.asarray(Image.fromarray(d.astype(np.float32), mode='F').resize((nw, nh), Image.NEAREST), np.float32)
    return d.astype(np.float32)


def depth_scale_table(cfg: dict | None, depth: np.ndarray | None,
                      world: tuple[float, float]) -> list[list[float]] | None:
    """透视系数只随视深变(小孔相机):沿作者的透视轴采 (视深, 系数),整理成视深严格增的表。

    透视轴只在可走区有意义;轴外的像素(远山、崖下)按屏幕位置投到轴上会查错——跑马梁左上的远山
    投到轴的近端,拿到 1.3、比脚下的竹子还大。按视深查,同一视深就是同一系数;表外按两端钳住。
    """
    a = perspective_axis_data(cfg)
    if a is None or depth is None:
        return None
    nx, ny, ax, ay, _len_sq, stops = a
    nh, nw = depth.shape
    ts = np.linspace(0.0, 1.0, DEPTH_SCALE_SAMPLES)
    r = max(2, int(round(0.004 * nw)))
    ds = np.empty_like(ts)
    for i, t in enumerate(ts):
        px = int(np.clip((nx + t * ax) / world[0] * nw, 0, nw - 1))
        py = int(np.clip((ny + t * ay) / world[1] * nh, 0, nh - 1))
        ds[i] = float(np.median(depth[max(0, py - r):py + r + 1, max(0, px - r):px + r + 1]))
    ds = np.maximum.accumulate(ds)              # 视深沿轴往远处不减(压掉轴擦过崖边时的毛刺)
    ss = np.interp(ts, [p for p, _ in stops], [s for _, s in stops])
    rows: list[list[float]] = []
    for d, s in zip(ds, ss):
        if rows and d <= rows[-1][0] + 1e-4:
            continue                             # 视深没往前走的点并掉
        rows.append([round(float(d), 4), round(float(s), 4)])
    return rows if len(rows) >= 2 else None


def scale_from_depth(table: list[list[float]], depth: np.ndarray) -> np.ndarray:
    td = np.array([r[0] for r in table], np.float64)
    ts = np.array([r[1] for r in table], np.float64)
    return np.maximum(0.01, np.interp(depth, td, ts)).astype(np.float32)


def run_below(mask: np.ndarray) -> np.ndarray:
    """每个像素往下数、连续还在掩码里的像素数(含自身)。"""
    h, _ = mask.shape
    run = np.zeros(mask.shape, np.float32)
    m = mask.astype(np.float32)
    acc = np.zeros(mask.shape[1], np.float32)
    for y in range(h - 1, -1, -1):
        acc = (acc + 1.0) * m[y]
        run[y] = acc
    return run


# ---------------------------------------------------------------------------- 拆层


def build_layers(scene: Scene, data: dict, seg: Segmenter, status=print,
                 lock: np.ndarray | None = None,
                 paint: dict[str, np.ndarray] | None = None,
                 overrides: dict | None = None) -> tuple[dict, dict]:
    """分割 → 实例 → 三张图 + 实例表。返回 ({文件名: RGB 数组}, meta)。"""
    from scipy import ndimage as ndi
    from tools.trajectory_workbench.geometry import SceneGeometry

    nw, nh = scene.native
    world = (float(data.get('worldWidth') or nw), float(data.get('worldHeight') or nh))
    px_per_wu = nw / world[0]
    R = (data.get('depthConfig') or {}).get('M', {}).get('R')
    up_px = abs(float(R[1][1])) * px_per_wu if R else px_per_wu
    depth = view_depth(scene, data)
    scale_table = depth_scale_table(data.get('perspectiveScale'), depth, world)
    persp = (scale_from_depth(scale_table, depth) if scale_table
             else perspective_field(data.get('perspectiveScale'), scene.native, world))
    img = Image.open(scene.rt_dir / scene.bg_name).convert('RGB')

    # ---- 石头 / 木质:并集掩码
    rock = seg.union(img, ROCK_PROMPTS)
    woody = seg.union(img, WOODY_PROMPTS)
    # 🔴 刚体度**自动打底**:分割认出来的木质(树干 / 枝条 / 茎)默认就是刚体——它们只能跟着整株摇,
    # 不该像草叶一样弯(制作人 2026-09-13:"那个树的枝干不是刚体了?")。作者的涂层在这个底上加减。
    rigid_auto = woody.astype(np.float32)
    rigid_add = (paint['rigid'].astype(np.float32) / 255.0) if paint is not None else np.zeros((nh, nw), np.float32)
    rigid_cut = (paint['unrigid'].astype(np.float32) / 255.0) if paint is not None else np.zeros((nh, nw), np.float32)
    rigid_w = np.clip(rigid_auto + rigid_add - rigid_cut, 0.0, 1.0)
    # ⚠ 作者涂的刚体**只管两件事**:逐像素刚体度、这些像素不颤叶。**不许**并进 `woody` 去参与
    # "整株刚转"的判定 —— 那条规则是"木质超 2% ⇒ 整株 plant",一涂竹竿整丛就变成刚体,
    # 叶子也不弯了,正好毁掉作者要的"竿刚叶弯"(2026-09-13 实测踩过:涂三根竿,plant 从 1 变 2)。
    woody_flutter = woody | (rigid_add > 0.5)
    # 作者锁定的块与石头同一待遇:从植被里扣掉 ⇒ 不属于任何实例、不补底板、原样留在底板上
    frozen = rock.copy()
    if lock is not None:
        frozen |= lock
    if paint is not None:
        frozen |= paint['freeze'] > 128

    # ---- 植被实例:逐提示词取实例,跨提示词按 IoU 去重
    cand: list[dict] = []
    for prompt, (prio, hw) in VEG_PROMPTS.items():
        for score, m in seg.instances(img, prompt):
            m = m & ~frozen
            if m.sum() < MIN_INSTANCE_PIXELS:
                continue
            merged = False
            for c in cand:
                inter = (c['mask'] & m).sum()
                if inter and inter / float((c['mask'] | m).sum()) > DEDUP_IOU:
                    c['mask'] |= m
                    if prio > c['prio']:
                        c.update(prio=prio, hw=hw, cls=prompt)
                    c['score'] = max(c['score'], score)
                    merged = True
                    break
            if not merged:
                cand.append({'mask': m, 'score': score, 'prio': prio, 'hw': hw, 'cls': prompt})
    # 重叠像素归优先级高、分数高的那株
    cand.sort(key=lambda c: (-c['prio'], -c['score']))
    owner = np.zeros((nh, nw), np.int32)
    insts: list[dict] = []
    for c in cand:
        free = c['mask'] & (owner == 0)
        if free.sum() < MIN_INSTANCE_PIXELS:
            continue
        insts.append(c)
        owner[free] = len(insts)
        c['mask'] = free
        # 整株刚动只给树或认出了木质部分的;其余都是根部钉住的平滑弯曲
        woody_n = (free & woody).sum()
        c['kind'] = 'plant' if c['cls'] == 'tree' or woody_n > WOODY_PLANT_FRACTION * free.sum() else 'field'
    status(f'  植被实例 {len(insts)} 个(石头' + ('与锁定块' if lock is not None else '') + '像素已扣掉)')

    # ---- 作者补画的植被:贴着已有实例的并进去,离得远的自成一株
    if paint is not None:
        add = (paint['veg'] > 128) & (owner == 0) & ~frozen
        if add.any():
            dist, (iy0, ix0) = ndi.distance_transform_edt(owner == 0, return_indices=True)
            near = add & (dist <= PAINT_MERGE_PX)
            owner[near] = owner[iy0[near], ix0[near]]
            merged = int(near.sum())
            lone = add & (owner == 0)
            new_n = 0
            if lone.any():
                lab, n = ndi.label(lone)
                for k in range(1, n + 1):
                    m = lab == k
                    if m.sum() < PAINT_MIN_PIXELS:
                        continue
                    insts.append({'mask': m, 'score': 1.0, 'prio': 2, 'hw': 85.0, 'cls': 'painted',
                                  'kind': 'plant' if rigid_add[m].mean() > 0.3 else 'field'})
                    owner[m] = len(insts)
                    new_n += 1
            status(f'  作者补画的植被:并进已有株 {merged} 像素、新起 {new_n} 株')

    veg = owner > 0
    # ---- 实例表与自由度
    freedom = np.zeros((nh, nw), np.float32)
    rows = []
    for i, c in enumerate(insts, start=1):
        m = c['mask']
        ys, xs = np.nonzero(m)
        y_max = int(ys.max())
        base = ys >= y_max - max(2, int(0.04 * (y_max - ys.min() + 1)))
        wm = m & woody
        if c['kind'] == 'plant' and wm.sum() > WOODY_PLANT_FRACTION * m.sum():
            wy, wx = np.nonzero(wm)
            wb = wy >= wy.max() - max(2, int(0.04 * (wy.max() - wy.min() + 1)))
            rx, ry = float(wx[wb].mean()), float(wy[wb].mean())
        else:
            rx, ry = float(xs[base].mean()), float(ys[base].mean())
        s_root = float(persp[min(nh - 1, int(round(ry))), min(nw - 1, int(round(rx)))])
        h_px = float(y_max - ys.min() + 1)
        if c['kind'] == 'plant':
            height = h_px / max(up_px * s_root, 1e-6)
            freedom[m] = 1.0
        else:
            height = float(c['hw'] or 60.0)
            hpx = np.maximum(height * persp[m] * up_px, 3.0)
            rb = run_below(m)
            freedom[m] = np.clip(rb[m] / hpx, 0.0, 1.0)
        reach = float(np.hypot(xs - rx, ys - ry).max())
        rows.append({
            'id': i, 'kind': c['kind'], 'cls': c['cls'], 'score': round(c['score'], 3),
            'root': [round(rx * world[0] / nw, 1), round(ry * world[1] / nh, 1)],
            'height': round(float(height), 1),
            'persp': round(s_root, 3),
            'reach': round(reach / px_per_wu, 1),
            'bbox': [round(float(xs.min()) / px_per_wu, 1), round(float(ys.min()) / px_per_wu, 1),
                     round(float(xs.max() + 1) / px_per_wu, 1), round(float(ys.max() + 1) / px_per_wu, 1)],
        })

    # ---- 作者点的逐株设置(锚点 / 整体摆):按位置落到这一次分割出来的株上
    ov_stat = apply_overrides(rows, owner, [c['mask'] for c in insts], overrides, world, status) \
        if overrides and (overrides.get('anchors') or overrides.get('coherent')) else None

    # ---- 根的世界点(风的相位、逐株相位按世界位置算)
    try:
        geo = SceneGeometry(scene.sid, scene.bg_name)
        for r in rows:
            wx, wy, wz = geo.scene_to_world_ground(r['root'][0], r['root'][1])
            r['rootWorld'] = [round(wx, 1), round(wy, 1), round(wz, 1)]
    except Exception as e:                                   # noqa: BLE001
        status(f'  ⚠ 根的世界点算不出来({type(e).__name__}: {e});运行时按画面点近似')

    # ---- 植被 alpha(软边)与叶度
    alpha = ndi.gaussian_filter(veg.astype(np.float32), MATTE_SOFT_SIGMA)
    alpha = np.where(veg, np.maximum(alpha, 0.5), alpha)
    leafy = np.where(woody_flutter & veg, 0.0, 1.0).astype(np.float32)
    leafy = ndi.gaussian_filter(leafy, 1.0)
    # ---- id 图(向外多铺 3 像素,软边那一圈也归本株)
    dist, (iy, ix) = ndi.distance_transform_edt(~veg, return_indices=True)
    owner_d = np.where(dist <= 3, owner[iy, ix], 0)
    # 自由度往外延(最近植被像素的值):网格顶点落在轮廓外时要带着本株的位移走,
    # 否则梢部被外面那圈"自由度 0"的顶点钉住、上沿被压扁
    freedom = np.where(veg, freedom, np.where(dist <= FREEDOM_EXTEND_PX, freedom[iy, ix], 0.0))
    kind_code = np.zeros(len(insts) + 1, np.uint8)
    for r in rows:
        kind_code[r['id']] = 1 if r['kind'] == 'plant' else 2
    ids = np.stack([(owner_d & 255), (owner_d >> 8) & 255, kind_code[owner_d]], -1).astype(np.uint8)
    # 刚体度也往轮廓外延一点,轮廓外的网格顶点才跟着竿走(与自由度同一条理由)
    rigid_out = np.where(veg, rigid_w, np.where(dist <= FREEDOM_EXTEND_PX, rigid_w[iy, ix], 0.0))
    # ⚠ 刚体度**单独一张灰度图**,不许塞进 matte 的 alpha:浏览器把 PNG 画进 canvas 时按 alpha 预乘,
    # alpha=0 的像素 RGB 会被清成 0 —— 运行时的 CPU 副本正是这么取的,塞进 alpha 等于把自由度整张清零
    # (症状:草木一动不动,而且没有任何报错)。2026-09-13 踩过一次。
    matte = np.stack([
        np.round(np.clip(alpha, 0, 1) * 255),
        np.round(np.clip(leafy, 0, 1) * 255),
        np.round(np.clip(freedom, 0, 1) * 255),
    ], -1).astype(np.uint8)
    rigid_img = np.repeat(np.round(np.clip(rigid_out, 0, 1) * 255).astype(np.uint8)[:, :, None], 3, axis=2)

    # ---- 底板:只补轮廓往里那一条带(带外的植物本体永远被植被层盖着)
    plate = fill_plate(np.asarray(img), plate_plan(veg))

    meta = {
        'margin': PLATE_MARGIN,
        'depthScale': scale_table,
        'lock': {'file': LOCK_FILE, 'coverage': round(float(lock.mean()), 4)} if lock is not None else None,
        'paint': ({'file': PAINT_FILE,
                   'veg': round(float((paint['veg'] > 128).mean()), 4),
                   'freeze': round(float((paint['freeze'] > 128).mean()), 4),
                   'rigid': round(float((paint['rigid'] > 128).mean()), 4),
                   'unrigid': round(float((paint['unrigid'] > 128).mean()), 4)} if paint is not None else None),
        'rigid_coverage': round(float((rigid_w > 0.5).mean()), 4),
        'overrides': ov_stat,
        'instances': rows,
        'rock_coverage': round(float(rock.mean()), 4),
        'veg_coverage': round(float(veg.mean()), 4),
    }
    lock_note = f';作者锁定 {meta["lock"]["coverage"] * 100:.1f}%' if meta['lock'] else ''
    rg = rigid_w > 0.5
    if rg.any():
        hit = float((rg & veg).sum()) / float(rg.sum())
        lock_note += f';刚体 {float((rg & veg).sum()) / max(float(veg.sum()), 1) * 100:.1f}%(木质自动打底)'
        if paint is not None and (rigid_add > 0.5).any() and hit < 0.5:
            status('  ⚠ 涂的刚体多半没落在植被上(涂到石头 / 锁死区 / 空地了):那些像素不属于任何一株,'
                   '刚体度会被丢掉。开工作台把「已抠出的植被」那层打开对着涂。')
    status(f'  植被覆盖 {meta["veg_coverage"] * 100:.1f}%;plant {sum(r["kind"] == "plant" for r in rows)} 株、'
           f'field {sum(r["kind"] == "field" for r in rows)} 片;石头 {meta["rock_coverage"] * 100:.1f}%{lock_note}')
    meta['_veg'] = veg                                   # 给各时段 / 各几何件补底板用,不进 sway.json
    return {'sway_plate.png': plate, 'sway_matte.png': matte, 'sway_ids.png': ids,
            'sway_rigid.png': rigid_img}, meta


# ---------------------------------------------------------------------------- 烘焙


def plate_plan(veg: np.ndarray, margin: float = PLATE_MARGIN, gap: float = 3.0) -> dict:
    """按植被掩码算一次"补带里每个点去哪取":带里的点关于最近轮廓点**镜像**到外面、再越过毛边圈。

    与图无关——同一份计划可以填原画、夜景原画、法线、albedo、深度(运行时漏出来的地方,
    颜色要补、光照要用的几何件也要补,而且必须补在**同一批像素**上)。`margin` / `gap` 按目标图的分辨率给。
    """
    from scipy import ndimage as ndi

    h, w = veg.shape
    dist_in, (qy, qx) = ndi.distance_transform_edt(veg, return_indices=True)
    band = veg & (dist_in <= margin)
    ring = ndi.binary_dilation(veg, iterations=max(1, int(round(gap * 2 / 3)))) & ~veg
    hole = band | ring
    by, bx = np.nonzero(band)
    vy = qy[by, bx] - by
    vx = qx[by, bx] - bx
    vl = np.maximum(np.hypot(vy, vx), 1e-6)
    my = np.round(qy[by, bx] + vy + vy / vl * gap).astype(np.int64)
    mx = np.round(qx[by, bx] + vx + vx / vl * gap).astype(np.int64)
    ok = (my >= 0) & (my < h) & (mx >= 0) & (mx < w)
    ok[ok] = ~hole[my[ok], mx[ok]] & ~veg[my[ok], mx[ok]]
    return {'hole': hole, 'by': by[ok], 'bx': bx[ok], 'my': my[ok], 'mx': mx[ok]}


def fill_plate(arr: np.ndarray, plan: dict) -> np.ndarray:
    """照 `plate_plan` 填一张图:先镜像外面的内容进来,镜像点落在别的植被上 / 出画时才用 Telea 兜底。

    纯 Telea 补出来是一圈糊的平均色,植物一挪就露馅,所以只做兜底。
    支持 8 位 RGB(原画 / albedo / 法线编码)与单通道 16 位(深度)。
    """
    import cv2

    hole = plan['hole'].astype(np.uint8) * 255
    if arr.ndim == 3:
        tel = cv2.inpaint(np.ascontiguousarray(arr[..., :3]), hole, 5, cv2.INPAINT_TELEA)
    else:
        tel = cv2.inpaint(np.ascontiguousarray(arr), hole, 5, cv2.INPAINT_TELEA)
    out = tel.copy()
    out[plan['by'], plan['bx']] = arr[plan['my'], plan['mx']] if arr.ndim == 2 else arr[..., :3][plan['my'], plan['mx']]
    return out


def veg_at(veg: np.ndarray, size: tuple[int, int]) -> np.ndarray:
    """植被掩码缩到另一张图的分辨率(宽, 高):块里有一个植被像素就算植被(宁可多补,不许漏补)。"""
    h, w = veg.shape
    tw, th = size
    if (tw, th) == (w, h):
        return veg
    im = Image.fromarray(veg.astype(np.uint8) * 255).resize((tw, th), Image.BOX)
    return np.asarray(im) > 0


#: 打光场景额外要补的几何件(运行时漏出来的地方,光照读的是这几张的"扣掉植物"版本)
LIT_PLATE_FILES = {'normal': 'sway_plate_normal.png', 'albedo': 'sway_plate_albedo.png', 'depth': 'sway_plate_depth.png'}


def lit_plates(s, veg: np.ndarray, depth_rel: str, status=print) -> dict[str, bytes]:
    """打光场景:法线 / albedo / 深度各补一张"扣掉植物"的版本,与原画底板补在同一批像素上。"""
    nw = veg.shape[1]
    out: dict[str, bytes] = {}
    for key, src in (('normal', s.bake_dir / 'normal.png'), ('albedo', s.bake_dir / 'albedo.png')):
        if not src.is_file():
            status(f'  ⚠ {s.bake_dir.name}/{src.name} 不在,打光的漏出处用不上补过的{key}')
            continue
        a = np.asarray(Image.open(src).convert('RGB'))
        k = a.shape[1] / nw
        plan = plate_plan(veg_at(veg, (a.shape[1], a.shape[0])), margin=PLATE_MARGIN * k, gap=max(1.0, 3.0 * k))
        out[LIT_PLATE_FILES[key]] = _png(fill_plate(a, plan))
    dp = s.rt_dir / depth_rel
    if dp.is_file():
        rg = np.asarray(Image.open(dp).convert('RGB'))
        d16 = (rg[..., 0].astype(np.uint16) << 8) | rg[..., 1].astype(np.uint16)
        k = d16.shape[1] / nw
        plan = plate_plan(veg_at(veg, (d16.shape[1], d16.shape[0])), margin=PLATE_MARGIN * k, gap=max(1.0, 3.0 * k))
        f16 = fill_plate(d16, plan).astype(np.uint16)
        enc = np.zeros((*f16.shape, 3), np.uint8)
        enc[..., 0] = f16 >> 8
        enc[..., 1] = f16 & 0xFF
        out[LIT_PLATE_FILES['depth']] = _png(enc)
    else:
        status(f'  ⚠ 深度图 {depth_rel} 不在,打光的漏出处深度用不上补过的')
    return out


def _has_payload(bake_dir: Path) -> bool:
    return (bake_dir / 'geometry.json').is_file() or (bake_dir / 'lighting.json').is_file()


def _authored_plate(bake_dir: Path) -> bool:
    try:
        meta = json.loads((bake_dir / 'sway.json').read_text(encoding='utf-8'))
        return bool((meta.get('plate') or {}).get('authored'))
    except Exception:                                        # noqa: BLE001
        return False


def bake_sway(sid: str, status=print) -> list[dict]:
    """按**主背景**拆一次,同一份字节写进每个已有照明载荷的时段目录(与 albedo 同一条规则)。

    没有载荷目录的时段原画**跳过并说出来**:不为它单独建一个只装摆动图的目录(打包按载荷入口展开,
    那种目录进不了包;而且那个时段本来就缺整套照明载荷,该先烘的是那个)。
    作者手修过的底板(``sway.json`` 里 ``plate.authored = true``)不覆盖。
    """
    main_bg = scene_paths(sid)['bg_name']
    scene = Scene(sid)
    data = scene_paths(sid)['data']
    status(f'{sid} / {main_bg}(主背景):分割与拆层…')
    seg = CachedSegmenter((scene.rt_dir / main_bg).read_bytes(), status)
    lock = read_lock(scene.bake_dir, scene.native, status)
    if lock is not None:
        status(f'  读到作者锁定掩码 {LOCK_FILE}:{lock.mean() * 100:.1f}% 的像素不动')
    paint = read_paint(scene.bake_dir, scene.native, status)
    if paint is not None:
        status(f'  读到作者涂层 {PAINT_FILE}:补植被 {(paint["veg"] > 128).mean() * 100:.1f}%、'
               f'锁死 {(paint["freeze"] > 128).mean() * 100:.1f}%、刚体 {(paint["rigid"] > 128).mean() * 100:.1f}%')
    overrides = read_overrides(scene.bake_dir)
    if overrides['anchors'] or overrides['coherent']:
        status(f'  读到作者逐株设置 {OVERRIDES_FILE}:锚点 {len(overrides["anchors"])} 个、整体摆 {len(overrides["coherent"])} 株')
    maps, meta = build_layers(scene, data, seg, status=status, lock=lock, paint=paint, overrides=overrides)
    veg = meta.pop('_veg')
    blobs = {name: _png(arr) for name, arr in maps.items() if name != 'sway_plate.png'}
    main_plan = plate_plan(veg)
    lit = bool(data.get('lighting'))
    depth_rel = ((data.get('depthConfig') or {}).get('depth_map')) or 'raw_depth_rg.png'
    src_sha1 = hashlib.sha1((scene.rt_dir / main_bg).read_bytes()).hexdigest()[:12]
    rows = []
    for bg in scene_backgrounds(sid):
        s = Scene(sid, bg)
        if s.native != scene.native:
            status(f'  跳过 {bg}:尺寸 {s.native} 与主背景 {scene.native} 不同,拆层对不上')
            continue
        if not _has_payload(s.bake_dir):
            status(f'  跳过 {bg}:lighting/{s.bake_dir.name}/ 没有照明载荷(先烘 scene_fields),这个时段草木不动')
            continue
        authored = _authored_plate(s.bake_dir)
        for name, b in blobs.items():
            _atomic_bytes(s.bake_dir / name, b)
        # 底板按**这个时段自己的原画**补(夜景的漏出处要是夜景的颜色);分割与"补哪些像素"用主背景那一份
        if authored:
            status(f'  {s.bake_dir.name}/sway_plate.png 是作者手修的,保留')
        else:
            vimg = np.asarray(Image.open(s.rt_dir / bg).convert('RGB'))
            _atomic_bytes(s.bake_dir / 'sway_plate.png', _png(fill_plate(vimg, main_plan)))
        lit_files = {}
        if lit:
            lit_files = lit_plates(s, veg, depth_rel, status)
            for name, b in lit_files.items():
                _atomic_bytes(s.bake_dir / name, b)
            status(f'  {s.bake_dir.name}/:打光的漏出处补了 {", ".join(sorted(lit_files)) or "(一张都没有)"}')
        out_meta = {
            'version': SWAY_VERSION,
            'from_background': main_bg,
            'source_sha1': src_sha1,
            'plate': {'file': 'sway_plate.png', 'authored': authored, 'inpaint': 'opencv-telea-band',
                      'from': bg},
            # 打光场景:漏出处光照要用的几何件(扣掉植物的版本)。缺 = 这个时段不打光或没烘几何场
            'litPlate': ({k: v for k, v in LIT_PLATE_FILES.items() if v in lit_files} or None) if lit else None,
            'matte': 'sway_matte.png',
            'ids': 'sway_ids.png',
            'rigid': 'sway_rigid.png',
            'margin': meta['margin'],
            'lock': meta['lock'],
            'paint': meta['paint'],
            'rigid_coverage': meta['rigid_coverage'],
            'overrides': meta.get('overrides'),
            'perspectiveScale': data.get('perspectiveScale'),
            'depthScale': meta['depthScale'],
            'channels': {
                'matte': 'R 植被 alpha(软边) / G 叶度(0 木质 → 1 叶) / B 自由度(场:下沿 0 → 梢 1)',
                'rigid': '刚体度(分割出的木质自动打底 + 作者加减;1 = 只跟着整株转、一点不弯);'
                         '单独一张是因为 canvas 会按 alpha 预乘,塞进 matte 的 alpha 会把整张 RGB 清零',
                'ids': 'R/G 实例 id 低/高字节(0 = 无) / B 种类(1 plant / 2 field)',
            },
            'segmentation': {'model': SAM_MODEL, 'vegetation': list(VEG_PROMPTS), 'woody': list(WOODY_PROMPTS),
                             'rock': list(ROCK_PROMPTS), 'score_threshold': SCORE_THRESHOLD},
            'veg_coverage': meta['veg_coverage'],
            'rock_coverage': meta['rock_coverage'],
            'instances': meta['instances'],
        }
        _atomic_bytes(s.bake_dir / 'sway.json',
                      (json.dumps(out_meta, ensure_ascii=False, indent=1) + '\n').encode('utf-8'))
        # v1 的单张摆动图不再有人读
        old = s.bake_dir / 'sway.png'
        if old.is_file():
            old.unlink()
        status(f'  → {s.bake_dir.relative_to(_ROOT).as_posix()}/sway_*.png')
        rows.append({'key': s.bake_dir.name, 'instances': len(meta['instances'])})
    return rows


def freeze_into_paint(paint: dict[str, np.ndarray] | None, mask: np.ndarray) -> np.ndarray:
    """把一张布尔掩码并进作者涂层的「锁死」通道,返回完整的 RGBA 四通道。

    纯函数,好测:**别的三个通道一根汗毛都不许动**(补植被 / 加刚体 / 减刚体 都是作者的活),
    锁死通道取并集(命令行圈的那几株与手涂的那些块叠加,不是覆盖)。
    """
    h, w = mask.shape
    out = np.zeros((h, w, 4), np.uint8)
    if paint is not None:
        for i, k in enumerate(('veg', 'freeze', 'rigid', 'unrigid')):
            out[..., i] = paint[k]
    out[..., 1] = np.maximum(out[..., 1], np.where(mask, 255, 0).astype(np.uint8))
    return out


def seed_lock(sid: str, ids_arg: str, status=print) -> None:
    """把当前拆层里的若干株锁死:圈"画面上那一丛"最省事的办法就是给它的实例 id。

    ⚠ 写的是 ``sway_paint.png`` 的 **G 通道**,不是另起一张 ``sway_lock.png``。
    "同一份内容两个来源"正是当初把作者的活吃回来的那个 bug:工作台里擦掉 → 保存成功 →
    刷新一下,盘上另一张图又把擦掉的全读了回来。这条命令与工作台写的是同一张图、同一个通道,
    覆盖前也走工作台那套历史(后悔了能在工作台的「历史…」里恢复)。
    """
    from scipy import ndimage as ndi

    scene = Scene(sid)
    p = scene.bake_dir / 'sway_ids.png'
    if not p.is_file():
        raise SystemExit(f'{p} 不在:先烘一次,再按 sway.json 里的 id 锁')
    a = np.asarray(Image.open(p).convert('RGB')).astype(np.int32)
    idm = a[..., 0] + 256 * a[..., 1]
    want = sorted({int(x) for x in ids_arg.replace(',', ' ').split()})
    m = np.isin(idm, want)
    if not m.any():
        raise SystemExit(f'这些 id 在 {p.name} 里一个像素都没有:{want}')
    m = ndi.binary_dilation(m, iterations=2)              # 连植被软边那一圈一起锁,否则边上留一道会动的毛边

    old = read_lock(scene.bake_dir, scene.native, status)  # 还留着旧文件的话,顺手一起迁进来
    if old is not None:
        m |= old
    out = freeze_into_paint(read_paint(scene.bake_dir, scene.native, status), m)

    try:    # 覆盖作者的涂层之前留一份;历史与工作台同一个目录、同一套命名
        from tools.sway_workbench import layers as _wb
        _wb.keep_history(scene)
    except Exception as e:                                # noqa: BLE001 - 留不成也得让作者知道
        status(f'  ⚠ 没留成历史({e}):照样写,但这一次覆盖撤不回来')

    buf = io.BytesIO()
    Image.fromarray(out, 'RGBA').save(buf, format='PNG', optimize=True)
    _atomic_bytes(scene.bake_dir / PAINT_FILE, buf.getvalue())
    status(f'  锁死通道({PAINT_FILE} 的 G):{(out[..., 1] > 128).mean() * 100:.1f}% 的像素不动(并入 id {want})')
    lp = scene.bake_dir / LOCK_FILE
    if lp.is_file():
        lp.unlink()
        status(f'  旧的 {LOCK_FILE} 已并进涂层并删除——锁死区从此只有一个来源')


def main() -> None:
    import argparse
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, 'reconfigure'):
            stream.reconfigure(encoding='utf-8', errors='replace')
    ap = argparse.ArgumentParser(prog='character_lighting_lab.sway_field')
    ap.add_argument('--scene', required=True)
    ap.add_argument('--lock-ids',
                    help='把这些实例 id(上一次烘焙的,逗号分隔)并进涂层的「锁死」通道再烘'
                         '(写 sway_paint.png 的 G,与草木工作台同一份数据)')
    args = ap.parse_args()
    if args.lock_ids:
        seed_lock(args.scene, args.lock_ids)
    bake_sway(args.scene)


if __name__ == '__main__':
    main()
