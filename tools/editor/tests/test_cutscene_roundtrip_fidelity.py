"""过场编辑器「打开→展开→Apply」类型级往返保真。

锁定本次修复：数值参数不再 int->float 漂移、cutsceneSpawnActor 世界坐标不被 clamp、
showImg 不凭空加空 id、faceEntity/showEmote 不凭空加 direction/anchorOffset、moveEntityTo
不凭空加 sceneId，且新建 present 步采用运行时默认值（而非写出 duration:0 的"假"步）。

回归基线：修复前驱动真实工程「打开→展开→Apply」曾产生 125 处类型级往返漂移。
"""
from __future__ import annotations

import sys
import unittest
from copy import deepcopy
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import Any

from PySide6.QtWidgets import QApplication

from tools.editor.editors.timeline_editor import StepWidget, TimelineEditor
from tools.editor.project_model import ProjectModel
from tools.editor.tests.save_test_utils import (
    copy_assets_subset,
    repo_root_from_tests,
    write_minimal_loadable_project,
)


def _typed_diff(a: Any, b: Any, path: str = "") -> list[str]:
    """类型严格深比较：值不等或 int/float 类型不一致都算 diff（bool 单列）。"""
    out: list[str] = []
    if isinstance(a, dict) and isinstance(b, dict):
        for k in dict.fromkeys(list(a.keys()) + list(b.keys())):
            if k not in a:
                out.append(f"{path}.{k}: 仅在输出 = {b[k]!r}")
            elif k not in b:
                out.append(f"{path}.{k}: 仅在输入(丢失) = {a[k]!r}")
            else:
                out += _typed_diff(a[k], b[k], f"{path}.{k}")
    elif isinstance(a, list) and isinstance(b, list):
        if len(a) != len(b):
            out.append(f"{path}: 列表长度 {len(a)}->{len(b)}")
        for i, (x, y) in enumerate(zip(a, b)):
            out += _typed_diff(x, y, f"{path}[{i}]")
    else:
        if isinstance(a, bool) or isinstance(b, bool):
            if a != b or type(a) is not type(b):
                out.append(f"{path}: {a!r}({type(a).__name__})->{b!r}({type(b).__name__})")
        elif isinstance(a, (int, float)) and isinstance(b, (int, float)):
            if a != b or type(a) is not type(b):
                out.append(f"{path}: {a!r}({type(a).__name__})->{b!r}({type(b).__name__})")
        elif a != b:
            out.append(f"{path}: {a!r}->{b!r}")
    return out


# 覆盖所有易漂移形态的合成过场（整数 duration/坐标/scale、世界坐标出生点、无 sceneId/direction/
# anchorOffset 的 action、带 subtitleEmote 的字幕、缺 id 的 showImg、并行子轨）。
_SYNTH_STEPS: list[dict] = [
    {"kind": "present", "type": "fadeToBlack", "duration": 1000},
    {"kind": "present", "type": "waitTime", "duration": 500},
    {"kind": "present", "type": "showTitle", "text": "第一天", "duration": 2000},
    {"kind": "present", "type": "showMovieBar", "heightPercent": 0.1},
    {"kind": "present", "type": "cameraMove", "x": 200, "y": 700, "duration": 1000},
    {"kind": "present", "type": "cameraZoom", "scale": 1, "duration": 600},
    {"kind": "present", "type": "showImg",
     "image": "/resources/runtime/images/x.png"},
    {"kind": "present", "type": "showSubtitle", "text": "字幕",
     "subtitleBand": "movieTop", "subtitleAlign": "center",
     "subtitleVoice": "voice_line_01",
     "subtitleEmote": {"target": "player", "emote": "！", "duration": 1500.0,
                       "anchorOffsetX": 0.0, "anchorOffsetY": 0.0}},
    {"kind": "present", "type": "showSubtitle", "text": "带对象配音",
     "position": "bottom", "subtitleVoice": {"id": "voice_line_02", "volume": 0.75}},
    {"kind": "action", "type": "cutsceneSpawnActor",
     "params": {"id": "_cut_tall", "name": "高个", "x": 520, "y": 930}},
    {"kind": "action", "type": "faceEntity",
     "params": {"target": "_cut_tall", "faceTarget": "player"}},
    {"kind": "action", "type": "showEmoteAndWait",
     "params": {"target": "_cut_tall", "emote": "？", "duration": 1200}},
    {"kind": "parallel", "tracks": [
        {"kind": "action", "type": "moveEntityTo",
         "params": {"target": "_cut_tall", "x": 700, "y": 500, "speed": 80}},
        {"kind": "present", "type": "cameraMove", "x": 850, "y": 500, "duration": 2000},
    ]},
]


