"""探针文末「--- 引用 ---」与 cwd 原文、tool_log 的校验规则。"""
from __future__ import annotations

from pathlib import Path

from tools.chronicle_sim_v2.core.agents.probe_citation_verify import (
    build_citation_diagnostic_prompt,
    verify_probe_citation,
)


def _write(cwd: Path, rel: str, content: str) -> None:
    p = cwd / rel
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(content, encoding="utf-8")


def _read_log(path: str) -> dict:
    return {"tool_name": "read_file", "args": {"path": path}, "content": ""}


def test_missing_ref_block(tmp_path: Path) -> None:
    ok, reasons = verify_probe_citation("no ref section", [], tmp_path)
    assert not ok
    assert reasons and "引用" in reasons[0]


def test_valid_quote_substring(tmp_path: Path) -> None:
    _write(tmp_path, "chronicle/week_001/events/a.json", '{"desc": "张三夜访米仓"}')
    log = [_read_log("chronicle/week_001/events/a.json")]
    answer = (
        "- **灵感**：张三夜访米仓。\n"
        "- **依据**：chronicle/week_001/events/a.json；摘录「张三夜访米仓」。\n\n"
        "--- 引用 ---\n"
        '[{"path": "chronicle/week_001/events/a.json", "quote": "张三夜访米仓"}]'
    )
    ok, reasons = verify_probe_citation(answer, log, tmp_path)
    assert ok, reasons


def test_quote_not_in_content(tmp_path: Path) -> None:
    _write(tmp_path, "chronicle/week_001/events/a.json", '{"desc": "张三夜访米仓"}')
    log = [_read_log("chronicle/week_001/events/a.json")]
    answer = (
        "- **灵感**：李四白日劫镖。\n\n"
        "--- 引用 ---\n"
        '[{"path": "chronicle/week_001/events/a.json", "quote": "李四白日劫镖"}]'
    )
    ok, reasons = verify_probe_citation(answer, log, tmp_path)
    assert not ok
    assert any("连续子串" in r for r in reasons)


def test_path_missing_from_tool_log(tmp_path: Path) -> None:
    _write(tmp_path, "chronicle/a.json", "hello world")
    answer = (
        "- **灵感**：hi。\n\n"
        "--- 引用 ---\n"
        '[{"path": "chronicle/a.json", "quote": "hello"}]'
    )
    ok, reasons = verify_probe_citation(answer, [], tmp_path)
    assert not ok
    assert any("read_file" in r for r in reasons)


def test_path_out_of_cwd_rejected(tmp_path: Path) -> None:
    log = [_read_log("../escape.txt")]
    answer = (
        "--- 引用 ---\n"
        '[{"path": "../escape.txt", "quote": "whatever"}]'
    )
    ok, reasons = verify_probe_citation(answer, log, tmp_path)
    assert not ok
    assert any("不存在" in r or "越界" in r for r in reasons)


def test_empty_refs_allowed_when_saying_unfound(tmp_path: Path) -> None:
    answer = (
        "在本地编年史中未找到相关内容。\n\n"
        "--- 引用 ---\n[]"
    )
    ok, reasons = verify_probe_citation(answer, [], tmp_path)
    assert ok, reasons


def test_empty_refs_with_inspiration_but_no_unfound_phrase_rejected(tmp_path: Path) -> None:
    answer = (
        "- **灵感**：编造的情节。\n\n"
        "--- 引用 ---\n[]"
    )
    ok, reasons = verify_probe_citation(answer, [], tmp_path)
    assert not ok


def test_refs_must_be_json_array(tmp_path: Path) -> None:
    answer = "--- 引用 ---\n{\"a\":1}"
    ok, reasons = verify_probe_citation(answer, [], tmp_path)
    assert not ok


def test_diagnostic_prompt_includes_reasons() -> None:
    text = build_citation_diagnostic_prompt(["原因甲", "原因乙"])
    assert "原因甲" in text and "原因乙" in text
