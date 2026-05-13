"""P0-1 smoke：包结构能被导入、CLI app 能被构造。"""
from __future__ import annotations


def test_package_importable() -> None:
    import tools.chronicle_sim_v3 as v3

    assert isinstance(v3.__version__, str)
    assert v3.__version__


def test_cli_app_importable() -> None:
    from tools.chronicle_sim_v3.cli.main import app

    assert app is not None
    assert app.info.name == "csim"


def test_subapps_attached() -> None:
    from tools.chronicle_sim_v3.cli.main import app

    names = {g.name for g in app.registered_groups}
    assert {"run", "llm", "cook", "graph", "node"}.issubset(names)
