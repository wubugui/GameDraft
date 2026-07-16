"""必填参数解析 parity 护栏（审查 P1-10）。

叙事编辑器 Python 兜底校验的必填集必须从 TS 权威 actionParamManifest.ts 解析，且
**绝不比 TS 更严**（narrative-state-editor 机制卡红线：Python 兜底 ⊆ TS 权威）。
此前把 _PARAM_SCHEMAS（GUI 控件清单）整表当必填，比 TS 严 25 处、拦死合法最小形态。

本测试锁定：
1. 解析器能从真实 manifest 解析出条目（非空、覆盖 ACTION_TYPES 里有 handler 的类型）；
2. 「Python required ⊆ TS required」语义——用**独立**正则从 manifest 再抽一份 TS 必填集
   比对，防解析器凭空多要参数；nonEmpty ⊆ required；
3. 解析失败时 fail-open（返回 None，调用方不做必填拦截）。
"""
from __future__ import annotations

import re
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]
MANIFEST = REPO / "src/core/actionParamManifest.ts"


def _independent_ts_required() -> dict[str, tuple[set[str], set[str]]]:
    """独立于被测模块，从 manifest 直接抽 {action: (required 集合, nonEmpty 集合)}。"""
    text = MANIFEST.read_text(encoding="utf-8")
    text = re.sub(r"/\*.*?\*/", "", text, flags=re.DOTALL)
    text = re.sub(r"//[^\n]*", "", text)
    start = text.find("{", text.find("ACTION_PARAM_MANIFEST"))
    end = text.find("\n};", start)
    section = text[start:end]
    out: dict[str, tuple[set[str], set[str]]] = {}
    for m in re.finditer(r"^\x20{2}([A-Za-z][A-Za-z0-9]*)\s*:\s*\{(.*?)\}", section, re.MULTILINE | re.DOTALL):
        name, body = m.group(1), m.group(2)
        req_m = re.search(r"\brequired\s*:\s*\[(.*?)\]", body, re.DOTALL)
        ne_m = re.search(r"\bnonEmpty\s*:\s*\[(.*?)\]", body, re.DOTALL)
        required = set(re.findall(r"['\"]([^'\"]+)['\"]", req_m.group(1))) if req_m else set()
        non_empty = set(re.findall(r"['\"]([^'\"]+)['\"]", ne_m.group(1))) if ne_m else set()
        out[name] = (required, non_empty)
    return out


def test_parser_returns_entries() -> None:
    from tools.editor.shared.narrative_required_params import load_required_params

    parsed = load_required_params()
    assert parsed is not None, "解析器应能从真实 manifest 解析出必填集"
    # 抽样几个已知条目（值以 actionParamManifest.ts 为准）
    assert parsed["giveItem"][0] == ("id",)
    assert set(parsed["setFlag"][0]) == {"key", "value"}
    assert parsed["setFlag"][1] == frozenset({"key"})
    # 全可选形态：required 为空（历史误当必填的典型）
    assert parsed["waitMs"][0] == ()
    assert parsed["stopSceneAmbient"][0] == ()


def test_python_required_is_subset_of_ts_required() -> None:
    """Python 兜底 ⊆ TS 权威：解析出的必填集不得超过独立抽取的 TS 必填集。"""
    from tools.editor.shared.narrative_required_params import load_required_params

    parsed = load_required_params()
    assert parsed is not None
    ts = _independent_ts_required()
    for action, (required, non_empty) in parsed.items():
        assert action in ts, f"解析出 manifest 没有的 action：{action}"
        ts_required, ts_non_empty = ts[action]
        assert set(required) <= ts_required, (
            f"{action}: Python 必填 {set(required)} 超出 TS 必填 {ts_required}（红线倒挂）"
        )
        assert set(non_empty) <= ts_non_empty, f"{action}: nonEmpty 超出 TS"
        assert set(non_empty) <= set(required), f"{action}: nonEmpty 不是 required 子集"


def test_covers_editor_action_types_with_manifest() -> None:
    """编辑器 ACTION_TYPES 里非 DEBUG_ONLY 的类型都应能从 manifest 拿到必填集。"""
    from tools.editor.shared.action_editor import ACTION_TYPES, DEBUG_ONLY_ACTION_TYPES
    from tools.editor.shared.narrative_required_params import load_required_params

    parsed = load_required_params()
    assert parsed is not None
    exempt = {str(x) for x in DEBUG_ONLY_ACTION_TYPES}
    missing = sorted({str(a) for a in ACTION_TYPES} - set(parsed) - exempt)
    assert not missing, f"这些编辑器 action 在 manifest 解析结果里缺失：{missing}"


def test_fail_open_on_unparseable() -> None:
    from tools.editor.shared.narrative_required_params import parse_manifest_text

    assert parse_manifest_text("") is None
    assert parse_manifest_text("const X = 1;") is None
    # 结构缺 required 键 → 解析放弃（返回 None），调用方 fail-open
    broken = "export const ACTION_PARAM_MANIFEST = {\n  foo: { optional: ['a'] },\n};\n"
    assert parse_manifest_text(broken) is None
