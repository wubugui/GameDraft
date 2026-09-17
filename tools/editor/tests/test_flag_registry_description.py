"""static flag 的「说明」不许在 Save All 里被无声抹掉，且编辑器里看得见、改得了。

真实事故（2026-09-16 全工程 load→Save All→逐字节比对抓到）：`flag_registry.json` 的
`static` 项里作者写了一句「引擎只读：…内容不得写入」，归一化把每项一律削成
{key, valueType} 两个键 —— 策划在编辑器里既看不到这句话（那一页没有这个字段），
按一次 Save All 还会把它从盘上删掉。而这句话正是 flag 纪律赖以传达的那一行。

这里钉三件事：归一化保住说明、Save All 往返不掉、编辑器那一页能看能改。
"""
from __future__ import annotations

import json
import os
from pathlib import Path

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
os.environ.setdefault("GAMEDRAFT_EDITOR_NO_LSP", "1")

from PySide6.QtWidgets import QApplication  # noqa: E402

from tools.editor.flag_registry import load_flag_registry  # noqa: E402
from tools.editor.project_model import ProjectModel  # noqa: E402
from tools.editor.tests.save_test_utils import write_minimal_loadable_project  # noqa: E402

DESC = "引擎只读：指定火把或环境火源正在保护玩家；内容不得写入"


def _app() -> QApplication:
    return QApplication.instance() or QApplication([])


def _write_registry(root: Path, static: list[dict]) -> Path:
    p = root / "public" / "assets" / "data" / "flag_registry.json"
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(
        json.dumps({"static": static, "patterns": [], "migrations": {}, "runtime": {}},
                   ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    return p


def test_migrate_keeps_description(tmp_path: Path) -> None:
    p = _write_registry(tmp_path, [
        {"key": "player_fire_protected", "valueType": "bool", "description": DESC},
        {"key": "plain_one", "valueType": "float"},
        {"key": "blank_desc", "valueType": "bool", "description": "   "},
        {"key": "bad_desc", "valueType": "bool", "description": 7},
    ])
    static = {e["key"]: e for e in load_flag_registry(p)["static"]}
    assert static["player_fire_protected"]["description"] == DESC
    assert "description" not in static["plain_one"]
    # 空白 / 非字符串不落键：免得盘上留下一堆 "description": "" 的噪音
    assert "description" not in static["blank_desc"]
    assert "description" not in static["bad_desc"]


def test_save_all_roundtrip_keeps_description(tmp_path: Path) -> None:
    _app()
    proj = tmp_path / "proj"
    write_minimal_loadable_project(proj)
    reg_path = _write_registry(proj, [{"key": "player_fire_protected", "valueType": "bool",
                                       "description": DESC}])
    model = ProjectModel()
    model.load_project(proj)
    model.mark_dirty("flag_registry")
    model.save_all()
    back = json.loads(reg_path.read_text("utf-8"))
    assert back["static"] == [{"key": "player_fire_protected", "valueType": "bool",
                              "description": DESC}]


def test_editor_shows_and_edits_description(tmp_path: Path) -> None:
    _app()
    from tools.editor.editors.flag_registry_editor import FlagRegistryEditor

    proj = tmp_path / "proj"
    write_minimal_loadable_project(proj)
    reg_path = _write_registry(proj, [
        {"key": "player_fire_protected", "valueType": "bool", "description": DESC},
        {"key": "torch_lit", "valueType": "bool"},
    ])
    model = ProjectModel()
    model.load_project(proj)
    ed = FlagRegistryEditor(model)
    ed.refresh_views()

    # 选中带说明的：那一行字要显示出来（策划看得见才不会当它不存在）
    assert ed.select_by_id("player_fire_protected")
    assert ed._static_desc.isEnabled()
    assert ed._static_desc.text() == DESC

    # 换一条没说明的：框子要跟着空掉，不能留着上一条的字（否则一敲就串到别的 flag 上）
    assert ed.select_by_id("torch_lit")
    assert ed._static_desc.text() == ""

    # 改：逐键落模型 + 标脏，敲完立刻 Save All 也不丢
    model._dirty.clear()
    ed._static_desc.setText("引擎只读：手上那根点着没有")
    ed._on_static_desc_edited(ed._static_desc.text())
    assert model.flag_registry["static"][1]["description"] == "引擎只读：手上那根点着没有"
    assert "flag_registry" in model._dirty

    model.save_all()
    back = {e["key"]: e for e in json.loads(reg_path.read_text("utf-8"))["static"]}
    assert back["torch_lit"]["description"] == "引擎只读：手上那根点着没有"
    assert back["player_fire_protected"]["description"] == DESC

    # 清空 = 不写这个键（别在盘上留空字符串）
    ed._static_desc.setText("")
    ed._on_static_desc_edited("")
    assert "description" not in model.flag_registry["static"][1]

    # 多选时不可改：否则一敲字只会落到其中一条上，另一条看着像没保存
    ed._static_list.selectAll()
    ed._sync_static_type_ui()
    assert not ed._static_desc.isEnabled()
    assert ed._static_desc.text() == ""
