---
target: editor-change-verification-gate
date: 2026-09-12
session: 场景灯 follow 作者面
---

现象: 「输出字节不变」强验收在**带 `vfx` 的场景上必红且与改动无关** —— 场景面板把 vfx 行的 dict 存进 `QListWidgetItem.setData(UserRole, d)`，PySide 把它转成 QVariantMap（键**按字母排序**），读回来键序就变了（`id/effect/anchor` → `anchor/effect/id`，`anchor` 内部也被排成 `h/surface/x/y`）。实测 `义庄.json`、`崖墓前段1.json` 逐字节不相等，`lighting` 块与其余顶层键全部相等，只有 `vfx` 被重排；与本次改动（只碰灯表单）无关。
证据: `sh scripts/py.sh -c "…QListWidgetItem().setData(UserRole,{'id':..,'effect':..,'anchor':{'x':..,'y':..,'h':..,'surface':..}})"` 读回来是 `['anchor','effect','id'] / ['h','surface','x','y']`；写回链路 `scene_editor._vfx_rows_from_widgets` → `sc["vfx"]`（scene_editor.py:5577 / 7473）。
建议: 验证门配方的「输出字节不变」那节加一条已知噪音源：**任何把业务 dict 存进 Qt `UserRole` 的列表面板都会丢键序**（ambient/vfx 一族），字节验收前要么先隔离这类键、要么改成把原始 dict 挂在旁路（像 `_AMBIENT_RAW_ROLE` 那样存原始引用）再按原序重建。
