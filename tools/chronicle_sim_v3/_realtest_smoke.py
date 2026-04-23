"""真实 cline 路径冒烟脚本（手动跑 / CI 不引）。

用法：
    python -m tools.chronicle_sim_v3._realtest_smoke provider
    python -m tools.chronicle_sim_v3._realtest_smoke agent-stub
    python -m tools.chronicle_sim_v3._realtest_smoke agent-real
"""
from __future__ import annotations

import sys

from typer.testing import CliRunner

from tools.chronicle_sim_v3.cli.main import app


_runner = CliRunner()
_RUN = "runs/realtest"


def _invoke(*argv: str) -> int:
    print(">>>", " ".join(argv), flush=True)
    res = _runner.invoke(app, list(argv))
    print(res.output, end="", flush=True)
    print(f"<<< exit={res.exit_code}\n", flush=True)
    return res.exit_code


def main() -> int:
    if len(sys.argv) < 2:
        print(__doc__)
        return 2
    cmd = sys.argv[1]
    if cmd == "provider":
        rc = _invoke("provider", "list", "--run", _RUN)
        if rc != 0:
            return rc
        rc = _invoke("provider", "show", "dashscope", "--run", _RUN)
        return rc
    if cmd == "provider-test":
        # 只 ping /models —— 非 LLM 推理调用
        return _invoke(
            "provider", "test", "dashscope", "--run", _RUN, "--timeout", "15"
        )
    if cmd == "agent-list":
        return _invoke("agent", "list", "--run", _RUN)
    if cmd == "agent-stub":
        return _invoke(
            "agent", "test",
            "--run", _RUN,
            "--agent", "smoke_stub",
            "--spec", "_inline",
            "--var", "__system=系统",
            "--var", "__user=hi",
            "--cache", "off",
            "--output", "text",
        )
    if cmd == "agent-real":
        # 唯一允许的真实 LLM 路径：cline runner
        return _invoke(
            "agent", "test",
            "--run", _RUN,
            "--agent", "smoke_real",
            "--spec", "data/agent_specs/smoke.toml",
            "--var", "__user=回声",
            "--cache", "off",
            "--output", "text",
            "--artifact-filename", "agent_output.txt",
            "--timeout", "300",
        )
    print(f"unknown cmd {cmd!r}")
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
