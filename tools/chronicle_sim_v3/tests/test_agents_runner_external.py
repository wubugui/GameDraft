"""ExternalRunner: 单元 + 集成（用 python 自身做子进程）。"""
from __future__ import annotations

import os
import sys
import textwrap
from pathlib import Path

import pytest

from tools.chronicle_sim_v3.agents.errors import (
    AgentConfigError,
    AgentRunnerError,
)
from tools.chronicle_sim_v3.agents.resolver import ResolvedAgent
from tools.chronicle_sim_v3.agents.runners.base import AgentRunnerContext
from tools.chronicle_sim_v3.agents.runners.external import (
    ExternalRunner,
    _build_argv,
    _build_env,
    _resolve_executable,
)
from tools.chronicle_sim_v3.agents.types import AgentTask, NullAgentObserver
from tools.chronicle_sim_v3.providers.service import ProviderService


_PROVIDERS = """\
schema: chronicle_sim_v3/providers@1
providers:
  ds:
    kind: openai_compat
    base_url: https://api.example/v1
    api_key_ref: env:DS_KEY
"""


_LLM = """\
schema: chronicle_sim_v3/llm@1
models:
  stub: {provider: stub_local, invocation: stub}
  embed-stub: {provider: stub_local, invocation: stub}
routes: {offline: stub, embed: embed-stub}
"""


_AGENTS = """\
schema: chronicle_sim_v3/agents@1
agents:
  ext:
    runner: external
    provider: ds
    model_id: my-model
    config:
      executable: __PYTHON__
      argv_template: ["${input_file}"]
"""


def _setup_run(tmp_path: Path) -> Path:
    run = tmp_path / "run"
    cfg = run / "config"
    cfg.mkdir(parents=True)
    # ProviderService 还需要 stub_local 才能装 LLMService（这里不需要），
    # 但 ExternalRunner 不依赖 LLMService。
    (cfg / "providers.yaml").write_text(
        _PROVIDERS + "  stub_local:\n    kind: stub\n", encoding="utf-8"
    )
    (cfg / "llm.yaml").write_text(_LLM, encoding="utf-8")
    (cfg / "agents.yaml").write_text(_AGENTS, encoding="utf-8")
    return run


def _agent(**over) -> ResolvedAgent:
    base = dict(
        logical="ext", physical="ext", runner_kind="external",
        provider_id="ds", llm_route=None, model_id="my-model", timeout_sec=30,
        config={
            "executable": sys.executable,
            "argv_template": [
                "-c",
                "import sys, pathlib; "
                "p = pathlib.Path(sys.argv[1]); "
                "out = pathlib.Path(sys.argv[2]); "
                "out.write_text('ECHO:' + p.read_text(encoding='utf-8'), encoding='utf-8')",
                "${input_file}", "${output_file}",
            ],
        },
        agent_hash="ah" * 8,
    )
    base.update(over)
    return ResolvedAgent(**base)


def _ctx(run: Path) -> AgentRunnerContext:
    return AgentRunnerContext(
        run_dir=run, spec_search_root=run,
        provider_service=ProviderService(run),
        llm_service=None, observer=NullAgentObserver(),
    )


# -------- 单元 --------


def test_build_argv_substitutes_placeholders() -> None:
    argv = _build_argv(
        "echo",
        ["--in", "${input_file}", "--key", "${api_key}"],
        {"input_file": "/tmp/in.md", "api_key": "sk-x"},
    )
    assert argv == ["echo", "--in", "/tmp/in.md", "--key", "sk-x"]


def test_build_argv_template_must_be_list() -> None:
    with pytest.raises(AgentConfigError):
        _build_argv("echo", "not-a-list", {})  # type: ignore[arg-type]


def test_build_argv_template_elements_must_be_str() -> None:
    with pytest.raises(AgentConfigError):
        _build_argv("echo", ["ok", 123], {})  # type: ignore[list-item]


def test_build_env_substitutes_placeholders() -> None:
    env = _build_env(
        {"PATH": "/x"},
        {"MY_KEY": "${api_key}", "BASE": "${base_url}"},
        {"api_key": "sk-x", "base_url": "https://x"},
    )
    assert env["MY_KEY"] == "sk-x"
    assert env["BASE"] == "https://x"
    assert env["PATH"] == "/x"


def test_build_env_rejects_non_string_keys() -> None:
    with pytest.raises(AgentConfigError):
        _build_env({}, {123: "x"}, {})  # type: ignore[dict-item]


def test_resolve_executable_requires_explicit() -> None:
    with pytest.raises(AgentConfigError):
        _resolve_executable("")


def test_resolve_executable_passes_through_when_not_found(tmp_path: Path) -> None:
    """非绝对路径且 which 找不到 → 透传，让 subprocess 报 FileNotFoundError。"""
    out = _resolve_executable("nonexistent_bin_xyz_zzz")
    assert out == "nonexistent_bin_xyz_zzz"


# -------- 集成（python 子进程）--------


@pytest.mark.asyncio
async def test_external_runner_end_to_end(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("DS_KEY", "sk-test")
    run = _setup_run(tmp_path)
    task = AgentTask(spec_ref="_inline", vars={"__system": "s", "__user": "hello"})
    res = await ExternalRunner().run_task(
        _agent(), task, "text", "agent_output.txt", _ctx(run), timeout_sec=30,
    )
    assert "ECHO:" in res.text
    assert "hello" in res.text
    assert res.runner_kind == "external"
    assert res.exit_code == 0
    assert res.llm_calls_count is None


@pytest.mark.asyncio
async def test_external_runner_no_output_file_raises(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("DS_KEY", "sk-test")
    run = _setup_run(tmp_path)
    a = _agent(config={
        "executable": sys.executable,
        "argv_template": ["-c", "pass"],  # 不写 output
    })
    task = AgentTask(spec_ref="_inline", vars={"__system": "s", "__user": "hi"})
    with pytest.raises(AgentRunnerError, match="output_file"):
        await ExternalRunner().run_task(
            a, task, "text", "agent_output.txt", _ctx(run), 15,
        )


@pytest.mark.asyncio
async def test_external_runner_requires_provider(tmp_path: Path) -> None:
    run = _setup_run(tmp_path)
    task = AgentTask(spec_ref="_inline", vars={"__system": "s", "__user": "x"})
    with pytest.raises(AgentConfigError, match="provider"):
        await ExternalRunner().run_task(
            _agent(provider_id=None), task, "text", "", _ctx(run), 15,
        )


@pytest.mark.asyncio
async def test_external_runner_unknown_provider_id(tmp_path: Path) -> None:
    run = _setup_run(tmp_path)
    task = AgentTask(spec_ref="_inline", vars={"__system": "s", "__user": "x"})
    with pytest.raises(AgentConfigError, match="provider"):
        await ExternalRunner().run_task(
            _agent(provider_id="nope"), task, "text", "", _ctx(run), 15,
        )
