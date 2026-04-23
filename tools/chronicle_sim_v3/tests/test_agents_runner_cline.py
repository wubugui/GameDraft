"""ClineRunner 单元：可执行探测 / auth argv / task argv / 工件优先回读。

不调用真实 cline 子进程；用 monkeypatch 替换 SubprocessAgentRunner._run_one。
"""
from __future__ import annotations

import asyncio
import os
from pathlib import Path
from typing import Any

import pytest

from tools.chronicle_sim_v3.agents.errors import AgentConfigError
from tools.chronicle_sim_v3.agents.resolver import ResolvedAgent
from tools.chronicle_sim_v3.agents.runners import cline as cline_mod
from tools.chronicle_sim_v3.agents.runners.base import AgentRunnerContext
from tools.chronicle_sim_v3.agents.runners.cline import (
    ClineRunner,
    _build_auth_argv,
    _build_task_argv,
    _cline_task_model_flag,
    _read_artifact_or_stdout,
    resolve_cline_executable,
)
from tools.chronicle_sim_v3.agents.types import AgentTask, NullAgentObserver
from tools.chronicle_sim_v3.providers.service import ProviderService
from tools.chronicle_sim_v3.providers.types import ResolvedProvider


# -------- 单元 --------


def _provider(kind, base_url="", api_key="") -> ResolvedProvider:
    return ResolvedProvider(
        provider_id="x", kind=kind, base_url=base_url, api_key=api_key,
        extra={}, provider_hash="h" * 16,
    )


def test_resolve_cline_executable_falls_back_to_name() -> None:
    """没安装 cline 时返回字符串 'cline'，不抛错。"""
    out = resolve_cline_executable("definitely-not-here-xyz-zzz")
    assert isinstance(out, str)


def test_resolve_cline_executable_explicit_existing_path(tmp_path: Path) -> None:
    fake = tmp_path / "cline.cmd"
    fake.write_text("@echo off\n", encoding="utf-8")
    out = resolve_cline_executable(str(fake))
    assert Path(out).resolve() == fake.resolve()


def test_build_auth_argv_openai_compat() -> None:
    p = _provider("openai_compat", "https://x.example/v1", "sk-secret")
    argv = _build_auth_argv("cline.cmd", Path("/cfg"), p, "qwen3.5-plus")
    assert argv is not None
    assert argv[0] == "cline.cmd"
    assert "auth" in argv
    assert "-p" in argv and "openai" in argv
    assert "-k" in argv and "sk-secret" in argv
    assert "-m" in argv and "qwen3.5-plus" in argv
    assert "-b" in argv and "https://x.example/v1" in argv
    assert "--config" in argv


def test_build_auth_argv_dashscope_compat() -> None:
    p = _provider("dashscope_compat",
                  "https://dashscope.aliyuncs.com/v1", "sk-x")
    argv = _build_auth_argv("cline", Path("/cfg"), p, "qwen3.5-plus")
    assert argv is not None
    assert "openai" in argv  # dashscope_compat 也走 -p openai
    assert "sk-x" in argv


def test_build_auth_argv_ollama_no_key() -> None:
    p = _provider("ollama", "http://127.0.0.1:11434")
    argv = _build_auth_argv("cline", Path("/cfg"), p, "llama3")
    assert argv is not None
    assert "ollama" in argv
    assert "-k" not in argv  # ollama 不传 key
    # base 应被改写为 host/v1
    assert "http://127.0.0.1:11434/v1" in argv


def test_build_auth_argv_stub_returns_none() -> None:
    p = _provider("stub")
    assert _build_auth_argv("cline", Path("/cfg"), p, "x") is None


def test_build_auth_argv_verbose_passes_flag() -> None:
    p = _provider("openai_compat", "https://x.example/v1", "k")
    argv = _build_auth_argv("cline", Path("/cfg"), p, "m", verbose=True)
    assert argv is not None
    assert "--verbose" in argv


def test_build_task_argv_basic(tmp_path: Path) -> None:
    cfg, ws = tmp_path / "cfg", tmp_path / "ws"
    argv = _build_task_argv(
        "cline", cfg, ws, output_kind="text", timeout_sec=120,
        model_flag=None, verbose=False,
    )
    assert argv[0] == "cline"
    assert argv[1] == "task"
    assert "-y" in argv and "-a" in argv
    assert "--config" in argv and str(cfg) in argv
    assert "-c" in argv and str(ws) in argv
    assert "--timeout" in argv and "120" in argv
    assert "-m" not in argv  # model_flag=None 时省略 -m
    # 末参恒为短引导句
    assert "input.md" in argv[-1]


def test_build_task_argv_jsonl_adds_json_flag(tmp_path: Path) -> None:
    argv = _build_task_argv(
        "cline", tmp_path / "cfg", tmp_path / "ws",
        output_kind="jsonl", timeout_sec=60, model_flag=None, verbose=False,
    )
    assert "--json" in argv


def test_build_task_argv_with_model_flag(tmp_path: Path) -> None:
    argv = _build_task_argv(
        "cline", tmp_path / "cfg", tmp_path / "ws",
        output_kind="text", timeout_sec=60, model_flag="llama3",
        verbose=False,
    )
    assert "-m" in argv
    i = argv.index("-m")
    assert argv[i + 1] == "llama3"


def test_cline_task_model_flag_openai_compat_with_base_returns_none() -> None:
    p = _provider("openai_compat", "https://x.example/v1", "k")
    assert _cline_task_model_flag(p, "any-model") is None


def test_cline_task_model_flag_ollama_passes_through() -> None:
    p = _provider("ollama", "http://127.0.0.1:11434")
    assert _cline_task_model_flag(p, "llama3") == "llama3"


