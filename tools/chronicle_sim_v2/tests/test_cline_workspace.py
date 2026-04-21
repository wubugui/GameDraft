"""materialize_temp_ws / cleanup / ensure_mcp_for_run / effective snapshot 的行为。"""
from __future__ import annotations

import json
from pathlib import Path

from tools.chronicle_sim_v2.core.llm.agent_spec import AgentSpec
from tools.chronicle_sim_v2.core.llm.cline_workspace import (
    MCP_CLINE_RULE_TEXT,
    MCP_SERVER_ID,
    cleanup_temp_ws,
    cline_config_path,
    cline_mcp_settings_path,
    ensure_mcp_for_run,
    materialize_temp_ws,
    write_llm_effective_snapshot,
)
from tools.chronicle_sim_v2.core.llm.provider_profile import ProviderProfile


def _make_spec(
    *,
    agent_id: str = "t",
    mcp: str = "none",
    copy_chronicle: bool = False,
    thinking: bool = False,
    output_mode: str = "text",
    system: str = "SYS {{k}}",
    user_template: str = "UT",
) -> AgentSpec:
    return AgentSpec(
        agent_id=agent_id,
        system=system,
        user_template=user_template,
        mcp=mcp,
        copy_chronicle_to_cwd=copy_chronicle,
        thinking=thinking,
        output_mode=output_mode,
    )


def test_cline_config_path_is_under_run_dir(tmp_path: Path) -> None:
    p = cline_config_path(tmp_path)
    assert p == (tmp_path / ".cline_config").resolve()
    assert p.is_dir()


def test_materialize_writes_role_and_mcp(tmp_path: Path) -> None:
    spec = _make_spec(mcp="chroma", system="HELLO {{who}}")
    ws = materialize_temp_ws(tmp_path, spec, system_ctx={"who": "world"})
    try:
        assert ws.is_dir()
        role = (ws / ".clinerules" / "01_role.md").read_text(encoding="utf-8")
        assert role == "HELLO world"
        mcp = (ws / ".clinerules" / "02_mcp.md").read_text(encoding="utf-8")
        assert mcp == MCP_CLINE_RULE_TEXT
    finally:
        cleanup_temp_ws(ws)
    assert not ws.exists()


def test_materialize_no_mcp_file_when_none(tmp_path: Path) -> None:
    spec = _make_spec(mcp="none", system="X")
    ws = materialize_temp_ws(tmp_path, spec, system_ctx={})
    try:
        assert (ws / ".clinerules" / "01_role.md").is_file()
        assert not (ws / ".clinerules" / "02_mcp.md").exists()
    finally:
        cleanup_temp_ws(ws)


def test_materialize_copies_chronicle_for_probe(tmp_path: Path) -> None:
    src = tmp_path / "chronicle"
    (src / "week_001").mkdir(parents=True)
    (src / "week_001" / "summary.md").write_text("hello", encoding="utf-8")

    spec = _make_spec(mcp="chroma", copy_chronicle=True, output_mode="jsonl")
    ws = materialize_temp_ws(tmp_path, spec, system_ctx={"k": "v"})
    try:
        snap = ws / "chronicle" / "week_001" / "summary.md"
        assert snap.is_file()
        assert snap.read_text(encoding="utf-8") == "hello"
    finally:
        cleanup_temp_ws(ws)


def test_materialize_creates_empty_chronicle_when_source_missing(tmp_path: Path) -> None:
    spec = _make_spec(copy_chronicle=True, system="s")
    ws = materialize_temp_ws(tmp_path, spec, system_ctx={})
    try:
        empty = ws / "chronicle"
        assert empty.is_dir()
        assert list(empty.iterdir()) == []
    finally:
        cleanup_temp_ws(ws)


def test_ensure_mcp_for_run_merges_and_preserves_others(tmp_path: Path) -> None:
    settings_path = cline_mcp_settings_path(tmp_path)
    settings_path.parent.mkdir(parents=True, exist_ok=True)
    settings_path.write_text(
        json.dumps(
            {
                "mcpServers": {
                    "some_other": {
                        "command": "node",
                        "args": ["foo.js"],
                    }
                }
            }
        ),
        encoding="utf-8",
    )

    out = ensure_mcp_for_run(tmp_path)
    assert out == settings_path

    data = json.loads(settings_path.read_text(encoding="utf-8"))
    assert "some_other" in data["mcpServers"]
    assert data["mcpServers"]["some_other"]["command"] == "node"

    entry = data["mcpServers"][MCP_SERVER_ID]
    assert "--run-dir" in entry["args"]
    idx = entry["args"].index("--run-dir")
    assert Path(entry["args"][idx + 1]) == tmp_path.resolve()
    assert entry["disabled"] is False
    assert set(entry["alwaysAllow"]) == {"chroma_search_world", "chroma_search_ideas"}


def test_ensure_mcp_replaces_stale_chronicle_sim_entry(tmp_path: Path) -> None:
    ensure_mcp_for_run(tmp_path)
    settings_path = cline_mcp_settings_path(tmp_path)
    data = json.loads(settings_path.read_text(encoding="utf-8"))
    data["mcpServers"][MCP_SERVER_ID]["args"] = ["oudated"]
    settings_path.write_text(json.dumps(data), encoding="utf-8")

    ensure_mcp_for_run(tmp_path)
    data2 = json.loads(settings_path.read_text(encoding="utf-8"))
    assert "--run-dir" in data2["mcpServers"][MCP_SERVER_ID]["args"]


def test_write_llm_effective_snapshot_redacts_api_key(tmp_path: Path) -> None:
    profile = ProviderProfile(
        kind="openai_compat",
        model="gpt-x",
        base_url="https://example.test/v1",
        api_key="sk-REAL-SECRET-TOKEN",
    )
    argv = [
        "cline",
        "--config",
        str(tmp_path / ".cline_config"),
        "-c",
        str(tmp_path / "ws" / "probe_abc"),
        "-m",
        "gpt-x",
        "payload",
    ]
    out_path = write_llm_effective_snapshot(
        tmp_path,
        agent_id="probe",
        profile=profile,
        argv=argv,
        timings_ms={"total_ms": 12},
        extra={"user_len": 7},
    )
    assert out_path.is_file()
    rec = json.loads(out_path.read_text(encoding="utf-8"))
    assert rec["api_key_mask"] == "***"
    assert "sk-REAL-SECRET-TOKEN" not in out_path.read_text(encoding="utf-8")
    assert rec["model"] == "gpt-x"
    assert rec["base_url"] == "https://example.test/v1"
    assert rec["agent_id"] == "probe"
    assert rec["extra"]["user_len"] == 7
    assert len(rec["argv_digest"]) == 16
