"""从 LLM 回复中稳健提取 JSON（去围栏、BOM、尾随逗号、raw_decode 等）。

对阿里云百炼 OpenAI 兼容地址，`OpenAICompatAdapter` 会在调用方传入 `json_schema` 时自动加
`response_format`（通常为 json_object）；其它网关仍仅靠提示词，故解析侧继续容错常见笔误。

语法级损坏（缺引号、多余文本、未闭合括号等）在自研路径仍失败时，交由 PyPI `json-repair`
（mangiucugna/json_repair，专用于 LLM 输出）修复后再解析；修复后的字符串仍走同一套
Seed 根候选选择，避免只解出小片段。
"""
from __future__ import annotations

import json
import re
from typing import Any

try:
    from json_repair import loads as _json_repair_loads
    from json_repair import repair_json as _json_repair_to_str
except ImportError:  # pragma: no cover
    _json_repair_loads = None  # type: ignore[assignment]
    _json_repair_to_str = None  # type: ignore[assignment]


class LLMJSONError(ValueError):
    """无法从文本中解析出期望的 JSON 结构。"""

    def __init__(self, message: str, preview: str = "") -> None:
        super().__init__(message)
        self.preview = preview


_FENCE_START = re.compile(r"^```(?:json)?\s*", re.IGNORECASE)
_TRAILING_COMMA_BEFORE_END = re.compile(r",(\s*[}\]])")

# 常见「类 JSON」污染：弯引号、全角括号、零宽字符
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


def _strip_zw(s: str) -> str:
    # 须写 \u2066-\u2069；若误写 \2066 会被当成八进制转义，区间会误伤普通 ASCII（含 { "等）
    return re.sub(r"[\u200b-\u200f\ufeff\u202a-\u202e\u2066-\u2069]", "", s)


def normalize_jsonish_text(s: str) -> str:
    """在解析前统一符号，降低模型输出格式噪声导致的失败率。"""
    t = (s or "").translate(_SMART_QUOTE_TRANS)
    t = t.replace("\uff3b", "[").replace("\uff3d", "]")
    t = _strip_zw(t)
    return t


def sanitize_control_chars_in_json_strings(s: str) -> str:
    """将 JSON 字符串值内的裸控制字符转为 \\n / \\t 等转义序列。

    模型常在长文本字段（如 body、reason）里直接换行，违反 JSON 规范，导致 json.loads 与
    raw_decode 整体失败；本函数仅在双引号字符串内部改写，不误伤键名外的空白。
    """
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
        o = ord(c)
        if o < 0x20:
            out.append(f"\\u{o:04x}")
            continue
        out.append(c)
    return "".join(out)


def strip_markdown_fences(text: str) -> str:
    s = (text or "").strip()
    if "```" not in s:
        return s
    parts = s.split("```")
    if len(parts) >= 3:
        for i in range(1, len(parts), 2):
            chunk = parts[i].strip()
            chunk = _FENCE_START.sub("", chunk).strip()
            if chunk.startswith("{") or chunk.startswith("["):
                return chunk
    return (
        s.replace("```json", "")
        .replace("```JSON", "")
        .replace("```", "")
        .strip()
    )


def _strip_trailing_commas_json(s: str) -> str:
    """移除紧挨在闭合 } 或 ] 前的逗号（标准 JSON 不允许，模型常见）。"""
    prev = None
    while prev != s:
        prev = s
        s = _TRAILING_COMMA_BEFORE_END.sub(r"\1", s)
    return s


def _decode_json_blob(blob: str) -> Any | None:
    """对单段文本尝试 json.loads、raw_decode、去尾随逗号后再解析。"""
    blob = blob.strip()
    if not blob:
        return None
    try:
        return json.loads(blob)
    except json.JSONDecodeError:
        pass
    dec = json.JSONDecoder()
    for opener in ("{", "["):
        idx = blob.find(opener)
        if idx < 0:
            continue
        try:
            val, _end = dec.raw_decode(blob, idx)
            return val
        except json.JSONDecodeError:
            continue
    try:
        fixed = _strip_trailing_commas_json(blob)
        if fixed != blob:
            return json.loads(fixed)
    except json.JSONDecodeError:
        pass
    dec = json.JSONDecoder()
    fixed = _strip_trailing_commas_json(blob)
    for opener in ("{", "["):
        idx = fixed.find(opener)
        if idx < 0:
            continue
        try:
            val, _end = dec.raw_decode(fixed, idx)
            return val
        except json.JSONDecodeError:
            continue
    return None


