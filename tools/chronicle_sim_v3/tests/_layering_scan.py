"""扫描 v3 包的 import 违规。

抽出独立模块是为了让 test_layering 与 test_no_v2_import 共用，
也便于 fixture 中临时构造文件做扫描器自检（见 test_layering.py）。
"""
from __future__ import annotations

import ast
from dataclasses import dataclass, field
from pathlib import Path


@dataclass(frozen=True)
class Violation:
    file: Path
    lineno: int
    rule: str
    detail: str

    def __str__(self) -> str:
        return f"{self.file}:{self.lineno}  [{self.rule}]  {self.detail}"


@dataclass
class LayeringRules:
    forbid_v2: bool = True
    forbid_qt: bool = True
    forbid_cli_in_engine_nodes: bool = True
    forbid_three_layer_violations: bool = True


_QT_PREFIXES = ("PySide6", "PyQt5", "PyQt6", "PySide2")
_V2_PREFIXES = ("tools.chronicle_sim_v2",)

_V3 = "tools.chronicle_sim_v3."

# 三层架构方向：上层可见下层；下层不可见上层
# providers (最底)  ──> 不可 import llm/agents/engine/nodes/cli
# llm              ──> 可 import providers；不可 import agents/nodes/cli
# agents           ──> 可 import providers + llm；不可 import nodes/cli
# nodes (业务)      ──> 仅可经 services.agents 间接调用；不许 import providers / llm / agents.runners / agents.service
_THREE_LAYER_FORBIDS: dict[str, tuple[tuple[str, ...], str]] = {
    "providers": (
        ("llm", "agents", "engine", "nodes", "cli", "gui"),
        "providers_layer_violation",
    ),
    "llm": (
        ("agents", "nodes", "cli", "gui"),
        "llm_layer_violation",
    ),
    "agents": (
        ("nodes", "cli", "gui"),
        "agents_layer_violation",
    ),
}

# 例外白名单：engine 包内的『纯工具模块』允许被任何层 import。
# 这些模块没有 engine 状态、不依赖 nodes/agents/llm，本质上是 v3 内部的
# 公共基础设施（hash / yaml IO / 文件锁等）。
_ENGINE_UTIL_WHITELIST: frozenset[str] = frozenset({
    "tools.chronicle_sim_v3.engine.canonical",
    "tools.chronicle_sim_v3.engine.io",
})


def _is_qt(name: str) -> bool:
    return any(name == p or name.startswith(p + ".") for p in _QT_PREFIXES)


def _is_v2(name: str) -> bool:
    return any(name == p or name.startswith(p + ".") for p in _V2_PREFIXES)


def _is_cli_or_gui(name: str) -> bool:
    return (
        name.startswith("tools.chronicle_sim_v3.cli")
        or name.startswith("tools.chronicle_sim_v3.gui")
    )


def _v3_subpkg(name: str) -> str | None:
    """返回 'tools.chronicle_sim_v3.<sub>' 的 sub 名；非 v3 import 返回 None。"""
    if not name.startswith(_V3):
        return None
    rest = name[len(_V3):]
    return rest.split(".", 1)[0] if rest else None


def _nodes_specific_forbids(name: str) -> str | None:
    """业务节点除三层规则外的额外禁止：
    nodes/ 只能通过 services.agents 间接调；
    禁止 import providers.* / llm.* / agents.runners.* / agents.service。
    """
    sub = _v3_subpkg(name)
    if sub is None:
        return None
    if sub == "providers":
        return "nodes_imports_providers"
    if sub == "llm":
        return "nodes_imports_llm"
    if sub == "agents":
        # 节点可以 import agents.types / agents.errors（轻量数据类）；
        # 不可 import service / runners / 其它运行期组件
        if name == "tools.chronicle_sim_v3.agents":
            return "nodes_imports_agents_pkg"
        rest = name[len("tools.chronicle_sim_v3.agents.") :]
        if rest in {"types", "errors"} or rest.startswith("types.") or rest.startswith("errors."):
            return None
        return "nodes_imports_agents_internal"
    return None


def _file_layer(path: Path, v3_root: Path) -> str:
    rel = path.relative_to(v3_root)
    parts = rel.parts
    if not parts:
        return ""
    return parts[0]  # engine / llm / nodes / cli / gui / data / tests / ...


def _iter_py_files(roots: list[Path]) -> list[Path]:
    files: list[Path] = []
    for root in roots:
        if not root.exists():
            continue
        for p in root.rglob("*.py"):
            if "__pycache__" in p.parts:
                continue
            files.append(p)
    return files


def _import_names(node: ast.AST) -> list[str]:
    """从 import 语句节点抽出『目标模块名』列表。"""
    out: list[str] = []
    if isinstance(node, ast.Import):
        for a in node.names:
            out.append(a.name)
    elif isinstance(node, ast.ImportFrom):
        if node.level and node.level > 0:
            return out  # 相对 import，无法判断绝对路径，放过（隔离 lint 看绝对引用）
        if node.module:
            out.append(node.module)
    return out


def scan_files(
    files: list[Path],
    v3_root: Path,
    rules: LayeringRules | None = None,
) -> list[Violation]:
    rules = rules or LayeringRules()
    violations: list[Violation] = []
    for f in files:
        try:
            tree = ast.parse(f.read_text(encoding="utf-8"), filename=str(f))
        except SyntaxError as e:
            violations.append(Violation(f, e.lineno or 0, "syntax", str(e)))
            continue
        layer = _file_layer(f, v3_root)
        for node in ast.walk(tree):
            if not isinstance(node, (ast.Import, ast.ImportFrom)):
                continue
            for name in _import_names(node):
                if rules.forbid_v2 and _is_v2(name):
                    violations.append(Violation(f, node.lineno, "no_v2_import", name))
                if rules.forbid_qt and _is_qt(name):
                    if layer in {"engine", "llm", "nodes", "cli", "agents", "providers"}:
                        violations.append(Violation(f, node.lineno, "no_qt_in_core", name))
                if rules.forbid_cli_in_engine_nodes and layer in {"engine", "nodes", "agents", "providers", "llm"} and _is_cli_or_gui(name):
                    violations.append(
                        Violation(f, node.lineno, "no_cli_or_gui_in_engine_nodes", name)
                    )
                if rules.forbid_three_layer_violations:
                    rule = _THREE_LAYER_FORBIDS.get(layer)
                    if rule is not None:
                        forbid_subs, rule_name = rule
                        sub = _v3_subpkg(name)
                        if sub in forbid_subs and name not in _ENGINE_UTIL_WHITELIST:
                            violations.append(
                                Violation(f, node.lineno, rule_name, name)
                            )
                    if layer == "nodes":
                        rname = _nodes_specific_forbids(name)
                        if rname is not None:
                            violations.append(Violation(f, node.lineno, rname, name))
    return violations


def scan_v3_package(v3_root: Path, rules: LayeringRules | None = None) -> list[Violation]:
    """扫描 engine/ llm/ nodes/ cli/ providers/ agents/ 全部子层。"""
    targets = [
        v3_root / d
        for d in ("engine", "llm", "nodes", "cli", "providers", "agents")
    ]
    files = _iter_py_files(targets)
    return scan_files(files, v3_root, rules)
