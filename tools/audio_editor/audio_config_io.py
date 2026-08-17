# -*- coding: utf-8 -*-
"""audio_config.json 的文本级读改写 —— 只改 src 字符串,一个字节都不多动。

为什么不用 json.load -> json.dumps 回写:那样会把整个文件重排(缩进/键序/中文转义),
主编辑器的往返契约当场碎、diff 炸成全文。所以改动一律落在**字符区间**上。

为什么不用正则:旧实现那条 `"<id>"\\s*:\\s*\\{\\s*\\n\\s*"src"\\s*:\\s*"` 有两处硬伤,
新模型下「更新 src」是唯一写路径,两处都会变成主干上的雷:

  1. 写死了 src 必须是条目对象里的**第一个键**。条目一旦是 ``{"volume":0.4,"src":...}``
     就匹配不上,旧代码会掉进「插入新条目」分支,在同一个区插出重复键。
  2. 全文 ``re.search`` 首个命中即改,**不知道自己在哪个区**。bgm 与 sfx 有同名 id 时
     改的可能是另一个区那条(旧实现靠「真文件里恰好没有同名 id」躲过)。

这里改成:完整解析一遍 JSON 并**记录每个值的字符区间**,按 (区, id) 精确定位到那条
src 的值区间,只替换区间内的内容。任意键序、任意缩进、紧凑单行、裸字符串条目、
中文 id / 中文路径全都天然支持。解析不了就整批拒绝,绝不猜。
"""
from __future__ import annotations

import copy
import json
import os
import tempfile
import time
from pathlib import Path
from typing import Any
from tools.atomic_io import retry_transient

#: audio_config 里承载 ``{id: {src, volume?}}`` 的三个频道。
#: systemSfx 是 id→id 映射,不在此列(它不挂文件)。
CHANNELS: tuple[str, ...] = ("bgm", "ambient", "sfx")

#: src 唯一合法形状 —— 运行时与编辑器两侧都只认这个前缀
#: (见 tools/editor/shared/project_paths.py 的 _URL_PREFIX_RUNTIME)。
#: 绝对磁盘路径必须拒:素材审计对它是 fail-open,``/etc/hosts`` 都能报绿。
SRC_PREFIX = "/resources/runtime/"


class ConfigIOError(RuntimeError):
    """配置读改写过程中任何「说不清就别写」的情况。"""


# --------------------------------------------------------------- 带区间的 JSON 解析


class Node:
    """一个 JSON 值 + 它在原文里的字符区间 ``[start, end)``。

    ``members`` 只在对象上有值:键 -> 子 Node(子 Node 的区间是**值**的区间,不含键名)。
    """

    __slots__ = ("kind", "start", "end", "members", "value")

    def __init__(self, kind: str, start: int, end: int) -> None:
        self.kind = kind          # object / array / string / number / literal
        self.start = start
        self.end = end
        self.members: dict[str, Node] = {}
        self.value: Any = None

    def __repr__(self) -> str:    # pragma: no cover - 只为调试
        return f"<Node {self.kind} [{self.start},{self.end})>"


_WS = " \t\r\n"


