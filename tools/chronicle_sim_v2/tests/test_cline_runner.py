"""runner argv 构造与 jsonl 解析的行为。"""
from __future__ import annotations

import json
import shutil
import sys
from pathlib import Path

import pytest

from tools.chronicle_sim_v2.core.llm import cline_runner as cr
from tools.chronicle_sim_v2.core.llm.agent_spec import AgentSpec
from tools.chronicle_sim_v2.core.llm.cline_runner import (
    ARGV_STDIN_THRESHOLD,
    INPUT_MD_TASK_PROMPT,
    THINKING_TOKEN_DEFAULT,
    _build_argv,
    _parse_jsonl_output,
    build_cline_env,
    cline_task_model_flag,
)
from tools.chronicle_sim_v2.core.llm.provider_profile import ProviderProfile


def _spec(**kw) -> AgentSpec:
    base = dict(
        agent_id="t",
        system="s",
        user_template="u",
        mcp="none",
        copy_chronicle_to_cwd=False,
        thinking=False,
        output_mode="text",
    )
    base.update(kw)
    return AgentSpec(**base)


def test_cline_task_model_flag_openai_compat_custom_base_omits_m() -> None:
    """自定义 OpenAI 兼容网关：task 不传 -m，模型仅由 cline auth 写入。"""
    p = ProviderProfile(
        kind="openai_compat",
        base_url="https://dashscope.aliyuncs.com/compatible-mode/v1",
        api_key="k",
        model="qwen-turbo",
    )
    assert cline_task_model_flag(p, "qwen-turbo") is None


def test_cline_task_model_flag_openai_compat_default_base_keeps_m() -> None:
    """未配 base_url 时仍传 -m（走默认 OpenAI 端点语义）。"""
    p = ProviderProfile(kind="openai_compat", base_url="", api_key="k", model="gpt-4o-mini")
    assert cline_task_model_flag(p, "gpt-4o-mini") == "gpt-4o-mini"


def test_build_argv_short_goes_inline(tmp_path: Path) -> None:
    cfg = tmp_path / "cfg"
    ws = tmp_path / "ws"
    argv, use_stdin = _build_argv(
        "cline",
        cfg,
        ws,
        model="m1",
        timeout_sec=600,
        spec=_spec(),
        user_text="short",
    )
    assert use_stdin is False
    assert argv[0] == "cline"
    assert argv[1] == "task", "必须走 cline task 子命令，裸 cline 会误触 Kanban"
    assert argv[-1] == "short"
    assert "--config" in argv and str(cfg) in argv
    assert "-c" in argv and str(ws) in argv
    assert "--timeout" in argv and "600" in argv
    assert "-m" in argv and "m1" in argv
    assert "--json" not in argv
    assert "--thinking" not in argv


def test_build_argv_long_uses_input_md_prompt(tmp_path: Path) -> None:
    """超过阈值时正文由 cwd/input.md 承载；argv 末参为短引导句（Cline 不走 stdin 当 prompt）。"""
    cfg = tmp_path / "cfg"
    ws = tmp_path / "ws"
    long_text = "x" * (ARGV_STDIN_THRESHOLD + 100)
    argv, use_stdin = _build_argv(
        "cline",
        cfg,
        ws,
        model="",
        timeout_sec=600,
        spec=_spec(thinking=True),
        user_text=long_text,
    )
    assert use_stdin is False
    assert argv[-1] == INPUT_MD_TASK_PROMPT
    ti = argv.index("--thinking")
    assert argv[ti + 1] == THINKING_TOKEN_DEFAULT
    assert long_text not in argv
    assert "-m" not in argv


def test_build_argv_jsonl_and_thinking(tmp_path: Path) -> None:
    cfg = tmp_path / "cfg"
    ws = tmp_path / "ws"
    argv, _ = _build_argv(
        "cline",
        cfg,
        ws,
        model="m",
        timeout_sec=60,
        spec=_spec(output_mode="jsonl", thinking=True),
        user_text="hi",
    )
    assert "--json" in argv
    assert "--thinking" in argv
    ti = argv.index("--thinking")
    assert argv[ti + 1] == THINKING_TOKEN_DEFAULT


def test_build_argv_cline_verbose(tmp_path: Path) -> None:
    cfg = tmp_path / "cfg"
    ws = tmp_path / "ws"
    argv, _ = _build_argv(
        "cline",
        cfg,
        ws,
        model="m",
        timeout_sec=60,
        spec=_spec(),
        user_text="hi",
        cline_verbose=True,
    )
    assert argv[0] == "cline"
    assert argv[1] == "--verbose"
    assert argv[2] == "task", "--verbose 是全局选项，必须在 task 之前"
    assert argv[3] == "-y"


