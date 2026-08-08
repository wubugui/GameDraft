---
target: action-registration-quadruple
date: 2026-08-08
session: 任务系统当前任务槽 / 目标 / 引导 / 醒目提示
---

现象: 四件套卡把「实体引用」的登记面只写成 `ENTITY_REF_PARAMS`（按 action 参数登记），但这轮新增的实体引用长在**数据文件自身**（quests.json 的 `guidance[].entityId`，不是 action，没有 `type`/`params` 那层壳），`_walk_ref_actions` 按 `type ∈ ENTITY_REF_PARAMS` 判别根本看不见它；照卡登记还会被 `test_manifest_parity` 拦（键必须是真 action）。
证据: `tools/editor/shared/entity_refactor.py` 的 `_rewrite_quest_guidance_targets` / `_iter_quest_guidance`（照 `_rewrite_bubble_line_speakers` 的先例另写一条改写函数，并接进 scan/rename/move/undo-move），护栏 `tools/editor/tests/test_quest_objectives_guidance.py::GuidanceRefactorFollowTests`。
建议: 卡里补一句「数据文件自身的实体引用不进 ENTITY_REF_PARAMS，照 bubble_lines speaker 的先例单写改写函数 + 接 scan 三条路径 + 配跟随测试」，并点明**场景限定写法（sceneId+entityKind+entityId）零歧义可机械跟随**，比裸 id 好维护。
