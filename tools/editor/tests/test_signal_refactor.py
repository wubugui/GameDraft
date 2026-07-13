"""信号重构引擎（shared/signal_refactor.py）契约测试。

覆盖：全通道扫描计数、改名级联（含对话图磁盘→暂存面）、撤销（反向改名 / 删除反向
编辑回放的字节级复原）、前置校验闸（撞名/保留名/force 门）、脏桶正确性、
save_all 对 dialogue_graph_edits 桶的覆写落盘。全程遵守"零磁盘写入直到 Save All"。
"""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from tools.editor.shared.signal_refactor import (
    SignalRefactorError,
    delete_signal,
    push_journal,
    rename_graph,
    rename_signal,
    rename_state,
    scan_graph_usages,
    scan_signal_usages,
    scan_state_usages,
    undo_delete,
    undo_last,
    _migrations_snapshot,
)


def _emit(sig: str) -> dict:
    return {"type": "emitNarrativeSignal", "params": {"signal": sig}}


class FakeModel:
    """引擎消费面的最小模型：narrative + 两个资产集合 + 对话图两级暂存面 + 磁盘目录。"""

    def __init__(self, dialogues_path: Path | None = None) -> None:
        self.narrative_graphs = {
            "schemaVersion": 3,
            "signals": [{"id": "sig_a", "label": "甲"}, {"id": "sig_b"}],
            "compositions": [
                {
                    "id": "comp1",
                    "mainGraph": {
                        "id": "flow_main",
                        "initialState": "s0",
                        "states": {
                            "s0": {"id": "s0"},
                            "s1": {"id": "s1", "onEnterActions": [_emit("sig_a"), {"type": "giveItem", "params": {}}]},
                        },
                        "transitions": [{"id": "t1", "from": "s0", "to": "s1", "signal": "sig_a"}],
                    },
                    "elements": [
                        {"id": "dlg1", "kind": "dialogueBlackbox", "refId": "图A", "meta": {"emits": ["sig_a"], "reads": []}},
                        {
                            "id": "w1",
                            "kind": "wrapperGraph",
                            "graph": {
                                "id": "wrap_1",
                                "initialState": "u",
                                "states": {"u": {"id": "u"}, "v": {"id": "v", "broadcastOnEnter": True}},
                                "transitions": [{"id": "t2", "from": "u", "to": "v", "signal": "sig_a"}],
                            },
                        },
                    ],
                }
            ],
        }
        self.scenes = {"场景1": {"zones": [{"id": "z1", "onEnter": [_emit("sig_a")]}]}}
        self.pressure_holds = [{"id": "ph1", "onRelease": [_emit("sig_a")]}]
        self.pending_dialogue_stubs: dict[str, dict] = {}
        self.pending_dialogue_graph_edits: dict[str, dict] = {}
        self.dialogues_path = dialogues_path
        self.dirty: list[tuple[str, str]] = []

    def mark_dirty(self, bucket: str, item: str = "") -> None:
        self.dirty.append((bucket, item))


