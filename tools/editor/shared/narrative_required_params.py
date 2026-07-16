"""从 src/core/actionParamManifest.ts（只读权威）解析各 action 的必填参数集。

背景（审查 P1-10）：叙事编辑器的 Python 兜底校验曾把 `_PARAM_SCHEMAS`（GUI 控件
清单）整表当必填，比 TS 权威严 25 处——「保持默认值」的合法最小形态被 Ctrl+S /
Save All 拦死。红线（narrative-state-editor 机制卡）：**Python 兜底必须是 TS 权威
的子集**。系统修法就是本模块：required/nonEmpty 直接从 manifest 解析，不再手抄。

语义与 manifest 对齐（见 actionParamManifest.ts 头注释）：
- required：键缺失或值为 null 视为缺参；
- nonEmpty：required 的子集——值为字符串且 trim 后为空同样视为缺参
  （非字符串值不做此检查）。

解析失败（文件缺失 / 结构大改导致解析不出任何条目）返回 None，调用方必须
**fail-open**：只校验 action 类型存在、不做必填拦截——宁可放过（validate-data
门与 TS 权威校验兜真错），不可拦住合法数据。

本模块刻意用文本解析而非执行 TS：与 tools/editor/tests/test_action_manifest_parity.py
同一手法；解析正确性由 tools/editor/tests/test_narrative_required_params.py 的
parity 测试锁定（含「Python required ⊆ TS required」语义）。
"""
from __future__ import annotations

import re
from pathlib import Path

_MANIFEST_REL = "src/core/actionParamManifest.ts"

# 顶层条目：两空格缩进的 `<action>: { ... }`（条目体内只有数组/标量，无嵌套花括号，
# 非贪婪到第一个 `}` 即条目边界）。
_ENTRY_RE = re.compile(
    r"^\x20{2}([A-Za-z][A-Za-z0-9]*)\s*:\s*\{(.*?)\}", re.MULTILINE | re.DOTALL
)
_REQUIRED_RE = re.compile(r"\brequired\s*:\s*\[(.*?)\]", re.DOTALL)
_NON_EMPTY_RE = re.compile(r"\bnonEmpty\s*:\s*\[(.*?)\]", re.DOTALL)
_STRING_RE = re.compile(r"['\"]([^'\"]+)['\"]")

# (mtime, parsed) 缓存：编辑器进程常驻，manifest 变更（重新拉代码等）后自动重读。
_cache: tuple[float, dict[str, tuple[tuple[str, ...], frozenset[str]]] | None] | None = None


def manifest_path() -> Path:
    return Path(__file__).resolve().parents[3] / _MANIFEST_REL


def _strip_comments(text: str) -> str:
    text = re.sub(r"/\*.*?\*/", "", text, flags=re.DOTALL)
    return re.sub(r"//[^\n]*", "", text)


def parse_manifest_text(text: str) -> dict[str, tuple[tuple[str, ...], frozenset[str]]] | None:
    """解析 manifest 源码文本 → {action_type: (required 有序元组, nonEmpty 集合)}。

    解析不出任何条目（结构大改/标记缺失）返回 None，调用方 fail-open。
    """
    stripped = _strip_comments(str(text or ""))
    marker = stripped.find("ACTION_PARAM_MANIFEST")
    if marker < 0:
        return None
    start = stripped.find("{", marker)
    end = stripped.find("\n};", start)
    if start < 0 or end < 0:
        return None
    section = stripped[start:end]
    out: dict[str, tuple[tuple[str, ...], frozenset[str]]] = {}
    for m in _ENTRY_RE.finditer(section):
        action_type, body = m.group(1), m.group(2)
        req_m = _REQUIRED_RE.search(body)
        if req_m is None:
            # manifest 每条都有 required；缺了说明解析没对上条目边界——整体放弃，fail-open。
            return None
        required = tuple(_STRING_RE.findall(req_m.group(1)))
        non_empty_m = _NON_EMPTY_RE.search(body)
        non_empty = frozenset(_STRING_RE.findall(non_empty_m.group(1))) if non_empty_m else frozenset()
        # 契约自检：nonEmpty ⊆ required（manifest 头注释明文）。违反=解析错位，放弃。
        if not non_empty <= set(required):
            return None
        out[action_type] = (required, non_empty)
    return out or None


def load_required_params() -> dict[str, tuple[tuple[str, ...], frozenset[str]]] | None:
    """读取并缓存 manifest 必填集；任何失败返回 None（调用方 fail-open）。"""
    global _cache
    path = manifest_path()
    try:
        mtime = path.stat().st_mtime
    except OSError:
        return None
    if _cache is not None and _cache[0] == mtime:
        return _cache[1]
    try:
        parsed = parse_manifest_text(path.read_text(encoding="utf-8"))
    except OSError:
        parsed = None
    _cache = (mtime, parsed)
    return parsed
