"""从四个权威源**只读**提取 JSON 数据语言的"语法"。

设计铁律(见 README):生成方向只能是 代码→schema。本模块绝不 import 任何
运行时/编辑器模块(action_editor.py 模块级 import Qt,headless import 有副作用)——
Python 权威一律 ast 静态解析,TS 权威一律文本解析。

权威源:
1. tools/editor/shared/action_editor.py   → ACTION_TYPES / _PARAM_SCHEMAS(控件类型)
2. src/core/actionParamManifest.ts        → ACTION_PARAM_MANIFEST(required/optional 唯一权威)
3. tools/editor/shared/entity_refactor.py → ENTITY_REF_PARAMS(哪个参数是实体/场景/出生点引用)
4. src/systems/graphDialogue/evaluateGraphCondition.ts + src/data/types.ts
                                          → 条件叶子清单(ConditionTrace kind 联合)/枚举字面量

任何提取失败都 raise(权威源改形状=镜子必须跟着改,静默降级只会产出错误 schema);
"权威之间打架"不 raise,记入 warnings 由 summary 呈现。
"""

from __future__ import annotations

import ast
import json
import re
from dataclasses import dataclass, field
from pathlib import Path

ACTION_EDITOR_PY = "tools/editor/shared/action_editor.py"
ENTITY_REFACTOR_PY = "tools/editor/shared/entity_refactor.py"
ACTION_MANIFEST_TS = "src/core/actionParamManifest.ts"
EVAL_CONDITION_TS = "src/systems/graphDialogue/evaluateGraphCondition.ts"
TYPES_TS = "src/data/types.ts"

# ConditionTrace 里非叶子的 kind;剩下的就是条件叶子清单(机器可校验锚点)
_NON_LEAF_TRACE_KINDS = {"all", "any", "not", "unknown"}
# 本工具已建模的叶子;提取出新 kind → warning "有新条件叶子,json_lang 需要跟进"
_MODELED_LEAVES = {"flag", "quest", "scenario", "scenarioLine", "narrative", "plane"}
# ENTITY_REF_PARAMS 已知 kind;出现新 kind → warning
_KNOWN_REF_KINDS = {
    "actor", "emote_subject", "npc", "npc_soft", "owner",
    "scene", "scene_hint", "spawn", "scene_entity", "scene_hotspot", "scene_zone",
}


@dataclass
class LanguageSpec:
    """提取结果:JSON 数据语言的语法快照。"""

    action_types: list[str]
    debug_only_action_types: set[str]
    legacy_action_types: set[str]
    # type → [(param, widget_kind)]
    param_schemas: dict[str, list[tuple[str, str]]]
    # type → {required, nonEmpty?, optional?}
    param_manifest: dict[str, dict[str, list[str]]]
    # type → {param: ref_kind}
    entity_ref_params: dict[str, dict[str, str]]
    condition_leaves: list[str]
    quest_statuses: list[str]
    scenario_line_statuses: list[str]
    flag_ops: list[str]
    warnings: list[str] = field(default_factory=list)


# --------------------------------------------------------------------------- #
# Python 权威:ast 静态解析(零 import 副作用)
# --------------------------------------------------------------------------- #

def _py_toplevel_literal(source: str, name: str, path: str):
    """取模块顶层 `name = <字面量>` / `name: T = <字面量>` 的值。"""
    tree = ast.parse(source)
    for node in tree.body:
        target = None
        if isinstance(node, ast.Assign) and len(node.targets) == 1:
            target = node.targets[0]
        elif isinstance(node, ast.AnnAssign):
            target = node.target
        if isinstance(target, ast.Name) and target.id == name and node.value is not None:
            return ast.literal_eval(node.value)
    raise ValueError(f"{path} 中找不到顶层字面量 {name}(权威源改形状了,extract.py 需要跟进)")


# --------------------------------------------------------------------------- #
# TS 权威:文本解析
# --------------------------------------------------------------------------- #

def _strip_line_comments(text: str) -> str:
    return re.sub(r"//[^\n]*", "", text)


def _braced_block_after(text: str, anchor: str, path: str) -> str:
    """anchor 之后第一个 { 起、括号配平的整块(先剥行注释再配平)。"""
    idx = text.find(anchor)
    if idx < 0:
        raise ValueError(f"{path} 中找不到锚点 {anchor!r}")
    rest = _strip_line_comments(text[idx:])
    start = rest.find("{")
    if start < 0:
        raise ValueError(f"{path} 锚点 {anchor!r} 后没有 {{")
    depth = 0
    for k in range(start, len(rest)):
        c = rest[k]
        if c == "{":
            depth += 1
        elif c == "}":
            depth -= 1
            if depth == 0:
                return rest[start:k + 1]
    raise ValueError(f"{path} 锚点 {anchor!r} 后括号不配平")


def _ts_object_literal_to_json(block: str):
    """把无函数、无嵌套模板串的 TS 对象字面量转 JSON。仅覆盖 manifest 这种简单形状。"""
    s = block
    s = re.sub(r"([{,]\s*)([A-Za-z_$][\w$]*)\s*:", r'\1"\2":', s)
    s = re.sub(r"'([^'\\\n]*)'", lambda m: json.dumps(m.group(1), ensure_ascii=False), s)
    s = re.sub(r",(\s*[}\]])", r"\1", s)
    return json.loads(s)


