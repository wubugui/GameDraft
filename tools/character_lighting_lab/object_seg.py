"""图像域物体识别(SAM3 文本提示实例分割)——地形提取的第一步。

**为什么要有这一步**:地形场 `d_walk` 是由 `cal['ground_mask']` 外推出来的世界高度场
反解得到的。旧口径用「朝上 + 从画面底部 2D 洪泛」猜地面,屋顶既朝上又和街面连成一片,
于是房子被整个烘进地形——角色站在屋顶那一列时脚深度取到屋顶,遮挡/碰撞/影子跟着一起错。

**正确的顺序是先扣物体、剩下的才是地形**(2026-07-23 拍板):
  识别物体(本模块,只看图,不依赖深度) → 扣掉 → 剩余像素直接算伪世界位置
  → 被物体挡住的空洞由周围地形调和外推 → 地形层完整
朝上判据在崎岖山地必死(`ground_up_dot=0.75` 等价于「坡度 < 41.4°」,陡坡直接看不见),
而物体是有闭合轮廓的「东西」,识别它不依赖地形有多崎岖——这是「扣」比「捡」稳的根因。

**失败必须响**:模型不可用时本模块 raise。静默降级会烘出一张「没有物体」的地形
(＝房子又全烘进去了)而不给任何提示,属于「失败伪装成功」,运行时规范明令禁止。
"""
from __future__ import annotations

import json
import os
import time
from pathlib import Path

import numpy as np
from PIL import Image

MODEL_ID = 'vil-uob/sam3-litetext-s0'

# 提示词表:按题材域分组,便于按场景类型裁剪。
#
# 收词标准 =「站在地面上、会把地形高度场污染掉的东西」。地面覆盖物(草、土路、
# 水面)刻意**不收**——它们的深度≈地面,扣掉只会平白在地形上挖洞还要外推回来。
#
# 括号里是 2026-07-23 在 雾津街头/temple/破屋/阎王岭山口/码头白天 五张图上实测的
# 最高分;标 (—) 的是这五张里没有该物件、尚未在真实场景上验过的词,别当成无效就删。
PROMPT_GROUPS: dict[str, tuple[str, ...]] = {
    'architecture': (
        'building',        # .86
        'house',           # .95
        'wooden hut',      # .95
        'tiled roof',      # .95
        'stone wall',      # .89
        'wooden pillar',   # .86
        'wooden fence',    # .70
        'stone steps',     # .48
        'gate',            # .22
        'city gate tower',      # (—) 城门口
        'stone archway',        # (—) 城门/院门
        'stone arch bridge',    # (—) bridge_underpass
        'wooden pier',     # .88 码头
    ),
    'shop': (
        'awning',          # .94
        'cloth canopy',    # .79
        'shed',            # .61
        'market stall',    # .39
        'hanging cloth',   # (—) 室内帷幔/幌子
    ),
    'furniture': (
        'wooden table',    # .97
        'wooden stool',    # .96
        'wooden bed',      # .95
        'bench',           # .94  ⚠ 山地上会误命中石头,靠分数门槛压
        'cabinet',         # .93
        'shelf',           # .91
        'stove',           # (—) 灶台
    ),
    'container': (
        'boat',            # .97
        'basket',          # .93
        'wooden crate',    # .91
        'ceramic jar',     # .87
        'barrel',          # .86
        'wooden cart',     # .84
        'firewood pile',   # .50
        'water vat',       # (—) 水缸
        'sack',            # .16
    ),
    'ritual': (
        'stone statue',    # .94  神像/石像
        'lantern',         # .80
        'stone tablet',    # (—) 石碑
        'offering table',  # (—) 供桌/香案
        'censer',          # (—) 香炉('incense burner' 只到 .17,换词)
        'stone shrine',    # (—) 土地庙
        'notice board',    # (—) 告示板
        'stone well',      # (—) 枯井
    ),
    'vegetation': (
        'tree',            # .78
        'dead tree',       # .73
        'bamboo',          # .41  ⚠ 易误命中木构架
        'bush',            # .24
        'tree stump',      # (—)
    ),
    # 石头单列且默认不启用:山地场景里「石头」常常就是地形本身
    # (阎王岭实测 boulder 命中 166 个 @.67)。要用就按场景开,并配合人工兜底。
    'rock': ('boulder',),
    'creature': (
        'person',          # (—) 茶馆/街市有人
        'horse',           # (—)
        'dead body',       # (—) 义庄/停尸
    ),
}
DEFAULT_GROUPS = ('architecture', 'shop', 'furniture', 'container',
                  'ritual', 'vegetation', 'creature')

