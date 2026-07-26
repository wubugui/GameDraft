"""`./dev.sh sync-rule-graphs` —— 从 rules.json 重新生成规矩层图并落盘。

为什么必须有 CLI 而不只是编辑器里一个按钮：本项目的工作流是「AI 直接改 JSON、
人类只通过编辑器维护 JSON」。生成器若只挂在 PyQt 的 save_all 上，AI 每次改完
rules.json 都会让派生产物过期 → 收尾校验报错 → 而 AI 没有任何办法把它清掉，
必须叫人开 GUI。那样收尾校验就从质量闸变成死锁闸。

用法：
    ./dev.sh sync-rule-graphs              # 生成并落盘
    ./dev.sh sync-rule-graphs -- --check   # 只检查是否同步（CI/收尾用），不写盘
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

from .project_model import ProjectModel
from .shared.rule_graph_sync import rule_ledger_drift, sync_rule_graphs


def _default_project_root() -> Path:
    return Path(__file__).resolve().parents[2]


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="python -m tools.editor.sync_rule_graphs",
        description="从 rules.json 生成规矩层图（narrative_graphs.json 的 rule_ledger）。",
    )
    parser.add_argument(
        "project_path", nargs="?", default=None,
        help="工程根目录（含 public/assets）。缺省取本仓库根。",
    )
    parser.add_argument(
        "--check", action="store_true",
        help="只检查是否已同步，不写盘；不同步时 exit 1。",
    )
    args = parser.parse_args(argv)

    project_root = (
        Path(args.project_path).resolve() if args.project_path else _default_project_root()
    )
    if not (project_root / "public" / "assets").is_dir():
        print(f"[sync-rule-graphs] 不是有效 GameDraft 工程（缺 public/assets）: {project_root}", file=sys.stderr)
        return 2

    model = ProjectModel()
    try:
        model.load_project(project_root)
    except Exception as exc:  # noqa: BLE001
        print(f"[sync-rule-graphs] 工程加载失败: {exc}", file=sys.stderr)
        return 2

    if args.check:
        drift = rule_ledger_drift(model)
        if drift:
            print(f"[sync-rule-graphs] {drift}", file=sys.stderr)
            return 1
        print("[sync-rule-graphs] 已同步。")
        return 0

    try:
        result = sync_rule_graphs(model)
    except Exception as exc:  # noqa: BLE001
        print(f"[sync-rule-graphs] 生成失败: {exc}", file=sys.stderr)
        return 2

    if not result["changed"]:
        print(f"[sync-rule-graphs] 已是最新（{result['elements']} 张层图），未写盘。")
        return 0

    try:
        model.save_all()
    except Exception as exc:  # noqa: BLE001
        print(f"[sync-rule-graphs] 落盘失败（磁盘零变化）: {exc}", file=sys.stderr)
        return 2

    verb = "新建" if result["created"] else "更新"
    print(f"[sync-rule-graphs] 已{verb} rule_ledger：{result['elements']} 张层图。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