class TestCutsceneRoundtripFidelity(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls._qt_app = QApplication.instance() or QApplication(sys.argv)

    def _roundtrip_via_editor(self, model: ProjectModel) -> list[str]:
        originals = deepcopy(model.cutscenes)
        ed = TimelineEditor(model)
        diffs: list[str] = []
        for idx in range(len(model.cutscenes)):
            ed._on_select(idx)
            ed._set_all_step_collapsed(False)  # 展开全部含并行子轨，走 StepWidget 控件路径
            steps = [ol.to_dict() for ol in ed._step_outlines]
            cid = originals[idx].get("id", f"#{idx}")
            diffs += _typed_diff(originals[idx].get("steps") or [], steps, f"{cid}.steps")
        return diffs

    def test_synthetic_cutscene_type_level_roundtrip(self) -> None:
        with TemporaryDirectory() as td:
            root = Path(td) / "p"
            write_minimal_loadable_project(root)
            model = ProjectModel()
            model.load_project(root)
            model.cutscenes[0]["steps"] = deepcopy(_SYNTH_STEPS)
            diffs = self._roundtrip_via_editor(model)
            self.assertEqual(diffs, [], "合成过场存在类型级往返漂移:\n  " + "\n  ".join(diffs))

    def test_cutscene_spawn_actor_world_coords_not_clamped(self) -> None:
        """cutsceneSpawnActor x/y 是世界坐标，曾被 ±50 量程 clamp 成 50（数据丢失）。"""
        with TemporaryDirectory() as td:
            root = Path(td) / "p"
            write_minimal_loadable_project(root)
            model = ProjectModel()
            model.load_project(root)
            model.cutscenes[0]["steps"] = [
                {"kind": "action", "type": "cutsceneSpawnActor",
                 "params": {"id": "_cut_a", "name": "甲", "x": 1603.15, "y": 1092.18}},
            ]
            ed = TimelineEditor(model)
            ed._on_select(0)
            ed._set_all_step_collapsed(False)
            out = ed._step_outlines[0].to_dict()
            self.assertEqual(out["params"]["x"], 1603.15)
            self.assertEqual(out["params"]["y"], 1092.18)

    def test_new_present_steps_use_runtime_defaults(self) -> None:
        """新建 present 步切到各类型后，数值参数取运行时默认值，而非写出 0（瞬时/不可见）。"""
        cases = {
            "fadeToBlack": ("duration", 1000),
            "fadeIn": ("duration", 1000),
            "flashWhite": ("duration", 200),
            "waitTime": ("duration", 1000),
            "showTitle": ("duration", 2000),
            "showMovieBar": ("heightPercent", 0.1),
            "cameraZoom": ("scale", 1),
        }
        for ptype, (pname, expect) in cases.items():
            sw = StepWidget({"kind": "present", "type": "waitClick"})
            sw._type_combo.set_committed_type(ptype)
            sw._on_present_type_changed()
            out = sw.to_dict()
            self.assertEqual(out.get("type"), ptype)
            self.assertEqual(
                out.get(pname), expect,
                f"{ptype}.{pname} 应默认 {expect}（运行时默认值），实得 {out.get(pname)!r}",
            )

    def test_real_cutscenes_type_level_roundtrip(self) -> None:
        """真实工程过场数据全量往返保真（缺 assets 时跳过）。"""
        repo = repo_root_from_tests()
        if not (repo / "public" / "assets" / "data" / "cutscenes" / "index.json").is_file():
            raise unittest.SkipTest("缺少真实过场数据，跳过")
        with TemporaryDirectory() as td:
            dst = Path(td) / "proj"
            try:
                copy_assets_subset(repo, dst, ("data", "scenes", "dialogues"))
            except Exception as exc:  # noqa: BLE001
                raise unittest.SkipTest(f"裁剪 assets 失败，跳过：{exc}") from exc
            model = ProjectModel()
            try:
                model.load_project(dst)
            except Exception as exc:  # noqa: BLE001
                raise unittest.SkipTest(f"工程加载不适合本机：{exc}") from exc
            if not model.cutscenes:
                raise unittest.SkipTest("工程无过场，跳过")
            diffs = self._roundtrip_via_editor(model)
            self.assertEqual(
                diffs, [],
                f"真实过场存在类型级往返漂移（{len(diffs)} 处）:\n  " + "\n  ".join(diffs[:40]),
            )


class TestActionRuntimeDefaultParams(unittest.TestCase):
    """运行时非零默认的 int 参数（fadeMs/count/durationMs…）：编辑器须按运行时默认 seed，
    且缺该键时往返不注入——否则"打开即保存"会写出 0 改变行为（count:0 不给物品 / fadeMs:0 瞬切）。"""

    @classmethod
    def setUpClass(cls) -> None:
        cls._qt_app = QApplication.instance() or QApplication(sys.argv)

    def _model(self) -> ProjectModel:
        self._td = TemporaryDirectory()
        root = Path(self._td.name) / "p"
        write_minimal_loadable_project(root)
        m = ProjectModel()
        m.load_project(root)
        return m

    def test_new_action_int_params_seed_runtime_default(self) -> None:
        from PySide6.QtWidgets import QSpinBox
        from tools.editor.shared.action_editor import (
            ActionRow, _ACTION_PARAM_RUNTIME_DEFAULTS,
        )
        m = self._model()
        for (act, pname), expect in _ACTION_PARAM_RUNTIME_DEFAULTS.items():
            row = ActionRow({"type": act, "params": {}}, model=m)
            w = row._param_widgets.get(pname)
            if not isinstance(w, QSpinBox):
                continue  # blendOverlayImage 等专属构造器自行 seed，这里只核泛型 int
            self.assertEqual(
                w.value(), expect,
                f"{act}.{pname} 新建应 seed 运行时默认 {expect}，实得 {w.value()}",
            )

    def test_absent_int_param_not_injected_on_roundtrip(self) -> None:
        from tools.editor.shared.action_editor import (
            ActionRow, _ACTION_PARAM_RUNTIME_DEFAULTS,
        )
        m = self._model()
        for (act, pname), _dv in _ACTION_PARAM_RUNTIME_DEFAULTS.items():
            out = ActionRow({"type": act, "params": {}}, model=m).to_dict()
            self.assertNotIn(
                pname, out.get("params", {}),
                f"{act} 原本缺 {pname}，往返不应注入（运行时自带默认）",
            )

    def test_explicit_int_value_preserved(self) -> None:
        from tools.editor.shared.action_editor import ActionRow
        m = self._model()
        # 显式值（含刻意的 0=瞬切）必须原样保留为 int
        o1 = ActionRow({"type": "giveItem", "params": {"id": "x", "count": 3}}, model=m).to_dict()
        self.assertEqual(o1["params"]["count"], 3)
        self.assertIs(type(o1["params"]["count"]), int)
        o2 = ActionRow({"type": "stopBgm", "params": {"fadeMs": 0}}, model=m).to_dict()
        self.assertEqual(o2["params"]["fadeMs"], 0)


if __name__ == "__main__":
    unittest.main()
