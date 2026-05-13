"""按 OutputSpec.kind 解析 backend 文本。

策略：
- text → 原样返回
- json_object / json_array → 严格 json，失败回退 json-repair
- jsonl → 按行解析；非 JSON 行作为 say 文本累积；JSON 行进 tool_log；
  返回 (text, tool_log, parsed)；parsed 是合并后的最终 say 文本（或最后一行 JSON 的 'final'）
"""
from __future__ import annotations

import json
from typing import Any

try:
    from json_repair import repair_json
except ImportError:  # pragma: no cover
    repair_json = None  # type: ignore[assignment]

from tools.chronicle_sim_v3.llm.errors import LLMOutputParseError
from tools.chronicle_sim_v3.llm.types import OutputSpec


def _parse_strict_or_repair(text: str) -> Any:
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        if repair_json is None:
            extracted = _extract_json_candidate(text)
            if extracted is None:
                raise
            return json.loads(extracted)
        extracted = _extract_json_candidate(text)
        if extracted is not None:
            try:
                return json.loads(extracted)
            except json.JSONDecodeError:
                pass
        repaired = repair_json(text, return_objects=False)
        if not repaired:
            extracted = _extract_json_candidate(text)
            if extracted is None:
                raise
            repaired = repair_json(extracted, return_objects=False)
            if not repaired:
                raise
        return json.loads(repaired)


def _extract_json_candidate(text: str) -> str | None:
    stripped = text.strip()
    first_obj = stripped.find("{")
    last_obj = stripped.rfind("}")
    if first_obj >= 0 and last_obj > first_obj:
        return stripped[first_obj : last_obj + 1]
    first_arr = stripped.find("[")
    last_arr = stripped.rfind("]")
    if first_arr >= 0 and last_arr > first_arr:
        return stripped[first_arr : last_arr + 1]
    return None


def parse_output(text: str, spec: OutputSpec) -> tuple[Any, list[dict]]:
    """返回 (parsed, tool_log)。

    text 模式 tool_log 永空；jsonl 模式 tool_log 含每条 JSON 行（除 say 外）。
    """
    kind = spec.kind
    if kind == "text":
        return text, []
    if kind == "json_object":
        try:
            obj = _parse_strict_or_repair(text)
        except Exception as e:
            raise LLMOutputParseError(f"json_object 解析失败: {e}; head={text[:120]!r}") from e
        if not isinstance(obj, dict):
            raise LLMOutputParseError(f"json_object 期望 dict，得到 {type(obj).__name__}")
        return obj, []
    if kind == "json_array":
        try:
            obj = _parse_strict_or_repair(text)
        except Exception as e:
            raise LLMOutputParseError(f"json_array 解析失败: {e}; head={text[:120]!r}") from e
        if not isinstance(obj, list):
            raise LLMOutputParseError(f"json_array 期望 list，得到 {type(obj).__name__}")
        return obj, []
    if kind == "jsonl":
        tool_log: list[dict] = []
        say_chunks: list[str] = []
        final: Any = None
        for raw_line in text.splitlines():
            line = raw_line.strip()
            if not line:
                continue
            try:
                obj = json.loads(line)
            except json.JSONDecodeError:
                say_chunks.append(line)
                continue
            if isinstance(obj, dict):
                if obj.get("type") == "say" or "say" in obj:
                    msg = obj.get("text") or obj.get("say") or ""
                    if msg:
                        say_chunks.append(str(msg))
                else:
                    if "final" in obj:
                        final = obj["final"]
                    tool_log.append(obj)
        parsed_text = "\n".join(say_chunks) if say_chunks else text
        if final is not None:
            return final, tool_log
        return parsed_text, tool_log
    raise LLMOutputParseError(f"未知 OutputSpec.kind={kind!r}")