def test_parse_jsonl_output_joins_say_text_and_extracts_tools() -> None:
    lines = [
        json.dumps({"type": "say", "say": "text", "text": "Hello "}),
        json.dumps(
            {
                "type": "tool",
                "tool_name": "read_file",
                "args": {"path": "chronicle/w/x.json"},
                "content": "{\"id\": 1}",
            }
        ),
        json.dumps({"type": "say", "say": "text", "text": "world."}),
        "not_json_ignored",
    ]
    text, tool_log = _parse_jsonl_output("\n".join(lines))
    assert text == "Hello \n\nworld."
    assert len(tool_log) == 1
    assert tool_log[0]["tool_name"] == "read_file"
    assert tool_log[0]["args"] == {"path": "chronicle/w/x.json"}


def test_parse_jsonl_empty_falls_back_to_raw() -> None:
    text, tool_log = _parse_jsonl_output("no json here")
    assert text == "no json here"
    assert tool_log == []


def test_resolve_cline_executable_explicit_file(tmp_path: Path) -> None:
    exe = tmp_path / "my_cline.cmd"
    exe.write_text("@echo off\n", encoding="utf-8")
    out = cr.resolve_cline_executable({"cline_executable": str(exe)})
    assert Path(out) == exe.resolve()


@pytest.mark.skipif(sys.platform != "win32", reason="仅 Windows 探测 %APPDATA%\\npm\\cline.cmd")
def test_resolve_cline_executable_fallback_apdata_npm(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("APPDATA", str(tmp_path))
    monkeypatch.setattr(shutil, "which", lambda *_a, **_kw: None)
    shim = tmp_path / "npm" / "cline.cmd"
    shim.parent.mkdir(parents=True)
    shim.write_text("@echo off\n", encoding="utf-8")
    out = cr.resolve_cline_executable({})
    assert Path(out) == shim.resolve()


def test_build_cline_env_strips_proxy_and_sets_no_proxy_star(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("CLINE_DIR", raising=False)
    monkeypatch.setenv("CHRONICLE_UNIT_TEST_MARKER", "yes")
    monkeypatch.setenv("HTTP_PROXY", "http://127.0.0.1:9")
    monkeypatch.setenv("HTTPS_PROXY", "http://127.0.0.1:9")
    env = build_cline_env()
    assert env.get("CHRONICLE_UNIT_TEST_MARKER") == "yes"
    assert "HTTP_PROXY" not in env
    assert "HTTPS_PROXY" not in env
    assert env.get("NO_PROXY") == "*"
    assert "CHRONICLE_RUN_DIR" not in env or env.get("CHRONICLE_RUN_DIR") != "(injected)"
    assert "CHRONICLE_PROBE_TOOL_LOG" not in env
    assert "CLINE_DIR" not in env


def test_build_cline_env_sets_cline_dir_when_run_dir_given(tmp_path: Path) -> None:
    env = build_cline_env(run_dir=tmp_path)
    assert env.get("CLINE_DIR") == str((tmp_path / ".cline_config").resolve())


def test_run_agent_cline_stub_short_circuits(tmp_path: Path, monkeypatch) -> None:
    """kind='stub' 不应起子进程：返回占位文本且不创建 cwd。"""
    from tools.chronicle_sim_v2.core.llm.agent_llm import AgentLLMResources
    from tools.chronicle_sim_v2.core.llm.provider_profile import ProviderProfile
    from tools.chronicle_sim_v2.core.llm.stub_llm import build_chronicle_stub_llm

    pa = AgentLLMResources(
        agent_id="t",
        profile=ProviderProfile(kind="stub"),
        llm=build_chronicle_stub_llm(),
        default_extra={},
        audit_run_dir=None,
    )

    called = {"n": 0}

    async def _no_exec(*a, **kw):
        called["n"] += 1
        raise AssertionError("stub 路径不应触发子进程")

    monkeypatch.setattr(cr.asyncio, "create_subprocess_exec", _no_exec)

    import asyncio

    res = asyncio.run(
        cr.run_agent_cline(
            pa,
            tmp_path,
            _spec(system="HI {{x}}"),
            user_text="payload",
            system_ctx={"x": "y"},
        )
    )
    assert called["n"] == 0
    assert res.exit_code == 0
    assert res.text
