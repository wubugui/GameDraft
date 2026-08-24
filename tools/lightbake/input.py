"""场景装载与伪世界几何重建(方案 §3)。★ 本包唯一的外部数据依赖面。

只读工程文件:场景 JSON(`public/assets/scenes/`)、原画与深度图
(`public/resources/runtime/scenes/`)。**不 import 任何其他工具模块** ——
数据契约逐字来自方案 §3(深度解码 §3.2 / 伪世界 §3.3 / 法线 §3.4 /
角色刻度 = character_band_wu 的刻度链)。
"""
from __future__ import annotations

import copy
import json
from dataclasses import dataclass
from pathlib import Path

import numpy as np
from PIL import Image

from .const import CHAR_SCENE_H, DEFAULT_SKY, WORK_W
from .encode import resize_f

ROOT = Path(__file__).resolve().parents[2]
SCENES_JSON = ROOT / 'public' / 'assets' / 'scenes'
SCENES_RT = ROOT / 'public' / 'resources' / 'runtime' / 'scenes'


@dataclass
class SceneInput:
    sid: str
    native: tuple[int, int]          # (w, h)
    work: tuple[int, int]            # (w, h)
    bg_srgb: np.ndarray              # (h,w,3) float32 0..1,原生分辨率
    depth: np.ndarray                # (h,w) float32,work
    world: np.ndarray                # (h,w,3) float32,work
    normal: np.ndarray               # (h,w,3) float32,work,全值域世界法线,edge-safe
    q: np.ndarray                    # (h,w,3) float32,work
    R: np.ndarray                    # (3,3) float32 正交,world = R @ q
    ppu: float
    cx: float
    cy: float
    char_wu: float
    band: float
    scene_per_wu: float
    bake_sky: dict | None            # 场景 JSON lighting.bakeSky(无则 None)
    bg_name: str
    scene_json: Path
    rt_dir: Path


