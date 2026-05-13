"""Run 管理：创建/列出/删除，无 SQLite。"""
from __future__ import annotations

import json
import shutil
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from uuid import uuid4

from tools.chronicle_sim_v2.paths import RUNS_DIR, ensure_runs_dir

DATA_DIR = Path(__file__).parent.parent.parent / "data"


def _load_default_llm_config() -> dict[str, Any]:
    """从 data/private_llm_defaults.json 读取完整 tier 配置。"""
    p = DATA_DIR / "private_llm_defaults.json"
    if p.is_file():
        try:
            with open(p, encoding="utf-8") as f:
                return json.load(f)
        except (json.JSONDecodeError, OSError):
            pass
    return {"default": {"kind": "stub"}}


_SUBDIRS = [
    "ideas",
    "config",
    "config/pending",
    "world/agents",
    "world/factions",
    "world/locations",
    "world/relationships",
    "chronicle",
    "traces",
    "cold_storage",
]


def create_run(name: str, start_week: int = 1, total_weeks: int = 52) -> tuple[str, Path]:
    """创建新 run，返回 (run_id, run_dir)。"""
    ensure_runs_dir()
    run_id = uuid4().hex[:12]
    run_dir = RUNS_DIR / run_id
    run_dir.mkdir(parents=True, exist_ok=True)

    # 创建子目录
    for sub in _SUBDIRS:
        (run_dir / sub).mkdir(parents=True, exist_ok=True)

    # 写 run.json
    config = {
        "run_id": run_id,
        "name": name,
        "start_week": start_week,
        "total_weeks": total_weeks,
        "current_week": 0,
        "pacing_profile_id": "default",
        "created_at": datetime.now(timezone.utc).isoformat(),
    }
    with open(run_dir / "run.json", "w", encoding="utf-8") as f:
        json.dump(config, f, ensure_ascii=False, indent=2)

    # 写默认 LLM 配置
    llm_cfg = _load_default_llm_config()
    with open(run_dir / "config" / "llm_config.json", "w", encoding="utf-8") as f:
        json.dump(llm_cfg, f, ensure_ascii=False, indent=2)

    return run_id, run_dir


def list_runs() -> list[dict[str, Any]]:
    """列出所有 run。"""
    runs = ensure_runs_dir()
    result = []
    for d in sorted(runs.iterdir()):
        if not d.is_dir():
            continue
        meta_path = d / "run.json"
        if meta_path.is_file():
            try:
                with open(meta_path, "r", encoding="utf-8") as f:
                    meta = json.load(f)
                result.append(meta)
            except (json.JSONDecodeError, OSError):
                result.append({"run_id": d.name, "name": d.name, "error": "无法读取 run.json"})
        else:
            result.append({"run_id": d.name, "name": d.name, "error": "无 run.json"})
    return result


def delete_run(run_dir: Path) -> None:
    """删除 run 目录。"""
    if run_dir.is_dir():
        shutil.rmtree(run_dir)


def load_run_meta(run_dir: Path) -> dict[str, Any]:
    """加载 run.json。"""
    p = run_dir / "run.json"
    if not p.is_file():
        return {}
    with open(p, "r", encoding="utf-8") as f:
        return json.load(f)


def save_run_meta(run_dir: Path, meta: dict[str, Any]) -> None:
    """原子写 run.json。"""
    import tempfile
    import os
    p = run_dir / "run.json"
    p.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=str(run_dir), suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(meta, f, ensure_ascii=False, indent=2)
        os.replace(tmp, str(p))
    except Exception:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def load_llm_config(run_dir: Path) -> dict[str, Any]:
    """加载 LLM 配置。"""
    p = run_dir / "config" / "llm_config.json"
    if not p.is_file():
        return {"default": {"kind": "stub"}}
    with open(p, "r", encoding="utf-8") as f:
        return json.load(f)


def save_llm_config(run_dir: Path, cfg: dict[str, Any]) -> None:
    """保存 LLM 配置。"""
    from tools.chronicle_sim_v2.core.world.fs import write_json
    write_json(run_dir, "config/llm_config.json", cfg)


def fork_run(src_dir: Path, name: str) -> tuple[str, Path]:
    """分支复制 run。"""
    import shutil as _sh
    ensure_runs_dir()
    run_id = uuid4().hex[:12]
    dst_dir = RUNS_DIR / run_id
    _sh.copytree(src_dir, dst_dir)
    meta = load_run_meta(dst_dir)
    meta["run_id"] = run_id
    meta["name"] = name
    meta["forked_from"] = src_dir.name
    save_run_meta(dst_dir, meta)
    return run_id, dst_dir