class _SpanParser:
    """够用的 JSON 解析器:只多做一件事 —— 记住每个值的字符区间。

    刻意不复用 stdlib:``json`` 不吐位置信息,``object_pairs_hook`` 拿不到 span。
    解析结果同时当校验用 —— 任何解析失败都让调用方整批放弃。
    """

    def __init__(self, text: str) -> None:
        self.s = text
        self.i = 0
        self.n = len(text)

    def parse(self) -> Node:
        self._ws()
        node = self._value()
        self._ws()
        if self.i != self.n:
            raise ConfigIOError(f"JSON 尾部有多余内容(偏移 {self.i})")
        return node

    # -- 基础

    def _ws(self) -> None:
        while self.i < self.n and self.s[self.i] in _WS:
            self.i += 1

    def _expect(self, ch: str) -> None:
        if self.i >= self.n or self.s[self.i] != ch:
            got = self.s[self.i] if self.i < self.n else "EOF"
            raise ConfigIOError(f"偏移 {self.i} 期望 {ch!r},实际 {got!r}")
        self.i += 1

    # -- 值

    def _value(self) -> Node:
        if self.i >= self.n:
            raise ConfigIOError("JSON 提前结束")
        ch = self.s[self.i]
        if ch == "{":
            return self._object()
        if ch == "[":
            return self._array()
        if ch == '"':
            return self._string()
        return self._primitive()

    def _object(self) -> Node:
        start = self.i
        self._expect("{")
        node = Node("object", start, -1)
        self._ws()
        if self.i < self.n and self.s[self.i] == "}":
            self.i += 1
            node.end = self.i
            return node
        while True:
            self._ws()
            key_node = self._string()
            key = key_node.value
            self._ws()
            self._expect(":")
            self._ws()
            val = self._value()
            # 重复键:JSON 规范未定义,json.loads 取最后一个。这里如实照做,
            # 但重复键本身就是坏文件的信号,由调用方的结构对账去拦。
            node.members[key] = val
            self._ws()
            if self.i < self.n and self.s[self.i] == ",":
                self.i += 1
                continue
            self._expect("}")
            node.end = self.i
            return node

    def _array(self) -> Node:
        start = self.i
        self._expect("[")
        node = Node("array", start, -1)
        self._ws()
        if self.i < self.n and self.s[self.i] == "]":
            self.i += 1
            node.end = self.i
            return node
        while True:
            self._ws()
            self._value()
            self._ws()
            if self.i < self.n and self.s[self.i] == ",":
                self.i += 1
                continue
            self._expect("]")
            node.end = self.i
            return node

    def _string(self) -> Node:
        """扫出字符串的区间,**整段一次性**交给 json 解码。

        刻意不逐段解码:UTF-16 代理对写成两个相邻的 \\uD83D \\uDE00 时,分开解各得半个,
        拼起来与 `json.loads` 的结果不同 —— 那样算出来的 key 与 `json.loads(text)` 里的
        键对不上,对应的 key 就永远查不到、永远挂不上文件。区间是对的,只是解码粒度不能错。
        """
        start = self.i
        self._expect('"')
        while True:
            if self.i >= self.n:
                raise ConfigIOError(f"字符串未闭合(起于偏移 {start})")
            ch = self.s[self.i]
            if ch == "\\":
                self.i += 2                     # 跳过转义符与它后面那个字符
                if self.i - 1 < self.n and self.s[self.i - 1] == "u":
                    self.i += 4                 # \\uXXXX 还有四位十六进制
                continue
            if ch == '"':
                self.i += 1
                node = Node("string", start, self.i)
                try:
                    node.value = json.loads(self.s[start:self.i])
                except ValueError as ex:
                    raise ConfigIOError(f"偏移 {start} 处的字符串非法: {ex}") from ex
                return node
            self.i += 1

    def _primitive(self) -> Node:
        start = self.i
        while self.i < self.n and self.s[self.i] not in ",}]" + _WS:
            self.i += 1
        raw = self.s[start:self.i]
        if not raw:
            raise ConfigIOError(f"偏移 {start} 处不是合法的值")
        node = Node("number" if raw[0] in "-0123456789" else "literal", start, self.i)
        try:
            node.value = json.loads(raw)
        except ValueError as ex:
            raise ConfigIOError(f"偏移 {start} 处的值 {raw!r} 非法: {ex}") from ex
        return node


# --------------------------------------------------------------- 定位


def entry_src_span(root: Node, channel: str, audio_id: str) -> tuple[int, int] | None:
    """定位 ``<channel>.<audio_id>`` 的 src **值**区间(含两侧引号)。

    返回 None 有三种情况,调用方都必须当「不能写」处理,绝不许退化成插入:
      * 该区不存在 / 不是对象;
      * 该 id 不在这个区里;
      * 条目是对象但没有 src 键(有 src 才谈得上换 src)。

    条目是裸字符串(历史形态 ``"id": "/x.wav"``)时,整个字符串就是 src 的值区间。
    """
    sec = root.members.get(channel)
    if sec is None or sec.kind != "object":
        return None
    entry = sec.members.get(audio_id)
    if entry is None:
        return None
    if entry.kind == "string":
        return (entry.start, entry.end)
    if entry.kind != "object":
        return None
    src = entry.members.get("src")
    if src is None or src.kind != "string":
        return None
    return (src.start, src.end)


def read_entry(doc: dict, channel: str, audio_id: str) -> dict | None:
    """从已解析的 doc 里取一条登记,统一成 ``{"src":..., "volume":...|None}``。"""
    sec = doc.get(channel)
    if not isinstance(sec, dict) or audio_id not in sec:
        return None
    raw = sec[audio_id]
    if isinstance(raw, str):
        return {"src": raw, "volume": None, "extra": {}}
    if isinstance(raw, dict):
        vol = raw.get("volume")
        if isinstance(vol, bool) or not isinstance(vol, (int, float)):
            vol = None
        extra = {k: v for k, v in raw.items() if k not in ("src", "volume")}
        return {"src": str(raw.get("src") or ""), "volume": vol, "extra": extra}
    return None


