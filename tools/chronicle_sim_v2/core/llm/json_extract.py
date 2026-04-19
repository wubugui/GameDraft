"""从 LLM 回复中提取 JSON。

使用 `json-repair` 作为唯一解析器。预处理仅负责清理 Markdown 围栏、弯引号、
全角括号、控制字符等表面污染，修复和解析全部交给库。
"""
from __future__ import annotations

import json
import re
from typing import Any

from json_repair import repair_json as _repair_json


class LLMJSONError(ValueError):
    """无法从文本中解析出期望的 JSON 结构。"""

    def __init__(self, message: str, preview: str = "", *, details: str = "") -> None:
        super().__init__(message)
        self.preview = preview
        self.raw_text = ""
        self.details = (details or "").strip()

    def __str__(self) -> str:
        base = self.args[0] if self.args else "LLMJSONError"
        if self.details:
            return f"{base} | {self.details}"
        return str(base)

    def reason_lines(self) -> list[str]:
        lines = [str(self.args[0]) if self.args else "LLMJSONError"]
        if self.details:
            lines.append(self.details)
        if self.preview:
            pv = self.preview.replace("\n", "\\n")
            if len(pv) > 360:
                pv = pv[:360] + "…"
            lines.append(f"文本预览: {pv}")
        return lines


_FENCE_RE = re.compile(r"^```(?:json)?\s*", re.IGNORECASE)

_SMART_QUOTE_TRANS = str.maketrans(
    {
        "\u201c": '"',
        "\u201d": '"',
        "\u2018": "'",
        "\u2019": "'",
        "\uff5b": "{",
        "\uff5d": "}",
        "\u300c": '"',
        "\u300d": '"',
        "\ufeff": None,
    }
)


def strip_markdown_fences(text: str) -> str:
    """提取 Markdown 代码块内的 JSON 内容。"""
    s = (text or "").strip()
    if "```" not in s:
        return s
    parts = s.split("```")
    for i in range(1, len(parts), 2):
        chunk = parts[i].strip()
        chunk = _FENCE_RE.sub("", chunk).strip()
        if chunk.startswith("{") or chunk.startswith("["):
            return chunk
    return s.replace("```json", "").replace("```JSON", "").replace("```", "").strip()


def normalize_jsonish_text(s: str) -> str:
    """统一弯引号、全角括号、零宽字符。"""
    t = (s or "").translate(_SMART_QUOTE_TRANS)
    t = t.replace("\uff3b", "[").replace("\uff3d", "]")
    t = re.sub(r"[\u200b-\u200f\ufeff\u202a-\u202e\u2066-\u2069]", "", t)
    return t


def sanitize_control_chars_in_json_strings(s: str) -> str:
    """将 JSON 字符串值内的裸控制字符转为转义序列。"""
    out: list[str] = []
    in_string = False
    escape = False
    for c in s or "":
        if not in_string:
            if c == '"':
                in_string = True
            out.append(c)
            continue
        if escape:
            out.append(c)
            escape = False
            continue
        if c == "\\":
            out.append(c)
            escape = True
            continue
        if c == '"':
            in_string = False
            out.append(c)
            continue
        if c == "\n":
            out.append("\\n")
            continue
        if c == "\r":
            out.append("\\r")
            continue
        if c == "\t":
            out.append("\\t")
            continue
        if ord(c) < 0x20:
            out.append(f"\\u{ord(c):04x}")
            continue
        out.append(c)
    return "".join(out)


_SEED_TOP_KEYS = frozenset(
    {
        "world_setting",
        "design_pillars",
        "custom_sections",
        "agents",
        "factions",
        "locations",
        "relationships",
        "anchor_events",
        "social_graph_edges",
        "event_type_candidates",
    }
)


def _seed_likeness_score(d: dict[str, Any]) -> tuple[int, int, int, int]:
    ws = d.get("world_setting")
    ws_keys = len(ws) if isinstance(ws, dict) else 0
    overlap = sum(1 for k in _SEED_TOP_KEYS if k in d and d.get(k) not in (None, [], {}))
    ag = d.get("agents")
    agents_n = len(ag) if isinstance(ag, list) else 0
    return (ws_keys, overlap, agents_n, len(str(d)))