#: SAM 侧收集阈值取低(便宜的过滤放到消费端,避免改阈值就要重跑推理)
COLLECT_THRESHOLD = 0.15
#: 实例去重的 IoU 阈值(跨提示词/跨分块的同一个东西会被多次命中)
NMS_IOU = 0.6


def _encode_ids(ids: np.ndarray) -> Image.Image:
    """实例 id → RGB(r=高字节, g=低字节)。刻意不用 16bit 灰度:查看器要在浏览器里
    解出精确 id 做「点实例翻转」,而 canvas 只给 8bit 通道,16bit 灰度会被截断成 id&255。"""
    rgb = np.zeros(ids.shape + (3,), np.uint8)
    rgb[..., 0] = (ids >> 8).astype(np.uint8)
    rgb[..., 1] = (ids & 0xFF).astype(np.uint8)
    return Image.fromarray(rgb)


def _decode_ids(path: Path) -> np.ndarray:
    a = np.asarray(Image.open(path).convert('RGB'), np.uint16)
    return (a[..., 0] << 8) | a[..., 1]


def _tile_boxes(w: int, h: int):
    tw = min(w, 1200)
    starts = [0] if w <= tw else [0, w - tw]
    return [(x, 0, x + tw, h) for x in starts]


def _prompts_for(P: dict) -> list[str]:
    groups = P.get('object_groups') or DEFAULT_GROUPS
    if isinstance(groups, str):
        groups = [g.strip() for g in groups.split(',') if g.strip()]
    words: list[str] = []
    for g in groups:
        if g not in PROMPT_GROUPS:
            raise RuntimeError(f'未知的物体提示词组 {g!r};可选:{sorted(PROMPT_GROUPS)}')
        words.extend(PROMPT_GROUPS[g])
    extra = P.get('object_prompts_extra') or ()
    if isinstance(extra, str):
        extra = [w.strip() for w in extra.split(',') if w.strip()]
    words.extend(extra)
    return list(dict.fromkeys(words))          # 去重保序


def _load_model(status):
    os.environ.setdefault('HF_HUB_OFFLINE', '1')
    os.environ.setdefault('TRANSFORMERS_OFFLINE', '1')
    try:
        import torch
        from transformers import AutoModel, AutoProcessor
    except Exception as e:                      # noqa: BLE001
        raise RuntimeError(
            f'物体识别需要 torch/transformers,当前不可用({e})。'
            '不能降级——没有物体掩膜烘出来的地形会把房子当地面。') from e
    try:
        pr = AutoProcessor.from_pretrained(MODEL_ID, trust_remote_code=True, local_files_only=True)
        md = AutoModel.from_pretrained(MODEL_ID, trust_remote_code=True, local_files_only=True)
    except Exception as e:                      # noqa: BLE001
        raise RuntimeError(
            f'物体识别模型 {MODEL_ID} 载入失败({e})。请先把权重放进本地 HF 缓存。') from e
    device = torch.device('mps' if torch.backends.mps.is_available() else 'cpu')
    md = md.to(device=device, dtype=torch.float32).eval()
    status(f'[objects] model {MODEL_ID} on {device.type}')
    return torch, pr, md, device


