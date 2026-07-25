"""「说话人实体」下拉的主角候选 + 运行时保留 id parity。

脚本台词（过场 present:showDialogue / playScriptedDialogue）的说话人常常就是主角，
但主角不在任何场景的 NPC 表里——下拉必须恒带一条 `player` 且排在最前，否则策划只能
手打（非 editable 的过场表单里根本填不进去），「跟随说话人」的立绘也就永远解析不出主角。

`player` 是运行时保留实体 id（Game.resolveActor / scriptedDialogueSpeaker），编辑器这份
候选是它的手工镜像——本文件同时锁住两侧不漂。
"""
from __future__ import annotations

import re
from pathlib import Path
from tempfile import TemporaryDirectory

from PySide6.QtWidgets import QApplication

from tools.editor.project_model import ProjectModel
from tools.editor.shared.cutscene_dialogue_speaker_row import (
    PLAYER_ENTITY_ID,
    CutsceneShowDialogueFields,
    scripted_speaker_items,
)
from tools.editor.tests.save_test_utils import write_minimal_loadable_project

REPO = Path(__file__).resolve().parents[3]


class _FakeModel:
    def __init__(self, scene_npcs, global_npcs):
        self._scene = scene_npcs
        self._global = global_npcs

    def npc_ids_for_scene(self, _scene_id):
        return list(self._scene)

    def all_npc_ids_global(self):
        return list(self._global)


def test_player_is_first_candidate_for_scene_and_global_scope() -> None:
    model = _FakeModel([("guanergou", "关二狗")], [("axiu", "阿秀")])
    scoped = scripted_speaker_items(model, "teahouse")
    assert scoped[0][0] == PLAYER_ENTITY_ID
    assert [i[0] for i in scoped] == [PLAYER_ENTITY_ID, "guanergou"]
    # 无场景上下文回退全工程时同样带主角
    fallback = scripted_speaker_items(model, None)
    assert [i[0] for i in fallback] == [PLAYER_ENTITY_ID, "axiu"]
    # 无工程也至少有主角可选
    assert [i[0] for i in scripted_speaker_items(None, None)] == [PLAYER_ENTITY_ID]


def test_player_candidate_not_duplicated_when_project_has_such_npc() -> None:
    model = _FakeModel([("player", "同名 NPC")], [])
    items = scripted_speaker_items(model, "s")
    assert items == [("player", "同名 NPC")]


def test_cutscene_show_dialogue_can_select_player_and_roundtrip() -> None:
    """过场表单里选中主角 + 「跟随说话人」立绘，to_step_dict 必须原样写出。"""
    app = QApplication.instance() or QApplication([])
    assert app is not None
    with TemporaryDirectory() as td:
        root = Path(td) / "p"
        write_minimal_loadable_project(root)
        model = ProjectModel()
        model.load_project(root)
        w = CutsceneShowDialogueFields(
            model, None, "", "先看看再说。", "", on_change=lambda: None,
            portrait={"emotion": "neutral"},
        )
        ids = [w._snpc._ids[i] for i in range(len(w._snpc._ids))]
        assert ids[0] == ""  # allow_empty 的 (none)
        assert ids[1] == PLAYER_ENTITY_ID, f"主角未排在候选首位：{ids}"
        w._snpc.set_current(PLAYER_ENTITY_ID)
        step = w.to_step_dict()
        assert step["scriptedNpcId"] == PLAYER_ENTITY_ID
        # 「跟随说话人」= 只带 emotion、不带 slug（运行时按说话人实体的装扮配置解析）
        assert step["portrait"] == {"emotion": "neutral"}


def test_runtime_reserves_the_same_player_id() -> None:
    """运行时保留 id 常量与编辑器候选是手工镜像——两侧必须是同一个字符串。"""
    ts = (REPO / "src/utils/scriptedDialogueSpeaker.ts").read_text("utf-8")
    m = re.search(r"PLAYER_ENTITY_ID\s*=\s*'([^']+)'", ts)
    assert m, "scriptedDialogueSpeaker.ts 未找到 PLAYER_ENTITY_ID 常量"
    assert m.group(1) == PLAYER_ENTITY_ID
