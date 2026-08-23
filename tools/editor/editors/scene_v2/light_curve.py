""""光环境曲线怎么存"的唯一口径。

`lightEnvCurve` 在磁盘上是 **`{"points": [...]}`**（老画布写盘处
`scene_editor.py` 的 `sc["lightEnvCurve"] = {"points": ...}`，读取处也只认这个形状），
不是裸列表。

新画布起初按裸列表读写，后果两条，都不轻：

- **读**：真实场景（`梦_夜路.json`）里它是 dict，取 `p[0]` 拿到字符串 `'p'`，
  加载当场 `ValueError`；
- **写**：写成裸列表后老画布**再也读不出这条曲线**，静默数据丢失。

所以形状判定收进这一处：读兼容两种，**写按原样**（原来是 dict 就还写 dict）。
"""
from __future__ import annotations

__all__ = ["light_curve_points", "light_curve_write_shape"]


def light_curve_points(scene: dict) -> list:
    """取控制点列表。兼容 `{"points": [...]}` 与裸列表两种形状。"""
    raw = (scene or {}).get("lightEnvCurve")
    if isinstance(raw, dict):
        pts = raw.get("points")
        return pts if isinstance(pts, list) else []
    return raw if isinstance(raw, list) else []


def light_curve_write_shape(scene: dict, points: list):
    """按**原有形状**打包写回。

    原来是 dict 就仍写 dict，并保留 dict 上除 `points` 外的其它键
    （将来加了别的曲线级配置也不会被这次写回抹掉）。
    """
    raw = (scene or {}).get("lightEnvCurve")
    if isinstance(raw, dict):
        out = dict(raw)
        out["points"] = points
        return out
    return points
