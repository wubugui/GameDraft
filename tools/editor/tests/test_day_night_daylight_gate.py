"""「时段表没标 daylight」的构建期闸（2026-08-18 事故的回归锁）。

事故形状：内容侧把时段表换成 `辰/午/暮/夜`，而运行时「NPC 未写 phases 时的缺省归属」
是代码里硬写的 `['day']`。`'day'` 在新表里不存在 → 白名单判定恒假 → 所有开了日夜的
场景 24 小时空无一人，**且全程没有任何报错**——条件为假就是"不显示"，
肉眼分不出是设计如此还是坏了。整条街空了将近两周才被发现。

运行时侧已改成只认 `daylight` 标记、不认任何时段 id（见 `dayTime.daylightPhaseIds`），
这里锁的是构建期那一半：没标就当面说（律 7 构建期严于运行时）。

同一个 daylight 缺省还有第二条命门：**场景分组的时段归属**。组只在某段在场、
成员按 NPC 种类缺省只在白日段，两者纯「与」→ 成员一天 24 小时都不出现，
画面上与"设计如此"长得一模一样。那一族的护栏在本文件后半段
（`SceneGroupPhaseGateTests`），锁的是 validator 的 `_validate_scene_group_phases`
/ `_check_phases_field` / `_hard_time_phase_set`。
"""
from __future__ import annotations

import json
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import Any, Sequence

from tools.editor.project_model import ProjectModel
from tools.editor.tests.save_test_utils import write_minimal_loadable_project
from tools.editor.validator import Issue, _validate_day_night, validate


def _model(game_config: dict[str, Any], scenes: dict[str, Any] | None = None) -> ProjectModel:
    model = ProjectModel.__new__(ProjectModel)
    model.game_config = game_config
    model.scenes = scenes if scenes is not None else {}
    return model


_DAY_NIGHT_SCENE = {"雾津街头": {"dayNight": {"enabled": True}}}
_CHINESE_PHASES = [
    {"id": "辰", "from": "07:00"},
    {"id": "午", "from": "11:00"},
    {"id": "暮", "from": "18:00"},
    {"id": "夜", "from": "20:00"},
]


def _run(game_config: dict[str, Any], scenes: dict[str, Any] | None = None) -> list[Issue]:
    issues: list[Issue] = []
    _validate_day_night(_model(game_config, scenes), issues)
    return issues


class DaylightGateTests(unittest.TestCase):
    def test_the_2026_08_18_accident_is_caught(self) -> None:
        """换了词表、没标 daylight、且真有场景开了日夜 → 必须出警告。"""
        issues = _run({"dayNight": {"phases": _CHINESE_PHASES}}, _DAY_NIGHT_SCENE)
        self.assertEqual([i.severity for i in issues], ["warning"])
        self.assertIn("daylight", issues[0].message)
        self.assertIn("雾津街头", issues[0].message)

    def test_marked_table_is_silent(self) -> None:
        marked = [dict(p, daylight=True) if p["id"] in ("辰", "午") else p for p in _CHINESE_PHASES]
        self.assertEqual(_run({"dayNight": {"phases": marked}}, _DAY_NIGHT_SCENE), [])

    def test_no_day_night_scene_means_no_complaint(self) -> None:
        """没有场景开日夜时整套时段过滤都不生效，标不标都无所谓——别制造噪音警告。"""
        self.assertEqual(_run({"dayNight": {"phases": _CHINESE_PHASES}}, {}), [])
        self.assertEqual(
            _run({"dayNight": {"phases": _CHINESE_PHASES}}, {"义庄": {"dayNight": {}}}), []
        )

    def test_unconfigured_table_falls_back_to_builtin_mark(self) -> None:
        """没配 dayNight = 用内置四段，那张表里 `day` 自带标记，不该报。"""
        self.assertEqual(_run({}, _DAY_NIGHT_SCENE), [])

    def test_non_boolean_daylight_is_an_error(self) -> None:
        """运行时按 `=== true` 判，写 "true" / 1 会被静默当成没标——按 error 拦。"""
        issues = _run(
            {"dayNight": {"phases": [{"id": "辰", "from": "07:00", "daylight": "true"}]}},
            _DAY_NIGHT_SCENE,
        )
        self.assertIn("error", [i.severity for i in issues])
        self.assertTrue(any("daylight" in i.message for i in issues))

    def test_malformed_day_night_block_is_an_error(self) -> None:
        self.assertEqual([i.severity for i in _run({"dayNight": "早上"}, _DAY_NIGHT_SCENE)], ["error"])
        self.assertEqual(
            [i.severity for i in _run({"dayNight": {"phases": "辰午暮夜"}}, _DAY_NIGHT_SCENE)],
            ["error"],
        )


