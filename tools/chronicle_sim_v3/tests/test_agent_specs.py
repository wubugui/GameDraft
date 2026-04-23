"""P3-1 验证 11 个 agent_spec TOML 加载与 stub 渲染。"""
from __future__ import annotations

import asyncio
from pathlib import Path

import pytest

from tools.chronicle_sim_v3.llm.render import load_spec, render
from tools.chronicle_sim_v3.llm.service import LLMService
from tools.chronicle_sim_v3.llm.types import LLMRef, OutputSpec, Prompt
from tools.chronicle_sim_v3.providers.service import ProviderService
from tools.chronicle_sim_v3.tests._fixtures import make_stub_run


def _llm(run: Path) -> LLMService:
    ps = ProviderService(run)
    return LLMService(run, ps)


_SPECS_DIR = Path(__file__).resolve().parents[1] / "data" / "agent_specs"

_SPECS = [
    "tier_s_npc.toml",
    "tier_a_npc.toml",
    "tier_b_npc.toml",
    "director.toml",
    "gm.toml",
    "rumor.toml",
    "week_summarizer.toml",
    "month_historian.toml",
    "style_rewriter.toml",
    "initializer.toml",
    "probe.toml",
]


@pytest.mark.parametrize("spec_file", _SPECS)
def test_spec_loads_and_has_system(spec_file: str) -> None:
    spec = load_spec(f"data/agent_specs/{spec_file}")
    assert spec.system, f"{spec_file} 缺 system"
    assert spec.user, f"{spec_file} 缺 user"
    assert spec.sha


def test_universal_contract_present() -> None:
    p = _SPECS_DIR / "_universal_output_contract.md"
    assert p.is_file()
    assert "JSON" in p.read_text(encoding="utf-8")


def test_design_doc_present() -> None:
    p = Path(__file__).resolve().parents[3] / "docs" / "prompt-design-notes.md"
    assert p.is_file()


def _vars_for(spec_file: str) -> dict:
    """提供合法 vars 以让 render 不抛错。"""
    common_vars = {
        "agent_id": "npc_x", "week": 3, "context_text": "无特殊记忆",
        "world_bible_text": "{}", "intents_json": "[]",
        "event_types_text": "(无)", "event_selection_notes": "无",
        "pacing_mult": 1.0, "drafts_json": "[]",
        "events_text": "无", "rumors_text": "无",
        "summaries_text": "无",
        "fingerprint_json": "{}", "source_text": "原文",
        "ideas_blob": "灵感片段",
        "question": "示例问题",
        "n": 1,
        "public_text": "公开内容",
    }
    return common_vars


@pytest.mark.parametrize("spec_file", _SPECS)
def test_spec_renders_without_missing_vars(spec_file: str) -> None:
    spec_ref = f"data/agent_specs/{spec_file}"
    sys_text, usr_text, _ = render(
        Prompt(spec_ref=spec_ref, vars=_vars_for(spec_file)),
    )
    assert sys_text
    assert usr_text


@pytest.mark.asyncio
@pytest.mark.parametrize("spec_file", _SPECS)
async def test_spec_e2e_stub(tmp_path: Path, spec_file: str) -> None:
    """走 LLMService stub backend，每个 spec 都能跑通 chat 不抛错。"""
    run = make_stub_run(tmp_path)
    svc = _llm(run)
    ref = LLMRef(
        role="test", model="offline",
        output=OutputSpec(kind="text"),  # stub 对所有 kind 都返回稳定占位
    )
    prompt = Prompt(
        spec_ref=f"data/agent_specs/{spec_file}",
        vars=_vars_for(spec_file),
    )
    result = await svc.chat(ref, prompt)
    assert result.text
    assert result.audit_id
    await svc.aclose()


@pytest.mark.asyncio
async def test_stub_results_stable_per_spec(tmp_path: Path) -> None:
    """同 spec 同 vars → stub 输出相同。"""
    run = make_stub_run(tmp_path)
    svc = _llm(run)
    ref = LLMRef(role="t", model="offline", output=OutputSpec(kind="text"))
    p = Prompt(spec_ref="data/agent_specs/tier_s_npc.toml",
                 vars=_vars_for("tier_s_npc.toml"))
    a = await svc.chat(ref, p)
    b = await svc.chat(ref, p)
    # 第二次走 cache（offline route 默认 hash）
    assert a.text == b.text
    await svc.aclose()
