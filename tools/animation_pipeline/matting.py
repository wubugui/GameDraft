"""Matting — proven winner from the bake-off (see README.md §matting):

  fusion = BiRefNet defines the object extent (kills grey-bg halo outside +
           fills grey-costume holes inside)  +  color-key gives the crisp edge.

Beats plain color-key (holes grey costumes: boy jacket 2.4%) and rembg-u2net
(catastrophic holes: coolie pants 6.5%). Falls back to rembg-isnet if BiRefNet
(torch+transformers) is unavailable. Returns float alpha in [0,1].
"""
from __future__ import annotations
import numpy as np
import cv2

_bir = None
_dev = None


def _bg_grey(rgb: np.ndarray) -> np.ndarray:
    h, w, _ = rgb.shape
    c = max(8, min(h, w) // 32)
    corners = np.concatenate([
        rgb[:c, :c].reshape(-1, 3), rgb[:c, -c:].reshape(-1, 3),
        rgb[-c:, :c].reshape(-1, 3), rgb[-c:, -c:].reshape(-1, 3)])
    return np.median(corners, axis=0)


def color_key(rgb: np.ndarray) -> np.ndarray:
    """Soft alpha from distance to the flat grey background. Crisp edges, but
    holes same-colour (grey) costume regions -> only used as the edge term."""
    bg = _bg_grey(rgb)
    dist = np.sqrt(((rgb.astype(np.float32) - bg) ** 2).sum(2))
    return np.clip((dist - 18) / 22, 0, 1)


def _load_birefnet():
    global _bir, _dev
    if _bir is not None:
        return _bir
    import torch
    from transformers import AutoModelForImageSegmentation
    _dev = "mps" if torch.backends.mps.is_available() else (
        "cuda" if torch.cuda.is_available() else "cpu")
    _bir = AutoModelForImageSegmentation.from_pretrained(
        "ZhengPeng7/BiRefNet", trust_remote_code=True).to(_dev).to(torch.float32).eval()
    return _bir


def _birefnet_alpha(rgb: np.ndarray) -> np.ndarray:
    import torch
    import torchvision.transforms as T
    m = _load_birefnet()
    h, w, _ = rgb.shape
    from PIL import Image
    tf = T.Compose([T.Resize((1024, 1024)), T.ToTensor(),
                    T.Normalize([0.485, 0.456, 0.406], [0.229, 0.224, 0.225])])
    x = tf(Image.fromarray(rgb)).unsqueeze(0).to(_dev)
    with torch.no_grad():
        o = m(x)[-1].sigmoid().cpu()[0, 0].numpy()
    return cv2.resize(o, (w, h))


def _rembg_alpha(rgb: np.ndarray, model: str = "isnet-general-use") -> np.ndarray:
    from rembg import remove, new_session
    from PIL import Image
    sess = new_session(model)
    mask = remove(Image.fromarray(rgb), session=sess, only_mask=True, post_process_mask=True)
    return np.asarray(mask).astype(np.float32) / 255


def matte(rgb: np.ndarray, method: str = "fusion") -> np.ndarray:
    """RGB uint8 HxWx3 -> float alpha [0,1]."""
    if method == "color_key":
        return color_key(rgb)
    if method == "rembg_isnet":
        return _rembg_alpha(rgb, "isnet-general-use")
    if method == "birefnet":
        return _birefnet_alpha(rgb)
    if method == "fusion":
        try:
            br = _birefnet_alpha(rgb)
        except Exception:
            # BiRefNet unavailable -> fall back to a learned method that doesn't hole
            return _rembg_alpha(rgb, "isnet-general-use")
        ck = color_key(rgb)
        fused = ck.copy()
        fused[br < 0.10] = 0.0                       # kill color-key halo outside object
        core = br > 0.90
        fused[core] = np.maximum(fused[core], br[core])  # fill grey-costume holes
        return fused
    raise ValueError(f"unknown matte method: {method}")


def matte_rgba(rgb: np.ndarray, method: str = "fusion") -> np.ndarray:
    """-> HxWx4 uint8 RGBA."""
    a = (np.clip(matte(rgb, method), 0, 1) * 255).astype(np.uint8)
    return np.dstack([rgb, a])