# ---------------------------------------------------------------------------
# 场景分组的「时段归属」（entityGroups[].phases）
# ---------------------------------------------------------------------------

_SCENE_ID = "sc_group_phase"
_GROUP_ID = "送葬队伍"

# 时段 id 一律从上面那张表里取，按**角色**命名而不是按 id 命名：
# 第 0 段是标了 daylight 的那种（= NPC 未写 phases 时的种类缺省所在），
# 后两段在缺省之外（组要这类段、成员跟不上，就是死内容的形状）。
_DAYLIGHT_PHASE = _CHINESE_PHASES[0]["id"]
_OFF_HOURS_PHASE = _CHINESE_PHASES[3]["id"]
_OTHER_OFF_HOURS_PHASE = _CHINESE_PHASES[2]["id"]
# 故意不在时段表里登记的一个串，用来验「坏 id 只报一条」。
_UNREGISTERED_PHASE = "没登记的时段"

# 报文锚点按语义挑、不整句断言（文案会改，语义不会）。
_NO_OVERLAP = "与之没有交集"
_UNREGISTERED_MARK = "含未登记时段"
_GATE_OFF_MARK = "没开 dayNight.enabled"


def _marked_phases() -> list[dict[str, Any]]:
    """与现网同形的时段表：前两段标 daylight，后两段不标。"""
    daylight = {p["id"] for p in _CHINESE_PHASES[:2]}
    return [dict(p, daylight=True) if p["id"] in daylight else dict(p) for p in _CHINESE_PHASES]


def _npc(n: int, **kw: Any) -> dict[str, Any]:
    return {
        "id": f"n{n}", "name": f"送葬人{n}", "x": 10 * n, "y": 10,
        "interactionRange": 50, "group": _GROUP_ID, **kw,
    }


def _hotspot(hid: str, **kw: Any) -> dict[str, Any]:
    return {
        "id": hid, "type": "inspect", "label": "", "x": 5, "y": 5,
        "interactionRange": 50, "data": {"text": "看一眼"}, "group": _GROUP_ID, **kw,
    }


def _zone(zid: str, **kw: Any) -> dict[str, Any]:
    return {
        "id": zid, "group": _GROUP_ID,
        "polygon": [{"x": 0, "y": 0}, {"x": 80, "y": 0}, {"x": 80, "y": 80}], **kw,
    }


def _scene(
    group: dict[str, Any],
    *,
    npcs: Sequence[dict[str, Any]] = (),
    hotspots: Sequence[dict[str, Any]] = (),
    zones: Sequence[dict[str, Any]] = (),
    day_night: bool = True,
) -> dict[str, Any]:
    return {
        "id": _SCENE_ID, "name": "分组时段测试场景",
        "dayNight": {"enabled": day_night},
        "entityGroups": [group],
        "npcs": list(npcs), "hotspots": list(hotspots), "zones": list(zones),
        "spawnPoints": {},
    }


def _validate_scene(scene: dict[str, Any]) -> list[Issue]:
    """把场景 dict 落进临时工程，走 `validate()` 这个**公开入口**跑全量校验。

    刻意不直接调 `_validate_scene_group_phases` / `_check_phases_field` /
    `_hard_time_phase_set`：绕开真实入口拼内部状态的测试恒绿，连「这条检查到底有没有
    被 validate() 接上」都没验过——本仓在这上头反复吃过亏
    （`agent_docs/editor-tools/recipes/editor-change-verification-gate.md` 的流程探针门）。
    """
    with TemporaryDirectory() as td:
        root = Path(td) / "p"
        write_minimal_loadable_project(root)
        (root / "public" / "assets" / "data" / "game_config.json").write_text(
            json.dumps({"dayNight": {"phases": _marked_phases()}}, ensure_ascii=False, indent=2)
            + "\n",
            encoding="utf-8",
        )
        (root / "public" / "assets" / "scenes" / f"{_SCENE_ID}.json").write_text(
            json.dumps(scene, ensure_ascii=False, indent=2) + "\n", encoding="utf-8",
        )
        model = ProjectModel()
        model.load_project(root)
        return validate(model)


def _phase_issues(scene: dict[str, Any]) -> list[Issue]:
    """本场景里与「时段」有关的 issue（分组时段这一族），跑完真实入口再筛。

    筛得宽（凡提到 phases / 时段的都留），这样"该静默"的用例是真的静默，
    而不是被一条过窄的过滤器挡掉。
    """
    return [
        i for i in _validate_scene(scene)
        if i.item_id == _SCENE_ID and ("phases" in i.message or "时段" in i.message)
    ]