def segment_objects(img_path: Path, cache_dir: Path, h: str, P: dict,
                    status=print) -> tuple[np.ndarray, list[dict]]:
    """返回 (实例 id 图 uint16 原生分辨率, 实例元信息列表)。按背景哈希缓存。

    id 0 = 未命中(候选地形);其余为实例编号,与 meta 列表中的 ``id`` 对应。
    """
    cache_png = cache_dir / f'objects_{h}.png'
    cache_json = cache_dir / f'objects_{h}.json'
    if cache_png.exists() and cache_json.exists():
        ids = _decode_ids(cache_png)
        meta = json.loads(cache_json.read_text())
        status(f'[objects] cached {cache_png.name}: {len(meta)} 实例')
        return ids, meta

    prompts = _prompts_for(P)
    torch, pr, md, device = _load_model(status)
    img = Image.open(img_path).convert('RGB')
    W, H = img.size
    found: list[tuple[float, str, np.ndarray]] = []
    t0 = time.time()
    for x0, y0, x1, y1 in _tile_boxes(W, H):
        pix = pr(images=img.crop((x0, y0, x1, y1)), return_tensors='pt')['pixel_values'].to(device)
        with torch.inference_mode():
            vis = md.get_vision_features(pixel_values=pix)
        for p in prompts:
            ti = pr(text=p, return_tensors='pt')
            with torch.inference_mode():
                out = md(input_ids=ti['input_ids'].to(device),
                         attention_mask=ti['attention_mask'].to(device),
                         vision_embeds=vis)
            res = pr.post_process_instance_segmentation(
                out, threshold=COLLECT_THRESHOLD, mask_threshold=0.5,
                target_sizes=[[y1 - y0, x1 - x0]])[0]
            scores = np.asarray(res['scores'].detach().float().cpu()).reshape(-1)
            masks = np.asarray(res['masks'].detach().float().cpu())
            if masks.ndim == 4:
                masks = masks[:, 0]
            for s, m in zip(scores, masks):
                full = np.zeros((H, W), bool)
                full[y0:y1, x0:x1] = m > 0.5
                if full.sum() < 64:
                    continue
                found.append((float(s), p, full))

    # 跨提示词/分块去重:高分优先,与已收实例 IoU 超阈值即丢
    found.sort(key=lambda t: -t[0])
    kept: list[tuple[float, str, np.ndarray]] = []
    for s, p, m in found:
        a = m.sum()
        dup = False
        for _, _, km in kept:
            inter = np.count_nonzero(m & km)
            if inter and inter / (a + km.sum() - inter) > NMS_IOU:
                dup = True
                break
        if not dup:
            kept.append((s, p, m))

    ids = np.zeros((H, W), np.uint16)
    meta: list[dict] = []
    for i, (s, p, m) in enumerate(kept, start=1):
        if i > 65535:
            status(f'[objects] ⚠ 实例数超 uint16 上限,截断于 {i - 1}')
            break
        ids[m] = i                              # 后者覆盖前者:高分在前,故低分实例被压
        ys, xs = np.where(m)
        meta.append(dict(id=i, prompt=p, score=round(s, 4), area=int(m.sum()),
                         bbox=[int(xs.min()), int(ys.min()), int(xs.max()), int(ys.max())]))
    _encode_ids(ids).save(cache_png, optimize=True)
    cache_json.write_text(json.dumps(meta, ensure_ascii=False, indent=1) + '\n')
    status(f'[objects] SAM3 {time.time() - t0:.0f}s, {len(prompts)} 词 → '
           f'{len(found)} 命中 → 去重后 {len(meta)} 实例, 覆盖 {(ids > 0).mean() * 100:.1f}%')
    return ids, meta


def object_mask(ids: np.ndarray, meta: list[dict], P: dict,
                edit: np.ndarray | None = None) -> np.ndarray:
    """实例 id 图 → 物体布尔掩膜。

    - ``object_score_min``:分数门槛(改它不需要重跑推理,元信息里带分数)
    - ``edit``:人工覆写层,与 id 图同分辨率;1=强制算物体 2=强制算地形(块优先于自动)
    """
    smin = float(P.get('object_score_min', 0.35))
    keep = {m['id'] for m in meta if m['score'] >= smin}
    mask = np.isin(ids, list(keep)) if keep else np.zeros(ids.shape, bool)
    if edit is not None:
        mask = (mask | (edit == 1)) & ~(edit == 2)
    return mask