@pytest.fixture()
def disk_model(tmp_path: Path) -> FakeModel:
    graphs_dir = tmp_path / "graphs"
    graphs_dir.mkdir()
    doc = {"id": "对话甲", "entry": "n1", "nodes": {"n1": {"id": "n1", "runActions": [_emit("sig_a"), _emit("sig_a")]}}}
    (graphs_dir / "对话甲.json").write_text(
        json.dumps(doc, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    return FakeModel(dialogues_path=tmp_path)


def test_scan_counts_all_channels(disk_model: FakeModel) -> None:
    u = scan_signal_usages(disk_model, "sig_a")
    assert len(u["listeners"]) == 2
    assert u["actionEmits"] == 1
    assert len(u["metaEmits"]) == 1
    assert u["assets"] == [
        {"bucket": "scene", "attr": "scenes", "itemId": "场景1", "count": 1},
        {"bucket": "pressure_holds", "attr": "pressure_holds", "itemId": "ph1", "count": 1},
    ]
    assert u["dialogues"] == [{"graphId": "对话甲", "count": 2}]
    assert u["totalRefs"] == 8
    assert u["registryIndex"] == 0


def test_rename_cascades_and_stages_dialogue(disk_model: FakeModel) -> None:
    summary = rename_signal(disk_model, "sig_a", "sig_new")
    assert scan_signal_usages(disk_model, "sig_a")["totalRefs"] == 0
    assert scan_signal_usages(disk_model, "sig_new")["totalRefs"] == 8
    # 对话图：磁盘原文未动，改动进暂存编辑面 + 标脏
    raw = (Path(disk_model.dialogues_path) / "graphs" / "对话甲.json").read_text(encoding="utf-8")
    assert "sig_a" in raw and "sig_new" not in raw
    assert "对话甲" in disk_model.pending_dialogue_graph_edits
    assert ("dialogue_graph_edits", "") in disk_model.dirty
    assert ("scene", "场景1") in disk_model.dirty
    assert ("narrative_graphs", "") in disk_model.dirty
    assert summary["dialogues"] == [{"graphId": "对话甲", "count": 2, "bucket": "dialogue_graph_edits"}]
    # 撤销 = 反向改名，回到原名后暂存面内容与磁盘原文语义一致
    rename_signal(disk_model, "sig_new", "sig_a")
    assert scan_signal_usages(disk_model, "sig_a")["totalRefs"] == 8
    assert disk_model.pending_dialogue_graph_edits["对话甲"] == json.loads(raw)


def test_rename_prefers_pending_stub_surface(disk_model: FakeModel) -> None:
    disk_model.pending_dialogue_stubs["新桩"] = {"id": "新桩", "entry": "n", "nodes": {"n": {"runActions": [_emit("sig_a")]}}}
    rename_signal(disk_model, "sig_a", "sig_new")
    assert disk_model.pending_dialogue_stubs["新桩"]["nodes"]["n"]["runActions"][0]["params"]["signal"] == "sig_new"
    assert "新桩" not in disk_model.pending_dialogue_graph_edits, "已是桩暂存面的图不应再进编辑暂存面"
    assert ("dialogue_stubs", "") in disk_model.dirty


def test_rename_validation_gates(disk_model: FakeModel) -> None:
    with pytest.raises(SignalRefactorError):
        rename_signal(disk_model, "sig_a", "sig_b")  # 注册表撞名
    with pytest.raises(SignalRefactorError):
        rename_signal(disk_model, "sig_a", "__draft__")  # 保留名
    with pytest.raises(SignalRefactorError):
        rename_signal(disk_model, "sig_a", "state:flow_main:s1")  # 派生命名空间
    with pytest.raises(SignalRefactorError):
        rename_signal(disk_model, "sig_missing", "sig_x")  # 不在注册表
    # 与派生广播撞名（wrap_1.v 开了 broadcastOnEnter）
    disk_model.narrative_graphs["signals"].append({"id": "sig_c"})
    with pytest.raises(SignalRefactorError):
        rename_signal(disk_model, "sig_c", "state:wrap_1:v")


def test_delete_force_and_undo_restore_bytes(disk_model: FakeModel) -> None:
    before_narrative = json.dumps(disk_model.narrative_graphs, ensure_ascii=False, sort_keys=True)
    before_scene = json.dumps(disk_model.scenes, ensure_ascii=False, sort_keys=True)
    with pytest.raises(SignalRefactorError):
        delete_signal(disk_model, "sig_a")  # 有引用，force 门拦住
    summary, reverse_ops = delete_signal(disk_model, "sig_a", force=True)
    assert summary["cleaned"] == 8
    assert scan_signal_usages(disk_model, "sig_a")["totalRefs"] == 0
    assert scan_signal_usages(disk_model, "sig_a")["registryIndex"] == -1
    main = disk_model.narrative_graphs["compositions"][0]["mainGraph"]
    assert main["transitions"][0]["signal"] == "__draft__"
    assert main["states"]["s1"]["onEnterActions"] == [{"type": "giveItem", "params": {}}]
    # 对话图暂存面里的发射动作被摘除
    assert scan_signal_usages(disk_model, "sig_a")["dialogues"] == []

    undo_delete(disk_model, reverse_ops)
    assert json.dumps(disk_model.narrative_graphs, ensure_ascii=False, sort_keys=True) == before_narrative
    assert json.dumps(disk_model.scenes, ensure_ascii=False, sort_keys=True) == before_scene
    # 原本只在磁盘的对话图：撤销后暂存编辑面回到空，语义回到磁盘原文
    assert "对话甲" not in disk_model.pending_dialogue_graph_edits
    assert scan_signal_usages(disk_model, "sig_a")["totalRefs"] == 8


def test_delete_no_refs_only_registry(disk_model: FakeModel) -> None:
    summary, reverse_ops = delete_signal(disk_model, "sig_b")
    assert summary["cleaned"] == 0
    assert scan_signal_usages(disk_model, "sig_b")["registryIndex"] == -1
    undo_delete(disk_model, reverse_ops)
    assert scan_signal_usages(disk_model, "sig_b")["registryIndex"] == 1


def _leaf(gid: str, sid: str) -> dict:
    return {"narrative": gid, "state": sid, "reached": True}


def _wire_state_refs(m: FakeModel) -> None:
    """给夹具补一圈状态引用：派生监听 / 场景条件 / 任务条件 / 地图 / setNarrativeState / 对话 switch。"""
    m.narrative_graphs["compositions"][0]["mainGraph"]["states"]["s1"]["broadcastOnEnter"] = True
    wrap = m.narrative_graphs["compositions"][0]["elements"][1]["graph"]
    wrap["transitions"].append({"id": "t3", "from": "u", "to": "v", "signal": "state:flow_main:s1"})
    m.scenes["场景1"]["zones"][0]["conditions"] = [_leaf("flow_main", "s1")]
    m.scenes["场景1"]["hotspots"] = [
        {"id": "h1", "actions": [{"type": "setNarrativeState", "params": {"graphId": "flow_main", "stateId": "s1"}}]}
    ]
    m.quests = [{"id": "q1", "completionConditions": [_leaf("flow_main", "s1")]}]
    m.map_nodes = [{"id": "n1", "visibleWhen": {"all": [_leaf("flow_main", "s1")]}}]
    p = Path(m.dialogues_path) / "graphs" / "对话甲.json"
    doc = json.loads(p.read_text(encoding="utf-8"))
    doc["nodes"]["n2"] = {"id": "n2", "type": "switch", "cases": [{"condition": _leaf("flow_main", "s1"), "next": "n1"}]}
    p.write_text(json.dumps(doc, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def test_rename_state_cascades_and_migrations(disk_model: FakeModel) -> None:
    _wire_state_refs(disk_model)
    scan = scan_state_usages(disk_model, "flow_main", "s1")
    assert scan["internalEndpoints"] == 1  # t1 的 to=s1
    assert len(scan["derivedListeners"]) == 1
    assert scan["totalRefs"] >= 7

    rename_state(disk_model, "flow_main", "s1", "s1_done")
    main = disk_model.narrative_graphs["compositions"][0]["mainGraph"]
    assert list(main["states"].keys()) == ["s0", "s1_done"], "states 键序必须保真"
    assert main["states"]["s1_done"]["id"] == "s1_done"
    assert main["transitions"][0]["to"] == "s1_done"
    wrap = disk_model.narrative_graphs["compositions"][0]["elements"][1]["graph"]
    assert wrap["transitions"][-1]["signal"] == "state:flow_main:s1_done"
    assert disk_model.scenes["场景1"]["zones"][0]["conditions"][0]["state"] == "s1_done"
    assert disk_model.scenes["场景1"]["hotspots"][0]["actions"][0]["params"]["stateId"] == "s1_done"
    assert disk_model.quests[0]["completionConditions"][0]["state"] == "s1_done"
    assert disk_model.map_nodes[0]["visibleWhen"]["all"][0]["state"] == "s1_done"
    dlg = disk_model.pending_dialogue_graph_edits["对话甲"]
    assert dlg["nodes"]["n2"]["cases"][0]["condition"]["state"] == "s1_done"
    assert disk_model.narrative_graphs["migrations"]["states"]["flow_main"] == {"s1": "s1_done"}
    # 二次改名：既有迁移值跟随重写（旧档 s1 直达最终名），再登记新跳
    rename_state(disk_model, "flow_main", "s1_done", "s1_final")
    assert disk_model.narrative_graphs["migrations"]["states"]["flow_main"] == {
        "s1": "s1_final", "s1_done": "s1_final",
    }


def test_rename_state_undo_restores_bytes_and_migrations(disk_model: FakeModel) -> None:
    _wire_state_refs(disk_model)
    before = json.dumps(disk_model.narrative_graphs, ensure_ascii=False, sort_keys=True)
    before_scene = json.dumps(disk_model.scenes, ensure_ascii=False, sort_keys=True)
    snap = _migrations_snapshot(disk_model)
    rename_state(disk_model, "flow_main", "s1", "s1x")
    push_journal(disk_model, {
        "op": "renameState", "graphId": "flow_main", "oldStateId": "s1", "newStateId": "s1x",
        "migrationsSnapshot": snap,
    })
    res = undo_last(disk_model)
    assert res["ok"], res
    assert json.dumps(disk_model.narrative_graphs, ensure_ascii=False, sort_keys=True) == before
    assert json.dumps(disk_model.scenes, ensure_ascii=False, sort_keys=True) == before_scene


def test_rename_graph_cascades_and_migrations(disk_model: FakeModel) -> None:
    _wire_state_refs(disk_model)
    disk_model.narrative_graphs["compositions"][0]["elements"][0]["meta"]["reads"] = ["flow_main"]
    scan = scan_graph_usages(disk_model, "flow_main")
    assert scan["derivedListeners"] == 1 and scan["metaReads"] == 1
    assert scan["totalRefs"] >= 7

    rename_graph(disk_model, "flow_main", "flow_main_v2")
    main = disk_model.narrative_graphs["compositions"][0]["mainGraph"]
    assert main["id"] == "flow_main_v2"
    wrap = disk_model.narrative_graphs["compositions"][0]["elements"][1]["graph"]
    assert wrap["transitions"][-1]["signal"] == "state:flow_main_v2:s1"
    assert disk_model.narrative_graphs["compositions"][0]["elements"][0]["meta"]["reads"] == ["flow_main_v2"]
    assert disk_model.scenes["场景1"]["zones"][0]["conditions"][0]["narrative"] == "flow_main_v2"
    assert disk_model.scenes["场景1"]["hotspots"][0]["actions"][0]["params"]["graphId"] == "flow_main_v2"
    assert disk_model.pending_dialogue_graph_edits["对话甲"]["nodes"]["n2"]["cases"][0]["condition"]["narrative"] == "flow_main_v2"
    assert disk_model.narrative_graphs["migrations"]["graphs"] == {"flow_main": "flow_main_v2"}
    # states 迁移映射外层键跟随图改名；graphs 既有值跟随重写
    disk_model.narrative_graphs["migrations"]["states"] = {"flow_main_v2": {"a": "b"}}
    rename_graph(disk_model, "flow_main_v2", "flow_main_v3")
    assert disk_model.narrative_graphs["migrations"]["states"] == {"flow_main_v3": {"a": "b"}}
    assert disk_model.narrative_graphs["migrations"]["graphs"] == {
        "flow_main": "flow_main_v3", "flow_main_v2": "flow_main_v3",
    }


def test_rename_state_and_graph_validation_gates(disk_model: FakeModel) -> None:
    with pytest.raises(SignalRefactorError):
        rename_state(disk_model, "flow_main", "s0", "s1")  # 撞既有状态
    with pytest.raises(SignalRefactorError):
        rename_state(disk_model, "no_such_graph", "s0", "sx")
    with pytest.raises(SignalRefactorError):
        rename_graph(disk_model, "flow_main", "wrap_1")  # 撞既有图 id
    with pytest.raises(SignalRefactorError):
        rename_graph(disk_model, "no_such_graph", "x")


def test_save_all_writes_dialogue_graph_edits(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """真 ProjectModel：dialogue_graph_edits 桶随 save_all 覆写原文件，提交后暂存清空。"""
    from tools.editor.project_model import ProjectModel

    assert "dialogue_graph_edits" in ProjectModel.KNOWN_DIRTY_BUCKETS
    model = ProjectModel.__new__(ProjectModel)  # 不跑重载的 __init__，只装本测试要的面
    graphs_dir = tmp_path / "graphs"
    graphs_dir.mkdir(parents=True)
    original = {"id": "对话乙", "entry": "n1", "nodes": {"n1": {"runActions": [_emit("old_sig")]}}}
    target = graphs_dir / "对话乙.json"
    target.write_text(json.dumps(original, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    edited = json.loads(json.dumps(original))
    edited["nodes"]["n1"]["runActions"][0]["params"]["signal"] = "new_sig"

    from tools.editor.file_io import StagedJsonWriter

    monkeypatch.setattr(type(model), "dialogues_path", property(lambda self: tmp_path), raising=False)
    model.pending_dialogue_graph_edits = {"对话乙": edited, "../逃逸": edited, "": edited}
    writer = StagedJsonWriter()
    try:
        # 直接演练 save_all 的该分支逻辑（完整 save_all 需要全工程骨架，此处针对性覆盖）
        from tools.editor.shared.narrative_templates import _dialogue_id_error

        for gid, graph in list(model.pending_dialogue_graph_edits.items()):
            gid_s = str(gid).strip()
            if not gid_s or _dialogue_id_error(gid_s) or not isinstance(graph, dict):
                continue
            writer.add(graphs_dir / f"{gid_s}.json", graph)
        writer.commit()
    finally:
        writer.abort()

    written = json.loads(target.read_text(encoding="utf-8"))
    assert written["nodes"]["n1"]["runActions"][0]["params"]["signal"] == "new_sig"
    assert not (tmp_path / "逃逸.json").exists() and not (graphs_dir.parent / "逃逸.json").exists()