def edge_safe_normals(world: np.ndarray, R: np.ndarray) -> np.ndarray:
    """伪世界高度场的法线,**不跨深度断层**(§3.4;从 bake_gbuffer 带过来的逻辑)。

    中心差分会横跨前景/背景的深度断崖,把每一条剪影都变成一圈假倒角。
    这里前向与后向切线都指向图像轴正方向,**取更短的那条**:只要有一侧还落在
    同一个可见表面上,导数就留在那个面上。边界行/列固定用朝内的那侧。
    最后统一翻到朝相机一侧(相机看向 q 空间 +z,世界里是 R 的第三列)。
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
    facing = -R[:, 2]
    flip = (n @ facing) < 0
    n[flip] *= -1.0
    return n.astype(np.float32)


def _decode_depth(rt_dir: Path, cfg: dict, native: tuple[int, int]) -> np.ndarray:
    """§3.2 深度解码,逐字照抄,不许改。"""
    dp = rt_dir / cfg.get('depth_map', 'raw_depth_rg.png')
    if not dp.exists():
        raise FileNotFoundError(f'深度图不存在: {dp}')
    rg = np.asarray(Image.open(dp).convert('RGB'), np.uint16)
    # ⚠ raw_depth_rg 与背景成对,git 可能拆散(§3.1 / 记忆
    #   depthconfig-png-pair-can-split)。28/28 场景实测:深度图尺寸 = 背景
    #   尺寸恒成立 —— 不同即警(重采样仍能对齐,但值得人看一眼)。
    nw, nh = native
    if (rg.shape[1], rg.shape[0]) != (nw, nh):
        print(f'  ⚠ {rt_dir.name}: 深度图 {rg.shape[1]}x{rg.shape[0]} ≠ 背景 '
              f'{nw}x{nh}(28 场景实测应相等;若刚换过素材先跑 '
              f'./dev.sh audit-depth)', flush=True)
    raw = rg[..., 0] * 256 + rg[..., 1]
    t = raw.astype(np.float32) / 65535.0
    dm = cfg.get('depth_mapping')
    if not dm:
        # 缺标定时 scale=1/offset=0 的静默退化会让整份载荷全错(实测标定量级
        # scale 1.9–5.95 / offset −0.95..−4.54)—— 与缺深度图同级,硬错。
        raise RuntimeError(f'{rt_dir.name}: depthConfig 缺 depth_mapping,'
                           '深度无标定,不烘')
    if dm.get('invert'):
        t = 1.0 - t
    d = t * float(dm.get('scale', 1.0)) + float(dm.get('offset', 0.0))
    if d.shape[::-1] != native:
        d = resize_f(d, native)
    return d.astype(np.float32)


def load(sid: str, work_w: int = WORK_W) -> SceneInput:
    """装载一个场景的全部烘焙输入。"""
    j = SCENES_JSON / f'{sid}.json'
    if not j.exists():
        raise FileNotFoundError(f'场景 JSON 不存在: {j}')
    data = json.loads(j.read_text(encoding='utf-8'))
    bgs = data.get('backgrounds') or []
    bg_name = (bgs[0].get('image') if bgs and isinstance(bgs[0], dict) else None) \
        or 'background.png'
    rt_dir = SCENES_RT / sid
    bg_path = rt_dir / bg_name
    if not bg_path.exists():
        raise FileNotFoundError(f'场景 {sid} 背景图不存在: {bg_path}')
    img = Image.open(bg_path).convert('RGB')
    native = img.size
    bg_srgb = np.asarray(img, np.float32) / 255.0

    cfg = data.get('depthConfig')
    if not cfg or 'M' not in cfg:
        raise RuntimeError(f'{sid}: 没有 depthConfig,无法重建伪世界')
    depth_native = _decode_depth(rt_dir, cfg, native)

    M = cfg['M']
    R = np.asarray(M['R'], np.float32)
    # §3.3 全部推导建立在「转置即逆」上 —— 非正交的 R 会静默产出错误伪世界
    if R.shape != (3, 3) or not np.allclose(R @ R.T, np.eye(3), atol=1e-4):
        raise RuntimeError(f'{sid}: depthConfig.M.R 非 3×3 正交阵,不烘')
    nw, nh = native
    # 28/28 场景实测不变量:标定中心 = 画幅中心。偏了 = depthConfig 与背景
    # 不配对(素材换了半边的信号)—— 硬错,别带病烘。
    if abs(float(M['cx']) - nw / 2) > 1.0 or abs(float(M['cy']) - nh / 2) > 1.0:
        raise RuntimeError(
            f'{sid}: 标定中心 ({M["cx"]}, {M["cy"]}) 偏离画幅中心 '
            f'({nw / 2}, {nh / 2}) —— depthConfig 与背景可能被 git 拆散,'
            f'先跑 ./dev.sh audit-depth')
    w = min(work_w, nw)
    h = max(1, round(nh * w / nw))
    s = w / nw
    ppu = float(M['ppu']) * s
    cx = float(M['cx']) * s
    cy = float(M['cy']) * s

    d = resize_f(depth_native, (w, h)) if (w, h) != native else depth_native
    px = np.arange(w, dtype=np.float32)[None, :].repeat(h, 0)
    py = np.arange(h, dtype=np.float32)[:, None].repeat(w, 1)
    q = np.stack([(px - cx) / ppu, (cy - py) / ppu, d], -1).astype(np.float32)
    world = (q @ R.T).astype(np.float32)          # world = R·q,R 正交,转置即逆
    # §3.4:法线用 edge-safe 差分(不是 §3.3 里的高斯平滑中心差分);
    # 平滑只作用在 world 上游的深度已由重采样自带,法线自身不再模糊 ——
    # 与现役 bake_gbuffer 的用法一致(edge_safe_normals(world, R))。
    normal = edge_safe_normals(world, R)

    # 角色刻度链(与 tools/scene_relight/bake.py:character_band_wu 同一约定):
    # 场景坐标 --(native_w / worldWidth)--> 背景像素 --(1/ppu 原生)--> 世界单位
    world_w = float(data.get('worldWidth') or 0.0)
    ppu_native = float(M['ppu'])
    if world_w <= 0 or ppu_native <= 0:
        raise RuntimeError(f'{sid}: 缺 worldWidth 或 depthConfig.M.ppu,无法推角色刻度')
    scene_per_wu = world_w / (nw / ppu_native)
    char_wu = CHAR_SCENE_H / scene_per_wu
    band = char_wu * 1.15

    bake_sky = (data.get('lighting') or {}).get('bakeSky')

    return SceneInput(
        sid=sid, native=native, work=(w, h), bg_srgb=bg_srgb,
        depth=np.ascontiguousarray(d, np.float32), world=world, normal=normal,
        q=q, R=R, ppu=ppu, cx=cx, cy=cy,
        char_wu=char_wu, band=band, scene_per_wu=scene_per_wu,
        bake_sky=dict(bake_sky) if bake_sky else None,
        bg_name=bg_name, scene_json=j, rt_dir=rt_dir,
    )


def resolve_sky_spec(inp: SceneInput, override: dict | None = None) -> dict:
    """烘焙期逃逸辐射的取法。优先级:CLI 覆写 > 场景 JSON lighting.bakeSky >
    DEFAULT_SKY(§5.3)。**绝对不许从画面上取值**。

    深拷贝(DEFAULT_SKY 的 color 是模块级可变对象,批烘时不许共享);
    `_source` 记来源(override/scene/default)—— 回落 default 时 pipeline 显式
    告警:实测 28/28 场景都还没写 bakeSky,无声吃默认值就是无声错。
    """
    if override:
        return {**copy.deepcopy(override), '_source': 'override'}
    if inp.bake_sky:
        return {**copy.deepcopy(inp.bake_sky), '_source': 'scene'}
    return {**copy.deepcopy(DEFAULT_SKY), '_source': 'default'}


def save_bake_sky(sid: str, spec: dict) -> Path:
    """把调定的烘焙期天空写回场景 JSON `lighting.bakeSky`(§5.3 / §11.1)。

    场景 JSON 是业务数据 —— 一律走编辑器**统一写盘出口**
    (`tools/editor/file_io`:原子写 + 既定格式规范化 + 保键序),
    不许自己 `json.dump`(editor-tools norms 第一戒)。GUI 的「存回」按钮
    调的就是本函数;CLI/脚本也从这里走,不给 GUI 单开后门。
    """
    from tools.editor.file_io import read_json, write_json
    j = SCENES_JSON / f'{sid}.json'
    clean = {k: v for k, v in spec.items() if not k.startswith('_')}
    data = read_json(j)
    data.setdefault('lighting', {})['bakeSky'] = clean
    write_json(j, data)
    return j


#: lighting.bakeParams 键表:场景 JSON 用 camelCase,库内用 snake_case。
#: 三处消费(parse/save/GUI)共用一张表 —— 键的存在性只在这里定义一次。
_BP_CAMEL = {'workW': 'work_w', 'spp': 'spp', 'momentSpp': 'moment_spp',
             'aoSpp': 'ao_spp', 'volSpp': 'vol_spp',
             'volDensity': 'vol_density', 'volMaxCells': 'vol_max_cells',
             'noGi': 'no_gi', 'nee': 'nee', 'clampIndirect': 'clamp_indirect',
             'denoise': 'denoise', 'denoiseIters': 'denoise_iters'}
_BP_SNAKE = {v: k for k, v in _BP_CAMEL.items()}
_BP_TYPES = {'work_w': int, 'spp': int, 'moment_spp': int, 'ao_spp': int,
             'vol_spp': int, 'vol_density': (int, float),
             'vol_max_cells': int, 'no_gi': bool, 'nee': bool,
             'clamp_indirect': (int, float), 'denoise': bool,
             'denoise_iters': int}


def parse_bake_params(raw) -> dict:
    """`lighting.bakeParams`(camelCase)→ snake kwargs。未知键/错类型**硬错**
    —— 参数长在数据里就必须被校验:静默吞错键,「teahouse 要密度 4」这类
    事实就会再次死于拼写(2026-08-25 制作人「4搞」的立法目的)。"""
    if raw is None:
        return {}
    if not isinstance(raw, dict):
        raise ValueError('lighting.bakeParams 必须是对象,拿到 '
                         f'{type(raw).__name__}')
    out = {}
    for k, v in raw.items():
        if k not in _BP_CAMEL:
            raise ValueError(f'lighting.bakeParams 未知键 {k!r};'
                             f'允许:{sorted(_BP_CAMEL)}')
        sk = _BP_CAMEL[k]
        t = _BP_TYPES[sk]
        if isinstance(v, bool) and t is not bool:
            raise ValueError(f'bakeParams.{k} 类型错:期望 {t},拿到 bool')
        if not isinstance(v, t):
            raise ValueError(f'bakeParams.{k} 类型错:期望 {t},'
                             f'拿到 {type(v).__name__}')
        out[sk] = v
    return out


def read_bake_params(sid: str) -> dict:
    """读场景 JSON 的 `lighting.bakeParams`(snake 化;无则 {})。
    独立于 load —— work_w 要在 load **之前**决议。"""
    j = SCENES_JSON / f'{sid}.json'
    data = json.loads(j.read_text(encoding='utf-8'))
    return parse_bake_params((data.get('lighting') or {}).get('bakeParams'))


def save_runtime_sky(sid: str, sky: dict) -> Path:
    """把**运行时**程序性天空写回场景 JSON `lighting.sky`(游戏着色消费的
    那份;与 bakeSky 是两回事)。统一写盘出口,同 save_bake_sky。"""
    from tools.editor.file_io import read_json, write_json
    j = SCENES_JSON / f'{sid}.json'
    clean = {k: v for k, v in sky.items() if not k.startswith('_')}
    data = read_json(j)
    data.setdefault('lighting', {})['sky'] = clean
    write_json(j, data)
    return j


def save_bake_params(sid: str, params: dict) -> Path:
    """把质量参数写回 `lighting.bakeParams`(camelCase;与 save_bake_sky
    同门:统一写盘出口,GUI 与脚本都从这走)。None 值不落盘。"""
    from tools.editor.file_io import read_json, write_json
    j = SCENES_JSON / f'{sid}.json'
    camel = {}
    for k, v in params.items():
        if k not in _BP_SNAKE:
            raise ValueError(f'save_bake_params 未知键 {k!r}')
        if v is None:
            continue
        camel[_BP_SNAKE[k]] = v
    data = read_json(j)
    data.setdefault('lighting', {})['bakeParams'] = camel
    write_json(j, data)
    return j


def list_bakeable() -> list[str]:
    """全部可烘场景(有背景 + depthConfig + 深度图)。身份 = 场景 JSON 文件名。"""
    out = []
    for j in sorted(SCENES_JSON.glob('*.json')):
        try:
            data = json.loads(j.read_text(encoding='utf-8'))
        except Exception:                          # noqa: BLE001 — 坏 JSON 不拖垮清单
            continue
        sid = j.stem
        cfg = data.get('depthConfig') or {}
        bgs = data.get('backgrounds') or []
        bg_name = (bgs[0].get('image') if bgs and isinstance(bgs[0], dict) else None) \
            or 'background.png'
        if not cfg or 'M' not in cfg or not cfg.get('depth_mapping'):
            continue
        # 准入条件与 load() 的硬校验对齐 —— 「可烘清单」不许列出随后必炸的场景
        if float(data.get('worldWidth') or 0.0) <= 0:
            continue
        if float(cfg['M'].get('ppu') or 0.0) <= 0:
            continue
        if not (SCENES_RT / sid / bg_name).exists():
            continue
        if not (SCENES_RT / sid / cfg.get('depth_map', 'raw_depth_rg.png')).exists():
            continue
        out.append(sid)
    return out