def _texts(issues: list[Issue], severity: str) -> list[str]:
    return [i.message for i in issues if i.severity == severity]


class SceneGroupPhaseGateTests(unittest.TestCase):
    """分组时段的唯一公式（镜像 `SceneManager.entityInPhase` / `isEntityInPhaseWithGroup`）：

        有效在场 = isEntityInPhase(实体.phases, 当前, 组.phases ?? 种类缺省)
                && isEntityInPhase(组.phases,   当前, 无)

    这里锁 validator 侧的四条：id 登记、总闸、组∩成员空交集、conditions 里的 timePhase 提醒。
    立此族用例的直接原因：删掉 `_validate_scene_group_phases` 整段，全套编辑器测试仍然全绿
    （2026-08-26 交叉复核实测），而迁移之后现网数据一条都触发不了——等于没有护栏。
    """

    # —— 空交集：报，且每个成员一条 ——

    def test_pre_migration_conditions_shape_flags_every_member(self) -> None:
        """迁移前那个形状：组用 conditions 的 timePhase 表达时段、成员是不写 phases 的 NPC。

        组只在非白日段在场，成员按 NPC 种类缺省只在标了 daylight 的段出没，两边纯「与」
        → 这些人一天 24 小时都不在场。雾津街头「雾津送葬队伍」13 个人正是这个形状，
        这条就是他们的静态检出。**每个成员一条**：策划要知道是哪几个人，不能只报一条了事。
        """
        issues = _phase_issues(_scene(
            {"id": _GROUP_ID, "label": "送葬队伍",
             "conditions": [{"timePhase": _OFF_HOURS_PHASE}]},
            npcs=[_npc(1), _npc(2), _npc(3)],
        ))
        errors = _texts(issues, "error")
        self.assertEqual(len(errors), 3, errors)
        for n in (1, 2, 3):
            self.assertTrue(
                any(f"'n{n}'" in m and _NO_OVERLAP in m for m in errors),
                f"成员 n{n} 没有单独的空交集报告：{errors}",
            )

    def test_migrated_phases_shape_is_silent(self) -> None:
        """迁移后：组写 phases、成员不写 → 成员跟组走，交集恒等于组，一条都不该报。

        这是内容侧被引导去写的那个形状；它要是也报，整条规则就没法收工。
        """
        self.assertEqual(_phase_issues(_scene(
            {"id": _GROUP_ID, "label": "送葬队伍", "phases": [_OFF_HOURS_PHASE]},
            npcs=[_npc(1), _npc(2), _npc(3)],
        )), [])

    def test_explicit_member_phases_are_judged_per_entity(self) -> None:
        """成员自己写了时段：不相交的报，相交的静默——三类实体别一视同仁地报。"""
        issues = _phase_issues(_scene(
            {"id": _GROUP_ID, "label": "送葬队伍", "phases": [_OFF_HOURS_PHASE]},
            npcs=[_npc(1, phases=[_DAYLIGHT_PHASE])],
            zones=[_zone("z1", phases=[_OFF_HOURS_PHASE])],
            hotspots=[_hotspot("h1", phases=[_OTHER_OFF_HOURS_PHASE, _OFF_HOURS_PHASE])],
        ))
        errors = _texts(issues, "error")
        self.assertEqual(len(errors), 1, errors)
        self.assertIn("'n1'", errors[0])
        self.assertIn(_NO_OVERLAP, errors[0])

    def test_only_npcs_fall_back_to_the_daylight_default(self) -> None:
        """种类分叉：都不写 phases 时，只有 NPC 回落 daylight 段（会撞上非白日的组），
        热点 / 区域的缺省是全时段（与任何组都相交）。三类共用一份缺省就会把后两类误报。
        """
        issues = _phase_issues(_scene(
            {"id": _GROUP_ID, "label": "送葬队伍",
             "conditions": [{"timePhase": _OFF_HOURS_PHASE}]},
            npcs=[_npc(1)], zones=[_zone("z1")], hotspots=[_hotspot("h1")],
        ))
        errors = _texts(issues, "error")
        self.assertEqual(len(errors), 1, errors)
        self.assertIn("'n1'", errors[0])

    # —— 场景总闸：dayNight.enabled 关掉时整套判定不生效 ——

    def test_scene_day_night_off_leaves_only_a_warning(self) -> None:
        """没开日夜 = 时段归属根本不生效：提醒「配了不生效」，但不许报空交集 error。"""
        issues = _phase_issues(_scene(
            {"id": _GROUP_ID, "label": "送葬队伍", "phases": [_OFF_HOURS_PHASE]},
            npcs=[_npc(1), _npc(2)], day_night=False,
        ))
        self.assertEqual(_texts(issues, "error"), [])
        warnings = _texts(issues, "warning")
        self.assertEqual(len(warnings), 1, warnings)
        self.assertIn(_GATE_OFF_MARK, warnings[0])

    def test_scene_day_night_off_also_disables_the_kind_default(self) -> None:
        """总闸关掉时 NPC 的 daylight 缺省一并不生效——这时 conditions 里的 timePhase
        再怎么写都撞不空，报 error 就是误报（运行时那边同样恒显）。"""
        issues = _phase_issues(_scene(
            {"id": _GROUP_ID, "label": "送葬队伍",
             "conditions": [{"timePhase": _OFF_HOURS_PHASE}]},
            npcs=[_npc(1)], day_night=False,
        ))
        self.assertEqual(_texts(issues, "error"), [])

    # —— 硬约束的边界：宁可漏报不可误报 ——

    def test_time_phase_under_any_or_not_is_not_a_hard_constraint(self) -> None:
        """`any` / `not` 底下的 timePhase 可能由别的分支满足，不算「必然成立」。

        这是自觉的取舍：这条判定报的是 error，误报会拦住合法内容，所以宁可漏报。
        钉住它，别哪天被"顺手改进"成把整棵条件树都当「与」。
        """
        for conds in (
            [{"any": [{"timePhase": _OFF_HOURS_PHASE}, {"flag": "story.open", "equals": True}]}],
            [{"not": {"timePhase": _OFF_HOURS_PHASE}}],
        ):
            with self.subTest(conds=conds):
                issues = _phase_issues(_scene(
                    {"id": _GROUP_ID, "label": "送葬队伍", "conditions": conds},
                    npcs=[_npc(1)],
                ))
                self.assertEqual(_texts(issues, "error"), [])

    def test_time_phase_under_all_is_still_a_hard_constraint(self) -> None:
        """配对上一条：`all` 是「与」，里面的 timePhase 照样算数——
        否则"any/not 不误报"只是恒绿，证明不了判定还活着。"""
        issues = _phase_issues(_scene(
            {"id": _GROUP_ID, "label": "送葬队伍",
             "conditions": [{"all": [{"timePhase": _OFF_HOURS_PHASE},
                                     {"flag": "story.open", "equals": True}]}]},
            npcs=[_npc(1)],
        ))
        self.assertEqual(len(_texts(issues, "error")), 1, issues)

    # —— 坏数据只报一条：别在坏数据上叠推理 ——

    def test_unregistered_group_phase_reports_only_once(self) -> None:
        """组的 phases 含未登记 id：只报「未登记」。此时组的时段集合根本不可信，
        再往下算空交集就是拿坏数据推出来的第二条错。"""
        issues = _phase_issues(_scene(
            {"id": _GROUP_ID, "label": "送葬队伍", "phases": [_UNREGISTERED_PHASE]},
            npcs=[_npc(1, phases=[_DAYLIGHT_PHASE])],
        ))
        errors = _texts(issues, "error")
        self.assertEqual(len(errors), 1, errors)
        self.assertIn(_UNREGISTERED_MARK, errors[0])
        self.assertNotIn(_NO_OVERLAP, errors[0])

    def test_unregistered_member_phase_reports_only_once(self) -> None:
        """成员的 phases 含未登记 id：同理，实体级那条已经报过了，组这边不叠第二条。"""
        issues = _phase_issues(_scene(
            {"id": _GROUP_ID, "label": "送葬队伍", "phases": [_OFF_HOURS_PHASE]},
            npcs=[_npc(1, phases=[_UNREGISTERED_PHASE])],
        ))
        errors = _texts(issues, "error")
        self.assertEqual(len(errors), 1, errors)
        self.assertIn(_UNREGISTERED_MARK, errors[0])
        self.assertNotIn(_NO_OVERLAP, errors[0])

    # —— 引导：用错字段要当面说 ——

    def test_group_conditions_time_phase_points_at_the_phases_field(self) -> None:
        """组用 conditions 表达时段是「错的工具」：那条不吃场景总闸、也不给成员当缺省。
        不拦（条件叶本身合法），但必须指名道姓让人改用分组的「时段归属」。"""
        issues = [i for i in _validate_scene(_scene(
            {"id": _GROUP_ID, "label": "送葬队伍",
             "conditions": [{"timePhase": _OFF_HOURS_PHASE}]},
            npcs=[_npc(1)],
        )) if i.data_type == "sceneGroup"]
        self.assertEqual([i.severity for i in issues], ["warning"], issues)
        self.assertEqual(issues[0].item_id, _GROUP_ID)
        self.assertIn("phases", issues[0].message)
        self.assertIn("时段归属", issues[0].message)


if __name__ == "__main__":
    unittest.main()
