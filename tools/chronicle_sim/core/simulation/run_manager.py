from __future__ import annotations

import json
import shutil
import uuid
from pathlib import Path
from typing import Any

from tools.chronicle_sim.core.llm.private_defaults import load_private_llm_defaults
from tools.chronicle_sim.core.runtime.memory_store import release_chroma_client_for_run
from tools.chronicle_sim.core.storage.db import Database, connect_run_db, init_schema
from tools.chronicle_sim.paths import RUNS_DIR, ensure_runs_dir


def create_run(
    name: str,
    total_weeks: int = 13,
    pacing_profile_id: str = "default",
    llm_config: dict[str, Any] | None = None,
) -> tuple[str, Path]:
    ensure_runs_dir()
    run_id = uuid.uuid4().hex[:10]
    run_dir = RUNS_DIR / run_id
    run_dir.mkdir(parents=True, exist_ok=True)
    db_path = run_dir / "run.db"
    conn = connect_run_db(db_path)
    cfg = llm_config if llm_config is not None else load_private_llm_defaults()
    conn.execute(
        """
        INSERT INTO runs (run_id, name, start_week, total_weeks, pacing_profile_id, llm_config_json, current_week)
        VALUES (?,?,?,?,?,?,?)
        """,
        (
            run_id,
            name,
            1,
            total_weeks,
            pacing_profile_id,
            json.dumps(cfg, ensure_ascii=False),
            0,
        ),
    )
    conn.commit()
    conn.close()
    return run_id, run_dir


def list_runs() -> list[dict[str, Any]]:
    ensure_runs_dir()
    out: list[dict[str, Any]] = []
    for d in sorted(RUNS_DIR.iterdir(), key=lambda p: p.stat().st_mtime, reverse=True):
        if not d.is_dir():
            continue
        dbp = d / "run.db"
        if not dbp.is_file():
            continue
        conn = connect_run_db(dbp)
        row = conn.execute("SELECT * FROM runs LIMIT 1").fetchone()
        conn.close()
        if row:
            out.append({"run_id": row["run_id"], "path": str(d), "name": row["name"], "current_week": row["current_week"]})
    return out


def fork_run(source_run_dir: Path, branch_label: str) -> tuple[str, Path]:
    ensure_runs_dir()
    new_id = uuid.uuid4().hex[:10]
    new_dir = RUNS_DIR / f"{new_id}-{branch_label}"
    shutil.copytree(source_run_dir, new_dir)
    db_path = new_dir / "run.db"
    conn = connect_run_db(db_path)
    row = conn.execute("SELECT name FROM runs LIMIT 1").fetchone()
    base_name = row["name"] if row else "run"
    conn.execute(
        "UPDATE runs SET run_id = ?, name = ? WHERE 1=1",
        (new_id, f"{base_name} (branch {branch_label})"),
    )
    conn.commit()
    conn.close()
    return new_id, new_dir


def open_database(run_dir: Path) -> Database:
    return Database(run_dir / "run.db")


def delete_run_dir(run_dir: Path) -> None:
    """删除整个 run 目录（含 run.db、snapshots 等）。仅允许删除 runs 下的子文件夹。"""
    ensure_runs_dir()
    root = RUNS_DIR.resolve()
    target = run_dir.resolve()
    try:
        target.relative_to(root)
    except ValueError as e:
        raise ValueError(f"拒绝删除：路径不在 runs 目录内 ({root})") from e
    if target == root:
        raise ValueError("不能删除 runs 根目录")
    if not target.is_dir():
        raise FileNotFoundError(str(target))
    release_chroma_client_for_run(target)
    shutil.rmtree(target)
