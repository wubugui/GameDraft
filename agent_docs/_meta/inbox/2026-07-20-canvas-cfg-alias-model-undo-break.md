---
target: editor-data-sync-paradigm
date: 2026-07-20
session: perspective-scale 深度轴升级
---

现象: 编辑器"画布是模型投影"范式说画布项原地更新即可；但当画布 live 拖拽处理器**就地 mutate 一个 cfg dict**、而该 dict 是加载时按引用存下的 model 子对象时，live 拖动直接改了 model，撤销基线（capture 的 before 快照）已被污染 → 撤销回不去（拖轴后 editor_undo 无效）。
证据: scene_editor.py `SceneCanvas.set_perspective_config` 原本 `self._persp_cfg = cfg`（cfg 来自 `sc.get("perspectiveScale")` = model 子对象），`_persp_axis_drag_update` 就地写 `_persp_cfg["near"]["x"]`；test_perspective_axis_editor.py 的拖端点+undo 用例复现（撤销后 near.x 仍是拖后值）。修复=存 `copy.deepcopy(cfg)`。
建议: 范式卡补一条——凡"画布 live 手势就地改 cfg/几何 dict"的路径，该 dict 必须是与 model 隔离的副本（deepcopy 或每次重建），提交才走正规 flush 写 model；持 model 引用做 live mutate = 撤销/脏态双破。
