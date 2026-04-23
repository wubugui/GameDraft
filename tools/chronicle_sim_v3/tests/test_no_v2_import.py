"""单挑 v2 import 检测，便于 CI 单独跑。"""
from __future__ import annotations

from pathlib import Path

from tools.chronicle_sim_v3.tests._layering_scan import (
    LayeringRules,
    scan_v3_package,
)

_V3_ROOT = Path(__file__).resolve().parents[1]


def test_no_v2_import_anywhere() -> None:
    """v3 任何文件都不许 import tools.chronicle_sim_v2.*。"""
    rules = LayeringRules(forbid_v2=True, forbid_qt=False, forbid_cli_in_engine_nodes=False)
    vios = scan_v3_package(_V3_ROOT, rules)
    only_v2 = [v for v in vios if v.rule == "no_v2_import"]
    assert not only_v2, "v2 import 违规：\n" + "\n".join(str(v) for v in only_v2)
