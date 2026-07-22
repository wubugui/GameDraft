"""SAM3-litetext semantic emitter gate (ported from the lightvolume experiment's
semantic_emitter_experiment: run_sam3_litetext.py + refine_object_evidence.py).

gate = semantic(mask x score, max over prompts) x object_gate(core/halo/direction
evidence). Multiplied into the statistical emitter confidence in stage_hdr --
the statistical model already carries the daylight/scene gate, so it is NOT
duplicated here. Cached per background hash; missing model degrades to gate=1.
"""
from __future__ import annotations

import math
import time
from pathlib import Path

import numpy as np
from PIL import Image
from scipy.ndimage import distance_transform_edt, find_objects, label

MODEL_ID = 'vil-uob/sam3-litetext-s0'
PROMPTS = ['burning candle flame', 'lit lantern', 'glowing window', 'small electric lamp']
LUMA_W = np.array([0.2126, 0.7152, 0.0722], np.float32)


def _smoothstep(e0, e1, x):
    t = np.clip((np.asarray(x, np.float32) - e0) / max(e1 - e0, 1e-9), 0, 1)
    return t * t * (3.0 - 2.0 * t)


def _tile_boxes(w: int, h: int):
    tw = min(w, 1200)
    starts = [0] if w <= tw else [0, w - tw]
    return [(x, 0, x + tw, h) for x in starts]


def _semantic_map(img: Image.Image, status=print) -> np.ndarray | None:
    import os
    os.environ.setdefault('HF_HUB_OFFLINE', '1')      # snapshot is local; the
    os.environ.setdefault('TRANSFORMERS_OFFLINE', '1')  # SOCKS proxy breaks httpx
    try:
        import torch
        from transformers import AutoModel, AutoProcessor
    except Exception as e:
        status(f'[sam-gate] transformers/torch unavailable ({e}); gate disabled')
        return None
    try:
        processor = AutoProcessor.from_pretrained(MODEL_ID, trust_remote_code=True, local_files_only=True)
        model = AutoModel.from_pretrained(MODEL_ID, trust_remote_code=True, local_files_only=True)
    except Exception as e:
        status(f'[sam-gate] model load failed ({e}); gate disabled')
        return None
    device = torch.device('mps' if torch.backends.mps.is_available() else 'cpu')
    dtype = torch.float32
    model = model.to(device=device, dtype=dtype).eval()
    w, h = img.size
    semantic = np.zeros((h, w), np.float32)
    t0 = time.time()
    for box in _tile_boxes(w, h):
        x0, y0, x1, y1 = box
        crop = img.crop(box)
        pix = processor(images=crop, return_tensors='pt')['pixel_values'].to(device=device, dtype=dtype)
        with torch.inference_mode():
            vis = model.get_vision_features(pixel_values=pix)
        for prompt in PROMPTS:
            ti = processor(text=prompt, return_tensors='pt')
            with torch.inference_mode():
                out = model(input_ids=ti['input_ids'].to(device),
                            attention_mask=ti['attention_mask'].to(device),
                            vision_embeds=vis)
            res = processor.post_process_instance_segmentation(
                out, threshold=0.15, mask_threshold=0.5,
                target_sizes=[[y1 - y0, x1 - x0]])[0]
            scores = np.asarray(res['scores'].detach().float().cpu()).reshape(-1)
            masks = np.asarray(res['masks'].detach().float().cpu())
            if masks.ndim == 4:
                masks = masks[:, 0]
            for s, m in zip(scores, masks):
                cur = semantic[y0:y1, x0:x1]
                np.maximum(cur, m.astype(np.float32) * float(s), out=cur)
    status(f'[sam-gate] SAM3 inference {time.time()-t0:.1f}s, '
           f'semantic>0.15 pixels {(semantic>0.15).mean()*100:.2f}%')
    return semantic


def _component_evidence(luma: np.ndarray, semantic: np.ndarray) -> np.ndarray:
    """Verbatim port of the experiment's core/halo/direction object evidence."""
    labels, _ = label(semantic > 0.15)
    gate_field = np.zeros_like(semantic, dtype=np.float32)
    for cid, slices in enumerate(find_objects(labels), 1):
        if slices is None:
            continue
        ys, xs = slices
        area = int(np.count_nonzero(labels[slices] == cid))
        if area < 8:
            continue
        pad = int(max(18, min(80, 10 + 3 * math.sqrt(area / math.pi))))
        y0, y1 = max(0, ys.start - pad), min(luma.shape[0], ys.stop + pad)
        x0, x1 = max(0, xs.start - pad), min(luma.shape[1], xs.stop + pad)
        comp = labels[y0:y1, x0:x1] == cid
        ll = luma[y0:y1, x0:x1]
        dist = distance_transform_edt(~comp)
        radius = max(2.0, math.sqrt(area / math.pi))
        near = (dist > 0) & (dist <= max(5.0, 1.2 * radius))
        far = (dist > max(7.0, 1.8 * radius)) & (dist <= max(16.0, 3.5 * radius))
        if not near.any() or not far.any():
            continue

        def ev(a, b):
            return float(np.log2((a + 1e-4) / (b + 1e-4)))

        core_ev = ev(np.percentile(ll[comp], 80), np.percentile(ll[far], 80))
        cy, cx = np.argwhere(comp).mean(axis=0)
        gy, gx = np.indices(comp.shape)
        angle = (np.arctan2(gy - cy, gx - cx) + math.pi) / (2 * math.pi)
        sector_ev = []
        for sector in range(8):
            ang = (angle >= sector / 8) & (angle < (sector + 1) / 8)
            ns, fs = near & ang, far & ang
            if np.count_nonzero(ns) > 4 and np.count_nonzero(fs) > 4:
                sector_ev.append(ev(np.percentile(ll[ns], 50), np.percentile(ll[fs], 50)))
        if not sector_ev:
            continue
        halo_ev = float(np.median(sector_ev))
        pos_frac = float(np.mean(np.asarray(sector_ev) > 0.1))
        core_gate = float(_smoothstep(0.25, 0.80, core_ev))
        halo_gate = float(_smoothstep(0.05, 0.35, halo_ev))
        dir_gate = float(_smoothstep(0.45, 0.75, pos_frac))
        gate_field[labels == cid] = core_gate * max(halo_gate, 0.40 * dir_gate)
    return gate_field


def emitter_gate(img_path: Path, cache_dir: Path, h: str, status=print) -> np.ndarray | None:
    """Full-res [0,1] semantic emitter gate for the given background, cached.
    Returns None when the model is unavailable (caller falls back to gate=1)."""
    cache = cache_dir / f'sam_gate_{h}.png'
    if cache.exists():
        return np.asarray(Image.open(cache), np.float32) / 65535.0
    img = Image.open(img_path).convert('RGB')
    semantic = _semantic_map(img, status)
    if semantic is None:
        return None
    luma = (np.asarray(img, np.float32) / 255.0) @ LUMA_W
    gate = np.clip(semantic * _component_evidence(luma, semantic), 0, 1)
    Image.fromarray(np.round(gate * 65535).astype(np.uint16)).save(cache, optimize=True)
    status(f'[sam-gate] gate>0.1 pixels {(gate>0.1).mean()*100:.2f}%, cached {cache.name}')
    return gate
