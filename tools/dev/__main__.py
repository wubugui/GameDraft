"""``python -m tools.dev <task>`` — cross-platform GameDraft task runner.

Replaces the Windows .cmd/.ps1 launchers. Run ``python -m tools.dev --help``
for the full task list. Launcher tasks accept ``--check`` to print the
resolved interpreter/argv without spawning anything (for CI/headless checks).
"""

from __future__ import annotations

import argparse
import sys


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="tools.dev", description="GameDraft cross-platform task runner")
    sub = parser.add_subparsers(dest="task", required=True)

    p_bootstrap = sub.add_parser("bootstrap", help="Initialize game/editor or clean local env")
    p_bootstrap.add_argument("action", nargs="?", default="", choices=["", "game", "editor", "clean"])
    p_bootstrap.add_argument("--yes", action="store_true", help="Skip CLEAN confirmation")

    p_deps = sub.add_parser("install-deps", help="Install third-party dependencies")
    p_deps.add_argument("--skip-dvc-pull", action="store_true")
    p_deps.add_argument("--tools", default=None, help="Comma list or 'all' for extra tool requirements")
    p_deps.add_argument("--npm-proxy", nargs="?", const="", default=None, help="Run npm install via proxy (default 127.0.0.1:7078)")

    p_initrt = sub.add_parser("init-runtime", help="Sync game runtime resources")
    p_initrt.add_argument("--install-deps", action="store_true")
    sub.add_parser("init-editor", help="Sync editor project resources")

    p_cfg = sub.add_parser("configure-oss", help="Configure DVC OSS remote")
    p_cfg.add_argument("--bucket", required=True)
    p_cfg.add_argument("--prefix", default="gamedraft/dvc")
    p_cfg.add_argument("--endpoint", default="https://oss-cn-hangzhou.aliyuncs.com")

    p_pull = sub.add_parser("pull", help="git pull + DVC pull (pull-all)")
    p_pull.add_argument("--editor", action="store_true")
    p_pull.add_argument("--vendor", action="store_true")
    p_pull.add_argument("--git-proxy", default="")

    p_push = sub.add_parser("push", help="DVC push + git push (push-all)")
    p_push.add_argument("--git-proxy", default="")

    p_commit = sub.add_parser("commit", help="dvc add + git add/commit (commit-all)")
    p_commit.add_argument("-m", "--message", default=None)
    p_commit.add_argument("message_pos", nargs="?", default=None, help="Commit message (positional alternative to -m)")

    p_upload = sub.add_parser("upload-bootstrap", help="Upload portable Python archive to OSS")
    p_upload.add_argument("--bucket", default="gamedraft-assets")
    p_upload.add_argument("--endpoint", default="https://oss-cn-shanghai.aliyuncs.com")
    p_upload.add_argument("--prefix", default="gamedraft/bootstrap")
    p_upload.add_argument("--archive", default="python311-dvc-win-x64.zip")

    p_game = sub.add_parser("game", help="Vite dev server")
    game_sub = p_game.add_subparsers(dest="game_action", required=True)
    p_game_start = game_sub.add_parser("start")
    p_game_start.add_argument("--proxy", nargs="?", const="", default=None)
    p_game_start.add_argument("--check", action="store_true")
    game_sub.add_parser("stop")

    # Tool launchers (each forwards unknown args to the tool, supports --check).
    from tools.dev.launch import TOOL_MODULES

    for name in [*TOOL_MODULES.keys(), "chronicle-week"]:
        tp = sub.add_parser(name, help=f"Launch {name}")
        tp.add_argument("--check", action="store_true")
        tp.add_argument("extra", nargs=argparse.REMAINDER)

    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    task = args.task

    if task == "bootstrap":
        from tools.dev import bootstrap

        return bootstrap.run(args.action, assume_yes=args.yes)
    if task == "install-deps":
        from tools.dev import deps

        return deps.install_deps(skip_dvc_pull=args.skip_dvc_pull, tools=args.tools, npm_proxy=args.npm_proxy)
    if task == "init-runtime":
        from tools.dev import sync

        return sync.init_runtime(install_deps_after=args.install_deps)
    if task == "init-editor":
        from tools.dev import sync

        return sync.init_editor()
    if task == "configure-oss":
        from tools.dev import sync

        return sync.configure_oss(args.bucket, args.prefix, args.endpoint)
    if task == "pull":
        from tools.dev import sync

        return sync.pull(editor=args.editor, vendor=args.vendor, git_proxy=args.git_proxy)
    if task == "push":
        from tools.dev import sync

        return sync.push(git_proxy=args.git_proxy)
    if task == "commit":
        from tools.dev import sync

        message = args.message or args.message_pos
        if not message:
            parser.error("commit requires a message (-m \"...\" or positional)")
        return sync.commit(message)
    if task == "upload-bootstrap":
        from tools.dev import sync

        return sync.upload_bootstrap(args.bucket, args.endpoint, args.prefix, args.archive)
    if task == "game":
        from tools.dev import game

        if args.game_action == "start":
            return game.start(proxy=args.proxy, check=args.check)
        return game.stop()

    from tools.dev.launch import TOOL_MODULES, run_chronicle_week, run_tool

    extra = [a for a in getattr(args, "extra", []) if a != "--"]
    if task == "chronicle-week":
        return run_chronicle_week(extra, check=args.check)
    if task in TOOL_MODULES:
        return run_tool(task, extra, check=args.check)

    parser.error(f"Unknown task: {task}")
    return 2


if __name__ == "__main__":
    sys.exit(main())
