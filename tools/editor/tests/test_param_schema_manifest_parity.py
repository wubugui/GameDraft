"""参数级 _PARAM_SCHEMAS ↔ actionParamManifest.ts parity 护栏（FIX-1 任务 G）。

test_action_manifest_parity 只比对 action **名**集合；对抗组 V4 实证：给某 action 的
编辑器 `_PARAM_SCHEMAS` 加一个幻影**参数**（manifest 里没有的参数名）零报错——
策划能在 GUI 里编出一个运行时/校验器都不认的参数，写盘后要么被静默忽略、要么被
网页叙事校验当"多余键"打回。本测试补齐参数级双向比对。

两个方向：
- **正向（危险，本轮补的核心）**：`_PARAM_SCHEMAS[a]` 的每个参数都必须是 manifest
  已登记的参数（required ∪ nonEmpty ∪ optional）。加幻影参数即 FAIL。
- **反向（必填覆盖）**：manifest 对 schema-action 声明的每个 **required** 参数，编辑器
  要么在 `_PARAM_SCHEMAS` 里建、要么走专用表单分支（显式白名单登记）。漏建 = 策划
  填不了必填参数。

合法差异（不误报）：
- `setNarrativeState`：DEBUG_ONLY，manifest 明文不收录 → 跳过。
- manifest 的 **optional** 参数（别名 / 默认值 / 编辑器不暴露的可选项，如 playSfx.volume、
  changeScene.cameraX/Y、fadeWorld*.duration 别名）不要求出现在 `_PARAM_SCHEMAS` → 反向
  只查 required，不查 optional。
- 三个 required 列表参数走专用列表编辑器而非泛型 schema → _BESPOKE_BUILT_REQUIRED 白名单。
"""
from __future__ import annotations

import re
from pathlib import Path

from tools.editor.shared.action_editor import _PARAM_SCHEMAS, DEBUG_ONLY_ACTION_TYPES

REPO = Path(__file__).resolve().parents[3]

# manifest required 参数中、编辑器不经 _PARAM_SCHEMAS 而走专用表单分支建的（早返回分支）。
# 这些是列表/复合参数，泛型 (name, kind) schema 表达不了，各有专用子编辑器：
#   runActions.actions      → _run_actions_editor
#   chooseAction.options    → _choice_options_editor
#   addDelayedEvent.actions → _delayed_editor
# 新增此类"必填但走专用分支"的参数时在此登记并注明分支，否则反向检查会 FAIL。
_BESPOKE_BUILT_REQUIRED: set[tuple[str, str]] = {
    ("runActions", "actions"),
    ("chooseAction", "options"),
    ("addDelayedEvent", "actions"),
}


def _manifest_entries() -> dict[str, dict[str, set[str]]]:
    """解析 actionParamManifest.ts：type → {required, nonEmpty, optional} 参数集。"""
    text = (REPO / "src/core/actionParamManifest.ts").read_text("utf-8")
    entries: dict[str, dict[str, set[str]]] = {}
    for m in re.finditer(r"^\s{2}([A-Za-z][A-Za-z0-9]*)\s*:\s*\{", text, re.MULTILINE):
        name = m.group(1)
        i = m.end() - 1  # 指向 '{'
        depth = 0
        j = i
        while j < len(text):
            if text[j] == "{":
                depth += 1
            elif text[j] == "}":
                depth -= 1
                if depth == 0:
                    break
            j += 1
        block = text[i:j + 1]
        buckets: dict[str, set[str]] = {"required": set(), "nonEmpty": set(), "optional": set()}
        for key in buckets:
            km = re.search(key + r"\s*:\s*\[([^\]]*)\]", block)
            if km:
                buckets[key] = set(re.findall(r"'([^']+)'", km.group(1)))
        entries[name] = buckets
    return entries


def _schema_params() -> dict[str, set[str]]:
    return {a: {n for n, _t in rows} for a, rows in _PARAM_SCHEMAS.items()}


def test_manifest_parse_sane() -> None:
    man = _manifest_entries()
    # 抽检若干已知条目，防解析静默失效导致空对比"假通过"。
    assert man.get("giveItem", {}).get("required") == {"id"}
    assert "count" in man.get("giveItem", {}).get("optional", set())
    assert man.get("setFlag", {}).get("required") == {"key", "value"}
    assert len(man) >= 90


def test_every_schema_action_has_manifest_entry() -> None:
    man = _manifest_entries()
    schema = _schema_params()
    missing = sorted(
        a for a in schema
        if a not in man and a not in DEBUG_ONLY_ACTION_TYPES
    )
    assert not missing, (
        f"这些 action 在编辑器 _PARAM_SCHEMAS 有登记，manifest 却无条目"
        f"（网页叙事校验会当未知类型拦保存）：{missing}"
    )


def test_forward_no_phantom_editor_param() -> None:
    """正向：_PARAM_SCHEMAS 的参数不得是 manifest 未登记的幻影参数。"""
    man = _manifest_entries()
    schema = _schema_params()
    offenders: list[str] = []
    for a, params in schema.items():
        if a in DEBUG_ONLY_ACTION_TYPES or a not in man:
            continue
        known = man[a]["required"] | man[a]["nonEmpty"] | man[a]["optional"]
        phantom = params - known
        if phantom:
            offenders.append(f"{a}: {sorted(phantom)}（manifest 已知={sorted(known)}）")
    assert not offenders, (
        "编辑器 _PARAM_SCHEMAS 出现 manifest 不认的幻影参数——策划能编出运行时/校验器"
        "都不认的参数键：\n" + "\n".join(sorted(offenders))
    )


def test_reverse_required_params_are_buildable() -> None:
    """反向：manifest 对 schema-action 的 required 参数，编辑器必须能建（schema 或专用分支）。"""
    man = _manifest_entries()
    schema = _schema_params()
    offenders: list[str] = []
    for a, params in schema.items():
        if a in DEBUG_ONLY_ACTION_TYPES or a not in man:
            continue
        required = man[a]["required"] | man[a]["nonEmpty"]
        for p in sorted(required):
            if p in params:
                continue
            if (a, p) in _BESPOKE_BUILT_REQUIRED:
                continue
            offenders.append(f"{a}.{p}")
    assert not offenders, (
        "manifest 声明为必填、但编辑器 _PARAM_SCHEMAS 未建且未登记为专用分支的参数"
        "（策划在 GUI 里填不了该必填参数）：\n" + "\n".join(sorted(offenders))
        + "\n若确由专用表单分支承载，补进 _BESPOKE_BUILT_REQUIRED 并注明分支。"
    )


def test_bespoke_whitelist_entries_are_actually_required() -> None:
    """白名单卫生：_BESPOKE_BUILT_REQUIRED 的项必须确是 manifest 的 required（防白名单腐化）。"""
    man = _manifest_entries()
    stale: list[str] = []
    for a, p in sorted(_BESPOKE_BUILT_REQUIRED):
        req = man.get(a, {}).get("required", set()) | man.get(a, {}).get("nonEmpty", set())
        if p not in req:
            stale.append(f"{a}.{p}")
    assert not stale, (
        f"_BESPOKE_BUILT_REQUIRED 登记了已非 manifest-required 的过时项（该清理）：{stale}"
    )