def test_read_artifact_or_stdout_prefers_artifact(tmp_path: Path) -> None:
    (tmp_path / "out.txt").write_text("from-artifact", encoding="utf-8")
    out = _read_artifact_or_stdout(tmp_path, "out.txt", "from-stdout")
    assert out == "from-artifact"


def test_read_artifact_or_stdout_falls_back_to_stdout(tmp_path: Path) -> None:
    out = _read_artifact_or_stdout(tmp_path, "missing.txt", "from-stdout")
    assert out == "from-stdout"


def test_read_artifact_or_stdout_empty_artifact_falls_back(tmp_path: Path) -> None:
    (tmp_path / "out.txt").write_text("   \n", encoding="utf-8")
    out = _read_artifact_or_stdout(tmp_path, "out.txt", "from-stdout")
    assert out == "from-stdout"


# -------- 集成（mock 子进程）--------


def _agent(**over) -> ResolvedAgent:
    base = dict(
        logical="npc", physical="cline_real", runner_kind="cline",
        provider_id="ds", llm_route=None, model_id="qwen3.5-plus",
        timeout_sec=60, config={}, agent_hash="ah" * 8,
    )
    base.update(over)
    return ResolvedAgent(**base)


def _setup_run(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    run = tmp_path / "run"
    cfg = run / "config"
    cfg.mkdir(parents=True)
    (cfg / "providers.yaml").write_text(
        "schema: chronicle_sim_v3/providers@1\n"
        "providers:\n"
        "  ds:\n"
        "    kind: openai_compat\n"
        "    base_url: https://x.example/v1\n"
        "    api_key_ref: env:DS_KEY\n",
        encoding="utf-8",
    )
    monkeypatch.setenv("DS_KEY", "sk-mock")
    return run


@pytest.mark.asyncio
async def test_cline_runner_end_to_end_mocked(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """子进程 _run_one 全程被 mock；只验证 ws/.clinerules + input.md + 工件回读。"""
    run = _setup_run(tmp_path, monkeypatch)

    captured_calls: list[dict[str, Any]] = []

    async def fake_run_one(
        self, argv, env, cwd, *, timeout, observer, stream_stderr,
        phase, source="subprocess", return_streams=False, retry_libuv=3,
    ):
        captured_calls.append({
            "phase": phase, "argv0": argv[0], "argv": argv, "cwd": cwd,
        })
        if phase == "cline.task":
            # 模拟 cline 在 ws 写出工件
            ws = Path(cwd)
            (ws / "out.md").write_text("hello-from-cline", encoding="utf-8")
            if return_streams:
                return b"stdout-trace", b"", 0
            return None
        return None

    monkeypatch.setattr(
        "tools.chronicle_sim_v3.agents.runners.base.SubprocessAgentRunner._run_one",
        fake_run_one,
    )
    # 同时也 mock 可执行探测（避免依赖系统装了 cline）
    monkeypatch.setattr(
        cline_mod, "resolve_cline_executable",
        lambda explicit="": "fake-cline.cmd",
    )

    ctx = AgentRunnerContext(
        run_dir=run, spec_search_root=run,
        provider_service=ProviderService(run),
        llm_service=None, observer=NullAgentObserver(),
    )
    task = AgentTask(spec_ref="_inline", vars={
        "__system": "你是测试角色", "__user": "请回答 1+1",
    })
    res = await ClineRunner().run_task(
        _agent(), task, "text", "out.md", ctx, timeout_sec=60,
    )

    assert res.text == "hello-from-cline"
    assert res.runner_kind == "cline"
    assert res.exit_code == 0
    assert res.llm_calls_count is None
    # 至少有 auth + task 两次调用
    phases = [c["phase"] for c in captured_calls]
    assert "cline.auth" in phases
    assert "cline.task" in phases
    # task argv 末参应为短引导句
    task_call = next(c for c in captured_calls if c["phase"] == "cline.task")
    assert "input.md" in task_call["argv"][-1]


@pytest.mark.asyncio
async def test_cline_runner_requires_provider(tmp_path: Path) -> None:
    run = tmp_path / "run"
    (run / "config").mkdir(parents=True)
    (run / "config" / "providers.yaml").write_text(
        "schema: chronicle_sim_v3/providers@1\n"
        "providers: {stub_local: {kind: stub}}\n",
        encoding="utf-8",
    )
    ctx = AgentRunnerContext(
        run_dir=run, spec_search_root=run,
        provider_service=ProviderService(run),
        llm_service=None, observer=NullAgentObserver(),
    )
    task = AgentTask(spec_ref="_inline", vars={"__system": "s", "__user": "u"})
    with pytest.raises(AgentConfigError, match="provider"):
        await ClineRunner().run_task(
            _agent(provider_id=None), task, "text", "", ctx, 30,
        )


@pytest.mark.asyncio
async def test_cline_runner_unknown_provider_id(tmp_path: Path) -> None:
    run = tmp_path / "run"
    (run / "config").mkdir(parents=True)
    (run / "config" / "providers.yaml").write_text(
        "schema: chronicle_sim_v3/providers@1\n"
        "providers: {stub_local: {kind: stub}}\n",
        encoding="utf-8",
    )
    ctx = AgentRunnerContext(
        run_dir=run, spec_search_root=run,
        provider_service=ProviderService(run),
        llm_service=None, observer=NullAgentObserver(),
    )
    task = AgentTask(spec_ref="_inline", vars={"__system": "s", "__user": "u"})
    with pytest.raises(AgentConfigError, match="provider"):
        await ClineRunner().run_task(
            _agent(provider_id="nope"), task, "text", "", ctx, 30,
        )