def validate_src(src: str) -> str | None:
    """新 src 必须长成运行时认得的样子。返回错误说明;合法返回 None。"""
    if not src:
        return "src 不能为空"
    if not src.startswith(SRC_PREFIX):
        return (f"src 必须以 {SRC_PREFIX} 开头(拿到的是 {src!r});"
                "绝对磁盘路径会让素材审计 fail-open,一律拒绝")
    if "\\" in src or "\n" in src or "\r" in src or '"' in src:
        return f"src 含有会拼坏 JSON 或不合法的字符: {src!r}"
    if ".." in src.split("/"):
        return f"src 含有 .. 路径段: {src!r}"
    return None


def key_is_writable(audio_id: str) -> str | None:
    """这个 id 能不能安全地当文本级写入的目标。返回错误说明;合法返回 None。

    **刻意比旧的 AUDIO_ID_RE 宽**:旧正则 ``^[A-Za-z0-9_-]{1,80}$`` 同时兼了两件事
    —— 防拼坏 JSON、防 id 当文件名时路径穿越。新模型里物理文件名由工具自己按内容
    hash 生成,跟 id 再无关系,于是「当文件名」这层约束整个消失。
    留着旧正则的后果是实打实的:线上 audio_config 已有 8 个中文 ambient id
    (海边 / 野外鸟叫 / 阴风 …),会被判非法 ⇒ 这 8 个 key 在新界面里永远挂不上文件。

    所以这里只挡真正会出事的:控制字符与引号反斜杠(它们出现在 id 里说明文件本身
    已经坏了,我们也不该去动)。中文、空格、连字符一律放行。
    """
    if not audio_id:
        return "key 不能为空"
    if any(ord(c) < 0x20 for c in audio_id):
        return f"key 含有控制字符: {audio_id!r}"
    if '"' in audio_id or "\\" in audio_id:
        return f"key 含有引号或反斜杠: {audio_id!r}"
    return None


# --------------------------------------------------------------- 计划 / 落盘


def plan_src_updates(text: str, updates: list[dict]) -> list[dict]:
    """算出这批 src 改动会怎么落,**不写盘**。

    ``updates``: ``[{"channel":..., "audio_id":..., "src":...}, ...]``
    返回每条的判定,``action`` ∈ update / noop / blocked。预览、确认框、真落盘
    三处共用这一个函数 —— 旧实现 plan 走 json、apply 走正则,于是出过
    「预览说 update、落盘整批拒」的错位。
    """
    root = _SpanParser(text).parse()
    doc = json.loads(text)
    out: list[dict] = []
    seen: dict[tuple[str, str], int] = {}
    for u in updates:
        ch, aid, src = u["channel"], u["audio_id"], u["src"]
        row = {"channel": ch, "audio_id": aid, "src": src,
               "action": "blocked", "reason": "", "old_src": None}
        cur = read_entry(doc, ch, aid)
        row["old_src"] = cur["src"] if cur else None

        dup_key = (ch, aid)
        if ch not in CHANNELS:
            # systemSfx 是 id→id 映射,它的「值」是另一个音频 id,不是文件路径。
            # 把 src 写进去等于把映射毁成一条路径,运行时再也查不到那个音频。
            row["reason"] = (f"「{ch}」不是承载文件的频道(只有 "
                             + " / ".join(CHANNELS) + " 是);本工具不碰它")
        elif dup_key in seen:
            row["reason"] = "同一个 key 在这一批里被分配了两次"
        elif cur is None:
            # 新模型不新增条目:key 全量来自实时扫描,扫不到就是数据在我们背后变了
            row["reason"] = f"「{ch}」区里没有 id 为 {aid!r} 的登记(本工具不新增条目)"
        elif (err := key_is_writable(aid)):
            row["reason"] = err
        elif (err := validate_src(src)):
            row["reason"] = err
        elif entry_src_span(root, ch, aid) is None:
            row["reason"] = (f"「{ch}」区的 {aid!r} 条目没有可替换的 src 字符串"
                             "(条目结构不认识,拒绝改写)")
        elif cur["src"] == src:
            row["action"] = "noop"
        else:
            row["action"] = "update"
        seen[dup_key] = 1
        out.append(row)
    return out