def _seed_top_key_overlap_count(d: dict[str, Any]) -> int:
    return sum(1 for k in _SEED_TOP_KEYS if k in d)


def _unwrap_seed_like_list(val: Any) -> Any:
    """仅当列表元素像 SeedDraft 时提一层；不误伤普通 JSON 数组。"""
    if not isinstance(val, list):
        return val
    dicts = [x for x in val if isinstance(x, dict)]
    seeded = [d for d in dicts if isinstance(d.get("world_setting"), dict)]
    if len(seeded) == 1:
        return seeded[0]
    if seeded:
        return max(seeded, key=_seed_likeness_score)
    if len(dicts) == 1:
        d0 = dicts[0]
        if _seed_top_key_overlap_count(d0) >= 3 or "agents" in d0:
            return d0
    return val


def _try_json_repair(s: str) -> Any:
    """调用 json-repair 修复并解析 LLM 输出。"""
    result = _repair_json(s, ensure_ascii=False, return_objects=True)
    if isinstance(result, (dict, list)):
        return result
    if isinstance(result, str) and result.strip():
        result = _repair_json(result, ensure_ascii=False, return_objects=True)
        if isinstance(result, (dict, list)):
            return result
    raise LLMJSONError(
        "json-repair 未能修复出有效的 JSON 对象",
        s[:480],
        details=f"去空白后长度={len(s.strip())}，首尾={s.strip()[:1]!r}…{s.strip()[-1:]!r}",
    )


def parse_json_lenient(text: str) -> Any:
    """返回 dict 或 list 等 JSON 值；失败则抛出 LLMJSONError。"""
    raw_full = text or ""
    raw_preview = raw_full[:480]
    s = strip_markdown_fences(text)
    s = normalize_jsonish_text((s or "").strip())
    if not s:
        raise LLMJSONError(
            "模型输出为空，无法解析 JSON",
            raw_preview,
            details="去围栏与规范化后文本为空",
        )

    # ① 先尝试直接 json.loads（干净输出走快路径）
    try:
        return json.loads(s)
    except json.JSONDecodeError:
        pass

    # ② 控制字符修复后重试
    s_fixed = sanitize_control_chars_in_json_strings(s)
    if s_fixed != s:
        try:
            return json.loads(s_fixed)
        except json.JSONDecodeError:
            pass

    # ③ 交给 json-repair
    try:
        return _try_json_repair(s_fixed if s_fixed != s else s)
    except Exception:
        pass

    err = LLMJSONError(
        "无法在输出中找到可解析的 JSON 对象或数组",
        raw_preview,
        details=f"预处理后 json.loads 与 json-repair 均失败，去空白后长度={len(s.strip())}",
    )
    err.raw_text = raw_full
    raise err


def _diagnose_wrong_root_type(val: Any) -> str:
    if isinstance(val, list):
        n = len(val)
        if n == 0:
            return "根为 []，种子需要非空对象"
        head = val[0]
        return (
            f"根为长度 {n} 的数组；首元素类型为 {type(head).__name__}。"
            " 期望单一 JSON 对象根（world_setting、agents 等与 world_setting 并列）。"
        )
    return f"根类型为 {type(val).__name__}，期望 object"


def parse_json_object(text: str) -> dict[str, Any]:
    val = _unwrap_seed_like_list(parse_json_lenient(text))
    if isinstance(val, dict) and len(val) == 1:
        inner = next(iter(val.values()))
        if isinstance(inner, dict) and "world_setting" in inner:
            val = inner
    if not isinstance(val, dict):
        err = LLMJSONError(
            f"期望 JSON 对象，得到 {type(val).__name__}",
            (text or "")[:480],
            details=_diagnose_wrong_root_type(val),
        )
        err.raw_text = text or ""
        raise err
    return val


def parse_json_array(text: str) -> list[Any]:
    val = parse_json_lenient(text)
    if not isinstance(val, list):
        raise LLMJSONError(
            f"期望 JSON 数组，得到 {type(val).__name__}",
            (text or "")[:480],
            details=(
                "根为对象或其它类型，期望以 [ 开头的 JSON 数组"
                if isinstance(val, dict)
                else f"根类型为 {type(val).__name__}"
            ),
        )
    return val
