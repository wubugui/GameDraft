"""TOML spec 加载、占位符渲染、非法取值的行为。"""
from __future__ import annotations

import pytest

from tools.chronicle_sim_v2.core.llm import agent_spec as spec_mod
from tools.chronicle_sim_v2.core.llm.agent_spec import (
    AgentSpecError,
    load_agent_spec,
    render_system,
    render_user,
)

ALL_SLOTS = [
    "initializer",
    "director",
    "gm",
    "tier_s_npc",
    "tier_a_npc",
    "tier_b_npc",
    "rumor",
    "week_summarizer",
    "month_historian",
    "style_rewriter",
    "probe",
]


@pytest.mark.parametrize("slot", ALL_SLOTS)
def test_load_all_shipped_specs(slot: str) -> None:
    sp = load_agent_spec(slot)
    assert sp.agent_id == slot
    assert sp.system.strip()
    assert sp.user_template.strip()
    assert sp.mcp in ("chroma", "none")
    assert sp.output_mode in ("text", "jsonl")


def test_load_missing_raises(tmp_path, monkeypatch) -> None:
    monkeypatch.setattr(spec_mod, "AGENT_SPECS_DIR", tmp_path)
    with pytest.raises(AgentSpecError):
        load_agent_spec("does_not_exist")


def test_render_strict_missing_placeholder(tmp_path, monkeypatch) -> None:
    (tmp_path / "x.toml").write_text(
        '[meta]\nagent_id = "x"\n'
        '[prompts]\nsystem = "sys {{a}}"\nuser_template = "u {{b}} {{c}}"\n',
        encoding="utf-8",
    )
    monkeypatch.setattr(spec_mod, "AGENT_SPECS_DIR", tmp_path)
    sp = load_agent_spec("x")
    with pytest.raises(AgentSpecError):
        render_user(sp, {"b": "1"})
    assert render_user(sp, {"b": "1", "c": "2"}) == "u 1 2"
    assert render_system(sp, {"a": "Z"}) == "sys Z"


def test_invalid_mcp_value(tmp_path, monkeypatch) -> None:
    (tmp_path / "x.toml").write_text(
        '[meta]\nagent_id = "x"\n[options]\nmcp = "weird"\n'
        '[prompts]\nsystem = "s"\nuser_template = "u"\n',
        encoding="utf-8",
    )
    monkeypatch.setattr(spec_mod, "AGENT_SPECS_DIR", tmp_path)
    with pytest.raises(AgentSpecError):
        load_agent_spec("x")


def test_invalid_output_mode(tmp_path, monkeypatch) -> None:
    (tmp_path / "x.toml").write_text(
        '[meta]\nagent_id = "x"\n[options]\noutput_mode = "xml"\n'
        '[prompts]\nsystem = "s"\nuser_template = "u"\n',
        encoding="utf-8",
    )
    monkeypatch.setattr(spec_mod, "AGENT_SPECS_DIR", tmp_path)
    with pytest.raises(AgentSpecError):
        load_agent_spec("x")


def test_probe_user_template_wants_expected_keys() -> None:
    sp = load_agent_spec("probe")
    text = render_user(sp, {"prior_turns_block": "", "user_question": "Q?"})
    assert "Q?" in text