def apply_src_updates(path: Path, updates: list[dict], *,
                      backup_dir: Path,
                      expect_stat: tuple[int, int] | None = None) -> dict:
    """把这批 src 改动落盘。全有全无:任何一条说不清就整批不写。

    ``expect_stat``: 调用方读这份配置时记下的 ``(size, mtime_ns)``。落盘前复核,
    对不上说明**别的程序**(多半是主编辑器 Save All)在这中间改过盘 —— 这时候写
    就是拿旧世界覆盖新世界,必须拒。fail-safe 不 fail-open。
    """
    # newline="":关掉 universal newlines。不关的话 CRLF 文件读进来变 LF、写回去就是
    # 整份换行符被改写 ——「一个字节都不多动」当场破功,而且备份也是改过的版本。
    original = path.read_text(encoding="utf-8", newline="")
    st = path.stat()
    if expect_stat is not None and (st.st_size, st.st_mtime_ns) != tuple(expect_stat):
        return {"ok": False, "applied": [], "noop": [], "blocked": [],
                "error": "audio_config.json 在这中间被别的程序改过了(多半是主编辑器保存了一次)。"
                         "已放弃写入,请刷新页面重新计算后再导出。"}

    plan = plan_src_updates(original, updates)
    blocked = [p for p in plan if p["action"] == "blocked"]
    if blocked:
        return {"ok": False, "applied": [], "noop": [], "blocked": blocked,
                "error": f"有 {len(blocked)} 条改不了,已放弃整批写入"}

    root = _SpanParser(original).parse()
    edits: list[tuple[int, int, str]] = []
    for p in plan:
        if p["action"] != "update":
            continue
        span = entry_src_span(root, p["channel"], p["audio_id"])
        assert span is not None            # plan 已经查过;这里为 None 是内部错误
        # ensure_ascii=False:中文路径必须原样落,转成 \\uXXXX 就破了往返契约
        edits.append((span[0], span[1], json.dumps(p["src"], ensure_ascii=False)))

    text = original
    for start, end, literal in sorted(edits, key=lambda e: e[0], reverse=True):
        text = text[:start] + literal + text[end:]

    # ---- 对账:落盘前把「预期结果」整份算出来,与实际解析结果做**全结构**比对。
    # 旧实现只逐条查目标 src 对不对,改坏别处是查不出来的;这里要求除了这几条 src
    # 之外一个字段都不许变。
    try:
        got = json.loads(text)
    except json.JSONDecodeError as ex:
        return {"ok": False, "applied": [], "noop": [], "blocked": [],
                "error": f"生成的 JSON 非法,已放弃写入: {ex}"}
    want = copy.deepcopy(json.loads(original))
    for p in plan:
        if p["action"] != "update":
            continue
        sec = want[p["channel"]]
        cur = sec[p["audio_id"]]
        sec[p["audio_id"]] = p["src"] if isinstance(cur, str) else {**cur, "src": p["src"]}
    if got != want:
        return {"ok": False, "applied": [], "noop": [], "blocked": [],
                "error": "写入结果与预期不符(改到了不该改的地方),已放弃写入"}

    applied = [p for p in plan if p["action"] == "update"]
    noop = [p for p in plan if p["action"] == "noop"]
    if text == original:
        # 什么都没变就别落备份,也别动 mtime —— 幂等重导是新模型的**主路径**
        return {"ok": True, "applied": [], "noop": noop, "blocked": [],
                "backup": None, "unchanged": True}

    backup = _write_backup(backup_dir, path, original)
    _atomic_write(path, text)
    return {"ok": True, "applied": applied, "noop": noop, "blocked": [],
            "backup": str(backup) if backup else None, "unchanged": False}


def _atomic_write(path: Path, text: str) -> None:
    """同目录 mkstemp + os.replace。裸 write_text 中途被打断会留半个文件,
    而这份文件是游戏数据,半个 = 整个工程打不开。"""
    fd, tmp = tempfile.mkstemp(dir=str(path.parent), prefix=path.name + ".", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="") as fh:
            fh.write(text)
            fh.flush()
            os.fsync(fh.fileno())
        retry_transient(os.replace, tmp, path)
    except BaseException:
        Path(tmp).unlink(missing_ok=True)
        raise


def _write_backup(backup_dir: Path, path: Path, original: str, keep: int = 30) -> Path | None:
    """备份落**工具自己的目录**,不落 public/assets/data/。

    旧实现把 ``audio_config.bak-<时间戳>.json`` 写在游戏数据目录里,后果是实打实的:
    主编辑器的引用扫描会把备份里的字符串一起算进引用计数,素材审计也会扫到它们;
    而「重复导出很廉价」正是新模型鼓励的事,备份会越堆越多。
    """
    try:
        backup_dir.mkdir(parents=True, exist_ok=True)
        dst = backup_dir / f"{path.stem}-{time.strftime('%Y%m%d-%H%M%S')}{path.suffix}"
        n = 1
        while dst.exists():
            dst = backup_dir / f"{path.stem}-{time.strftime('%Y%m%d-%H%M%S')}-{n}{path.suffix}"
            n += 1
        dst.write_text(original, encoding="utf-8", newline="")
        olds = sorted(backup_dir.glob(f"{path.stem}-*{path.suffix}"),
                      key=lambda p: p.stat().st_mtime, reverse=True)
        for old in olds[keep:]:
            old.unlink(missing_ok=True)
        return dst
    except OSError:
        # 备份失败不该拦住导出,但必须让调用方知道没有备份
        return None
