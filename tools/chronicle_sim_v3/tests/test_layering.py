"""P0-2 层级隔离 lint。

扫描 v3 包：
- engine/ llm/ nodes/ cli/ 不许 import PySide6 / PyQt
- 整包不许 import tools.chronicle_sim_v2.*
- engine/ nodes/ 不许 import cli/ gui/

用 ast 解析，实现见 _layering_scan.py。
"""
from __future__ import annotations

import textwrap
from pathlib import Path

import pytest

from tools.chronicle_sim_v3.tests._layering_scan import (
    LayeringRules,
    scan_files,
    scan_v3_package,
)

_V3_ROOT = Path(__file__).resolve().parents[1]


def test_real_v3_package_clean() -> None:
    """真实代码不应有任何隔离违规。"""
    vios = scan_v3_package(_V3_ROOT)
    assert not vios, "隔离违规：\n" + "\n".join(str(v) for v in vios)


def _write(p: Path, text: str) -> None:
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(textwrap.dedent(text).lstrip(), encoding="utf-8")


def test_scanner_catches_v2_import(tmp_path: Path) -> None:
    fake_root = tmp_path / "v3"
    f = fake_root / "engine" / "bad.py"
    _write(f, "from tools.chronicle_sim_v2.core.llm import cline_runner\n")
    vios = scan_files([f], fake_root)
    assert any(v.rule == "no_v2_import" for v in vios)


def test_scanner_catches_qt_in_engine(tmp_path: Path) -> None:
    fake_root = tmp_path / "v3"
    f = fake_root / "engine" / "bad.py"
    _write(f, "import PySide6.QtCore\n")
    vios = scan_files([f], fake_root)
    assert any(v.rule == "no_qt_in_core" for v in vios)


def test_scanner_catches_qt_in_llm(tmp_path: Path) -> None:
    fake_root = tmp_path / "v3"
    f = fake_root / "llm" / "bad.py"
    _write(f, "from PyQt5.QtCore import QObject\n")
    vios = scan_files([f], fake_root)
    assert any(v.rule == "no_qt_in_core" for v in vios)


def test_scanner_catches_cli_in_engine(tmp_path: Path) -> None:
    fake_root = tmp_path / "v3"
    f = fake_root / "engine" / "bad.py"
    _write(f, "from tools.chronicle_sim_v3.cli import main\n")
    vios = scan_files([f], fake_root)
    assert any(v.rule == "no_cli_or_gui_in_engine_nodes" for v in vios)


def test_scanner_catches_gui_in_nodes(tmp_path: Path) -> None:
    fake_root = tmp_path / "v3"
    f = fake_root / "nodes" / "bad.py"
    _write(f, "import tools.chronicle_sim_v3.gui.main_window\n")
    vios = scan_files([f], fake_root)
    assert any(v.rule == "no_cli_or_gui_in_engine_nodes" for v in vios)


def test_scanner_allows_engine_self_import(tmp_path: Path) -> None:
    fake_root = tmp_path / "v3"
    f = fake_root / "engine" / "ok.py"
    _write(f, "from tools.chronicle_sim_v3.engine import canonical\n")
    vios = scan_files([f], fake_root)
    assert not vios


def test_scanner_allows_qt_in_data_or_tests(tmp_path: Path) -> None:
    fake_root = tmp_path / "v3"
    # tests/ 不在四层名单里，可以 import Qt（GUI 测试将来需要）
    f = fake_root / "tests" / "ok.py"
    _write(f, "from PySide6.QtCore import Qt\n")
    vios = scan_files([f], fake_root)
    assert not vios


def test_relative_import_ignored(tmp_path: Path) -> None:
    fake_root = tmp_path / "v3"
    f = fake_root / "engine" / "ok.py"
    _write(f, "from . import canonical\n")
    vios = scan_files([f], fake_root)
    assert not vios


