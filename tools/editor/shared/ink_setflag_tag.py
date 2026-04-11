"""Parse Ink `# action:setFlag:key:value` tags (aligned with DialogueManager)."""
from __future__ import annotations

from typing import Any


def _decode_ink_quoted(s: str) -> tuple[str, int] | None:
    if not s:
        return None
    q = s[0]
    if q not in "\"'":
        return None
    i = 1
    out: list[str] = []
    while i < len(s):
        c = s[i]
        if c == "\\" and i + 1 < len(s):
            n = s[i + 1]
            if n == "n":
                out.append("\n")
                i += 2
                continue
            if n == "t":
                out.append("\t")
                i += 2
                continue
            if n == "r":
                out.append("\r")
                i += 2
                continue
            if n in "\\\"'":
                out.append(n)
                i += 2
                continue
            out.append(n)
            i += 2
            continue
        if c == q:
            return "".join(out), i + 1
        out.append(c)
        i += 1
    return None


def _parse_tag_value(s: str) -> Any:
    t = s.strip()
    if t == "true":
        return True
    if t == "false":
        return False
    try:
        n = float(t)
        if n == n:  # not NaN
            return n
    except ValueError:
        pass
    return s


def parse_append_flag_action_tag(tag: str) -> tuple[str, str] | None:
    """``action:appendFlag:key:text``，规则同 setFlag；追加片段统一为 str。"""
    prefix = "action:appendFlag:"
    if not tag.startswith(prefix):
        return None
    param_str = tag[len(prefix) :]
    idx = param_str.find(":")
    if idx <= 0:
        return None
    key = param_str[:idx].strip()
    if not key:
        return None
    rest = param_str[idx + 1 :].strip()
    if rest[:1] in "\"'":
        dec = _decode_ink_quoted(rest)
        if dec is not None and dec[1] == len(rest):
            return key, dec[0]
    v = _parse_tag_value(rest)
    return key, v if isinstance(v, str) else str(v)


def parse_set_flag_action_tag(tag: str) -> tuple[str, Any] | None:
    """
    tag: full tag text e.g. ``action:setFlag:my_key:value`` (no ``#`` prefix).
    First ``:`` after key splits key vs value; quoted value supports escapes.
    """
    prefix = "action:setFlag:"
    if not tag.startswith(prefix):
        return None
    param_str = tag[len(prefix):]
    idx = param_str.find(":")
    if idx <= 0:
        return None
    key = param_str[:idx].strip()
    if not key:
        return None
    rest = param_str[idx + 1 :].strip()
    if rest[:1] in "\"'":
        dec = _decode_ink_quoted(rest)
        if dec is not None and dec[1] == len(rest):
            return key, dec[0]
    return key, _parse_tag_value(rest)