def _extract_balanced(s: str, start: int, open_c: str, close_c: str) -> str | None:
    if start >= len(s) or s[start] != open_c:
        return None
    depth = 0
    in_string = False
    escape = False
    for i in range(start, len(s)):
        c = s[i]
        if in_string:
            if escape:
                escape = False
            elif c == "\\":
                escape = True
            elif c == '"':
                in_string = False
            continue
        if c == '"':
            in_string = True
            continue
        if c == open_c:
            depth += 1
        elif c == close_c:
            depth -= 1
            if depth == 0:
                return s[start : i + 1]
    return None


def _candidate_values_from_opener(s: str, open_c: str, close_c: str) -> list[Any]:
    """扫描每一处 opener，取平衡子串并尝试解码，收集所有成功值。"""
    found: list[Any] = []
    for i, c in enumerate(s):
        if c != open_c:
            continue
        frag = _extract_balanced(s, i, open_c, close_c)
        if not frag:
            continue
        val = _decode_json_blob(frag)
        if val is not None:
            found.append(val)
    return found


def _pick_largest_dict(cands: list[Any]) -> dict[str, Any] | None:
    dicts = [x for x in cands if isinstance(x, dict)]
    if not dicts:
        return None
    return max(dicts, key=lambda d: len(str(d)))


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
    """world_setting 键数量、非空顶层键数、agents 条数、总串长 —越大越像完整 SeedDraft 根。"""
    ws = d.get("world_setting")
    ws_keys = len(ws) if isinstance(ws, dict) else 0
    overlap = sum(1 for k in _SEED_TOP_KEYS if k in d and d.get(k) not in (None, [], {}))
    ag = d.get("agents")
    agents_n = len(ag) if isinstance(ag, list) else 0
    return (ws_keys, overlap, agents_n, len(str(d)))


def _pick_seed_root_dict(cands: list[Any]) -> dict[str, Any] | None:
    """在多个可解析子对象中优先选 SeedDraft 根对象，避免误选单条 agent/支柱等小字典。"""
    dicts = [x for x in cands if isinstance(x, dict)]
    if not dicts:
        return None
    seeded = [d for d in dicts if "world_setting" in d]
    if seeded:
        return max(seeded, key=_seed_likeness_score)
    # 无 world_setting 时仍可能把并列顶层键摊平在根上（极少见）
    scored = [d for d in dicts if _seed_top_key_overlap_count(d) >= 3]
    if scored:
        return max(scored, key=lambda d: (len(str(d)), _seed_top_key_overlap_count(d)))
    return max(dicts, key=lambda d: len(str(d)))


def _seed_top_key_overlap_count(d: dict[str, Any]) -> int:
    return sum(1 for k in _SEED_TOP_KEYS if k in d)


def _pick_largest_list(cands: list[Any]) -> list[Any] | None:
    lists = [x for x in cands if isinstance(x, list)]
    if not lists:
        return None
    return max(lists, key=lambda x: len(str(x)))


def _unwrap_seed_like_list(val: Any) -> Any:
    """仅当列表元素像 SeedDraft（含 world_setting 对象）时提一层；不误伤普通 JSON 数组。"""
    if not isinstance(val, list):
        return val
    dicts = [x for x in val if isinstance(x, dict)]
    seeded = [d for d in dicts if isinstance(d.get("world_setting"), dict)]
    if len(seeded) == 1:
        return seeded[0]
    if seeded:
        return max(seeded, key=_seed_likeness_score)
    # 单元素数组包裹的根对象（world_setting 偶发为 str / 缺失但并列键齐全）
    if len(dicts) == 1:
        d0 = dicts[0]
        if _seed_top_key_overlap_count(d0) >= 3 or "agents" in d0:
            return d0
    return val