def extract_action_manifest(root: Path) -> dict[str, dict[str, list[str]]]:
    path = root / ACTION_MANIFEST_TS
    text = path.read_text(encoding="utf-8")
    block = _braced_block_after(text, "export const ACTION_PARAM_MANIFEST", ACTION_MANIFEST_TS)
    raw = _ts_object_literal_to_json(block)
    out: dict[str, dict[str, list[str]]] = {}
    for t, entry in raw.items():
        if not isinstance(entry, dict) or "required" not in entry:
            raise ValueError(f"{ACTION_MANIFEST_TS} 条目 {t} 形状异常: {entry!r}")
        out[t] = {
            "required": list(entry.get("required") or []),
            "nonEmpty": list(entry.get("nonEmpty") or []),
            "optional": list(entry.get("optional") or []),
        }
    return out


def extract_condition_language(root: Path) -> tuple[list[str], list[str], list[str], list[str], list[str]]:
    """→ (叶子清单, quest 状态, scenarioLine 状态, flag op, warnings)"""
    warnings: list[str] = []
    text = (root / EVAL_CONDITION_TS).read_text(encoding="utf-8")

    kinds = re.findall(r"kind:\s*'(\w+)';", text)
    if not kinds:
        raise ValueError(f"{EVAL_CONDITION_TS} 提不到 ConditionTrace kind 联合")
    leaves = [k for k in dict.fromkeys(kinds) if k not in _NON_LEAF_TRACE_KINDS]
    unmodeled = set(leaves) - _MODELED_LEAVES
    if unmodeled:
        warnings.append(
            f"发现未建模的条件叶子 {sorted(unmodeled)}(ConditionTrace 新增 kind)——"
            f"json_lang/schema_build.py 需要跟进,当前 schema 对其不做校验"
        )
    missing = _MODELED_LEAVES - set(leaves)
    if missing:
        warnings.append(f"已建模叶子 {sorted(missing)} 在 ConditionTrace 中消失——确认是否已删除该条件类型")

    m = re.search(r"SCENARIO_LINE_STATUSES\s*=\s*new Set[^(]*\(\[([^\]]*)\]", text, re.S)
    if not m:
        raise ValueError(f"{EVAL_CONDITION_TS} 提不到 SCENARIO_LINE_STATUSES")
    line_statuses = re.findall(r"'(\w+)'", m.group(1))

    m = re.search(r"const questStatusMap[^=]*=\s*\{(.*?)\}", text, re.S)
    if not m:
        raise ValueError(f"{EVAL_CONDITION_TS} 提不到 questStatusMap")
    quest_statuses = re.findall(r"(\w+):\s*QuestStatus", m.group(1))

    types_text = (root / TYPES_TS).read_text(encoding="utf-8")
    m = re.search(r"export interface Condition\s*\{(.*?)\n\}", types_text, re.S)
    if not m:
        raise ValueError(f"{TYPES_TS} 提不到 interface Condition")
    op_line = re.search(r"op\?:\s*([^;]+);", m.group(1))
    if not op_line:
        raise ValueError(f"{TYPES_TS} Condition 里提不到 op 联合")
    flag_ops = re.findall(r"'([^']+)'", op_line.group(1))

    return leaves, quest_statuses, line_statuses, flag_ops, warnings


# --------------------------------------------------------------------------- #
# 汇总 + 权威对账 tripwire
# --------------------------------------------------------------------------- #

def extract_language_spec(root: Path) -> LanguageSpec:
    editor_src = (root / ACTION_EDITOR_PY).read_text(encoding="utf-8")
    action_types = _py_toplevel_literal(editor_src, "ACTION_TYPES", ACTION_EDITOR_PY)
    debug_only = set(_py_toplevel_literal(editor_src, "DEBUG_ONLY_ACTION_TYPES", ACTION_EDITOR_PY))
    legacy = set(_py_toplevel_literal(editor_src, "LEGACY_ACTION_TYPES", ACTION_EDITOR_PY))
    param_schemas_raw = _py_toplevel_literal(editor_src, "_PARAM_SCHEMAS", ACTION_EDITOR_PY)
    param_schemas = {t: [tuple(p) for p in pairs] for t, pairs in param_schemas_raw.items()}

    refactor_src = (root / ENTITY_REFACTOR_PY).read_text(encoding="utf-8")
    entity_ref_params = _py_toplevel_literal(refactor_src, "ENTITY_REF_PARAMS", ENTITY_REFACTOR_PY)

    manifest = extract_action_manifest(root)
    leaves, quest_statuses, line_statuses, flag_ops, warnings = extract_condition_language(root)

    # tripwire 1:manifest ∪ DEBUG_ONLY 应恰好等于 ACTION_TYPES(setNarrativeState 特例见 manifest 头注释)
    at, mk = set(action_types), set(manifest)
    only_editor = at - mk - debug_only
    only_manifest = mk - at
    if only_editor:
        warnings.append(f"ACTION_TYPES 有而 manifest 没有的动作 {sorted(only_editor)}——参数 required 无权威,schema 按全可选处理")
    if only_manifest:
        warnings.append(f"manifest 有而 ACTION_TYPES 没有的动作 {sorted(only_manifest)}——编辑器未登记,仍纳入 schema 枚举")

    # tripwire 2:ENTITY_REF_PARAMS 出现新 ref kind
    kinds_seen = {k for m in entity_ref_params.values() for k in m.values()}
    new_kinds = kinds_seen - _KNOWN_REF_KINDS
    if new_kinds:
        warnings.append(f"ENTITY_REF_PARAMS 出现未知引用 kind {sorted(new_kinds)}——schema_build 的宇宙映射需要跟进")

    return LanguageSpec(
        action_types=list(action_types),
        debug_only_action_types=debug_only,
        legacy_action_types=legacy,
        param_schemas=param_schemas,
        param_manifest=manifest,
        entity_ref_params={t: dict(m) for t, m in entity_ref_params.items()},
        condition_leaves=leaves,
        quest_statuses=quest_statuses,
        scenario_line_statuses=line_statuses,
        flag_ops=flag_ops,
        warnings=warnings,
    )
