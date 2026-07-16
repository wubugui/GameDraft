"""位置感知 JSON 扫描器:JSON 指针 ↔ 文本行列 的双向映射。

标准库 json 不暴露位置信息,LSP 的跳转/引用需要精确落点——本模块一次递归下降
扫描同时产出两个方向:

- pointer → 值/键的文本 span(定义跳转、引用定位)
- 光标 offset → 所在字符串 token(值文本、pointer、是键还是值)(取词)

容错:非法 JSON 直接 raise(调用方按"该文件暂不可导航"降级);不求当解析器,
只求位置与 json.loads 语义一致。
"""

from __future__ import annotations

import bisect
from dataclasses import dataclass

_WS = " \t\n\r"
_ESCAPABLE = set('"\\/bfnrtu')


@dataclass(frozen=True)
class StrToken:
    start: int          # 含开引号
    end: int            # 不含闭引号后一位(即闭引号 offset + 1)
    text: str           # 解码后的字符串值
    pointer: str        # 所属 JSON 指针(键 token 的 pointer 指向该键的值)
    is_key: bool


class JsonLocator:
    def __init__(self, text: str):
        self.text = text
        self._line_starts = [0]
        for i, ch in enumerate(text):
            if ch == "\n":
                self._line_starts.append(i + 1)
        self.value_span: dict[str, tuple[int, int]] = {}
        self.key_span: dict[str, tuple[int, int]] = {}
        self.tokens: list[StrToken] = []
        self._i = 0
        self._parse_value("")
        self.tokens.sort(key=lambda t: t.start)
        self._token_starts = [t.start for t in self.tokens]

    # ---- 对外 ----

    def pos(self, offset: int) -> tuple[int, int]:
        """offset → (line, character),两者 0 起(LSP 口径)。"""
        line = bisect.bisect_right(self._line_starts, offset) - 1
        return line, offset - self._line_starts[line]

    def range_of_pointer(self, pointer: str) -> tuple[tuple[int, int], tuple[int, int]] | None:
        span = self.key_span.get(pointer) or self.value_span.get(pointer)
        if span is None:
            return None
        return self.pos(span[0]), self.pos(span[1])

    def token_at(self, line: int, character: int) -> StrToken | None:
        if line >= len(self._line_starts):
            return None
        offset = self._line_starts[line] + character
        idx = bisect.bisect_right(self._token_starts, offset) - 1
        if idx < 0:
            return None
        tok = self.tokens[idx]
        return tok if tok.start <= offset < tok.end else None

    # ---- 递归下降 ----

    def _skip_ws(self) -> None:
        t, i = self.text, self._i
        while i < len(t) and t[i] in _WS:
            i += 1
        self._i = i

    def _err(self, msg: str):
        line, ch = self.pos(min(self._i, len(self.text) - 1) if self.text else 0)
        raise ValueError(f"JSON 位置扫描失败 @ {line + 1}:{ch + 1}: {msg}")

    def _parse_string(self, pointer: str, is_key: bool) -> str:
        t = self.text
        start = self._i
        if t[start] != '"':
            self._err("期望字符串")
        i = start + 1
        buf: list[str] = []
        while i < len(t):
            ch = t[i]
            if ch == '"':
                self.tokens.append(StrToken(start, i + 1, "".join(buf), pointer, is_key))
                self._i = i + 1
                return "".join(buf)
            if ch == "\\":
                nxt = t[i + 1] if i + 1 < len(t) else ""
                if nxt not in _ESCAPABLE:
                    self._err(f"非法转义 \\{nxt}")
                if nxt == "u":
                    buf.append(chr(int(t[i + 2:i + 6], 16)))
                    i += 6
                else:
                    buf.append({"n": "\n", "t": "\t", "r": "\r", "b": "\b", "f": "\f"}.get(nxt, nxt))
                    i += 2
            else:
                buf.append(ch)
                i += 1
        self._err("字符串未闭合")

    @staticmethod
    def _escape_pointer_seg(seg: str) -> str:
        return seg.replace("~", "~0").replace("/", "~1")

    def _parse_value(self, pointer: str) -> None:
        self._skip_ws()
        if self._i >= len(self.text):
            self._err("意外结尾")
        start = self._i
        ch = self.text[self._i]
        if ch == "{":
            self._i += 1
            self._skip_ws()
            if self.text[self._i] == "}":
                self._i += 1
            else:
                while True:
                    self._skip_ws()
                    key_start = self._i
                    key = self._parse_string(pointer, is_key=True)
                    child = f"{pointer}/{self._escape_pointer_seg(key)}"
                    self.key_span[child] = (key_start, self._i)
                    # 键 token 的 pointer 应指向其值,修正刚压入的 token
                    self.tokens[-1] = StrToken(key_start, self._i, key, child, True)
                    self._skip_ws()
                    if self.text[self._i] != ":":
                        self._err("期望 :")
                    self._i += 1
                    self._parse_value(child)
                    self._skip_ws()
                    if self.text[self._i] == ",":
                        self._i += 1
                        continue
                    if self.text[self._i] == "}":
                        self._i += 1
                        break
                    self._err("期望 , 或 }")
        elif ch == "[":
            self._i += 1
            self._skip_ws()
            if self.text[self._i] == "]":
                self._i += 1
            else:
                idx = 0
                while True:
                    self._parse_value(f"{pointer}/{idx}")
                    idx += 1
                    self._skip_ws()
                    if self.text[self._i] == ",":
                        self._i += 1
                        continue
                    if self.text[self._i] == "]":
                        self._i += 1
                        break
                    self._err("期望 , 或 ]")
        elif ch == '"':
            self._parse_string(pointer, is_key=False)
        else:
            i = self._i
            while i < len(self.text) and self.text[i] not in ",}] \t\n\r":
                i += 1
            lit = self.text[self._i:i]
            if lit not in ("true", "false", "null"):
                try:
                    float(lit)
                except ValueError:
                    self._err(f"非法字面量 {lit!r}")
            self._i = i
        self.value_span[pointer] = (start, self._i)
