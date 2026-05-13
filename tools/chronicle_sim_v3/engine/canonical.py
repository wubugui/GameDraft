"""Canonical JSON / 哈希工具。

设计目标：让任意位置的『结构 → 文本 → 结构』回路稳定，
哈希值在不同进程 / 不同 OS / 同一 Python 版本下完全一致。

不依赖第三方 yaml/json 实现以降低风险。
"""
from __future__ import annotations

import hashlib
import json
import math
from typing import Any


def _normalize(value: Any) -> Any:
    """递归把值规范化成 JSON 可序列化的形态。

    - dict 的 key 全部强转 str（不允许非 str key 进 canonical 流，否则 sort 不稳定）
    - tuple/set 转成 list；set 排序后转 list 才能稳定
    - float NaN/Inf 不接受（直接抛错；这是 cache key 安全边界）
    - bytes → 'sha256:<hex>'，避免任意二进制混入哈希
    """
    if value is None or isinstance(value, (str, bool)):
        return value
    if isinstance(value, int) and not isinstance(value, bool):
        return value
    if isinstance(value, float):
        if math.isnan(value) or math.isinf(value):
            raise ValueError("canonical: float 不允许 NaN/Inf")
        return value
    if isinstance(value, (list, tuple)):
        return [_normalize(v) for v in value]
    if isinstance(value, set) or isinstance(value, frozenset):
        try:
            return [_normalize(v) for v in sorted(value)]
        except TypeError:
            return [_normalize(v) for v in sorted(value, key=lambda x: repr(x))]
    if isinstance(value, dict):
        return {str(k): _normalize(v) for k, v in value.items()}
    if isinstance(value, bytes):
        return "bytes:sha256:" + hashlib.sha256(value).hexdigest()
    # 引擎内部专用占位 dataclass：SubgraphRef / PresetRef 都在 expr 层定义
    # 这里走鸭子识别：有 __dataclass_fields__ 的 frozen dataclass 视为 dict
    if hasattr(value, "__dataclass_fields__"):
        return {
            "__type__": type(value).__name__,
            **{k: _normalize(getattr(value, k)) for k in value.__dataclass_fields__},
        }
    raise TypeError(f"canonical: 不支持类型 {type(value).__name__}")


class _CanonicalEncoder(json.JSONEncoder):
    """sort_keys / 紧凑分隔 / utf-8 / float 用 repr 保 17 位。"""

    def __init__(self) -> None:
        super().__init__(
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
            allow_nan=False,
        )


_ENCODER = _CanonicalEncoder()


def canonical_json(value: Any) -> str:
    """规范化 + 紧凑、sort_keys、UTF-8 直出。"""
    return _ENCODER.encode(_normalize(value))


def sha256_hex(s: str | bytes) -> str:
    """SHA-256 全长十六进制（64 chars）。"""
    if isinstance(s, str):
        s = s.encode("utf-8")
    return hashlib.sha256(s).hexdigest()


def canonical_hash(value: Any) -> str:
    """对任意值计算稳定的 sha256；先 canonical_json 再哈希。"""
    return sha256_hex(canonical_json(value))