def _parse_after_json_repair(s: str) -> Any | None:
    """先用 json-repair 修语法，再跑候选与 Seed 根选择；仍失败则尝试 loads 直接得对象。"""
    if _json_repair_to_str is None or _json_repair_loads is None:
        return None
    s = (s or "").strip()
    if not s:
        return None
    try:
        fixed = _json_repair_to_str(s, ensure_ascii=False)
    except Exception:
        fixed = ""
    if isinstance(fixed, str) and fixed.strip():
        fixed_s = fixed.strip()
        r = _parse_json_lenient_on_normalized(fixed_s)
        if r is not None:
            return r
        fixed2 = sanitize_control_chars_in_json_strings(fixed_s)
        if fixed2 != fixed_s:
            r = _parse_json_lenient_on_normalized(fixed2)
            if r is not None:
                return r
    try:
        obj = _json_repair_loads(s)
        if isinstance(obj, (dict, list)):
            return obj
    except Exception:
        pass
    return None


def _parse_json_lenient_on_normalized(s: str) -> Any | None:
    """对已 strip/normalize 的文本尝试解码；成功返回 Python 值，否则 None。"""
    dict_cands = _candidate_values_from_opener(s, "{", "}")
    picked = _pick_seed_root_dict(dict_cands)
    r = _decode_json_blob(s)
    if isinstance(r, dict) and picked is not None:
        if _seed_likeness_score(picked) > _seed_likeness_score(r):
            r = picked
    elif r is None and picked is not None:
        r = picked

    if r is not None:
        return r

    for open_c, close_c in (("{", "}"), ("[", "]")):
        idx = s.find(open_c)
        if idx < 0:
            continue
        frag = _extract_balanced(s, idx, open_c, close_c)
        if frag:
            r2 = _decode_json_blob(frag)
            if r2 is not None:
                return r2

    if picked is not None:
        return picked

    list_cands = _candidate_values_from_opener(s, "[", "]")
    big_l = _pick_largest_list(list_cands)
    if big_l is not None:
        return big_l

    return None


def parse_json_lenient(text: str) -> Any:
    """返回 dict 或 list 等 JSON 值；失败则抛出 LLMJSONError。"""
    raw_preview = (text or "")[:480]
    s = strip_markdown_fences(text)
    s = normalize_jsonish_text((s or "").strip())
    if not s:
        raise LLMJSONError("模型输出为空，无法解析 JSON", raw_preview)

    r = _parse_json_lenient_on_normalized(s)
    if r is not None:
        return r

    # 模型常在长字符串字段内直接换行，违反 JSON；仅首轮失败时再修复，避免无谓改写
    s_fixed = sanitize_control_chars_in_json_strings(s)
    if s_fixed != s:
        r = _parse_json_lenient_on_normalized(s_fixed)
        if r is not None:
            return r

    r = _parse_after_json_repair(s)
    if r is not None:
        return r
    if s_fixed != s:
        r = _parse_after_json_repair(s_fixed)
        if r is not None:
            return r

    raise LLMJSONError("无法在输出中找到可解析的 JSON 对象或数组", raw_preview)


def parse_json_object(text: str) -> dict[str, Any]:
    val = _unwrap_seed_like_list(parse_json_lenient(text))
    if isinstance(val, dict) and len(val) == 1:
        inner = next(iter(val.values()))
        if isinstance(inner, dict) and "world_setting" in inner:
            val = inner
    if not isinstance(val, dict):
        raise LLMJSONError(
            f"期望 JSON 对象，得到 {type(val).__name__}",
            (text or "")[:480],
        )
    return val


def parse_json_array(text: str) -> list[Any]:
    val = parse_json_lenient(text)
    if not isinstance(val, list):
        raise LLMJSONError(
            f"期望 JSON 数组，得到 {type(val).__name__}",
            (text or "")[:480],
        )
    return val
