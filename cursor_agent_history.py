# -*- coding: utf-8 -*-
"""
Cursor Agent 历史导出/恢复工具。

用法:
  导出（打包到项目目录）:
    python cursor_agent_history.py export [项目目录]
  恢复（从包恢复，包路径可选）:
    python cursor_agent_history.py restore [包路径.zip]

导出包为 ZIP，内含 agent-transcripts 与 manifest.json；
恢复时解压到当前用户 Cursor projects 目录，覆盖对应 project 的 agent-transcripts。
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import zipfile
from datetime import datetime
from pathlib import Path


def _cursor_projects_base() -> Path:
    return Path(os.environ.get("USERPROFILE", os.path.expanduser("~"))) / ".cursor" / "projects"


def _project_key_from_path(project_path: str | Path) -> str:
    """根据项目目录路径计算 Cursor 使用的 project key（与 .cursor/projects 下文件夹名一致）。"""
    p = Path(project_path).resolve()
    drive = p.drive
    if drive:
        # Windows: "F:\GameDraft" -> "f-GameDraft"
        letter = drive.rstrip(":").lower()
        rel = p.relative_to(p.anchor) if p.anchor else p
        parts = [letter] + list(rel.parts)
        return "-".join(parts).replace(" ", "_")
    # 无盘符（Linux/macOS）：用路径转成单一字符串
    parts = [x for x in p.parts if x and x != "/"]
    return "-".join(parts).replace(" ", "_") if parts else "default"


def _ensure_project_key_dir(base: Path, project_key: str) -> Path:
    target = base / project_key
    target.mkdir(parents=True, exist_ok=True)
    return target


def export_agent_history(project_dir: str | Path) -> Path:
    """导出当前项目对应的 Cursor agent 历史到项目目录下的 ZIP。返回 ZIP 路径。"""
    project_dir = Path(project_dir).resolve()
    if not project_dir.is_dir():
        raise SystemExit("项目目录不存在: " + str(project_dir))

    base = _cursor_projects_base()
    project_key = _project_key_from_path(project_dir)
    transcripts_src = base / project_key / "agent-transcripts"

    if not transcripts_src.is_dir():
        raise SystemExit(
            "未找到 agent 历史目录: " + str(transcripts_src) + "\n请先在 Cursor 中打开该项目并产生过 agent 对话。"
        )

    out_name = "cursor-agent-history-" + datetime.now().strftime("%Y%m%d-%H%M%S") + ".zip"
    out_zip = project_dir / out_name

    manifest = {
        "project_key": project_key,
        "project_path": str(project_dir),
        "exported_at": datetime.utcnow().isoformat() + "Z",
    }

    with zipfile.ZipFile(out_zip, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("manifest.json", json.dumps(manifest, ensure_ascii=False, indent=2))
        for root, _dirs, files in os.walk(transcripts_src):
            for f in files:
                full = Path(root) / f
                arcname = "agent-transcripts" / full.relative_to(transcripts_src)
                zf.write(full, arcname)

    return out_zip


def restore_agent_history(package_path: str | Path | None, project_dir: str | Path | None) -> None:
    """从导出包恢复 agent 历史。若未指定包路径，则在项目目录下查找最新的 cursor-agent-history-*.zip。"""
    project_dir = Path(project_dir or os.getcwd()).resolve()
    if package_path is None:
        candidates = sorted(Path(project_dir).glob("cursor-agent-history-*.zip"), key=os.path.getmtime, reverse=True)
        if not candidates:
            raise SystemExit("未找到导出包 cursor-agent-history-*.zip，请指定包路径。")
        package_path = candidates[0]

    package_path = Path(package_path).resolve()
    if not package_path.is_file():
        raise SystemExit("包文件不存在: " + str(package_path))

    base = _cursor_projects_base()
    base.mkdir(parents=True, exist_ok=True)

    with zipfile.ZipFile(package_path, "r") as zf:
        try:
            manifest_data = zf.read("manifest.json").decode("utf-8")
        except KeyError:
            raise SystemExit("无效的导出包：缺少 manifest.json。")
        manifest = json.loads(manifest_data)
        project_key = manifest.get("project_key")
        if not project_key:
            raise SystemExit("无效的 manifest：缺少 project_key。")

        target_base = _ensure_project_key_dir(base, project_key)
        transcripts_dst = target_base / "agent-transcripts"
        if transcripts_dst.exists():
            import shutil
            shutil.rmtree(transcripts_dst)
        transcripts_dst.mkdir(parents=True)

        for info in zf.infolist():
            if info.filename == "manifest.json" or info.is_dir():
                continue
            if not info.filename.startswith("agent-transcripts/"):
                continue
            arcname = info.filename
            target_file = target_base / arcname
            target_file.parent.mkdir(parents=True, exist_ok=True)
            target_file.write_bytes(zf.read(info.filename))

    print("已恢复 agent 历史到: " + str(transcripts_dst))
    print("请完全退出并重新打开 Cursor 后，在 Agents 面板中查看。")


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Cursor Agent 历史导出/恢复：export 打包到项目目录，restore 从包恢复。"
    )
    sub = parser.add_subparsers(dest="command", required=True)

    export_p = sub.add_parser("export", help="导出 agent 历史到项目目录下的 ZIP")
    export_p.add_argument(
        "project_dir",
        nargs="?",
        default=os.getcwd(),
        help="项目目录（默认当前目录）",
    )

    restore_p = sub.add_parser("restore", help="从导出包恢复 agent 历史")
    restore_p.add_argument(
        "package_path",
        nargs="?",
        default=None,
        help="ZIP 包路径（默认使用项目目录下最新的 cursor-agent-history-*.zip）",
    )
    restore_p.add_argument(
        "--project-dir",
        default=None,
        help="项目目录，用于在未指定包时查找最新包（默认当前目录）",
    )

    args = parser.parse_args()
    if args.command == "export":
        zip_path = export_agent_history(args.project_dir)
        print("已导出: " + str(zip_path))
    elif args.command == "restore":
        restore_agent_history(
            getattr(args, "package_path", None),
            getattr(args, "project_dir", None) or os.getcwd(),
        )


if __name__ == "__main__":
    main()
