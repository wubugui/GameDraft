---
target: action-registration-registry-surfaces
date: 2026-09-12
session: 手持光源（火把）编辑器侧
---

现象: 卡里说「长在数据结构里的实体引用……单写一条改写函数，接进 scan / rename / move / undo-move 三条路径」——句子里写"三条"却列了四条，而且对**跟不着走的引用**（场景灯 `lighting.lights[*].follow.target`：灯是场景的家具，实体换场景它跟不过去）没有说法：move / undo-move 到底该改写、清空，还是只报。
证据: `tools/editor/shared/entity_refactor.py` 里三种先例互不相同——quest guidance 机械跟随 sceneId、bubble_lines 裸 speaker 只在全局唯一时改、轨迹资产明文"不扫不改不报"；本次给 follow.target 选的是第四种「rename 跟随 + move 只报不改 + undo 对称不动」，护栏 `tools/editor/tests/test_held_prop_editor_surfaces.py::SceneLightFollowRefactorTests`。
建议: 把「三条」改成「四条」，并把四种处置（机械跟随 / 全局唯一才跟 / 只报不改 / 不扫不报）做成一张判据表——选哪种取决于「引用所在的数据能不能跟着实体走」，不是取决于引用形状。
