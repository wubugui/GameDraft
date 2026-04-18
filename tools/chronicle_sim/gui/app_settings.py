"""应用级界面与会话偏好（QSettings），与 run 数据库中的业务数据分离。"""
from __future__ import annotations

from pathlib import Path
from typing import Any

from PySide6.QtCore import QByteArray, QSettings

_ORG = "GameDraft"
_APP = "ChronicleSim"


def _settings() -> QSettings:
    return QSettings(_ORG, _APP)


def save_last_run_path(path: Path | None) -> None:
    _settings().setValue("session/last_run_path", str(path) if path else "")


def load_last_run_path() -> Path | None:
    raw = _settings().value("session/last_run_path")
    if not raw:
        return None
    p = Path(str(raw))
    return p if p.is_dir() and (p / "run.db").is_file() else None


def save_main_window_geometry(geometry: QByteArray) -> None:
    _settings().setValue("ui/main_geometry", geometry)


def load_main_window_geometry() -> QByteArray | None:
    v = _settings().value("ui/main_geometry")
    if v is None or v == "":
        return None
    if isinstance(v, QByteArray):
        return v
    if isinstance(v, (bytes, bytearray)):
        return QByteArray(v)
    return None


def save_main_tab_index(i: int) -> None:
    _settings().setValue("ui/main_tab", int(i))


def load_main_tab_index() -> int:
    v = _settings().value("ui/main_tab", 0)
    try:
        return int(v)
    except (TypeError, ValueError):
        return 0


def set_value(key: str, value: Any) -> None:
    _settings().setValue(key, value)


def get_value(key: str, default: Any = None) -> Any:
    return _settings().value(key, default)