def test_scanner_catches_providers_imports_llm(tmp_path: Path) -> None:
    fake_root = tmp_path / "v3"
    f = fake_root / "providers" / "bad.py"
    _write(f, "from tools.chronicle_sim_v3.llm import service\n")
    vios = scan_files([f], fake_root)
    assert any(v.rule == "providers_layer_violation" for v in vios)


def test_scanner_catches_providers_imports_agents(tmp_path: Path) -> None:
    fake_root = tmp_path / "v3"
    f = fake_root / "providers" / "bad.py"
    _write(f, "from tools.chronicle_sim_v3.agents import service\n")
    vios = scan_files([f], fake_root)
    assert any(v.rule == "providers_layer_violation" for v in vios)


def test_scanner_catches_llm_imports_agents(tmp_path: Path) -> None:
    fake_root = tmp_path / "v3"
    f = fake_root / "llm" / "bad.py"
    _write(f, "from tools.chronicle_sim_v3.agents import service\n")
    vios = scan_files([f], fake_root)
    assert any(v.rule == "llm_layer_violation" for v in vios)


def test_scanner_allows_llm_imports_providers(tmp_path: Path) -> None:
    fake_root = tmp_path / "v3"
    f = fake_root / "llm" / "ok.py"
    _write(f, "from tools.chronicle_sim_v3.providers import service\n")
    vios = scan_files([f], fake_root)
    assert not vios


def test_scanner_allows_agents_imports_llm_and_providers(tmp_path: Path) -> None:
    fake_root = tmp_path / "v3"
    f = fake_root / "agents" / "ok.py"
    _write(
        f,
        "from tools.chronicle_sim_v3.llm import service\n"
        "from tools.chronicle_sim_v3.providers import service as ps\n",
    )
    vios = scan_files([f], fake_root)
    assert not vios


def test_scanner_catches_nodes_imports_providers(tmp_path: Path) -> None:
    fake_root = tmp_path / "v3"
    f = fake_root / "nodes" / "bad.py"
    _write(f, "from tools.chronicle_sim_v3.providers import service\n")
    vios = scan_files([f], fake_root)
    assert any(v.rule == "nodes_imports_providers" for v in vios)


def test_scanner_catches_nodes_imports_llm(tmp_path: Path) -> None:
    fake_root = tmp_path / "v3"
    f = fake_root / "nodes" / "bad.py"
    _write(f, "from tools.chronicle_sim_v3.llm import service\n")
    vios = scan_files([f], fake_root)
    assert any(v.rule == "nodes_imports_llm" for v in vios)


def test_scanner_catches_nodes_imports_agents_runners(tmp_path: Path) -> None:
    fake_root = tmp_path / "v3"
    f = fake_root / "nodes" / "bad.py"
    _write(f, "from tools.chronicle_sim_v3.agents.runners import cline\n")
    vios = scan_files([f], fake_root)
    assert any(v.rule == "nodes_imports_agents_internal" for v in vios)


def test_scanner_allows_nodes_imports_agents_types(tmp_path: Path) -> None:
    fake_root = tmp_path / "v3"
    f = fake_root / "nodes" / "ok.py"
    _write(
        f,
        "from tools.chronicle_sim_v3.agents.types import AgentRef\n"
        "from tools.chronicle_sim_v3.agents.errors import AgentError\n",
    )
    vios = scan_files([f], fake_root)
    assert not vios


def test_scanner_allows_engine_util_whitelist_in_providers(tmp_path: Path) -> None:
    fake_root = tmp_path / "v3"
    f = fake_root / "providers" / "ok.py"
    _write(
        f,
        "import tools.chronicle_sim_v3.engine.canonical\n"
        "import tools.chronicle_sim_v3.engine.io\n",
    )
    vios = scan_files([f], fake_root)
    assert not vios


def test_rules_can_disable(tmp_path: Path) -> None:
    fake_root = tmp_path / "v3"
    f = fake_root / "engine" / "bad.py"
    _write(f, "import PySide6\n")
    vios = scan_files([f], fake_root, LayeringRules(forbid_qt=False))
    assert not vios
