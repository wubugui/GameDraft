from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import tempfile
from typing import Any

import numpy as np


CACHE_SCHEMA_VERSION = 1
DEPTH_CACHE_KIND = "scene_depth"
HDR_CACHE_KIND = "scene_radiance_hdr"
HDR_FORMULA_VERSION = "srgb-eotf-exposure-gain-v1"


@dataclass(frozen=True)
class CacheValidation:
    fresh: bool
    reason: str


def array_sha256(array: np.ndarray) -> str:
    value = np.ascontiguousarray(array)
    digest = hashlib.sha256()
    digest.update(str(value.dtype).encode("ascii"))
    digest.update(repr(tuple(int(v) for v in value.shape)).encode("ascii"))
    digest.update(value.tobytes())
    return digest.hexdigest()


def depth_signature(
    *,
    background_sha256: str,
    model_id: str,
    shape: tuple[int, int],
) -> dict[str, Any]:
    return {
        "background_sha256": str(background_sha256),
        "model_id": str(model_id),
        "shape": [int(shape[0]), int(shape[1])],
    }


def hdr_signature(
    *,
    background_sha256: str,
    gain_sha256: str | None,
    shape: tuple[int, int, int],
    scene_exposure_ev: float,
    gain_ev_scale: float,
    max_gain_ev: float,
    reference_white_nits: float,
) -> dict[str, Any]:
    return {
        "background_sha256": str(background_sha256),
        "gain_sha256": gain_sha256,
        "shape": [int(v) for v in shape],
        "formula_version": HDR_FORMULA_VERSION,
        "physical_settings": {
            "scene_exposure_ev": float(scene_exposure_ev),
            "gain_ev_scale": float(gain_ev_scale),
            "max_gain_ev": float(max_gain_ev),
            "reference_white_nits": float(reference_white_nits),
        },
    }


def build_cache_metadata(
    *,
    kind: str,
    signature: dict[str, Any],
    array: np.ndarray,
) -> dict[str, Any]:
    value = np.asarray(array)
    return {
        "schema_version": CACHE_SCHEMA_VERSION,
        "kind": str(kind),
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "signature": signature,
        "data": {
            "shape": [int(v) for v in value.shape],
            "dtype": str(value.dtype),
            "sha256": array_sha256(value),
            "bytes": int(value.nbytes),
        },
    }


_SIGNATURE_REASONS = {
    "background_sha256": "背景图像素已变化",
    "model_id": "深度模型已变化",
    "gain_sha256": "gainEV 数据已变化",
    "shape": "场景分辨率已变化",
    "formula_version": "HDR 重建公式版本已变化",
    "physical_settings": "HDR 物理标定参数已变化",
}


def validate_cache_metadata(
    metadata: dict[str, Any] | None,
    *,
    kind: str,
    expected_signature: dict[str, Any],
    array: np.ndarray,
) -> CacheValidation:
    if not isinstance(metadata, dict):
        return CacheValidation(False, "缺少缓存元数据（旧缓存需要更新）")
    if metadata.get("schema_version") != CACHE_SCHEMA_VERSION:
        return CacheValidation(False, "缓存元数据版本已过期")
    if metadata.get("kind") != kind:
        return CacheValidation(False, "缓存类型不匹配")
    actual_signature = metadata.get("signature")
    if not isinstance(actual_signature, dict):
        return CacheValidation(False, "缓存来源签名缺失")
    for key, expected in expected_signature.items():
        if actual_signature.get(key) != expected:
            return CacheValidation(False, _SIGNATURE_REASONS.get(key, f"参数 {key} 已变化"))

    value = np.asarray(array)
    data = metadata.get("data")
    if not isinstance(data, dict):
        return CacheValidation(False, "缓存数据校验信息缺失")
    if data.get("shape") != [int(v) for v in value.shape]:
        return CacheValidation(False, "缓存数组尺寸与元数据不一致")
    if data.get("dtype") != str(value.dtype):
        return CacheValidation(False, "缓存数组 dtype 与元数据不一致")
    if data.get("sha256") != array_sha256(value):
        return CacheValidation(False, "缓存数据校验失败（文件可能损坏）")
    return CacheValidation(True, "缓存与当前软件参数一致")


def load_json(path: Path) -> dict[str, Any] | None:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    return value if isinstance(value, dict) else None


def save_json_atomic(path: Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = json.dumps(value, indent=2, ensure_ascii=False) + "\n"
    fd, temp_name = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(payload)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temp_name, path)
    except Exception:
        try:
            os.unlink(temp_name)
        except OSError:
            pass
        raise


def save_npy_atomic(path: Path, array: np.ndarray) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temp_name = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        with os.fdopen(fd, "wb") as handle:
            np.save(handle, np.asarray(array), allow_pickle=False)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temp_name, path)
    except Exception:
        try:
            os.unlink(temp_name)
        except OSError:
            pass
        raise
