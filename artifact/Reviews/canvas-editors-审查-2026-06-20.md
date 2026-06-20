# 主编辑器画布编辑 / 数据同步 / 保存 — 缺陷审查报告
> 多智能体审查（79 个 agent，每条发现都经对抗式复核）。日期 2026-06-20。审查范围：tools/editor 下所有含画布的编辑器。

**确认缺陷 63 条**（high 15 / medium 22 / low 26），驳回 8 条。

本报告只列问题清单，默认不修；待指令再进入修复。

---

## 0. 根因综述（一个结构性缺陷，派生出两大缺陷簇）

**核心结构缺陷：场景编辑器对"实体位置/数据的真相源"做了三向割裂。**

- **属性面板**改的是 `copy.deepcopy(实体)` 出来的 *staging 副本*（`_staging_npc/_staging_hotspot/_staging_zone/_staging_scene`）。
- **画布动画/重绘**（8ms `_tick_scene_npc_anims`、`refresh_*_visuals`）读的是 *已提交的 model*（`self._model.scenes[...]`）。
- **保存**写的也是 model，只有 `_apply_props()`（Apply 按钮 / Save All flush）才把 staging 灌回 model。

同一个实体的"可见精灵 / 被拖的图元 / 存盘数据"由三个不同的 dict 引用驱动，且**画布拖拽从不调用 `mark_dirty`**。由此派生：

1. **精灵闪烁簇（timer-vs-drag）= 你报告的 bug**：拖拽把新坐标写进 staging 副本并让精灵 `draw_at` 到新位，但 8ms 定时器随即读 *旧 model 坐标* 把精灵拍回原处 → 精灵在光标与旧位之间以 ~120Hz 振荡、滞后图元。详见 HIGH-1 / HIGH-? timer-vs-drag。

2. **静默丢数据簇（data-loss / dirty-marking）= 比闪烁更危险**：因为拖拽不 `mark_dirty`、切实体/切场景会无提示地丢弃 staging、关闭程序/切项目只看 `is_dirty` 且 flush 不在关闭路径上 —— **纯画布拖动（实体、出生点、多边形顶点、巡逻点）可以在没有任何"未保存"提示的情况下被永久丢弃**。这是一整簇高危缺陷（HIGH-3/4/5/11/12/14/15）。

**跨编辑器不一致是另一条线索**：map_editor、water_minigame 直接改 model 并*立即* `mark_dirty`（拖动即落库，正确范式）；scene_editor 用 staging 副本（出问题的范式）。但简单编辑器自己也有各自的 bug（选择同步崩溃、整画布重建闪烁、坐标四舍五入丢精度）。

**推荐修复主线**（细节待"开始修复"）：把场景编辑器统一到"画布读写同一个真相源 + 拖动即 `mark_dirty`/即时 flush"——要么取消逐实体 deepcopy 改用字段级 diff，要么让定时器/重绘/`draw_at` 全部经过一个"优先 staging"的位置解析器，并在拖拽提交点补 `mark_dirty`；关闭/切项目路径上先 flush 再判 `is_dirty`。

---

## 严重（HIGH）（15 条）

### HIGH-1. _refresh() silently drops the active selection: scene.clear() fires selectionChanged and clobbers _current_idx to -1 before restore
- **文件**: `tools/editor/editors/map_editor.py`  **行**: 322-354 (clear at 324; restore at 345-353; handler 283-300)
- **类别**: selection-sync  |  **复核**: confirmed → high  |  **置信**: certain
- **现象**: Any operation that re-runs _refresh() while a node is selected (and currently the only callers _add/_delete deliberately pre-set _current_idx, but ANY future caller, theme refresh, or a manual _refresh) loses the selection and clears the property panel. The saved-_current_idx restore logic at the bottom of _refresh is dead whenever a node was selected, because the local variable was already overwritten via the signal side-effect.
- **机理**: _refresh() calls self._map_scene.clear() at line 324 OUTSIDE any _syncing_selection guard. clear() emits QGraphicsScene.selectionChanged when a selected node existed (verified empirically). That re-enters _on_scene_selection_changed (line 283), which is NOT guarded, sees selectedItems()==[] and executes the 'no selection' branch: setCurrentRow(-1) and self._current_idx = -1 (lines 291-297). This runs BEFORE the restore block at line 345 reads `0 <= self._current_idx < len(...)`. Since _current_idx is now -1, the restore condition fails and the node is left deselected. Reproduced: select row 1, call _refresh(), result current_idx goes 1 -> -1, list row -> -1, 0 selected items.
- **修复方向**: Snapshot the intended index into a local before clear(): `target = self._current_idx`. Wrap self._map_scene.clear() in `self._syncing_selection = True / finally False` so the synchronous selectionChanged emission is ignored, then restore using the local `target` (not self._current_idx). Same guard should wrap any scene mutation that can drop a selected item.
- **证据**: Signal wired at line 200: `self._map_scene.selectionChanged.connect(self._on_scene_selection_changed)`. Nodes are selectable (line 132: `ItemIsSelectable`). In `_refresh()` (lines 322-326), `self._map_scene.clear()` at line 324 runs with NO `_syncing_selection` guard set. The handler `_on_scene_selection_changed` (283-300) checks `if self._syncing_selection: return` at 284 (False here), then with empty `selectedItems()` executes the no-selection branch and sets `self._current_idx = -1` at line 296. The restore block at 345-353 then evaluates `if 0 <= self._current_idx < len(...)` against the now-clobbered -1, so the condition fails and the node is left deselected.

Empirically verified two things with PySide6 (the project's binding):
1. `QGraphicsScene.clear()` DOES emit `selectionChanged` with `selectedItems()==[]` when a selected item exists.
2. Faithful replica of the selection-sync m
- **复核补充**: Mechanism is exactly right; line citations all check out (clear@324, handler@283-300 with unguarded `_current_idx=-1`@296, restore@345-353, signal connect@200, selectable flag@132). One correction to the symptom framing: the finding downplays current impact by saying the only callers `_add`/`_delete` 'deliberately pre-set _current_idx' (implying safety). Verification shows the opposite — that pre-set value is precisely what the re-entrant handler destroys. `_add` is an ACTIVE present-day bug: adding a node while another node is selected fails to select/load the new node (property panel not populated). `_delete` is incidentally unaffected only because it sets `_current_idx=-1` before refresh,

### HIGH-2. paper_craft: editing any order field silently overwrites empty correctPaper with the first paper option
- **文件**: `tools/editor/editors/paper_craft_editor.py`  **行**: 303-305, 323-331, 62-64
- **类别**: data-loss  |  **复核**: confirmed → high  |  **置信**: certain
- **现象**: Designer opens an order with no 'correct paper' set, edits its title/description/score, saves. The first paper option silently becomes the correct answer, changing minigame scoring without any visible action on the paper dropdown.
- **机理**: In _refresh_order_fields, when the order's correctPaper is empty or references a deleted/unknown paper, findData(cp) returns -1 and setCurrentIndex(i if i >= 0 else 0) silently selects paperOptions[0] in correct_paper_combo (under the _syncing guard, so not yet written). The UI now shows a paper selected while the JSON still says correctPaper="". _write_order line 330 unconditionally writes correctPaper = str(self.correct_paper_combo.currentData() or ""). _write_order is triggered by editingFinished on order_title and, crucially, by order_desc.textChanged (line 62, fires on every keystroke) and by success/warn score valueChanged. So merely typing in the title or description of an order that legitimately had no correct paper flips correctPaper from "" to the first paper id. Runtime scoring (src/systems/paperCraft/PaperCraftMinigameScene.ts:421: score += paper.score ?? (paper.id === order.correctPaper ? 12 : -6)) then awards +12 to a paper the designer never marked correct. correctPaper is optional in the runtime type (types.ts:48), so empty is a valid authored state that this corrupts.
- **修复方向**: Decouple display selection from the stored value: when correctPaper does not match any option, either insert an explicit empty/'(未设置)' sentinel item as index 0 and select it (so currentData() stays ""), or have _write_order skip writing correctPaper unless the user actually changed the combo (track a user-edited flag), or only write correctPaper when findData(cp) was >=0 originally. Do not let an index-0 display fallback feed back into _write_order.
- **证据**: paper_craft_editor.py _refresh_order_fields (lines 299-305):
  self.correct_paper_combo.clear()
  for p in o.get("paperOptions", []):
      if isinstance(p, dict):
          self.correct_paper_combo.addItem(..., str(p.get("id") or ""))   # userData = non-empty paper id
  cp = str(o.get("correctPaper") or "")          # "" when no correct paper authored
  i = self.correct_paper_combo.findData(cp)       # findData("") -> -1 (no item has empty-string data)
  self.correct_paper_combo.setCurrentIndex(i if i >= 0 else 0)   # silently selects paperOptions[0]
This runs under _syncing=True (line 292/311), so the change is NOT yet written; the combo just now *holds* paperOptions[0].id as currentData while JSON still has correctPaper="".

_write_order (lines 323-331):
  def _write_order(self):
      if self._syncing or not self._order: return
      ...
      self._order["correctPaper"] = str(self.c
- **复核补充**: Mechanism confirmed exactly as described. Two corrections to the report's citations (do not change the verdict): (1) the type lives at src/systems/paperCraft/types.ts:48 (correctPaper?: string;), NOT src/data/types.ts:48 — grep for correctPaper in src/data/types.ts returns nothing. (2) The runtime scoring is at PaperCraftMinigameScene.ts:421 as written (the finding cited 421 correctly; the comparison is `paper.id === this.order.correctPaper`). Scope precondition worth stating: the bug requires the order to have >=1 paperOption AND an empty-or-unknown correctPaper. If paperOptions is empty, the combo has 0 items, currentData() is None, and _write_order writes "" (no corruption) — so the findi

### HIGH-3. Canvas drag of an NPC/hotspot never calls mark_dirty; drag-then-switch-entity silently discards the move with no unsaved indicator
- **文件**: `tools/editor/editors/scene_editor.py`  **行**: 6226-6253, 6265-6290, 4797-4814, 2614-2623
- **类别**: data-loss  |  **复核**: confirmed → high  |  **置信**: certain
- **现象**: User drags an NPC to a new spot on the canvas, clicks another entity (or another scene) without pressing Apply, and the NPC silently jumps back to its old position; no save prompt warns them the move was discarded.
- **机理**: _on_item_moved/_on_item_position_live write rx/ry into the staging dict but never call self._model.mark_dirty (the only scene mark_dirty calls are in _apply_props L6585, _add_* L6644/6662/6685/6703, _delete_selected L6766, and the load_scene migration L6970). Staging only reaches the model via _apply_props (Apply button or Save All -> flush_to_model -> _apply_props). If the user drags an NPC and then selects a DIFFERENT entity, load_npc_props (L4810-4812) reassigns _source_npc/_staging_npc to the newly selected entity (auto-discard semantics), throwing away the dragged staging coordinates. Because mark_dirty was never called for the drag, model.is_dirty can remain False and save_all early-returns (project_model.py L305-307), so the move is lost on reload. The only feedback is the red '未应用' label (L5470-5478), which is easy to miss and is reset on every entity switch.
- **修复方向**: On any canvas drag commit (_on_item_moved), mark the scene dirty and/or auto-flush the dragged entity's staging coordinate into the model immediately (drags are atomic, unlike multi-field panel edits). At minimum, treat an un-applied drag the same as a dirty edit so Save All / scene-switch warns or auto-applies.
- **证据**: Drag handlers never call model.mark_dirty. _on_item_moved (L6265-6290) and _on_item_position_live (L6226-6253) write rx/ry into the staging dict returned by _staging_npc_for_canvas_drag (L6326)/_staging_hotspot_for_canvas_drag (L6314), then call self._props.sync_npc_xy_widgets / sync_hotspot_xy_widgets (L6252/6289). Those sync methods (L2810-2839, L2778-2808) end with self._emit_props_changed() (L2839, L2808). _emit_props_changed (L2299-2303) only does self._emit_changed_signal() + self._set_pending_dirty(True) — it never touches model.mark_dirty.

The panel's `changed` signal is not wired to any mark_dirty slot: `grep self._props.changed` in scene_editor.py returns NOTHING. The only consumer of panel dirtiness is pending_dirty_changed -> self._pending_dirty_label.setVisible (L5556-5559), i.e. the red "● 未应用" label (L5470-5478).

Commit-to-model + mark_dirty happens ONLY in _apply_props:
- **复核补充**: Mechanism is accurate as described; verdict confirmed, severity high stands (silent data-loss of authored positioning with no save prompt; only feedback is an easily-missed red label that is reset on every entity switch via _set_pending_dirty(False)).

Two clarifications/expansions, not corrections to the core defect:
1. The defect is BROADER than canvas drag. The exact same loss path applies to ANY property edit in the hotspot/npc/zone panels: every editing widget routes through _emit_props_changed (e.g. L2698/2722/2742, L3138, L4240, etc.), which sets the pending-dirty label but never calls model.mark_dirty. So editing an NPC's name/dialogue/condition and then clicking another entity witho

### HIGH-4. Switching scenes without Apply discards all staged drags of the previous scene
- **文件**: `tools/editor/editors/scene_editor.py`  **行**: 5958-6009,2587-2625
- **类别**: data-loss  |  **复核**: partial → high  |  **置信**: certain
- **现象**: Drag an entity in scene A, then click scene B in the left list. The drag is gone — reopening scene A shows the entity at its old committed position.
- **机理**: _on_scene_selected (5958) -> _load_scene (5964) overwrites self._current_scene_id, clears the canvas, and calls load_scene_props(sc, clear_pending_edits=True). It never calls _apply_props or flush_pending_to_model first. load_scene_props with clear_pending_edits=True nulls _staging_hotspot/_staging_npc/_staging_zone/_source_* and _spawn_scene (2614-2625), and rebuilds _staging_scene from the model copy. Any drag staged on the previous scene's entity (which only lives in staging until Apply) is dropped, and because the drag never marked dirty (see finding 1), save_all won't have flushed it either.
- **修复方向**: At the top of _load_scene (before reassigning _current_scene_id), commit pending staging: call self._apply_props() for the outgoing scene (or at minimum flush staging into the model and mark_dirty), guarding for _current_scene_id being None. Mirror the entity-switch short-circuit logic so an unchanged scene re-selection is a no-op.
- **证据**: Scene-switch path performs NO commit/flush before clearing staging:
- 5516: self._scene_list.currentItemChanged.connect(self._on_scene_selected)
- 5958-5962 _on_scene_selected -> self._load_scene(sid)  (no _apply_props/flush_pending_to_model)
- 5964-6009 _load_scene: sets _current_scene_id, self._canvas.clear_scene() (5972), and 6009 self._props.load_scene_props(sc, clear_pending_edits=True). No commit beforehand.
- 2614-2625 load_scene_props(clear_pending_edits=True): nulls _pending_hotspot/_pending_npc/_pending_zone and _source_hotspot/_staging_hotspot/_source_npc/_staging_npc/_source_zone/_staging_zone and _spawn_scene. Staging is the ONLY home of a staged drag.

Staging is a deep copy, so a drag on a staged entity does NOT touch the model:
- 3722-3724 load_hotspot_props: st = copy.deepcopy(hs); self._staging_hotspot = st; self._pending_hotspot = st.

The ONLY commit path is _apply_pr
- **复核补充**: Mechanism is essentially correct but the framing is over-broad. Two distinct drag paths exist (6314-6324 fallback): (A) dragging a not-yet-staged entity mutates the MODEL dict directly via item_moved firing before item_selected (1842-1847) — that move is retained in the in-memory model across a scene switch (so reopening scene A would show the NEW position), but is never mark_dirty'd so it is lost on disk save; (B) dragging the already-staged entity writes only to the deepcopy _staging_hotspot and IS discarded by load_scene_props(clear_pending_edits=True) on scene switch, matching the stated symptom. So the finding's symptom is real but only guaranteed for case B (the active staged entity), 

### HIGH-5. Switching scenes inside the Scene editor discards uncommitted staging without committing or warning
- **文件**: `tools/editor/editors/scene_editor.py`  **行**: 5958-5962, 6009, 2587-2625
- **类别**: data-loss  |  **复核**: confirmed → high  |  **置信**: certain
- **现象**: Drag an NPC in scene A, click scene B in the list, return to A — the NPC is back at its old position.
- **机理**: _on_scene_selected → _load_scene(sid) does no flush of the current scene's staging; at line 6009 it calls self._props.load_scene_props(sc, clear_pending_edits=True). load_scene_props with clear_pending_edits=True (scene_editor.py:2614-2625) nulls _staging_hotspot/_staging_npc/_staging_zone/_source_* outright. Per-entity drag edits live ONLY in those staging deepcopies (load_scene_props re-aliases hotspots/npcs/zones lists to the model at line 2599-2601, but a dragged entity's x/y were written to the SEPARATE _staging_npc copy, not the aliased list). So a dragged-but-not-Applied entity in scene A is destroyed the moment the user clicks scene B in the list, with no prompt (model not dirty).
- **修复方向**: Before _load_scene loads a new scene, commit the current scene's staging to the model (call _apply_props() or an equivalent commit), or at minimum prompt/auto-flush. Pairs naturally with the mark_dirty fix: if drag-end marked dirty and staging were committed on scene switch, no silent loss.
- **证据**: Drag persistence path proves the loss. _on_item_moved (scene_editor.py:6277-6289) for kind=="npc" calls _staging_npc_for_canvas_drag(eid) and writes the new coords into THAT returned dict:
  6278  npc = self._staging_npc_for_canvas_drag(eid)
  6281  npc["x"] = rx
  6282  npc["y"] = ry
_staging_npc_for_canvas_drag (6326-6329) returns the separate staging deepcopy when its id matches:
  6327  npc = self._props._staging_npc
  6328  if npc is not None and str(npc.get("id","")) == str(eid): return npc
That _staging_npc is a deepcopy of the model dict, created on selection in load_npc_props (4810-4813): _source_npc = npc (model dict); st = copy.deepcopy(npc); _staging_npc = st; _pending_npc = st. So the dragged x/y land ONLY in the deepcopy, never in _source_npc / the model list.

The ONLY path that copies staging back into the model is _apply_props (the Apply/Save button — save_btn.clicked.co
- **复核补充**: Confirmed exactly as described; cited line ranges (5958-5962, 6009, 2587-2625) are accurate and the deepcopy-vs-model-alias distinction is correct. Two clarifications, neither weakening the finding: (1) The data-loss path requires the NPC to be SELECTED before dragging, because _staging_npc only exists after load_npc_props runs on selection. In normal use dragging implies prior selection, so this is the ordinary path, not an edge case. If an entity could be dragged with no active panel, _staging_npc_for_canvas_drag falls through to the model list (6333-6335) and writes the model directly — but that is not the typical flow. (2) The same loss applies to staged hotspot/zone drags and to any fie

### HIGH-6. Canvas drag mutates staging but never marks the project dirty — lost on close/project-switch with no warning
- **文件**: `tools/editor/editors/scene_editor.py`  **行**: 6226-6300
- **类别**: dirty-marking  |  **复核**: confirmed → high  |  **置信**: certain
- **现象**: Drag an NPC/hotspot/spawn to a new position, then close the editor or open another project: NO 'unsaved changes' dialog appears (is_dirty is False), the app exits clean, and the drag is silently discarded on next load. The move was real on screen but never persisted.
- **机理**: _on_item_position_live (6226) and _on_item_moved (6265) write x/y onto the staging dict (or model fallback) for hotspot/npc/spawn, but neither ever calls self._model.mark_dirty. The ONLY scene mark_dirty on an edit path is inside _apply_props (6585), reachable only via the Apply button (wired at 5466) or Save All's flush_to_model->_apply_props (6302-6304). MainWindow.closeEvent (main_window.py:1282) and _confirm_can_replace_project (main_window.py:395) gate the 'unsaved changes' prompt on self._model.is_dirty; _confirm_pending_editor_changes (main_window.py:380) only checks TimelineEditor.has_pending_changes() and a generic confirm_close, and SceneEditor defines neither. So after a drag-and-release the project dirty flag is still False.
- **修复方向**: In both drag handlers, after writing staging, call self._model.mark_dirty('scene', self._current_scene_id) so the project knows the scene changed; OR give SceneEditor a confirm_close/has_pending_changes that consults props.is_pending_dirty() and the per-entity staging, and have the close/switch guards honor it. Marking dirty also makes Save All's whole-scene write actually carry the staged coords.
- **证据**: Drag handlers never mark the model dirty:
- _on_item_position_live (6226) and _on_item_moved (6265): for hotspot/npc write `hs["x"]=rx; hs["y"]=ry` onto the staging dict returned by _staging_hotspot_for_canvas_drag/_staging_npc_for_canvas_drag (6314/6326, which return `_props._staging_hotspot/_staging_npc` or fall back to the live model dict), and for spawn write onto `scw["spawnPoint"]`/`scw["spawnPoints"][eid]` via _spawn_scene_write_dict (6306). Then they call _props.sync_*_xy_widgets. NEITHER handler calls self._model.mark_dirty.
- sync_hotspot/npc/spawn_xy_widgets (2778/2810/2841) each end with `self._emit_props_changed()`. _emit_props_changed (2299) calls `self._emit_changed_signal()` and `self._set_pending_dirty(True)`. _set_pending_dirty (2305) only emits `pending_dirty_changed`, which SceneEditor wires ONLY to `self._pending_dirty_label.setVisible` (5556). The panel's `changed` 
- **复核补充**: Mechanism is accurate as described; line numbers all check out. Two refinements to the symptom: (1) An explicit "Save All" DOES persist the drag — _save_all -> _flush_editors_to_model (main_window.py:716) calls flush_to_model on every editor; SceneEditor.flush_to_model has no for_save_all kwarg so the TypeError fallback (line 734) calls flush()->_apply_props()->mark_dirty. So data loss occurs only when the user closes/switches WITHOUT manually hitting Save (the dirty prompt that would normally catch this never appears because is_dirty is False). The defect is precisely a missing dirty-prompt, leading to silent loss on the no-explicit-save path. (2) Adjacent defect spotted on the same paths: 

### HIGH-7. Entity id / name / hotspot label / scene name fields are bare QLineEdits with no change signal: edits never set the dirty flag and are silently discarded on auto-discard switch
- **文件**: `tools/editor/editors/scene_editor.py`  **行**: 3081, 3085, 4159-4160, 5009, 2458, 4042-4048
- **类别**: dirty-marking  |  **复核**: confirmed → high  |  **置信**: certain
- **现象**: Rename a hotspot/NPC/zone (or change an NPC name or hotspot label), then click another entity: the rename vanishes with zero warning (no dirty indicator ever appeared). A concrete downstream symptom: edit a zone id then edit its polygon table — _emit_zone_polygon_from_table_if_valid emits the NEW id, _staging_zone still has the OLD id, so the polygon edit is dropped from staging and the canvas (keyed by old id) is not updated.
- **机理**: self._hs_id, self._hs_label (RichTextLineEdit), self._npc_id, self._npc_name, self._zn_id, self._sc_name have NO textChanged/editingFinished connection (grep for textChanged finds only _sc_ambient_extra). Their values are pushed into the staging dict only inside _write_*_widgets_to_dict during a flush. So typing a rename/relabel does not call _emit_props_changed -> _set_pending_dirty(True); the red '● 未应用' label stays hidden. Switching entities calls load_*_props which flushes only shared scene staging and then overwrites _staging_* from the freshly deep-copied source, discarding the typed-but-unflushed text. There is no is_pending_dirty() confirmation gate on switch (is_pending_dirty exists but is never consulted before discard).
- **修复方向**: Connect these QLineEdits' textChanged (or editingFinished) to a slot that writes the value into the active staging dict and calls _emit_props_changed (mirroring _on_hs_xy_live_refresh). For RichTextLineEdit use its change signal. Optionally gate entity/scene switches on is_pending_dirty() with a discard/apply prompt.
- **证据**: All six widgets are bare QLineEdit/RichTextLineEdit with NO change-signal connection:
- L3081 `self._hs_id = QLineEdit()`; L3085 `self._hs_label = RichTextLineEdit(self._model)`
- L4159 `self._npc_id = QLineEdit()`; L4160 `self._npc_name = QLineEdit()`
- L5009 `self._zn_id = QLineEdit()`; L2458 `self._sc_name = QLineEdit()`
`grep -n "textChanged\|editingFinished"` over the whole file returns exactly ONE hit: L2550 `self._sc_ambient_extra.textChanged.connect(...)`. None of the six cited widgets ever connect to `_emit_props_changed`. Adjacent fields that DO mark dirty all wire a signal (e.g. L3101 castShadow.stateChanged, L3329 pickup_item.value_changed, L4176 dialogue_graph.value_changed), proving the six bare ones are an omission, not by design.

Dirty path: L2299-2303 `_emit_props_changed` -> `_set_pending_dirty(True)` -> `pending_dirty_changed.emit` (drives the red 未应用 toolbar label pe
- **复核补充**: Mechanism is accurate in every particular; verdict confirmed, severity high stands. One clarification to the auditor's wording: the typed text is NOT lost on a true Save All — at save, the no-arg flush_active_panel_widgets_to_staging() runs _write_*_widgets_to_dict, which reads .text() and captures the rename. The loss is scoped to entity-to-entity switches (and switching while on hotspot/npc/zone to a shared-scene flush path), where only only_shared_scene_staging=True is flushed. So this is "silent data loss on switch-before-save," not "edits never persist at all." That nuance does not lower severity: rename-then-click-next-entity is a core, common workflow and the absence of any change sig

### HIGH-8. SceneEditor canvas drag handlers never call mark_dirty — model dirtiness depends entirely on a later Apply/flush
- **文件**: `tools/editor/editors/scene_editor.py`  **行**: 6226-6263, 6265-6300
- **类别**: dirty-marking  |  **复核**: partial → high  |  **置信**: certain
- **现象**: After a Scene canvas drag, the window title shows no '*' dirty marker and Save All on a clean model can early-out via is_dirty=False before the user realizes the drag wasn't committed.
- **机理**: _on_item_position_live (drag live) and _on_item_moved (drag end) write rx/ry into the per-entity staging dict (_staging_hotspot/_staging_npc) or, for spawn, into _spawn_scene_write_dict() — but neither ever calls self._model.mark_dirty('scene', ...). Contrast map_editor._on_node_item_moved (map_editor.py:259-267) which writes the model node and immediately mark_dirty('map'), and water_minigame_editor._on_canvas_entity_moved (water_minigame_editor.py:846-854) which mutates the live _doc and calls _mark_wm_dirty. The Scene editor is the outlier: its drag persistence is coupled to _apply_props() being invoked (Apply button or Save-All flush). This is the structural reason the two gates above lose data.
- **修复方向**: Have _on_item_moved (drag-end) call self._model.mark_dirty('scene', self._current_scene_id) so the model is dirty even before Apply, matching map_editor/water_minigame. Keeping live-preview-only on _on_item_position_live is fine, but the drag-end commit should dirty the model. This alone makes the close/switch gates work even without the flush fix.
- **证据**: Mechanism CONFIRMED. In scene_editor.py the drag handlers write only to staging/model dicts and never call model.mark_dirty:
- _on_item_position_live (6226-6263) and _on_item_moved (6265-6300): for hotspot/npc they do `hs["x"]=rx; hs["y"]=ry` into the dict from _staging_hotspot_for_canvas_drag/_staging_npc_for_canvas_drag (6314-6336), for spawn into _spawn_scene_write_dict() (6306-6312); then call only sync_*_xy_widgets. No mark_dirty anywhere in these methods.
- The only dirty-marking path is sync_*_xy_widgets → _emit_props_changed (2299-2303), which calls self.changed.emit + _set_pending_dirty(True). _props.changed is NOT connected to anything at the SceneEditor level, and pending_dirty_changed connects ONLY to self._pending_dirty_label.setVisible (5555-5559) — a toolbar label, not model.mark_dirty.
- model.mark_dirty("scene", sc_id) for scene edits happens only inside _apply_props (65
- **复核补充**: Verdict 'partial' because the structural mechanism is real and high-severity, but the auditor pinned it to the wrong trigger. The Save All button is actually SAFE (flush runs before the is_dirty early-out), so the cited symptom ("Save All early-outs on a clean model") does not occur via the Save All button. The actual silent-data-loss vectors are closeEvent (main_window.py:1282-1302) and _confirm_can_replace_project (main_window.py:395-414): they check model.is_dirty without first flushing editors, and SceneEditor exposes no confirm_close/is_pending_dirty hook for _confirm_pending_editor_changes to catch the unapplied drag. Severity high is justified: an entity reposition done by canvas drag

### HIGH-9. Zone-polygon and collision-polygon drag commits write straight to the model on the fallback path but never mark dirty
- **文件**: `tools/editor/editors/scene_editor.py`  **行**: 6109-6135, 6138-6157, 6171-6190
- **类别**: dirty-marking  |  **复核**: confirmed → high  |  **置信**: certain
- **现象**: Drag a zone vertex or reshape an NPC/hotspot collision polygon on the canvas, then close or switch scenes; the new polygon is silently discarded.
- **机理**: _on_item_zone_polygon_committed, _on_item_hotspot_collision_polygon_committed, and _on_item_npc_collision_polygon_committed are wired to live canvas signals (item_zone_polygon_committed etc., connected at scene_editor.py:5526-5531). When the matching staging dict is active they write the polygon into staging; otherwise they take a fallback branch that mutates self._model.scenes[current]['zones'/'hotspots'/'npcs'] DIRECTLY (lines 6124-6132, 6147-6156, 6180-6189). Neither branch calls mark_dirty('scene'). So even a polygon edit that lands directly in the model is not flagged dirty and is lost on close/scene-switch via the same gates as findings 1/2/4. The staging branch is additionally vulnerable to clear_pending_edits.
- **修复方向**: Add self._model.mark_dirty('scene', self._current_scene_id) in all three committed-handlers (both staging and direct-model branches). Same remedy as the entity-position drag fix.
- **证据**: Signals wired to the live canvas at scene_editor.py:5526-5531:
  self._canvas.item_zone_polygon_committed.connect(self._on_item_zone_polygon_committed)
  self._canvas.item_hotspot_collision_polygon_committed.connect(self._on_item_hotspot_collision_polygon_committed)
  self._canvas.item_npc_collision_polygon_committed.connect(self._on_item_npc_collision_polygon_committed)

All three handlers (6109-6136, 6138-6163, 6171-6196) write the polygon and never call mark_dirty:
- Zone fallback (else branch) 6123-6134: `sc = self._model.scenes.get(...)` then `zone["polygon"] = poly_list`. Staging branch 6119-6122: `z_st["polygon"] = poly_list`. Neither calls mark_dirty.
- Hotspot 6146-6157: fallback sets target = hs from `sc.get("hotspots")`, then `target["collisionPolygon"] = ...; target["collisionPolygonLocal"] = True`. No mark_dirty.
- NPC 6179-6190: same pattern over `sc.get("npcs")`. No mark_d
- **复核补充**: Mechanism confirmed exactly as described; both branches are vulnerable. Two clarifications:

1) Recoverability nuance: the STAGING branch is recoverable if the user explicitly clicks Apply before switching/closing — _apply_props deep-copies staging into source and calls mark_dirty (6571-6585), so the polygon does persist on the normal "reshape then Apply" workflow. The unconditional silent-loss case is the FALLBACK branch (no matching staging dict active for that eid), where the polygon lands directly in the shared model list (zones/hotspots/npcs are intentionally shared model refs per the comment at 2597-2598) yet "scene" is never marked dirty — so save_all skips it unless some other edit d

### HIGH-10. Staging NPC/hotspot dict is a deepcopy, structurally distinct from the model object the timer/save read — proof of the read-one-write-another split
- **文件**: `tools/editor/editors/scene_editor.py`  **行**: 4810-4814, 3721-3725, 5894-5902, 6326-6336
- **类别**: staging-vs-model  |  **复核**: confirmed → high  |  **置信**: certain
- **现象**: Same as the timer finding for the user; for a maintainer it explains why 'who repositions what' diverges: the live visual, the dragged handle, and the saved file are driven by three different dict references.
- **机理**: load_npc_props sets self._source_npc = npc (the live model dict from sc['npcs'][i], L4810) and self._staging_npc = copy.deepcopy(npc) (L4811); load_hotspot_props is identical (_source_hotspot = hs L3721, deepcopy L3722). The drag handlers resolve their write target via _staging_npc_for_canvas_drag / _staging_hotspot_for_canvas_drag, which return _props._staging_npc when the id matches (L6327-6329 / L6315-6317) — i.e. the deepcopy. But _tick_scene_npc_anims iterates self._model.scenes[...]['npcs'] (L5894, L5900) — the original. Proof they are different objects: identity is the model dict in _source_npc, while edits go to the deepcopy in _staging_npc; only _apply_props/_commit_staging_dict_into (L6571-6573, source.clear()+source.update(deepcopy(staging))) reconciles them. So canvas reads model, drag writes staging, save commits a third step. (Subtlety: when NO entity panel is open, _staging_npc is None and the fallback path writes the MODEL dict directly — see the data-loss finding — which is why the bug is most visible precisely when the entity is selected.)
- **修复方向**: Either share a single dict (don't deepcopy NPC/hotspot for staging — use a field-level diff overlay) or route every reader (timer, refresh_*_visuals, draw_at) through one position resolver that knows about the active staging dict. The current 'model is canvas truth, staging is panel truth' split is the structural defect.
- **证据**: load_npc_props (L4810-4814): `self._source_npc = npc` (the live model dict from sc['npcs']), then `st = copy.deepcopy(npc); self._staging_npc = st; self._pending_npc = st; self._current_data = st`. load_hotspot_props (L3721-3725) is identical: `self._source_hotspot = hs; st = copy.deepcopy(hs); self._staging_hotspot = st; ...`. So source==model dict, staging==a distinct deepcopy.

Drag handlers resolve the write target via the staging resolvers. `_staging_npc_for_canvas_drag` (L6326-6329): `npc = self._props._staging_npc; if npc is not None and str(npc.get("id",""))==str(eid): return npc` (returns the deepcopy when an entity panel is open); `_staging_hotspot_for_canvas_drag` (L6314-6317) same. `_on_item_position_live`/`_on_item_moved` (L6240-6253 / L6277-6290) call these and write `npc["x"]=rx; npc["y"]=ry` into that staging deepcopy.

The anim timer `_tick_scene_npc_anims` (L5892-5916) 
- **复核补充**: Mechanism is accurate as described — all four cited line ranges check out (4810-4814, 3721-3725, 5894-5902, 6326-6336). One refinement to the "symptom": the visible snap-back only bites NPCs that have an active anim runtime (`_scene_npc_runtimes` non-empty, which keeps the 8ms timer alive). A static NPC with no loaded animation has no runtime ticking it, so the staged x/y survives until Save with no visual revert — the drag's own `rt.draw_at` (L6249) is a no-op path there. Hotspots have no equivalent re-drawing timer at all (only `refresh_hotspot_visuals(hs)` is called inline on the staging dict), so the hotspot half of this finding does NOT produce a snap-back; for hotspots the split is pur

### HIGH-11. Dragging or vertex-editing a NON-selected entity on the canvas writes straight into the live model dict, bypassing staging, dirty-marking, and mark_dirty
- **文件**: `tools/editor/editors/scene_editor.py`  **行**: 6314-6336, 6226-6300, 5642-5673, 6109-6135
- **类别**: staging-vs-model  |  **复核**: confirmed → high  |  **置信**: certain
- **现象**: Click-drag an entity you had not already selected (or drag a zone/patrol vertex while a different entity's panel is open): the move mutates in-memory model but the red 'unapplied' indicator never lights. If you then switch to a DIFFERENT scene before any Apply/Save All, the scene is never marked dirty and the move is silently dropped on save (save_all only writes scenes in _dirty_scene_ids).
- **机理**: _staging_hotspot_for_canvas_drag / _staging_npc_for_canvas_drag return _staging_* only when its id matches eid; otherwise they fall through to the live self._model.scenes[...] element. Because the editor's item_selected fires only on mouseRelease, a single click-drag of a previously-unselected entity runs _on_item_position_live with _staging_* still pointing at the OTHER entity, so the write lands in the model dict. The matching sync_*_xy_widgets early-returns (panel shows a different entity) so _emit_props_changed / _set_pending_dirty is never called, and no mark_dirty('scene', sid) is issued. The same model-fallback exists for _on_npc_patrol_route_committed and _on_item_zone_polygon_committed / collision committed handlers.
- **修复方向**: When a canvas edit targets a non-staged entity, either (a) route it through proper staging by first selecting/loading that entity, or (b) call self._model.mark_dirty('scene', sid) and set the pending-dirty flag at the point the model dict is mutated. Unify so canvas writes always go to one tracked location.
- **证据**: The full chain holds end-to-end. (1) Model-fallback exists in all cited handlers: _staging_hotspot_for_canvas_drag (6314-6324) and _staging_npc_for_canvas_drag (6326-6336) return the live `self._model.scenes[...]` element when staging id != eid; same fallback in _on_npc_patrol_route_committed (5663-5671: `for n in sc.get("npcs",...): target=n; pat=target.setdefault("patrol",{}); pat["route"]=norm`), _on_item_zone_polygon_committed (6123-6132: `for zone in sc.get("zones",...): zone["polygon"]=poly_list`), and the hotspot/npc collision committed handlers (6146-6157, 6179-6190).

(2) Timing: item_position_live is emitted from the dragged item's itemChange during the move (lines 551-553), and on release mouseReleaseEvent emits item_moved BEFORE item_selected (lines 1843-1847). So a click-drag of a previously-unselected entity runs _on_item_position_live/_on_item_moved while _props._staging_h
- **复核补充**: Mechanism is accurate as described. One refinement on the precondition of the symptom, not the bug itself: after the drag, item_selected fires and load_hotspot_props/load_npc_props deepcopy the (already-mutated) live dict into a fresh staging and set _source=that live dict, while calling _set_pending_dirty(False). _apply_props ALWAYS calls mark_dirty("scene", sc_id) unconditionally (line 6585) regardless of _pending_dirty. So if the user clicks Apply (or Save All while still on that scene -> flush_to_model -> _apply_props) the move IS persisted. The data loss therefore requires the user to switch to a different scene (or close without Save) before any Apply/Save on the dragged entity's scene

### HIGH-12. 8ms NPC anim timer reads COMMITTED model and snaps sprite back to stale position, fighting every staging-based edit
- **文件**: `tools/editor/editors/scene_editor.py`  **行**: 5429-5432, 5893-5916
- **类别**: timer-vs-drag  |  **复核**: confirmed → high  |  **置信**: certain
- **现象**: While dragging an NPC (or editing its x/y spinbox), the animated sprite flashes/oscillates between the cursor and the old position and visibly lags the draggable handle; it only 'sticks' to the new spot after Apply commits staging into the model.
- **机理**: _scene_npc_anim_timer (QTimer, PreciseTimer, interval=8ms, started in _rebuild_scene_npc_anim_layers L5863-5865) calls _tick_scene_npc_anims every 8ms. That handler builds npc_by_id from self._model.scenes[scene_id]['npcs'] (L5894, L5898-5902 — the COMMITTED model) and for each runtime calls rt.tick(dt, x, y) with x=float(npc.get('x')), y=float(npc.get('y')) read from the model (L5913-5915), which ends in _SceneNpcAnimRuntime.draw_at and setTransform/setPos (L407-441). Meanwhile a canvas drag of a selected NPC writes the new x/y onto _staging_npc (a deepcopy, see separate finding), NOT the model. So _on_item_position_live draws the sprite at the staging position, then within <=8ms the timer overwrites it back to the stale committed position. There is NO guard anywhere that pauses/suspends the timer during a drag or spinbox edit (grep of anim_timer.stop/start + isActive shows only scene-load/rebuild call sites).
- **修复方向**: Make the tick read the same source the drag writes: resolve each runtime's position through a single accessor that prefers _props._staging_npc when its id matches (mirroring _staging_npc_for_canvas_drag), else the model. OR suspend the timer / skip position writes for the NPC currently being dragged or live-edited (e.g. a _live_edit_npc_id set in _on_item_position_live and cleared on commit), letting draw_at from the drag handler own the position. Reading model-vs-staging inconsistently is the root cause.
- **证据**: Every link in the claimed chain checks out in tools/editor/editors/scene_editor.py:

Timer (L5429-5432):
  self._scene_npc_anim_timer = QTimer(self)
  self._scene_npc_anim_timer.setTimerType(Qt.TimerType.PreciseTimer)
  self._scene_npc_anim_timer.setInterval(8)
  self._scene_npc_anim_timer.timeout.connect(self._tick_scene_npc_anims)

Tick reads the COMMITTED model and repositions sprite (L5894, L5898-5902, L5912-5915):
  sc = self._model.scenes.get(self._current_scene_id or "")
  npc_by_id = {str(n.get("id","")): n for n in sc.get("npcs", []) ...}
  ... else:
      x = float(npc.get("x", 0)); y = float(npc.get("y", 0)); rt.tick(dt, x, y)

rt.tick -> draw_at -> setTransform repositions (L405, L436, L439):
  self.draw_at(npc_x, npc_y)  # inside tick
  t.translate(float(npc_x), float(npc_y)); ... self.item.setTransform(t)

Drag writes to STAGING deepcopy, not the model, and pushes the new p
- **复核补充**: Mechanism is accurate and severity (high) is justified — the conflict fires at ~120Hz (8ms PreciseTimer) so the sprite visibly oscillates/lags the drag handle and only "sticks" after Apply commits staging into the model.

Refinements for whoever fixes it:
1) The non-patrol path (else branch, L5912-5915) is what reads the committed model. When patrol preview is ON (rid in self._patrol_preview_ids, L5909-5911), the tick instead routes through _patrol_preview_advance, which also ignores staging (derives pos from the model patrol route) — so the staging-vs-tick conflict exists in that branch too, via a different stale source.
2) The timer cannot simply be paused during a drag: tick also advances

### HIGH-13. Free-running 8ms anim timer reads the COMMITTED model, overwriting staged NPC position every tick during both drag AND spin-box edits (the known bug, generalized)
- **文件**: `tools/editor/editors/scene_editor.py`  **行**: 5893-5916, 5924-5946, 6240-6253
- **类别**: timer-vs-drag  |  **复核**: confirmed → high  |  **置信**: certain
- **现象**: While dragging an NPC or scrubbing its x/y spin box, the animated sprite flickers/oscillates between the new staged position and the old committed position and lags the handle; it only settles after Apply commits staging into the model.
- **机理**: _tick_scene_npc_anims builds npc_by_id from self._model.scenes[current]['npcs'] (the COMMITTED model) and calls rt.tick(dt, model_x, model_y) -> draw_at(model_x, model_y) every 8ms. But interactive edits write to the per-NPC staging deepcopy _staging_npc (spin box path _on_npc_xy_live, and drag path _on_item_position_live when the dragged NPC is the selected one), leaving the model unchanged. _on_npc_xy_live_changed / _on_item_position_live each call rt.draw_at(staging) exactly once, which the next timer tick immediately reverts to the stale model position. The timer never pauses during interaction and never consults staging.
- **修复方向**: Make the tick prefer the active staging dict for the entity being edited: when rid == _props._staging_npc id, read x/y from staging instead of the model. Or pause the anim timer (or skip position writes for the actively-dragged/edited id) during interaction. Long-term, the canvas should read a single source of truth instead of the timer reading model while edits go to staging.
- **证据**: Timer setup (lines 5429-5432): `self._scene_npc_anim_timer.setInterval(8)`, PreciseTimer, `timeout.connect(self._tick_scene_npc_anims)` — free-running 8ms, never paused during interaction.

Timer reads COMMITTED model (lines 5894-5915):
  `sc = self._model.scenes.get(...)`
  `npc_by_id = {str(n.get("id","")): n for n in sc.get("npcs", []) ...}`  # committed model list
  non-patrol branch: `x = float(npc.get("x",0)); y = float(npc.get("y",0)); rt.tick(dt, x, y)`
`_SceneNpcAnimRuntime.tick` (line 405) ends with `self.draw_at(npc_x, npc_y)` — every 8ms the sprite is repositioned to committed model coords.

Staging is a separate deepcopy (lines 4810-4814): `self._source_npc = npc; st = copy.deepcopy(npc); self._staging_npc = st; self._pending_npc = st` — `_pending_npc IS _staging_npc`, both distinct from model dict `_source_npc`.

Spin-box path writes staging only (lines 4628-4643): `_on_npc
- **复核补充**: Mechanism is accurate as described. Two precisions (do not change the verdict): (1) The drag flicker manifests only for the *currently-selected* NPC. `_staging_npc_for_canvas_drag` (lines 6326-6336) returns the staging deepcopy only when its id matches the dragged eid; for a non-selected NPC dragged on canvas it falls through to the model dict (lines 6333-6335) and writes the model directly, so no flicker there. The finding correctly scopes this with "when the dragged NPC is the selected one." (2) The interactive single `draw_at` advances the sprite to the staged coord, but the next tick (<=8ms) reverts it to the stale model coord, producing the reported oscillation/lag until Apply. Severity

### HIGH-14. App close reads model.is_dirty WITHOUT flushing editors first — last canvas drag silently lost
- **文件**: `tools/editor/main_window.py`  **行**: 1282-1302
- **类别**: data-loss  |  **复核**: confirmed → high  |  **置信**: certain
- **现象**: User drags an NPC/hotspot/zone-vertex/spawn pin in the Scene editor, then quits the app (or it's the only unsaved edit). No 'unsaved changes' dialog appears and the move is gone on next launch.
- **机理**: closeEvent() calls _confirm_pending_editor_changes() (which only consults TimelineEditor.has_pending_changes + the two confirm_close editors) and then gates the Save prompt purely on `if self._model.is_dirty:` (line 1286). It never calls _flush_editors_to_model(). SceneEditor holds uncommitted edits in per-entity staging deepcopies (_props._staging_npc/_staging_hotspot/_staging_zone/_staging_scene) that are only pushed into the model — and mark_dirty('scene') only fired — by _apply_props() (scene_editor.py:6585), which runs on the Apply button or during Save All's flush. A canvas drag alone (see _on_item_moved / _on_item_position_live, scene_editor.py:6226/6265) writes to staging and never marks the model dirty. So if the user's only pending change is a dragged NPC/hotspot/spawn/zone, model.is_dirty is False, closeEvent skips the prompt, super().closeEvent runs, and the staging — hence the drag — is discarded with no warning.
- **修复方向**: In closeEvent (and any save-prompt gate), call _flush_editors_to_model() BEFORE reading self._model.is_dirty, OR have SceneEditor expose has_pending_changes()/confirm_close() like TimelineEditor so _confirm_pending_editor_changes catches staged-but-unflushed edits. Simplest: flush first, then check is_dirty. Must handle the flush raising (validation) gracefully so close can be cancelled.
- **证据**: closeEvent (tools/editor/main_window.py:1282-1302) gates the Save prompt solely on `if self._model.is_dirty:` (line 1286) after only calling `_confirm_pending_editor_changes()` (line 1283). It NEVER calls `_flush_editors_to_model()`.

`_confirm_pending_editor_changes()` (main_window.py:380-393) only handles TimelineEditor.has_pending_changes() plus editors exposing a `confirm_close` method. `grep "def confirm_close" tools/editor/editors/` returns ONLY narrative_state_editor.py:717 and dialogue_graph_editor_tab.py:67 — SceneEditor has NO confirm_close, so its pending edits are never consulted by the close path.

The flush that pushes SceneEditor staging into the model exists only on the Save-All path: `_flush_editors_to_model()` (main_window.py:716-742) iterates editors calling `flush_to_model()`. SceneEditor.flush_to_model() (scene_editor.py:6302-6304) calls `_apply_props()`, and `_apply
- **复核补充**: Mechanism is accurate and verified end-to-end. Two refinements: (1) Even when the dragged entity IS the currently-open one, `sync_hotspot_xy_widgets`/`sync_npc_xy_widgets`/`sync_spawn_xy_widgets` (scene_editor.py:2778/2810/2841) do call `_emit_props_changed()` which sets the editor's `_pending_dirty=True` and shows the red '未应用' label — but that still never reaches the model's dirty state, so the close prompt is skipped in BOTH the entity-open and entity-not-open drag cases. The finding's universal 'silently lost' claim holds. (2) When the dragged entity is NOT the currently-edited one, the handler mutates the live `self._model.scenes` dict directly rather than a deepcopy, so that particular

### HIGH-15. Open-other-project / replace-project gate also checks is_dirty without flushing — same silent drag loss
- **文件**: `tools/editor/main_window.py`  **行**: 395-414
- **类别**: data-loss  |  **复核**: confirmed → high  |  **置信**: certain
- **现象**: Drag an entity in Scene editor, then File→Open Project another folder; no save prompt, the drag is lost.
- **机理**: _confirm_can_replace_project() returns True early at line 400-401 when `not self._model.is_dirty`, after _confirm_pending_editor_changes() (which does not flush SceneEditor staging). Because a Scene canvas drag never sets model dirty (see finding above), an in-flight staged drag makes is_dirty False, the function returns True, and load_project() proceeds to call self._model.load_project(path) which clears/reloads self.scenes (project_model.py:171-176, 258-262) — destroying the staged drag with no Save prompt. Same root cause as closeEvent: is_dirty is read as the source of truth but staging is invisible to it.
- **修复方向**: Call _flush_editors_to_model() before the `if not self._model.is_dirty` check in _confirm_can_replace_project (or give SceneEditor a confirm_close/has_pending_changes that participates in _confirm_pending_editor_changes).
- **证据**: main_window.py:395-401 — _confirm_can_replace_project(): `if not self._confirm_pending_editor_changes(): return False` then `if not self._model.is_dirty: return True` (returns early, no prompt, no flush).

main_window.py:380-393 — _confirm_pending_editor_changes() only handles TimelineEditor.has_pending_changes()/confirm_apply_or_discard, then for other editors does `confirm = getattr(ed, "confirm_close", None); if callable(confirm) and not confirm(self): return False`. SceneEditor (class scene_editor.py:5422) defines NO confirm_close and NO has_pending_changes (grep confirms only flush_to_model at 6302), so it is never flushed/prompted.

scene_editor.py:1822-1846 — SceneCanvas.mouseReleaseEvent emits `self.item_moved.emit(it.entity_kind, it.entity_id, it.pos().x(), it.pos().y())`.
scene_editor.py:6265-6300 — _on_item_moved writes `hs["x"]=rx; hs["y"]=ry` / `npc["x"]=rx` / `scw["spawnPoi
- **复核补充**: Mechanism is accurate and verified end-to-end; all cited line ranges match. One refinement to the description: the drag handler writes into either a _staging_* dict (when a property panel is open on that entity) OR directly into model.scenes[...] via the fallback in _staging_hotspot_for_canvas_drag/_staging_npc_for_canvas_drag (scene_editor.py:6314-6336). In BOTH branches the edit is lost on load_project — staging because it's a detached deep copy never committed, and the live-scene branch because load_project re-reads from disk at 171-176 — so the conclusion holds regardless. Severity corrected from critical to high: this is genuine silent data-loss on a routine action (File→Open Project) w

---

## 中（MEDIUM）（22 条）

### MEDIUM-1. _redraw_edges() rebuilds ALL project edges (removeItem + recreate line/arrow/label) on every drag mouse-move tick — O(all transitions) per pixel, flicker
- **文件**: `tools/editor/editors/map_editor.py`  **行**: 154-156 (itemChange every move) -> 259-275 (_on_node_item_moved calls _redraw_edges) -> 355-451 (_clear_edge_items + _draw_edges over full scene_transitions())
- **类别**: perf-reload  |  **复核**: confirmed → medium  |  **置信**: certain
- **现象**: Edges flicker/blink and dragging gets choppy on projects with many scene transitions; scene_transitions() (full hotspot scan) is recomputed on every move. Scales with total project transition count, independent of how many touch the dragged node.
- **机理**: MapNodeGraphicsItem.itemChange fires ItemPositionHasChanged for every incremental drag step. _on_node_item_moved then calls _redraw_edges(), which _clear_edge_items() (removeItem for every existing edge item) and _draw_edges() — the latter calls self._model.scene_transitions() (a full O(scenes*hotspots) scan of the whole project) and recreates a QGraphicsLineItem + QGraphicsPolygonItem (+ optional QGraphicsTextItem) for EVERY transition in the project, not just edges incident to the dragged node. This whole teardown/rebuild runs on each mouse-move pixel during a drag.
- **修复方向**: Cache scene_transitions() and the pair/reverse sets once per drag (recompute only when transitions actually change, not on move). During a move, update only the geometry of edges incident to the moved node instead of clear-all + recreate-all; or move full redraw to drag-end (mouseReleased) and update incident edges live. Avoid removeItem/addItem churn by reusing QGraphicsLineItem objects and calling setLine().
- **证据**: Full call chain verified in tools/editor/editors/map_editor.py:

1) Per-move trigger (lines 133, 154-156): node has flag `ItemSendsGeometryChanges`; `itemChange` fires on `ItemPositionHasChanged` for every incremental drag step and calls `self._editor._on_node_item_moved(self._node_index, self.pos())`:
  155  if change == QGraphicsItem.GraphicsItemChange.ItemPositionHasChanged:
  156      self._editor._on_node_item_moved(self._node_index, self.pos())

2) `_on_node_item_moved` unconditionally calls `_redraw_edges()` on every move (line 275), no throttle / no drag-release guard:
  275  self._redraw_edges()

3) `_redraw_edges` (lines 355-365) calls `_clear_edge_items()` then `_draw_edges(pos_map)`. `_clear_edge_items` (254-257) does `self._map_scene.removeItem(it)` for every existing edge item:
  255  for it in self._edge_items:
  256      self._map_scene.removeItem(it)

4) `_draw_edges` (3
- **复核补充**: Mechanism is accurate as described. Minor refinement: "EVERY transition" is dedup'd to every distinct directed pair via `drawn_pairs` (lines 387-389), but this does not change the asymptotics — `scene_transitions()` still does a full project scan and all distinct edges are torn down and recreated each tick. Severity 'medium' is correct: editor-only UX degradation (edge flicker + choppy drag) that scales with total project transition count; no correctness, data-loss, or save-path impact. Adjacent cost in the same per-tick path: `_draw_edges` also rebuilds `pair_set`/`reverse_set` for dual-direction detection (370-378) every call, and the per-tick recreation of label `QGraphicsTextItem`s (text

### MEDIUM-2. Teardown crash: selectionChanged stays connected during GC and calls selectedItems() on an already-deleted C++ QGraphicsScene (RuntimeError)
- **文件**: `tools/editor/editors/map_editor.py`  **行**: 200, 283-300, 254-257
- **类别**: qt-lifecycle-crash  |  **复核**: confirmed → medium  |  **置信**: certain
- **现象**: Switching projects, closing the window, or otherwise destroying the Map tab can raise a RuntimeError from the dangling selectionChanged handler. Intermittent (depends on GC/teardown order) but real, and masked only inside the test harness.
- **机理**: self._map_scene.selectionChanged.connect(self._on_scene_selection_changed) (line 200) is never disconnected and the editor has no destroy()/closeEvent that blocks scene signals. When the MapEditor is torn down (project switch via _populate_tabs -> _clear_editor_stack -> deleteLater, or test GC), the QGraphicsScene C++ object can be destroyed while the Python slot is still wired; the queued/synchronous selectionChanged then runs _on_scene_selection_changed, which dereferences self._map_scene.selectedItems() -> `RuntimeError: Internal C++ object (QGraphicsScene) already deleted`. Reproduced incidentally: the traceback fired during normal GC in a test harness. The known test file test_map_editor_live_commit.py explicitly works around exactly this in tearDown (ed._map_scene.blockSignals(True) with a comment: '避免 GC 期 selectionChanged 命中半删除的 QGraphicsScene') — confirming the editor itself lacks the guard the tests have to compensate for.
- **修复方向**: Add a destroy()/closeEvent (or override deleteLater path) that disconnects self._map_scene.selectionChanged (or self._map_scene.blockSignals(True)) before the scene is destroyed. Defensively, guard _on_scene_selection_changed against a deleted scene (e.g. wrap selectedItems() access / use shiboken isValid) so a late signal is a no-op.
- **证据**: map_editor.py:200 wires the scene signal and it is NEVER torn down:
  `self._map_scene.selectionChanged.connect(self._on_scene_selection_changed)`
The slot dereferences the scene (lines 283-300):
  `def _on_scene_selection_changed(self) -> None:`
  `    if self._syncing_selection: return`
  `    sel = [ it for it in self._map_scene.selectedItems() if isinstance(it, MapNodeGraphicsItem) ]`
grep for "destroy|closeEvent|deleteLater|blockSignals|disconnect" in map_editor.py returns NO destroy/closeEvent/disconnect on _map_scene (only unrelated blockSignals on the x/y spinboxes at 486-493). The editor has no lifecycle guard for the scene signal.
Scene is parentless (line 197 `self._map_scene = QGraphicsScene()`), referenced only by `self._map_scene` and handed to the view — so its C++ lifetime vs. the slot owner (editor) is GC/teardown-order dependent.
Teardown path is real: main_window.py:51
- **复核补充**: Mechanism is accurate as described: an unmanaged selectionChanged->_on_scene_selection_changed connection with no destroy()/closeEvent, slot calls self._map_scene.selectedItems(), teardown goes through _clear_editor_stack -> deleteLater. The test's own tearDown comment is direct proof maintainers already hit this. I downgrade severity high->medium: the crash is strictly on the teardown/GC path (project switch, window close), is intermittent (order-dependent), and produces a noisy RuntimeError traceback rather than data loss, save corruption, or a broken authoring session; normal editing is unaffected. Proper fix: add a destroy()/closeEvent that disconnects the signal or calls self._map_scene

### MEDIUM-3. Map tab shows stale transition edges after scene/hotspot edits in another tab — no refresh-on-show or model-change hook
- **文件**: `tools/editor/editors/map_editor.py`  **行**: 166-252 (edges built only at __init__/_refresh); whole file has no showEvent / public refresh / reload_from_model
- **类别**: staging-vs-model  |  **复核**: confirmed → medium  |  **置信**: likely
- **现象**: Map canvas displays outdated arrows/labels (missing new transitions, showing deleted ones, wrong conditional dashing) after editing scenes elsewhere, until the Map editor is forced to _refresh (e.g. by add/delete/drag). The canvas reads one source (scene_transitions) but isn't told when that source changes.
- **机理**: Edges are derived from self._model.scene_transitions() (hotspot transition data) and drawn only during _refresh(), which runs in __init__ and on _add/_delete. There is no showEvent override, no public refresh()/reload hook, and main_window._show_stack_page (line 568) does NOT call any per-tab refresh. So if the user edits scene hotspots/targetScene/conditions in the Scene editor (which feeds scene_transitions) and then switches to the Map tab, the canvas keeps the edge set computed when the Map editor was last refreshed. Note: a full project load DOES rebuild editors via _populate_tabs (so it's fine across project switches), but intra-session cross-editor edits go stale.
- **修复方向**: Add a showEvent (or a public refresh() that main_window calls on tab activation) that re-runs _refresh() (or at least _redraw_edges()), preserving the current selection. Alternatively subscribe to a model-changed signal for scene/hotspot edits.
- **证据**: SOURCE IS LIVE DERIVED DATA — project_model.py:688-712 `scene_transitions()` recomputes edges from `self.scenes` hotspots on every call: iterates scenes, filters `hs.get("type") != "transition"`, reads `data.get("targetScene")`, `hs.get("label")`, `bool(hs.get("conditions"))`.

EDGES ONLY DRAWN ON MAP-INTERNAL OPS — map_editor.py:367-368 `_draw_edges` calls `self._model.scene_transitions()`. It is reached ONLY via `_refresh` (called __init__ line 252, `_add` line 539, `_delete` line 546) and `_redraw_edges` (line 355, called from `_on_node_item_moved`/`_on_xy_spin_changed`/`_on_scene_field_changed` — all Map-tab-internal).

NO REFRESH-ON-SHOW / PUBLIC HOOK — grep for `showEvent|def refresh|def reload|reload_from_model|def on_show` in map_editor.py returns nothing. By contrast scene_editor.py:1736, narrative_data_editors.py:551, filter_editor.py:178, anim_editor.py:280, player_avatar_edit
- **复核补充**: Mechanism is accurate as described. Minor refinement: `_redraw_edges` is also triggered by same-tab `sceneId`/`x`/`y` field edits (not only add/delete/drag), but those are all Map-tab-internal so they do not rescue cross-tab staleness — the conclusion stands. Severity medium is defensible (editor visualization staleness, no data loss/corruption — edges are a read-only view and any node drag or tab toggle forces a redraw; could arguably be low, but stale/wrong arrows can mislead authoring, so medium holds).

ADJACENT DEFECT (separate, minor): in `_draw_edges`/`_redraw_edges`, `pos_map` is keyed by `sceneId` (`pos_map[sid] = ...`, map_editor.py:334,362,364). If two map nodes share a sceneId — 

### MEDIUM-4. Clicking a node in the quest graph updates the property panel but does NOT sync the tree selection (one-way selection desync)
- **文件**: `tools/editor/editors/quest_editor.py`  **行**: 557-565, 578-593, 63-74
- **类别**: selection-sync  |  **复核**: confirmed → medium  |  **置信**: certain
- **现象**: Select quest A in the tree, then click quest B in the graph: panel shows B, graph highlights B, but the tree still highlights A. Editing fields and pressing apply edits B (correct) yet the tree never moves, so the user can easily believe they are editing A. Inconsistent highlight between the two views.
- **机理**: Tree->graph is wired: _on_tree_select calls highlight_node (quest_editor.py:590,593). Graph->panel is wired: view.node_clicked -> _on_graph_node_selected -> _show_quest_props/_show_group_props (557-565). But _on_graph_node_selected never calls self._tree.setCurrentItem(...), so after a graph click the tree's current row still points at the previously selected item. _show_quest_props sets _current_selection/_selection_type (672-676), so a subsequent _apply_quest edits the graph-clicked quest while the tree visually highlights a different one. The graph's own QuestGraphScene.node_selected/edge_selected/group_drilldown/nothing_selected signals (quest_graph_scene.py:70-73) are dead — node_selected/nothing_selected are emitted (257,271) but connected nowhere; edge_selected and group_drilldown are never even emitted — the editor instead uses the view's node_clicked, so the intended scene->editor selection channel is unused.
- **修复方向**: In _on_graph_node_selected, after resolving the node, find and setCurrentItem the matching QTreeWidgetItem (guarding currentItemChanged with blockSignals to avoid a re-entrant _on_tree_select->highlight_node loop). Optionally remove the dead QuestGraphScene signals or wire node_clicked through them to have a single selection channel.
- **证据**: Graph->panel is wired but graph->tree is not. quest_editor.py:368 `self._graph_view.node_clicked.connect(self._on_graph_node_selected)`. The handler at 557-565:
```
def _on_graph_node_selected(self, node_id: str) -> None:
    for g in self._model.quest_groups:
        if g["id"] == node_id:
            self._show_group_props(node_id); return
    for q in self._model.quests:
        if q["id"] == node_id:
            self._show_quest_props(node_id); return
```
calls ONLY _show_quest_props/_show_group_props — no self._tree.setCurrentItem. The sole setCurrentItem in the file is select_by_id (888-891), an external-nav entry point not invoked on graph click.
_show_quest_props/_show_group_props set the active selection: 657-658 `_selection_type="group"; _current_selection=gid`, 675-676 `_selection_type="quest"; _current_selection=qid`. _apply_group (701 `gid = self._current_selection`) and _ap
- **复核补充**: Mechanism is accurate as described; severity medium is appropriate (no data corruption — apply correctly targets the graph-clicked node — but the desynced tree highlight can mislead the user into thinking they are editing a different quest). Adjacent defect spotted while reading: `blank_clicked` (defined 28, emitted view-side at 73) is also connected nowhere, so clicking empty graph space clears the graph highlight (72) but leaves both the property panel and the tree pointing at the stale selection — same desync family, low severity. The dead QuestGraphScene signals (node_selected/edge_selected/group_drilldown/nothing_selected) are unused-code cruft, not themselves a runtime bug.

### MEDIUM-5. No confirmation or flush when switching scenes/entities discards unapplied scene-panel edits (auto-discard with only a passive indicator)
- **文件**: `tools/editor/editors/scene_editor.py`  **行**: 5958-5962, 5964-6011, 2587-2627
- **类别**: data-loss  |  **复核**: confirmed → medium  |  **置信**: certain
- **现象**: Change scene world size / bgm / depth tuning, then click another scene in the list without pressing Apply: the changes are silently discarded (red indicator was the only warning).
- **机理**: _on_scene_selected -> _load_scene does not call _apply_props, does not flush _staging_scene into _source_scene, and does not check _props.is_pending_dirty(). load_scene_props(clear_pending_edits=True) flushes only shared scene widgets into the OLD _staging_scene and then replaces _source_scene/_staging_scene with the NEW scene, so any un-applied scene-level edits (worldWidth/worldHeight/bgm/filter/depthConfig/onEnter/ambientSounds...) to the previous scene are dropped and the previous scene is never mark_dirty'd. Scene-panel spin/combo edits do set the dirty flag, so the red label warns — but there is no confirm dialog, so a single list click loses the edits.
- **修复方向**: Before _load_scene switches scenes, if _props.is_pending_dirty() prompt Apply/Discard/Cancel, or auto-flush the current scene panel via _apply_props. At minimum, consult is_pending_dirty() (already implemented but unused) at the switch boundary.
- **证据**: see above
- **复核补充**: Mechanism is accurate in every detail. Two refinements: (1) This is a DOCUMENTED, deliberate design ("auto-discard 语义", comments at 2286-2287 / 5468-5469 / tooltip 5475), not an overlooked flush bug — the red "● 未应用" indicator was added specifically to make the discard perceptible. So it is "data loss of unapplied in-editor staging" by design, not silent corruption: edits are never written to disk before Apply, so no saved-file data is harmed. Medium is fair given a single careless list-click discards multi-field tuning (worldWidth/Height, bgm, depthConfig, onEnter, ambientSounds) with only a passive red label as the safety net, but it is on the lower end of medium because the indicator is p

### MEDIUM-6. Spawn-pin drag in main SceneEditor can write a deepcopy staging that is dropped, and never marks dirty
- **文件**: `tools/editor/editors/scene_editor.py`  **行**: 6254-6263, 6306-6312
- **类别**: data-loss  |  **复核**: confirmed → medium  |  **置信**: certain
- **现象**: Drag the spawn pin in the main Scene canvas, then switch scenes or close — the spawn point reverts.
- **机理**: For kind=='spawn', _on_item_moved/_on_item_position_live call _spawn_scene_write_dict() (scene_editor.py:6306) which returns _props._staging_scene when it matches the current scene id, else the live model scene dict. _staging_scene deepcopies spawnPoint/spawnPoints (load_scene_props lines 2602-2611), so a spawn drag landing in _staging_scene is a copy that is only committed via commit_scene_staging_to_source() inside _apply_props. No mark_dirty is called in either branch. On scene switch _staging_scene is rebuilt from the model (losing the dragged spawn) and on close the model isn't dirty → no prompt. NOTE: the separate spawn-picker dialog's _on_canvas_moved (scene_editor.py:2004-2016) does it correctly (writes model + mark_dirty), highlighting the inconsistency in the main editor path.
- **修复方向**: In the spawn branch, write through to the model scene dict and call mark_dirty('scene', current), mirroring the spawn-picker dialog's _on_canvas_moved. If keeping staging, commit it on scene switch and dirty the model on drag-end.
- **证据**: scene_editor.py:6254-6263 (_on_item_position_live) and 6291-6300 (_on_item_moved), kind=="spawn" branch: `scw = self._spawn_scene_write_dict()` then `scw["spawnPoint"]={...}` / `scw.setdefault("spawnPoints",{})[eid]={...}`. Neither branch calls `self._model.mark_dirty`.

_spawn_scene_write_dict (6306-6312): `st = props._staging_scene; if st is not None and str(st.get("id",""))==sid: return st; return self._model.scenes.get(sid)`. Because load_scene_props always builds _staging_scene for the current scene, this returns the staging copy, not the model.

load_scene_props (2596-2612): `st = copy.deepcopy(sc)` and explicitly `st["spawnPoints"]=copy.deepcopy(...)` / `st["spawnPoint"]=copy.deepcopy(...)` then `self._staging_scene = st`. So spawnPoint/spawnPoints in staging are a detached deepcopy. (Contrast: 2599-2601 keeps hotspots/npcs/zones as SHARED model refs.)

Commit only happens in _app
- **复核补充**: Mechanism is accurate as described. Severity adjusted high→medium: the loss is real but conditional, not unconditional. The staged spawn IS persisted if the user clicks Apply (commit_scene_staging_to_source + mark_dirty) or triggers Save All (flush_to_model→_apply_props). Silent loss requires the specific sequence: drag spawn pin in main canvas → switch scene or close WITHOUT Apply/Save-All AND with no other edit having dirtied the model. A mitigating signal exists: _emit_props_changed sets _pending_dirty which shows a "未应用" toolbar label — though note that on a main-canvas spawn drag, sync_spawn_xy_widgets early-returns (spawn panel not active) so _emit_props_changed is NOT reached, meaning

### MEDIUM-7. Dragging an NPC/hotspot while a non-matching panel is open mutates the COMMITTED model directly but never marks dirty (silent model corruption / inconsistent dirty state)
- **文件**: `tools/editor/editors/scene_editor.py`  **行**: 6314-6336, 6240-6253, 2810-2816
- **类别**: dirty-marking  |  **复核**: confirmed → medium  |  **置信**: likely
- **现象**: Off-panel canvas drags either silently fail to persist (looks applied, reverts on reload) or silently persist (unintended edit saved), depending on whether other dirt exists — non-deterministic from the user's view.
- **机理**: _staging_npc_for_canvas_drag returns _staging_npc only when its id matches the dragged eid; otherwise it falls through and returns the live MODEL npc dict from self._model.scenes[...]['npcs'] (L6330-6335). So if you drag NPC 'A' while the scene panel or NPC 'B' panel is showing, the handler writes A's new x/y directly into the model (L6244-6245). But sync_npc_xy_widgets early-returns because the npc panel isn't showing the dragged id (L2812/2815), so _emit_props_changed/_set_pending_dirty are skipped, and mark_dirty is never called. Result: the model is mutated with is_dirty potentially False. On Save All with nothing else dirty, save_all returns early and the stray edit is lost on reload despite appearing applied on the canvas; if something else is dirty, the unintended move is written to disk without the user realizing.
- **修复方向**: When the drag target is the model dict (no matching staging), call mark_dirty immediately so save state is consistent; better, forbid/ignore drags on entities not currently in their staging panel, or auto-select+stage the entity on drag-start so all writes go through one path.
- **证据**: The asymmetry is real and matches the finding.

1) Staging vs model sharing. load_npc_props deepcopies the entity into staging (L4811 `st = copy.deepcopy(npc)`; same in load_scene_props L2596). But the npcs/hotspots/zones LISTS are intentionally shared with the model — load_scene_props L2597-2601:
  "# NOTE: hotspots/npcs/zones 故意共享 model 引用，保持画布右键添加/删除直写 model 的旧契约"
  for lk in ("hotspots","npcs","zones"): if lk in sc: st[lk] = sc[lk]
So `self._model.scenes[sid]['npcs'][...]` holds the live committed npc dicts.

2) The fall-through. _staging_npc_for_canvas_drag (L6326-6336): returns _staging_npc only when its id matches eid (L6327-6329); otherwise iterates `self._model.scenes.get(self._current_scene_id)['npcs']` and returns the LIVE MODEL dict (L6330-6335). Same pattern for hotspots L6314-6324.

3) The drag write. _on_item_moved npc branch (L6277-6290) does `npc["x"]=rx; npc["y"]=ry` th
- **复核补充**: Mechanism confirmed; two refinements to the description:

(a) Minor mischaracterization of the on-panel path: the finding says the on-panel drag reaches "_emit_props_changed/_set_pending_dirty ... mark_dirty." In fact _set_pending_dirty only toggles a panel-level "未应用/unapplied" label — pending_dirty_changed is connected solely to self._pending_dirty_label.setVisible (L5556-5559), NOT to model.mark_dirty. The model is dirtied for entity drags only at Apply time (_apply_props L6585) which commits staging->source. So the true contrast is: on-panel drag mutates only a deepcopy staging dict and is reversible/needs Apply; off-panel drag mutates the COMMITTED model with no staging, no Apply, and n

### MEDIUM-8. Drag of a non-selected entity sets no pending-dirty hint — user gets zero signal the staged move exists
- **文件**: `tools/editor/editors/scene_editor.py`  **行**: 2778-2808,2841-2857,6238,6263
- **类别**: dirty-marking  |  **复核**: confirmed → medium  |  **置信**: certain
- **现象**: Drag an entity that isn't the one open in the property panel: the '● 未应用' red hint does not appear, and the project isn't marked dirty — the user has no way to know the move is staged-but-unsaved, making the silent loss in findings 1-3 invisible.
- **机理**: After a drag, the only thing that flips the 'unapplied' (red) toolbar hint is _emit_props_changed, reached via sync_*_xy_widgets. But sync_hotspot_xy_widgets (2778), sync_npc_xy_widgets (2810) and sync_spawn_xy_widgets (2841) all early-return unless the dragged entity is the one currently shown in the active panel (e.g. 2781-2785). If you drag entity X on the canvas while panel shows entity Y (or the scene panel, or nothing), _pending_dirty stays False and pending_dirty_changed never fires (label wired at 5556-5557). Coupled with finding 1 (no mark_dirty), there is NO visible indication anywhere that a staged, unsaved move exists.
- **修复方向**: Always set pending-dirty (and mark_dirty) on any drag regardless of which panel/entity is active — drive it from the drag handler, not from the panel-bound sync_*_xy_widgets which is legitimately scoped to the visible entity.
- **证据**: The drag-end / drag-live handlers resolve the moved entity and mutate it, but the only dirty signal (sync_*_xy_widgets → _emit_props_changed) is gated behind an active-panel check that fails for a non-panel entity, and no mark_dirty exists in the path.

_on_item_moved (6265) / _on_item_position_live (6226):
  6269  hs = self._staging_hotspot_for_canvas_drag(eid)
  6272  hs["x"] = rx
  6273  hs["y"] = ry
  6275  self._props.sync_hotspot_xy_widgets(eid, rx, ry)   # only dirty trigger
(npc 6278-6289, spawn 6291-6300 are identical in shape; none call self._model.mark_dirty)

_staging_hotspot_for_canvas_drag (6314) returns the live MODEL dict when the entity isn't the staged/panel one:
  6315  hs = self._props._staging_hotspot
  6316  if hs is not None and str(hs.get("id","")) == str(eid): return hs
  6321  for h in sc.get("hotspots", []):
  6322      if ... str(h.get("id","")) == str(eid): r
- **复核补充**: Mechanism is accurate as described. One refinement: the staged move IS written into the in-memory model dict (the _staging_*_for_canvas_drag fallback returns the live self._model.scenes entry), so the data is not lost from RAM immediately — it is lost only because nothing marks the scene dirty, so save_all (305 early-return; 361 scene bucket gate) skips writing that scene. If the user independently dirties the same scene through any other edit before saving, the dragged move would ride along and persist; absent that, it is silently dropped with zero visual signal. This makes the bug state-dependent rather than an unconditional data loss, which keeps it at medium (not high). Adjacent defect s

### MEDIUM-9. Canvas polygon/patrol-route vertex edits commit geometry to staging but never set the pending-dirty flag
- **文件**: `tools/editor/editors/scene_editor.py`  **行**: 6109-6136, 6138-6196, 5642-5673
- **类别**: dirty-marking  |  **复核**: confirmed → medium  |  **置信**: certain
- **现象**: Drag a zone/collision/patrol vertex on the canvas: the geometry updates in staging but the red 'unapplied' indicator never appears. If you then select a DIFFERENT entity of the same kind (which overwrites that kind's _staging_* via load_*_props), the vertex edit is lost with no warning. (It does survive a direct Apply/Save All because _apply_props force-commits all three staging dicts and unconditionally marks the scene dirty.)
- **机理**: _on_item_zone_polygon_committed, _on_item_hotspot_collision_polygon_committed, _on_item_npc_collision_polygon_committed and _on_npc_patrol_route_committed write the new polygon/route into staging (or model) and then call only refresh_*_table / item_selected.emit — none call _emit_props_changed/_set_pending_dirty. refresh_*_table fills the table under its _*_updating guard, which suppresses the table's own itemChanged emit, so no dirty signal flows from there either. item_selected re-entry short-circuits when the same entity is already loaded.
- **修复方向**: Call self._props._set_pending_dirty(True) (or have the committed handlers emit a changed signal) whenever a canvas polygon/route commit writes into staging, so the unapplied indicator reflects the edit.
- **证据**: All four committed-handlers write geometry to staging/model but never mark dirty:

_on_item_zone_polygon_committed (6109): "z_st["polygon"] = poly_list" (6120) then only "self._props.refresh_zone_polygon_table(eid, poly_list)" (6135) + "self._canvas.item_selected.emit(kind, eid)" (6136). No _emit_props_changed.

_on_item_hotspot_collision_polygon_committed (6138): "target["collisionPolygon"] = ..." (6156) then QTimer.singleShot deferring "refresh_hotspot_collision_table(eid)" + "item_selected.emit('hotspot_collision', eid)" (6159-6163). No dirty.

_on_item_npc_collision_polygon_committed (6171): same pattern, "target["collisionPolygon"]" (6189) + deferred refresh + item_selected.emit (6192-6196). No dirty.

_on_npc_patrol_route_committed (5642): "pat["route"] = norm" (5671) then only "self._props.refresh_npc_patrol_table(npc_id, norm)" (5672). No item_selected.emit, no dirty.

Dirty path
- **复核补充**: Mechanism is accurate as described. One refinement: the bug is not merely cosmetic (missing red indicator). The same handlers also never call self._model.mark_dirty('scene', ...), which is the model-level flag that gates Save All / unsaved-on-quit prompts. So a canvas vertex edit made in isolation (no other property touched, Apply not pressed) is invisible to BOTH the pending-dirty indicator AND the unsaved-changes guard — quitting or switching scenes can drop it with no prompt. This is slightly worse than the finding's framing but does not raise it above medium, because any subsequent Apply (or any other edit that flips dirty) captures it, and the loss window requires the user to never pres

### MEDIUM-10. refresh_hotspot_visuals reloads QPixmap from disk and removes+re-adds the pixmap item on EVERY live drag tick -> flicker + disk I/O in the mouse-move hot path
- **文件**: `tools/editor/editors/scene_editor.py`  **行**: 1282-1329, 6237, 6274, 3544
- **类别**: perf-reload  |  **复核**: confirmed → medium  |  **置信**: certain
- **现象**: Dragging a hotspot that has a displayImage causes the preview sprite to flicker (remove/re-add each frame) and the drag feels sluggish, worsening with large source images or slow disks because the file is stat'd and decoded every mouse-move.
- **机理**: refresh_hotspot_visuals pops the existing hotspot_display item and removeItem()s it (L1290-1292), then re-reads the file path via disk_path_for_runtime_url (which does p.resolve()+is_file() stat each call, image_path_picker.py L55-62) and rebuilds the pixmap with pm_data = QPixmap(str(disk_path)) — a full image decode from disk (L1310) — then constructs a new QGraphicsPixmapItem and addItem()s it (L1317-1322). _on_item_position_live (hotspot case, L6237) and _on_item_moved (L6274) call refresh_hotspot_visuals on every emission; _DraggableCircle.itemChange emits item_position_live on every ItemPositionHasChanged (L546-553), i.e. per mouse-move during a drag. The hotspot x/y spinbox path (_on_hs_xy_live_refresh -> hotspot_visual_refresh_requested -> _on_hotspot_visual_refresh_requested -> refresh_hotspot_visuals, L3544 / L6211-6224) hits the same churn per spinbox tick.
- **修复方向**: Cache the decoded QPixmap (and resolved disk path) per (image_url, facing) so live updates only re-setPos/re-setTransform an existing QGraphicsPixmapItem instead of remove+reload+re-add. Split a cheap 'reposition existing display item' path (used during drag) from the full rebuild (used only when the image/size/facing actually changes), mirroring how collisionPolygon already updates in-place via set_points_from_model (L1343-1345).
- **证据**: refresh_hotspot_visuals (scene_editor.py L1282-1329) on EVERY call: L1290-1292 pops + removeItem()s the existing display item:
  old_disp = self._entity_items.pop(disp_key, None)
  if old_disp is not None and old_disp.scene() is self._gfx:
      self._gfx.removeItem(old_disp)
When img and ww>0 and hh>0 (L1300) it re-reads from disk:
  L1304-1308: disk_path = disk_path_for_runtime_url(self._project_model, img)
  L1310: pm_data = QPixmap(str(disk_path))   # uncached full decode
and rebuilds + re-adds a fresh pixmap item:
  L1317-1322: pix_it = QGraphicsPixmapItem(pm_data); ...; self._gfx.addItem(pix_it); self._entity_items[disp_key] = pix_it

disk_path_for_runtime_url (image_path_picker.py) stats the FS per call: L59 resolved = p.resolve(); L62 return resolved if resolved.is_file() else None.

No caching: grep shows no QPixmapCache anywhere; bare QPixmap(str(path)) at L1310 does not consul
- **复核补充**: Mechanism is fully accurate as described; every cited line checks out (image_path_picker resolve/is_file at L59/L62, inside the claimed L55-62 range). Severity medium is reasonable: editor-only (dev tool) path, scoped to hotspots that actually have a displayImage, fires only during active drag or spinbox edits, no data corruption or crash. One could argue low (dev tool, self-limited to interactive editing), but the per-frame uncached full-image decode + FS stat justifies medium, worse with large images / slow disks. Adjacent note: the natural fix mirrors the collision-polygon pattern already in the same function — cache the decoded/scaled QPixmap keyed by (image,facing) and only setPos() on 

### MEDIUM-11. Hotspot displayImage sprite is rebuilt and re-read from disk on every mouse-move during drag
- **文件**: `tools/editor/editors/scene_editor.py`  **行**: 1282-1329,6237
- **类别**: perf-reload  |  **复核**: confirmed → medium  |  **置信**: certain
- **现象**: Dragging a hotspot that has a displayImage causes visible flicker/lag of the preview image (teardown+rebuild each frame) and unnecessary disk I/O; worse for left-facing images due to per-frame mirror.
- **机理**: _on_item_position_live calls refresh_hotspot_visuals(hs) on every drag tick (6237). refresh_hotspot_visuals (1282) removeItem()s the old display item (1290-1292) and constructs a brand-new QGraphicsPixmapItem every call, reloading the bitmap from disk via QPixmap(str(disk_path)) (1310) inside the per-mouse-move hot path. With facing=='left' it additionally does QPixmap.fromImage(toImage().mirrored(True,False)) (1314) — a full-image copy+flip each frame. The display sprite is added straight to _gfx (1321), unparented from the hotspot _DraggableCircle handle, so it only tracks position via this rebuild.
- **修复方向**: Cache the QPixmap (and the mirrored variant) keyed by path+facing; during a live drag only update the existing display item's setPos/transform instead of removeItem+recreate+disk reload. Reserve the full rebuild for displayImage field edits, not coordinate changes.
- **证据**: Drag wiring is real and per-tick: _DraggableCircle.itemChange (line 541) fires on ItemPositionHasChanged during drag and emits item_position_live (lines 547-553); that signal is connected to _on_item_position_live (line 5525). _on_item_position_live, kind=="hotspot" branch, calls self._canvas.refresh_hotspot_visuals(hs) on every tick (line 6237). The staging helper (lines 6314-6324) returns the full hotspot dict including displayImage, so the rebuild path is reached.

refresh_hotspot_visuals rebuilds the sprite every call: pops + removeItem()s the old display item (lines 1290-1292), reads the bitmap fresh from disk via pm_data = QPixmap(str(disk_path)) (line 1310) with no caching layer (grep for QPixmapCache/lru_cache/pixmap_cache returns nothing), and for facing=="left" does QPixmap.fromImage(pm_data.toImage().mirrored(True, False)) — a full image copy+flip (line 1314). It then construc
- **复核补充**: Severity medium is fair — it's a real per-mouse-move teardown+rebuild + disk decode (worse for left-facing due to per-frame full-image mirror), causing flicker/lag, but it's editor-only (not shipped game), bounded to hotspots that actually have a displayImage, and only while one is being dragged, so not high. Adjacent corroborating defect: the collision-polygon half of the SAME function (lines 1330-1344+) was deliberately changed to update vertices in-place precisely to avoid removeItem in the mouse-event stack (see comment lines 1287-1288 citing a Qt crash class with patrol polylines). The display-image half was left on the teardown+rebuild path and was not given the same in-place treatment

### MEDIUM-12. Spawn-point drag writes to the staging_scene's deepcopied spawnPoint/spawnPoints, requiring Apply; drag-then-switch loses it with no dirty mark
- **文件**: `tools/editor/editors/scene_editor.py`  **行**: 6254-6263, 6291-6300, 6306-6312, 2602-2611
- **类别**: save-roundtrip  |  **复核**: partial → medium  |  **置信**: likely
- **现象**: Dragging a spawn point and then switching scene/entity without Apply reverts the spawn position; off-panel spawn drags can silently fail to persist.
- **机理**: _on_item_position_live/_on_item_moved (spawn case) resolve the write target via _spawn_scene_write_dict, which returns _props._staging_scene when its id matches the current scene (L6308-6311), else the model scene. In load_scene_props, _staging_scene's spawnPoint and spawnPoints are independent deepcopies of the model's (L2602-2611), so spawn drags into staging_scene do NOT reach the model until commit_scene_staging_to_source runs in _apply_props (L2911-2926 copies non-list keys incl. spawnPoint/spawnPoints back to source). As with NPC/hotspot, no mark_dirty is called on the drag, and switching scenes / entities without Apply re-deepcopies staging_scene (load_scene_props L2596-2611) and drops the un-applied spawn move. sync_spawn_xy_widgets does call _emit_props_changed (L2857) only when the spawn panel is the active widget, so off-panel spawn drags also leave no pending-dirty.
- **修复方向**: Same remedy as the NPC drag: mark scene dirty on spawn drag commit and/or immediately reflect the dragged coordinate into the model. Ensure the spawn write target and any future spawn visual reads share one source.
- **证据**: Core mechanism CONFIRMED:
- Spawn drag write target is the deepcopy, not the model. `_on_item_moved`/`_on_item_position_live` (spawn case, L6291-6300 / L6254-6263) call `_spawn_scene_write_dict()`, which returns `props._staging_scene` when its id matches the current scene (L6306-6312: `if st is not None and str(st.get("id","")) == sid: return st`). For a normally-loaded scene `_staging_scene` is non-None (set on every scene load).
- `_staging_scene`'s spawnPoint/spawnPoints are independent deepcopies of the model (load_scene_props L2602-2611: `st["spawnPoints"] = copy.deepcopy(sp_dict)`, `st["spawnPoint"] = copy.deepcopy(sp_pt)`), so spawn drags do NOT reach the model until Apply.
- Apply path commits them: `commit_scene_staging_to_source` (L2911-2926) copies every non-{hotspots,npcs,zones} key (incl. spawnPoint/spawnPoints) `src[key] = copy.deepcopy(val)`; called from `_apply_props` L65
- **复核补充**: Mechanism is real and accurately traced for the scene-switch path; the only error is conflating entity-switch with scene-switch (entity-switch within the same scene does NOT drop the move — _staging_scene is not rebuilt there). The genuinely silent-data-loss path is the off-panel spawn drag (no pending-dirty indicator) followed by a scene switch; the on-panel spawn-you're-editing drag does set pending-dirty via sync_spawn_xy_widgets→_emit_props_changed, giving a visual 'unapplied' cue, so that sub-case is recoverable. Medium is appropriate: silent loss on a real interaction path, but gated behind off-panel + no-Apply + scene-switch, and the most common on-panel case is dirty-tracked. Could b

### MEDIUM-13. Editing entity x/y in the spin boxes moves the sprite/collision but NOT the draggable handle circle (sprite/handle desync, inverse of the canvas-drag bug)
- **文件**: `tools/editor/editors/scene_editor.py`  **行**: 3526-3544, 5924-5946, 1282-1362, 6359-6408
- **类别**: sprite-handle-sync  |  **复核**: confirmed → medium  |  **置信**: certain
- **现象**: User edits NPC/hotspot X or Y numerically: the character art and collision shape move, but the colored selection dot (and its interaction-range ring and label) stay frozen at the pre-edit spot. The handle and sprite visibly separate until Apply snaps them together.
- **机理**: The visible NPC anim sprite (_SceneNpcAnimRuntime.item), the hotspot displayImage pixmap, and the collision polygon are all SEPARATE graphics items from the _DraggableCircle handle. _on_hs_xy_live_refresh (hotspot) and _on_npc_xy_live -> _on_npc_xy_live_changed (npc) write x/y into the staging dict and then refresh ONLY the display image / collision polygon / anim sprite via refresh_hotspot_visuals / refresh_npc_collision_visuals / rt.draw_at. None of these touch the hotspot:/npc: _DraggableCircle. A grep confirms the circle is repositioned by setPos only in __init__ (486) and the after-commit sync (6374, 6403) — there is no live setPos on spin-box edit. So typing into the x/y boxes makes the picture/collision jump while the clickable dot stays at the old location until Apply.
- **修复方向**: In _on_hs_xy_live_refresh and _on_npc_xy_live_changed, after writing staging x/y, also reposition the handle: look up self._canvas._entity_items[f'hotspot:{eid}'] / [f'npc:{eid}'] and call item.setPos(x, y) (guarding the resulting itemChange->item_position_live re-entry). Same applies to the spawn panel sp_x/sp_y path.
- **证据**: The _DraggableCircle handle (with its range-outline child at 508-526 and _label child at 499-506) is a SEPARATE graphics item from the display pixmap / collision polygon / anim sprite. Keys differ: handle = f"hotspot:{id}" (1279) / f"npc:{id}" (1422); display = f"hotspot_display:{id}" (1322); collision = f"hotspot_collision/npc_collision:{id}" (1356/1401); anim sprite = _SceneNpcAnimRuntime.item.

HOTSPOT live path: _hs_x/_hs_y.valueChanged -> _on_hs_xy_live_refresh (3087/3090). Writes hs["x"]/hs["y"] (3531-3532), emits hotspot_visual_refresh_requested (3544) -> _on_hotspot_visual_refresh_requested (6211) -> refresh_hotspot_visuals (1282). refresh_hotspot_visuals only setPos's the display pixmap (1318 `pix_it.setPos(cx-ww*0.5, cy-hh)`) and rebuilds/moves the collision polygon. It NEVER touches the f"hotspot:{id}" _DraggableCircle.

NPC live path: _npc_x/_npc_y.valueChanged -> _on_npc_xy_
- **复核补充**: Mechanism, file, line numbers, and symptom are all accurate -> confirmed. Severity nuance: this is a live-preview cosmetic desync that self-corrects on Apply. The spin boxes write the correct x/y into the staging dict (3531-3532 / 4632-4633), so there is no data corruption or persisted error; only the on-canvas handle, range ring, and label lag visually until commit. That makes it a real, reproducible UX defect but not data-threatening, so medium fits better than high. The asymmetry the finding names is real: the canvas-drag direction _on_item_position_live (6226) correctly calls sync_hotspot_xy_widgets (6238) to push the dragged position back into the spin boxes, but the inverse (spin-box e

### MEDIUM-14. Switching to a different entity discards the previous entity's staged drag (auto-discard, no commit)
- **文件**: `tools/editor/editors/scene_editor.py`  **行**: 6028-6084,3713-3725,4811-4812,5245-5246
- **类别**: staging-vs-model  |  **复核**: partial → medium  |  **置信**: certain
- **现象**: Drag hotspot A, then (without Apply) click hotspot B. A's drag is silently discarded; A reverts to its committed x/y. Same for NPC and zone.
- **机理**: _on_item_selected (6028) routes a canvas/list click to load_hotspot_props/load_npc_props/load_zone_props. Those reassign _source_* = new entity and _staging_* = deepcopy(new) (e.g. 3721-3723, 4811-4812, 5245-5246). For hotspot/npc/zone the switch only flushes shared scene staging (flush_active_panel_widgets_to_staging(only_shared_scene_staging=True), 3718) — the OUTGOING entity's _staging_* (which holds an uncommitted drag) is never committed to its source/model; it is overwritten ('auto-discard' per the code comment at 2753). Combined with finding 1 (drag never marks dirty), the staged move is lost unless the user clicked Apply while that entity was selected.
- **修复方向**: Before reassigning _source_*/_staging_* in load_*_props, if the outgoing staging differs from its source, commit it into the model and mark_dirty (an _apply_props-style commit for that one entity), or explicitly flush per-entity staging the way scene/spawn staging is flushed. Alternatively, mark_dirty on every drag (finding 1) plus commit-on-switch so Save All / switch preserves it.
- **证据**: CONFIRMED — core mechanism is real:
1) Drag release writes new x/y into staging only, never into source/model. `_on_item_moved` (6272-6273): `hs["x"]=rx; hs["y"]=ry` operating on `_staging_hotspot` (via `_staging_hotspot_for_canvas_drag`, 6314-6317); npc equiv 6281-6282. No write to `_source_*` or `self._model`.
2) On switch, load_hotspot_props/load_npc_props/load_zone_props reassign source+staging to the new entity, discarding the outgoing staging: 3721-3723 (`self._source_hotspot = hs; st = copy.deepcopy(hs); self._staging_hotspot = st`), 4810-4812, 5244-5246.
3) The only flush on switch is flush_active_panel_widgets_to_staging(only_shared_scene_staging=True) (3718/4799/5241), which returns at 2767-2768 (`if only_shared_scene_staging: return`) WITHOUT touching entity staging. Comment 2752-2754 explicitly: hotspot/npc/zone staging "切换会被新选中实体的 _staging_* 整体覆盖（auto-discard）".
4) The only 
- **复核补充**: Mechanism confirmed but mis-described and over-severitied. Correct mechanism: entity (hotspot/npc/zone) drags are staged-only; switching entities reassigns staging/source to the new entity (auto-discard by design, 2752-2754 and 5468-5476), with no commit-on-switch and no save prompt, so an un-Applied drag is lost on switch — a real usability footgun. Downgrade high->medium because: (a) it is intentional, documented auto-discard semantics, not accidental data corruption; (b) contrary to the finding, a drag DOES set _pending_dirty and shows the red "未应用" indicator (2808/2839 -> _emit_props_changed -> _set_pending_dirty(True)), so the user IS given feedback that unapplied changes exist and that

### MEDIUM-15. Free-running 8ms NPC anim timer reads committed model coords and snaps the sprite back during drag
- **文件**: `tools/editor/editors/scene_editor.py`  **行**: 5429-5432,5893-5916,6240-6253,5824-5851
- **类别**: timer-vs-drag  |  **复核**: confirmed → medium  |  **置信**: certain
- **现象**: Dragging an NPC that has a scene anim preview: the animated sprite flickers/oscillates between the cursor position and the old committed position, lagging the draggable circle. Cosmetic but makes precise placement hard.
- **机理**: _scene_npc_anim_timer is a PreciseTimer at 8ms (5431) that calls _tick_scene_npc_anims (5893). The tick builds npc_by_id from self._model.scenes[current]['npcs'] — the COMMITTED model (5898-5902) — and calls rt.tick(dt, x_model, y_model) -> rt.draw_at (5915, 385/405). The NPC preview sprite (QGraphicsPixmapItem) is added directly to the graphics scene (5830), UNPARENTED from its _DraggableCircle handle. During a drag, _on_item_position_live writes the new x/y to _staging_npc only (6244-6245) and pushes one rt.draw_at(rx,ry) (6249); 8ms later the timer overwrites it with the stale model coord. The handle (which moves freely) and the sprite (snapped back to model) diverge and oscillate.
- **修复方向**: Make the tick read the same source the drag writes: prefer props._staging_npc when its id matches (mirror _staging_npc_for_canvas_drag at 6326), or pause/skip position updates for the entity currently being dragged, or parent the preview sprite to the handle so it follows automatically and only let the timer drive the frame (not position) for the active entity.
- **证据**: Timer setup (lines 5429-5432): `self._scene_npc_anim_timer = QTimer(self)` / `.setTimerType(Qt.TimerType.PreciseTimer)` / `.setInterval(8)` / `.timeout.connect(self._tick_scene_npc_anims)`. No drag-active guard pauses it — the only `.stop()` calls are at 5614 (cleanup), 5883 (no runtimes), 5896 (scene missing); none fire during a drag.

Tick reads the COMMITTED model (lines 5894-5915): `sc = self._model.scenes.get(self._current_scene_id ...)`; builds `npc_by_id` from `sc.get("npcs", [])`; else-branch does `x = float(npc.get("x", 0)); y = float(npc.get("y", 0)); rt.tick(dt, x, y)`. `_SceneNpcAnimRuntime.tick` (385-405) always ends with `self.draw_at(npc_x, npc_y)` regardless of frame count, so it repositions the sprite every 8ms.

Preview sprite is an unparented item added directly to the scene with movement disabled (5824-5830): `item = QGraphicsPixmapItem()` ... `item.setFlag(...ItemIsM
- **复核补充**: Mechanism is accurate in every load-bearing detail. One nuance the finding omits: the bug only manifests when the dragged NPC is the currently-STAGED entity (the normal click-then-fine-tune / second-drag workflow). On the very first drag motion of a freshly-clicked NPC, `item_selected` (hence `load_npc_props` that creates `_staging_npc`) only fires on mouse RELEASE (line 1847), so during that first gesture `_staging_npc` may not yet match the eid and `_staging_npc_for_canvas_drag` falls through to the model dict (6333-6335) — writing directly to the same dict the timer reads, so no divergence that one time. The oscillation is thus reliably present for precise repositioning (the exact reporte

### MEDIUM-16. Sugar wheel canvas reloads every image from disk (QPixmap(path)) on every full refresh, and config spinbox/combo edits trigger a full canvas rebuild per change
- **文件**: `tools/editor/editors/sugar_wheel_editor.py`  **行**: 59-68, 292-437, 1088-1089, 1655-1698
- **类别**: perf-reload  |  **复核**: partial → medium  |  **置信**: certain
- **现象**: Dragging/scrubbing any numeric field (wheel scale, pointer offset, drag/accel tuning, etc.) makes the preview flicker and stutter; the wheel/pointer/charge handles visibly rebuild and the view re-fits on each tick because refresh() ends with self._fit() (437).
- **机理**: _load_runtime_pixmap calls QPixmap(str(p)) with no cache (59-68). SugarWheelCanvas.refresh() does self._scene.clear() then reloads background, wheel, pointer, foreground from disk every call (306,322,323,370 each invoke _load_runtime_pixmap). _on_config_changed (1655-1698) writes all scalar fields then calls self._mark_dirty() with the default refresh_canvas=True, and _mark_dirty (1084-1089) calls self._canvas.refresh(self._doc). Every QDoubleSpinBox.valueChanged (wired at 1053 for ~30 spinboxes) and every QComboBox.currentTextChanged (1019-1021) thus tears down and rebuilds the whole scene AND re-decodes 4 PNGs from disk. Holding a spin arrow or scrubbing produces a storm of disk reloads.
- **修复方向**: Add a QPixmap cache keyed by resolved disk path+mtime in _load_runtime_pixmap. For pure geometry/scale fields, prefer in-place updates (setScale/setPos on existing items) instead of full scene rebuild, or debounce _mark_dirty's canvas refresh. Many config fields don't need a rebuild at all (e.g. physics-only params like spinLinearDragPerSec) — gate refresh_canvas to only the fields that affect the drawn layout.
- **证据**: Mechanism confirmed end-to-end in tools/editor/editors/sugar_wheel_editor.py:

1) No pixmap cache. Lines 59-68: `_load_runtime_pixmap` resolves via `disk_path_for_runtime_url(...)` then `pm = QPixmap(str(p))` — a fresh decode every call. `disk_path_for_runtime_url` (image_path_picker.py:47-62) also has no cache (resolves + `is_file()` each time). grep for `QPixmapCache`/`@lru_cache`/`_pixmap_cache` in the editor returns nothing.

2) Full scene teardown + 4 disk reloads per refresh. `refresh()` (292-437): line 297 `self._scene.clear()`; line 306 bg `_load_runtime_pixmap`; lines 322-323 wheel + pointer `_load_runtime_pixmap`; line 370 foreground `_load_runtime_pixmap`; rebuilds all items; ends with `self._fit()` at line 437.

3) Config edits trigger full rebuild. `_on_config_changed` (1655-1698) writes ~30 scalar fields then calls `self._mark_dirty()` (default arg). `_mark_dirty` (1084-108
- **复核补充**: Mechanism is real and accurately traced; severity medium is appropriate (editor-only authoring perf, no runtime/gameplay impact; only stutters the preview during tuning). Only the symptom phrasing is inaccurate: the config spinboxes use ButtonSymbols.NoButtons (line 1012) so there is no spin arrow to hold — the actual trigger is per-edit valueChanged during typing/scrubbing. Adjacent note: `_on_images_changed` (1650-1653) also calls `_mark_dirty()` with default refresh_canvas=True, but that path is legitimate (image URLs actually changed). The wasteful path is specifically the scalar-config one, which never alters any of the 4 image URLs yet re-decodes all 4 PNGs every tick. A targeted fix: 

### MEDIUM-17. Per-edit full pixmap reload + re-tint from disk in refresh-one-row hot path (depth/category/id keystrokes -> flicker/lag)
- **文件**: `tools/editor/editors/water_minigame_canvas.py`  **行**: 25-34, 501-518, 273-298
- **类别**: perf-reload  |  **复核**: confirmed → medium  |  **置信**: certain
- **现象**: Scrubbing the depth spinbox or typing in the id/category field visibly flickers/lags the sprite because each step round-trips the image through disk decode + re-tint. Worse with large sprite PNGs.
- **机理**: refresh_entity_row() calls _load_runtime_pixmap (path.resolve() + is_file() stat + full QPixmap(path) decode) and then re-tints the pixmap (a second QPixmap allocation + QPainter Multiply pass) on EVERY single-row refresh, regardless of which field changed. The editor calls update_marker_visual -> refresh_entity_row from _on_ent_id_changed, _on_ent_scalar_changed (category), _on_ent_sprite_changed, and _on_ent_scalar_changed_spin (depth). depth and category are QDoubleSpinBox/QComboBox firing on every step/keystroke, and id is a QLineEdit firing per character — so editing depth re-decodes the source PNG from disk and rebuilds the tinted pixmap per step, even though the bytes on disk never changed. There is no QPixmap cache anywhere in the canvas.
- **修复方向**: Cache decoded source QPixmaps by runtime URL (dict url->QPixmap) in the canvas; only reload when the sprite URL actually changed. For depth/category/id-only changes, skip the disk decode entirely and re-tint/re-scale from the cached base pixmap (or, for id, just update tooltip/z).
- **证据**: canvas refresh_entity_row (lines 504-518) unconditionally reloads + re-tints:
  512: raw_pm = _load_runtime_pixmap(self._model, str(ent.get("sprite") or ""))
  516: it.refresh_geometry_from_ent(ent, pm, ambient=self._ambient)

_load_runtime_pixmap (lines 25-34) does disk round-trip every call:
  30: disk = disk_path_for_runtime_url(model, u)      # path resolution
  31: if disk is None or not disk.is_file():          # stat syscall
  33: pm = QPixmap(str(disk))                          # full PNG decode

refresh_geometry_from_ent re-tints (allocates 2nd pixmap + QPainter Multiply pass):
  286: vis_pm = _tint_pixmap_visual(scaled, depth, ambient, glow)
_tint_pixmap_visual (135-144):
  137: out = QPixmap(pm.size())
  140: p.drawPixmap(0, 0, pm)
  141: p.setCompositionMode(QPainter.CompositionMode_Multiply)
  142: p.fillRect(out.rect(), QColor(tr, tg, tb))

update_marker_visual -> refresh_e
- **复核补充**: Mechanism is accurate as written. Two corroborating details strengthen it: (1) _ent_depth is a QDoubleSpinBox with no setKeyboardTracking(False), so typing digits into it emits valueChanged per intermediate value — confirming per-step re-decode. (2) The id path (_on_ent_id_changed) does NOT change sprite/depth/category at all, yet still triggers a full disk reload + re-tint per character and produces a byte-identical tinted pixmap — pure waste, reinforcing the finding rather than weakening it. Severity 'medium' is appropriate: this is editor-only (not shipped game code), causes UX lag/flicker but no correctness/data issue, and is bounded to single-row refresh of one selected entity. Adjacent

### MEDIUM-18. Selection re-entrancy gap: removing the selected item during refresh() fires entity_selected(-1) back into the editor while the silent-select guard is still off
- **文件**: `tools/editor/editors/water_minigame_canvas.py`  **行**: 474-491, 428-435
- **类别**: selection-sync  |  **复核**: confirmed → medium  |  **置信**: likely
- **现象**: During canvas rebuilds (entity add/remove, instance switch, bounds/surface edits) a spurious deselect(-1) callback runs mid-rebuild. Combined with the lazy action flush it can trigger an unintended action write against a stale row, and momentarily clears the property form.
- **机理**: In refresh(), the loop at lines 474-475 calls scene.removeItem(it) for every existing item BEFORE _silent_select is set to True (set only at line 487). Removing a currently-selected QGraphicsItem emits QGraphicsScene.selectionChanged synchronously. Because _silent_select is still False, _on_scene_selection_changed runs, finds no EntitySpriteItem selected, and emits entity_selected(-1). That re-enters the editor's _on_canvas_entity_selected(-1) in the MIDDLE of refresh(), which mutates _prev_ent_row/_selected_ent_row to -1, can call _flush_actions_for_entity_row(old) against a row whose meaning is mid-transition, and calls _fill_entity_form(None) — all before refresh() finishes re-adding items and re-selecting the intended row.
- **修复方向**: Set self._silent_select = True before the removeItem loop (wrap the entire item teardown+rebuild+reselect in the guard), and only clear it after re-selection at line 491. Use try/finally so the guard is always restored.
- **证据**: water_minigame_canvas.py refresh() removes items before arming the guard:
  474:        for it in self._items:
  475:            self._scene.removeItem(it)
  476:        self._items.clear()
  ... (re-add items) ...
  487:        self._silent_select = True
  488:        self._scene.clearSelection()

Selection handler that re-enters (guard still False during the loop):
  428    def _on_scene_selection_changed(self) -> None:
  429        if self._silent_select:
  430            return
  ...
  435        self.entity_selected.emit(-1)

EntitySpriteItem is selectable, so the removed item IS in the scene selection set:
  258:        self.setFlag(QGraphicsItem.GraphicsItemFlag.ItemIsSelectable, True)

EMPIRICALLY VERIFIED (PySide6, offscreen): scene.removeItem(selected_item) emits selectionChanged SYNCHRONOUSLY — the signal fired immediately after removeItem, before processEvents. A faithful rep
- **复核补充**: CONFIRMED, and the finding slightly understates the harm. The "unintended action write against a stale row" is real and persistent, not just a flicker. In _reload_entities_canvas (entity add via _on_canvas_place_entity, remove via _remove_entity, instance switch), lines 826-827 set _prev_ent_row to the NEW target row before _refresh_canvas_visual() at 828; the synchronous re-entrant _on_canvas_entity_selected(-1) then runs _flush_actions_for_entity_row(new_row), which calls _ae_assign(entities[new_row]) and stamps the action editors' still-loaded PREVIOUS-entity onPick/onPullSuccess/onPullFail lists onto the new/just-reindexed entity — before _fill_entity_form reloads at line 830. For a fres

### MEDIUM-19. Instance-level edits (surface time/weather, bounds, waterBottom) tear down and rebuild ALL entity items with full disk reload per spinbox step
- **文件**: `tools/editor/editors/water_minigame_editor.py`  **行**: 691-716, 779-808
- **类别**: perf-reload  |  **复核**: confirmed → medium  |  **置信**: certain
- **现象**: Adjusting bounds width/height, waterBottom depth, or toggling surface time/weather causes the whole canvas (backdrop + all sprites) to flash and rebuild, with cost scaling by entity count and image sizes.
- **机理**: _on_surface_changed, _on_bounds_changed, and _on_wb_changed each call _refresh_canvas_visual(), which calls canvas.refresh() — a full teardown (removeItem of every entity) and rebuild that re-decodes EVERY entity's sprite from disk (water_minigame_canvas.py:474-485) and re-tints each. _bounds_w/_bounds_h are QSpinBoxes whose valueChanged fires on every increment; the backdrop texture is also re-decoded and re-scaled each time. So nudging the bounds value or the waterBottom depth steps through a complete canvas rebuild + reload of all sprites + backdrop per step.
- **修复方向**: Separate cheap geometry updates (setSceneRect + reposition existing items, re-tint from cached pixmaps for ambient changes) from full rebuilds. Only call the full refresh() when entity membership changes; for bounds/surface/wb tweaks update the backdrop and re-tint in place using cached base pixmaps.
- **证据**: Handlers (water_minigame_editor.py 691-716) all call _refresh_canvas_visual() unconditionally after the _loading/_doc guard:
  699:  _on_surface_changed -> self._refresh_canvas_visual()
  706:  _on_bounds_changed  -> self._doc["bounds"]={...}; self._refresh_canvas_visual()
  716:  _on_wb_changed      -> self._refresh_canvas_visual()
_refresh_canvas_visual (779-808) builds args and calls self._canvas.refresh(bounds_wh, texture_url, tint_hex, entities, selected_row, ambient) every time — no diffing / no early-out.

canvas.refresh (water_minigame_canvas.py 453-492) is a full teardown+rebuild:
  471:  pm = _load_runtime_pixmap(self._model, texture_url)   # backdrop re-decoded
  472:  self._scene.set_backdrop(pm, tint_hex)                # re-tint/re-scale
  474-476: for it in self._items: self._scene.removeItem(it); self._items.clear()
  478-485: for each entity: raw_pm = _load_runtime_pixma
- **复核补充**: Mechanism is accurate. One minor descriptive imprecision: _wb_depth has setButtonSymbols(NoButtons) (line 209), so it is typed/scrolled rather than arrow-stepped; only the bounds QSpinBoxes (187-190) literally step via buttons. But valueChanged still fires per keystroke/scroll on depth, so the per-change full-rebuild cost holds for all three handlers — does not change the verdict. Backdrop is also re-decoded+re-tinted each call (471-472), as claimed. Severity medium is correct: editor-only perf/UX (canvas flash + lag scaling with entity count and image size), no correctness or data-integrity impact. Adjacent point supporting the fix: refresh_entity_row (504-518) already does targeted single-

### MEDIUM-20. _on_canvas_entity_selected is not guarded against re-entrancy/self-selection during programmatic canvas updates
- **文件**: `tools/editor/editors/water_minigame_editor.py`  **行**: 832-844
- **类别**: selection-sync  |  **复核**: partial → medium  |  **置信**: speculative
- **现象**: Edge-case form/selection desync and an action flush triggered by a programmatic selection event during rebuilds; latent if more programmatic selection paths are added.
- **机理**: _on_canvas_entity_selected has no _loading guard. It is invoked by the canvas's selectionChanged signal. While the canvas guards its own programmatic selection with _silent_select, the gap in finding 5 (removal before guard) means this handler can fire with row=-1 mid-rebuild, and any future code path that programmatically changes scene selection outside the _silent_select window would re-enter here, mutating _selected_ent_row/_prev_ent_row and refilling the form during another operation. The handler also flushes actions (line 835) as a side effect of mere selection, so a spurious selection event mutates entity data.
- **修复方向**: Close the canvas guard gap (finding 5) and/or add an editor-side re-entrancy guard around selection-driven handlers; do not perform action flushes purely on a selection-changed event — flush on explicit row commit only.
- **证据**: The core mechanism is real. `_on_canvas_entity_selected` (water_minigame_editor.py:832-844) has NO `_loading` guard and flushes action data on mere selection:

  832  def _on_canvas_entity_selected(self, row: int) -> None:
  833      old = self._prev_ent_row
  834      if old >= 0 and old != row:
  835          self._flush_actions_for_entity_row(old)   # <-- data write on selection
  836      self._prev_ent_row = row
  837      self._selected_ent_row = row

The "removal before guard" gap is confirmed in the canvas `refresh` (water_minigame_canvas.py:474-491). Items are removed from the scene BEFORE the `_silent_select` guard is armed:

  474  for it in self._items:
  475      self._scene.removeItem(it)      # selected item removed -> Qt emits selectionChanged
  476  self._items.clear()
  ...
  487  self._silent_select = True          # guard armed only AFTER removal
  488  self._scene.cl
- **复核补充**: CONFIRMED mechanism, but the finding mis-severities it as "low" and mis-frames it as "latent / only if more programmatic selection paths are added." It is reachable TODAY through ordinary `_add_entity` (line 1020), `_duplicate_entity`, and `_remove_entity` (line 1029) — each calls `_reload_entities_canvas` while a previous entity was selected, which triggers `refresh()`, which removes the selected scene item before the guard. Because the spurious flush writes stale action-editor contents into the clamped new row and `_fill_entity_form` never writes back, this can silently corrupt an entity's onPick/onPullSuccess/onPullFail lists (e.g., copying the deleted entity's actions onto its neighbor a

### MEDIUM-21. Deleting an entity flushes the deleted entity's action lists into the entity that shifts up into its slot (data corruption)
- **文件**: `tools/editor/editors/water_minigame_editor.py`  **行**: 1022-1029, 810-826, 550-558, 1260-1263
- **类别**: staging-vs-model  |  **复核**: partial → medium  |  **置信**: likely
- **现象**: Delete an entity that had onPick/onPullSuccess/onPullFail actions; the next entity (which moved up into the deleted slot) silently loses its own actions and inherits the deleted entity's actions. Persists to JSON on save.
- **机理**: Action lists (onPick/onPullSuccess/onPullFail) are NOT written into the entity dict at edit time — the ActionEditor.changed signal only calls _mark_wm_dirty (line 384). The actual write happens lazily in _ae_assign(ent) via _flush_actions_for_entity_row(row), which unconditionally assigns the three ActionEditors' current contents to whatever dict sits at index `row`. _remove_entity (line 1022) does `ents.pop(row)` BEFORE updating _prev_ent_row, then calls _reload_entities_canvas. Inside _reload_entities_canvas, `old = self._prev_ent_row` is still the OLD (now-removed) index; since `old != row` (clamped new selection), it calls _flush_actions_for_entity_row(old). After the pop, index `old` now points at the entity that shifted up. The ActionEditors still hold the DELETED entity's actions (the form was never refilled), so the deleted entity's onPick/onPullSuccess/onPullFail get written onto the surviving neighbor, silently overwriting its actions.
- **修复方向**: Reset _prev_ent_row to -1 (or flush BEFORE popping, keyed to the pre-pop row) at the start of _remove_entity so the stale lazy-flush cannot target a shifted index. Better: make ActionEditor edits write straight into self._cur_ent on `changed` (assign live, like every other field) instead of the deferred row-indexed _ae_assign, eliminating the stale-row class entirely.
- **证据**: The lazy-write data flow the auditor describes is accurate:
- ActionEditor.changed only marks dirty, never writes the dict: `ae.changed.connect(self._mark_wm_dirty)` (line 384). _mark_wm_dirty (469-472) just calls model.mark_dirty.
- The actual write is lazy via _ae_assign(ent) (1260-1263): `ent["onPick"]=self._ae_pick.to_list(); ent["onPullSuccess"]=self._ae_ok.to_list(); ent["onPullFail"]=self._ae_fail.to_list()`.
- to_list() returns whatever set_data() last loaded (action_editor.py 4311-4317), so the editors keep the previously-selected entity's actions until the form is refilled.
- _flush_actions_for_entity_row(row) (550-558) unconditionally assigns the editors' contents to `ents[row]`.

BUT the trigger the auditor describes is INVERTED. _remove_entity (1022-1029):
  row = self._selected_ent_row            # = N
  ents.pop(row)                           # neighbor N+1 (if any) shifts
- **复核补充**: Mechanism is real (stale _prev_ent_row reinterpreted against the mutated list after pop), but mis-described: it does NOT corrupt the entity that "shifts up into the deleted slot." It ONLY fires when deleting the LAST entity (with >1 entities present), and the victim is the NEW last entity (index N-1, the one ABOVE the deleted one), which inherits the deleted entity's three action lists. Deleting any non-last entity is harmless because select_row clamps back to N and the `old != row` guard at line 824 skips the flush. Hence narrower than "high": requires (a) the deleted entity to be the last in the list, (b) it to have had onPick/onPullSuccess/onPullFail content loaded in the editors. Real si

### MEDIUM-22. Map picker silently clamps out-of-bounds destination / waypoints on load and writes the clamped values back on OK
- **文件**: `tools/editor/shared/move_entity_map_picker.py`  **行**: 264-277, 330-337, 428-435
- **类别**: coordinate-math  |  **复核**: confirmed → medium  |  **置信**: likely
- **现象**: Re-opening the map picker on an existing moveEntityTo and clicking OK can shift a previously-authored destination/waypoint to the scene border, changing where the entity walks, with no indication the value changed.
- **机理**: MoveEntityPathPickView.setup_from_scene_json clamps the incoming destination and every waypoint to [0, world_w] x [0, world_h] (lines 264-275). The caller (action_editor.py:1925-1939) seeds the dialog with the action's stored x/y/waypoints, then on Accept reads result_destination()/result_waypoints_objects() and writes them straight back into the action params (action_editor.py:1936-1939, _to_dict_move_entity_to lines 4080-4100). If the stored coordinate is outside the current scene's worldWidth/worldHeight (scene was resized after authoring, or sceneId chosen for the map differs from where the value was originally authored, or a negative value), the value is silently moved to the edge. Opening the picker and clicking OK without intentionally re-picking therefore mutates the persisted coordinate. There is no preservation path for out-of-range values and no warning.
- **修复方向**: Either keep the original value when the user does not re-pick (only emit clamped values for points the user actually clicked), or surface a visible warning/marker when an incoming point was out of bounds, or pass through the original dest/waypoints unchanged unless modified in-dialog. At minimum, do not silently clamp values the user never touched into the saved result.
- **证据**: move_entity_map_picker.py lines 264-275 (MoveEntityPathPickView.setup_from_scene_json) clamp the seeded destination and every waypoint into the current map scene's bounds:
  dx, dy = self._dest_xy
  self._dest_xy = (float(max(0.0, min(self._world_w, dx))), float(max(0.0, min(self._world_h, dy))))
  for vx, vy in self._vertices: nv.append((float(max(0.0, min(self._world_w, vx))), float(max(0.0, min(self._world_h, vy)))))
_world_w/_world_h are set from the scene's resolved size in the base class (lines 134-135 via resolve_world_size_for_scene_json), so the clamp uses the map scene's dimensions.

Dialog seeds then clamps: __init__ lines 393-395 call set_vertices(waypoints_xy) / set_destination(dest_x,dest_y) then setup_from_scene_json (which clamps). result_destination() (435) / result_waypoints_objects() (428-432) return the now-clamped view state.

Caller action_editor.py: dialog seeded w
- **复核补充**: Mechanism, all three line references, and the call path are accurate. The bug is real and silent: opening the picker and clicking OK without re-picking rewrites a previously-authored destination/waypoint to the scene border whenever the stored value lies outside the currently-selected map scene's [0,world_w]x[0,world_h] (scene shrunk after authoring, negative coordinate, or map sceneId resolving to a different/smaller scene). x/y spinboxes are read-only (only settable via the picker), so in-bounds values are the norm and the bug is conditional: it requires (a) an out-of-range stored value AND (b) an explicit OK. That conditionality, plus the loss being silent/persisted with no validator guar

---

## 低（LOW）（26 条）

### LOW-1. Spinbox 4-decimal rounding silently truncates model x/y on any spinbox interaction (drag stores full precision, spin commit overwrites with rounded)
- **文件**: `tools/editor/editors/map_editor.py`  **行**: 219-226 (setDecimals(4)); 259-274 (drag writes full float + setValue rounds display); 302-320 (_on_xy_spin_changed reads rounded .value() back into model)
- **类别**: coordinate-math  |  **复核**: partial → low  |  **置信**: certain
- **现象**: Sub-1e-4 position drift / snap whenever the x/y spinboxes are edited after a precise drag. The in-code comment at line 478-479 already acknowledges 'default rounding setPos to wrong place' and only defends the load path with blockSignals — the commit path still truncates.
- **机理**: Drag path _on_node_item_moved writes n['x']=float(pos.x()) at full precision, then mirrors into the spinbox via setValue which rounds to 4 decimals (decimals=4). The model still holds full precision at that point. But _on_xy_spin_changed reads x=self._m_x.value() (already rounded to 4 decimals) and writes n['x']=float(x) back into the model AND setPos(QPointF(x,y)). So the moment the user touches either spinbox (or any valueChanged fires from a non-blocked path), the node's persisted coordinate is truncated to 4 decimals and the graphics item is snapped to the rounded position. Reproduced: drag stores y=20.987654321; spinbox shows 20.9877; after _on_xy_spin_changed model y becomes 20.9877.
- **修复方向**: Either (a) decide 4 decimals is the canonical precision and round on drag-write too (consistent, no surprise), or (b) raise/derive decimals to match the coordinate scale and round-trip exact values. Avoid feeding the rounded spinbox value back as the authoritative model coordinate when it merely mirrors an unchanged drag position — only commit on genuine user spin edits.
- **证据**: Mechanism is literally correct in the code:

Spinbox precision (lines 219-226):
  self._m_x = QDoubleSpinBox(); self._m_x.setRange(-9999, 9999); self._m_x.setDecimals(4)
  self._m_y = QDoubleSpinBox(); self._m_y.setRange(-9999, 9999); self._m_y.setDecimals(4)

Drag path (lines 259-275) stores FULL precision and does NOT round the model:
  n["x"] = float(pos.x()); n["y"] = float(pos.y())   # full precision
  self._updating_from_spin = True
  self._m_x.setValue(pos.x()); self._m_y.setValue(pos.y())  # display rounds, but...
  # the resulting valueChanged hits _on_xy_spin_changed which early-returns:

Spin-commit path (lines 302-320) reads ROUNDED .value() back into the model:
  302  def _on_xy_spin_changed(self):
  305      if self._updating_from_spin or self._loading_ui: return   # guards drag/load
  310      x, y = self._m_x.value(), self._m_y.value()   # rounded to 4 decimals
  312     
- **复核补充**: Mechanism confirmed exactly as described, but severity is overstated (medium -> low), and the "silently truncates" framing is misleading.

1) Magnitude: decimals=4 means the truncation error is bounded at 5e-5 world units. Actual authored coordinates in public/assets/data/map_config.json are coarse map-node positions (x:200.0, y:168.0, x:122.0, etc.) — world-map travel nodes, not precision-critical geometry. A 0.00005-unit drift on a 0-9999 node has no perceptible visual or gameplay effect.

2) Not "silent" / not a hidden divergence: the value persisted by the spin-commit path is exactly what the spinbox DISPLAYS (both are the 4-decimal value), so it is WYSIWYG. There is no gap between what 

### LOW-2. Edge pos_map is keyed by sceneId, so duplicate/empty sceneId nodes collapse — edges anchor to the wrong node; _add() defaults sceneId='' producing collisions
- **文件**: `tools/editor/editors/map_editor.py`  **行**: 328-364 (pos_map[sid] = ...), 367-397 (_draw_edges resolves fs/ts via pos_map), 533-536 (_add seeds sceneId='')
- **类别**: coordinate-math  |  **复核**: partial → low  |  **置信**: likely
- **现象**: After adding several nodes before assigning scenes (all sceneId=''), or if two nodes reference the same scene, transition arrows snap to one node and ignore the others; visually wrong edge endpoints.
- **机理**: _refresh and _redraw_edges build pos_map as dict[sceneId -> (x,y)] (lines 334, 359-364). If two map nodes share a sceneId (or several freshly-added nodes still have the default empty sceneId from _add at line 535), the later (higher-index) node's position overwrites the earlier one in pos_map. _draw_edges then looks up pos_map[from_scene]/pos_map[to_scene] (line 391), so every edge for that sceneId is drawn from the surviving node's position, mis-anchoring arrows. The model implicitly assumes map nodes are 1:1 with scenes, but nothing enforces uniqueness and _add seeds empty ids.
- **修复方向**: Either enforce/validate unique sceneId per map node (warn on duplicate, block empty before edge draw), or key node positions by node index and resolve edges through an explicit sceneId->nodeIndex map that detects collisions. At minimum, skip edge endpoints whose sceneId is empty or ambiguous.
- **证据**: pos_map is keyed by sceneId — _refresh line 331/334: `sid = n.get("sceneId", "?")` then `pos_map[sid] = (float(x), float(y))`; _redraw_edges lines 359-364 same. _draw_edges resolves lines 383/391-392: `fs, ts = e["from_scene"], e["to_scene"]` ... `x1, y1 = pos_map[fs]; x2, y2 = pos_map[ts]`. _add line 535: `"sceneId": "", "name": "New", ...`.

BUT edges come from ProjectModel.scene_transitions() (project_model.py 688-712), whose from_scene/to_scene are real hotspot `targetScene` values: line 703-705 `target = data.get("targetScene"); if not target: continue` — so an edge endpoint is NEVER "" and never the "?" default. And _draw_edges line 384 guards `if fs not in pos_map or ts not in pos_map or fs == ts: continue`. Therefore an empty-sceneId node (key "") is never a lookup target: empty-sceneId nodes have zero edges by construction. The leading symptom ("after adding several nodes before
- **复核补充**: Title/severity stand at "low" but the mechanism is half-wrong and the leading symptom is refuted. The empty-sceneId ('') collision the finding emphasizes (and which _add seeds) has NO effect on edges, because scene_transitions never emits an edge with an empty endpoint and _draw_edges skips keys not present as real endpoints. Only the duplicate-REAL-sceneId sub-case is genuine, and that is a degenerate, non-normal authoring state the model never produces on its own. So: refute the '_add defaults sceneId="" produces collisions that mis-anchor edges' claim; keep only the narrow 'two nodes on the same real scene → later wins' observation as a cosmetic edge-anchoring quirk. Net: minor/cosmetic, 

### LOW-3. MapNodeGraphicsItem._node_index is a frozen snapshot with a dead set_node_index() — safe only because every reorder goes through full _refresh; latent stale-index hazard
- **文件**: `tools/editor/editors/map_editor.py`  **行**: 124, 151-152 (set_node_index defined, never called — grep confirms zero callers), 156/160 (handlers use self._node_index), 541-547 (_delete pops then _refresh)
- **类别**: selection-sync  |  **复核**: confirmed → low  |  **置信**: likely
- **现象**: No live bug today. But the dead set_node_index() signals an abandoned in-place-reindex path; adding reordering without _refresh would corrupt the index->row mapping (drag node N edits node N±k).
- **机理**: Each graphics item stores _node_index at construction and itemChange callbacks (_on_node_item_moved / _on_node_item_selected) report that captured index back to the editor as the model row. set_node_index() exists to reindex items in place but is never called. Today this is masked because the only mutators of map_nodes order (_add line 533, _delete line 541) both call _refresh(), which destroys and recreates ALL items with fresh indices — so after a delete remaining nodes' node_index DO match list rows. The danger is purely latent: any future code that pops/reorders map_nodes and updates edges/labels WITHOUT a full _refresh (e.g. an in-place move-up/move-down, which this editor lacks) would leave every later item pointing at the wrong model row, so a subsequent drag/select would mutate the wrong node.
- **修复方向**: Either remove the dead set_node_index() to make the 'always full _refresh' contract explicit, or, if in-place reordering is added, call set_node_index on every shifted item and re-point _current_idx accordingly. Add a comment that node_index is only valid because all reorders rebuild the scene.
- **证据**: map_editor.py L124 captures the index at construction: `self._node_index = node_index`. L151-152 defines `set_node_index(self, index)` to reindex in place; `grep -rn "set_node_index" tools/` returns exactly one line (the L151 definition) — zero callers, dead method. The itemChange callbacks report the frozen index: L156 `self._editor._on_node_item_moved(self._node_index, self.pos())` and L160 `self._editor._on_node_item_selected(self._node_index)`. Both handlers treat that index as the model row: L264 `n = self._model.map_nodes[idx]` and L280-281 `if self._list.currentRow() != idx: self._list.setCurrentRow(idx)`. The two and only order-mutators both full-refresh: `_add` (L533-539, append then `self._refresh()`) and `_delete` (L541-546, `self._model.map_nodes.pop(...)` then `self._refresh()`). `_refresh` (L322-339) clears `_node_graphics` and recreates every item via `for i, n in enumerat
- **复核补充**: Finding is accurate as stated, including line numbers and the masking mechanism. Severity "low" is appropriate: latent hazard / dead-code smell, not a present-day defect. Note `_on_scene_selection_changed` (L298) also relies on the same frozen index via `sel[0].node_index`, sharing the identical latent staleness — consistent with the finding, not a separate defect. No live correctness bug found in the current control flow because every order mutation funnels through `_refresh`.

### LOW-4. paper_craft: _select_* handlers toggle the shared _syncing boolean off mid-refresh (non-reentrant guard)
- **文件**: `tools/editor/editors/paper_craft_editor.py`  **行**: 291-315, 333-340, 392-403, 467-473, 508-515
- **类别**: selection-sync  |  **复核**: partial → low  |  **置信**: likely
- **现象**: Switching orders/instances can spuriously fire _write_* during refresh and (combined with the correctPaper fallback) mark the doc dirty or write stale field values; brittle and order-dependent. An exception mid-select wedges the guard, silently disabling all future writes.
- **机理**: _syncing is a plain boolean, not a re-entrancy counter. _refresh_order_fields sets _syncing=True (line 292) to protect a batch of writes, but lines 307-310 call _fill_combo which does combo.clear()+addItem; those change currentIndex and synchronously fire currentIndexChanged -> _select_part/_select_slot/_select_paper/_select_finish. Each _select_* unconditionally sets _syncing=True at entry and _syncing=False at exit (e.g. lines 335/340) without checking or restoring the prior value. So the first nested _select_part call resets _syncing to False, dropping the guard for the remainder of _refresh_order_fields (the slot/paper/finish fills at lines 308-310 then run unguarded). Any field write that leaks through during that window goes to the model. The same try/finally-less pattern means an exception inside a _select_* leaves _syncing in the wrong state permanently.
- **修复方向**: Replace the boolean with a reentrant counter (depth int) or a context manager that saves/restores the previous value, and wrap in try/finally so the guard is always restored. _select_* should save prev=self._syncing, set True, and restore prev rather than hardcoding False.
- **证据**: The structural mechanism is real and correctly located. `_syncing` is a plain bool (line 27), not a counter. _select_part/_slot/_paper/_finish unconditionally toggle it with NO entry guard and NO save/restore:
  333-340 `_select_part`: `self._part = self._pick_from(...)` / `self._syncing = True` (335) / set fields / `self._syncing = False` (340)
  392-403 `_select_slot`: 394 `=True` ... 403 `=False`
  467-473 `_select_paper`: 469 `=True` ... 473 `=False`
  508-515 `_select_finish`: 510 `=True` ... 515 `=False`
Contrast `_select_instance` (222 `if self._syncing: return`) and `_select_order` (235 `if self._syncing: return`) which DO guard — the asymmetry is exactly as claimed.
In `_refresh_order_fields` (291): 292 `self._syncing = True`; line 307 `self._fill_combo(self.part_combo, ...)` runs `combo.clear()`+`addItem` (317-321) which fire Qt `currentIndexChanged` -> nested `_select_part`, w
- **复核补充**: Verdict partial: the structural defect (non-reentrant boolean guard, no save/restore, no try/finally) is real and precisely located, but the described impact is overstated. The claim that "slot/paper/finish fills at 308-310 run unguarded" is literally true, yet the consequence ("spuriously fire _write_* ... mark the doc dirty or write stale field values") does not actually occur: the only signals during that window are currentIndexChanged -> _select_* read handlers, each of which re-asserts _syncing=True before touching any write-bound widget, and no _write_* slot is wired to currentIndexChanged. So no model mutation / dirty flag leaks. Severity dropped medium -> low: the real residual risk 

### LOW-5. _refresh_graph unconditionally calls fit_all, resetting the user's zoom/pan on every apply/add/delete
- **文件**: `tools/editor/editors/quest_editor.py`  **行**: 528-549
- **类别**: perf-reload  |  **复核**: confirmed → low  |  **置信**: likely
- **现象**: User zooms/pans the graph to inspect a region, edits a field and applies; the view jumps back to fit-all every time, making iterative editing on a large graph painful.
- **机理**: _refresh_graph() ends with self._graph_view.fit_all() (line 549) which does fitInView over itemsBoundingRect (quest_editor.py:105-109), resetting the view transform. _refresh_graph is called from _refresh() after every _apply_quest/_apply_group/add/delete/drop. Combined with the full scene.clear()+rebuild in populate_*, the user's pan and zoom are discarded on every edit.
- **修复方向**: Only fit_all on first populate / mode (drilldown) change, not on content-only refreshes. Preserve the current view transform across populate when the mode and node set are unchanged, or expose a separate 'fit' affordance and stop auto-fitting on apply.
- **证据**: quest_editor.py:528-549 `_refresh_graph()` always ends with `self._graph_view.fit_all()` (line 549) regardless of why it was called. `fit_all()` (lines 105-109) does:
```
rect = self._gscene.itemsBoundingRect()
if not rect.isNull():
    rect.adjust(-60, -60, 60, 60)
    self.fitInView(rect, Qt.AspectRatioMode.KeepAspectRatio)
```
`fitInView` resets the view transform, discarding zoom accumulated by `wheelEvent` → `self.scale(factor, factor)` (line 53) and pan applied via scrollbars (lines 89-92).

Call chain confirmed: `_refresh()` (line 470-473) calls `_rebuild_tree()` + `_refresh_graph()`. Every edit path ends in `self._refresh()`: `_apply_group` (723), `_apply_quest` (755), `_add_group` (782), `_add_quest` (804), `_delete_group` (843), `_delete_quest` (884). The drop handler emits `hierarchy_changed` which is wired to a refresh too.

Full rebuild also confirmed: `_refresh_graph` calls
- **复核补充**: Mechanism is described accurately. Severity 'low' is correct: pure UX annoyance on large graphs, no data loss or correctness impact. Note the cited line range (528-549) is correct for `_refresh_graph`; `fit_all` itself is at 105-109 as the finding states. Adjacent context for the fix: the same `_refresh_graph` is intentionally reused by navigation handlers `_on_graph_drilldown` (553-555), `_go_back` (567-570), `_go_top` (572-574), where `fit_all` IS desirable (the displayed subgraph changes). A correct fix must preserve zoom/pan only on in-place edits while still fitting on breadcrumb/navigation changes (e.g. pass a flag, or capture/restore `self.transform()` + scrollbar values around popula

### LOW-6. Quest graph edge arrowhead/label recompute runs on every node ItemPositionHasChanged with no batching
- **文件**: `tools/editor/editors/quest_graph_items.py`  **行**: 88-92, 147-151, 191-232
- **类别**: perf-reload  |  **复核**: confirmed → low  |  **置信**: speculative
- **现象**: On a dense graph, dragging a high-degree node can stutter as every connected edge's path+arrow+label is recomputed on each intermediate position event.
- **机理**: On each node move, itemChange iterates self._edges and calls edge.update_path() (88-92,147-151). update_path() (191-232) rebuilds the full cubic path, recomputes a bezier midpoint for label placement (210-215), and recomputes the arrowhead via atan2/cos/sin (217-230) for every connected edge, on every position-changed event (which fires continuously during a drag). For a high-degree node this is a per-mouse-move trig+QPainterPath rebuild storm. Compounded by the fact the move is discarded anyway (see schema finding), this is wasted work.
- **修复方向**: If node drag is kept, coalesce edge updates (cache trig, or schedule a single deferred relayout per event-loop turn). If nodes are made non-movable per the schema finding, this hot path disappears entirely.
- **证据**: itemChange handlers fire on every intermediate drag event and loop all incident edges:

QuestGroupItem (88-92) and QuestNodeItem (147-151) are identical:
  def itemChange(self, change, value):
      if change == QGraphicsItem.GraphicsItemChange.ItemPositionHasChanged:
          for edge in self._edges:
              edge.update_path()
      return super().itemChange(change, value)

Both set ItemSendsGeometryChanges (line 52, line 113), so itemChange actually fires; ItemPositionHasChanged is emitted by Qt on every mouse-move during a movable-item drag, not just at drop.

update_path() (191-232) does full per-call work, with no caching/throttling:
  - 208: path.cubicTo(...) rebuilds the cubic path
  - 210-215: recomputes bezier midpoint via the cubic polynomial and self._label.setPos(...)
  - 217-230: arrowhead via math.atan2 + two math.cos/math.sin pairs (p1, p2)
  - 232: self.setPath(pat
- **复核补充**: Confirmed and correctly severitied as low. Mechanism is accurate: no throttling/debouncing, full QPainterPath rebuild + bezier eval + atan2/cos/sin trig per incident edge on every ItemPositionHasChanged. Minor clarification to the description: the per-edge updates are not "wasted" in the sense of updating edges that didn't move — when a node is dragged, only that node's itemChange fires and each of its incident edges genuinely needs new geometry. The only true inefficiency is the absence of per-drag coalescing (e.g. collapsing multiple intermediate position events into one repaint), so the recompute storm is proportional to mouse-move frequency x node degree. Real-world impact is small becau

### LOW-7. Quest graph nodes are draggable but the drag is never persisted (no x/y in schema, layout recomputed every refresh)
- **文件**: `tools/editor/editors/quest_graph_items.py`  **行**: 50-52, 88-92, 111-113, 147-151
- **类别**: save-roundtrip  |  **复核**: partial → low  |  **置信**: certain
- **现象**: User drags a quest/group node to arrange the graph; the layout looks editable. The moment any field is applied, a node is added/deleted, or the user drills in/out (or reopens the editor), the entire arrangement snaps back to auto-layout. The drag feels like it should persist but is silently thrown away — a classic 'edit that does nothing' trap.
- **机理**: QuestGroupItem and QuestNodeItem set ItemIsMovable=True (lines 50-51, 111-112). Their itemChange (lines 88-92 / 147-151) only calls edge.update_path() on ItemPositionHasChanged — it never writes the new pos back to quest_data/group_data, never calls mark_dirty, and there is no x/y field anywhere in the quest/group JSON schema (confirmed: quests.json keys are completionConditions/description/group/id/nextQuests/preconditions/rewards/title/type; questGroups.json keys are id/name/type). Positions come purely from _hierarchical_layout() (quest_graph_scene.py:15-66), recomputed from scratch on every populate_top_level/populate_group. quest_editor._apply_quest/_apply_group and every add/delete/drop call self._refresh()->self._refresh_graph()->populate_* (quest_editor.py:470-549), which clears the scene and rebuilds at auto-layout coordinates.
- **修复方向**: Either make nodes non-movable (drop ItemIsMovable, keep ItemIsSelectable) so the canvas is honestly read-only auto-layout, OR add a real graphX/graphY persistence path: write pos into quest_data/group_data on ItemPositionHasChanged, mark_dirty, seed _hierarchical_layout from stored coords when present, and register the new fields in validator.py. Non-movable is the smaller, safer fix matching current intent.
- **证据**: PERSISTENCE GAP IS REAL (confirmed):
- quest_graph_items.py:50-52 / 111-113 set ItemIsMovable=True, ItemIsSelectable=True, ItemSendsGeometryChanges=True on both QuestGroupItem and QuestNodeItem.
- itemChange (lines 88-92 and 147-151) does ONLY edge.update_path(); it never writes item.pos() back to group_data/quest_data, never calls mark_dirty:
  88  def itemChange(self, change, value):
  89    if change == ...ItemPositionHasChanged:
  90      for edge in self._edges: edge.update_path()
  92    return super().itemChange(change, value)
- setPos(x,y) at lines 47 and 108 only consumes coordinates produced by _hierarchical_layout (quest_graph_scene.py:15-66); no code ever reads item.pos() into the data dicts (grep for setPos/pos() shows only layout-in and label/edge geometry).
- quest_graph_scene.populate_top_level (line 82) and populate_group (line 153) both call self.clear() then rebuild at
- **复核补充**: Mechanism re: missing persistence is accurate, but the finding mis-describes the lived symptom. Because mousePressEvent swallows the left-click before forwarding to the scene (quest_editor.py:69-70 event.accept()/return without super()), the ItemIsMovable flag never engages and nodes are not actually draggable in practice. So this is a latent/dead-flag inconsistency (movable flag + geometry-change plumbing wired up but unreachable and non-persisting), not an active high-severity 'edit that does nothing / silently loses arranged work' data trap. No authored content is ever lost — only a transient layout that the user can't even produce. Downgrading high -> low. The honest fix is either remove

### LOW-8. _apply_props commits staging then calls _refresh_one_scene_npc_anim which removeItem()s and rebuilds the anim sprite — heavy churn on every Apply, and re-reads QPixmap/JSON
- **文件**: `tools/editor/editors/scene_editor.py`  **行**: 6382-6408, 5867-5890, 5755-5851
- **类别**: perf-reload  |  **复核**: partial → low  |  **置信**: likely
- **现象**: Each Apply on an NPC causes a momentary disappearance/reappearance of the sprite and re-reads anim assets even when only position changed.
- **机理**: _sync_npc_canvas_after_commit (called from _apply_props L6581) ends with _refresh_one_scene_npc_anim(new_id) (L6408), which pops the old runtime, removeItem()s its sprite (L5878-5880), and calls _try_add_scene_npc_anim again. _try_add_scene_npc_anim re-opens the anim JSON (json_memo only lives for the single call, a fresh {} is passed L5885-5886) and may re-decode the atlas QPixmap (atlas_memo also fresh per call). So a simple Apply after moving an NPC re-parses JSON and rebuilds the sprite item even though only x/y changed. Not a correctness bug, but per-Apply disk/decode churn and a brief sprite remove/re-add flash.
- **修复方向**: If only position/facing changed, reposition the existing runtime (rt.draw_at) instead of tearing it down; reserve the full _refresh_one_scene_npc_anim for animFile/initialAnimState/world-size changes. Share a persistent json/atlas memo across calls.
- **证据**: The performance-churn mechanism is fully confirmed by the code.

_apply_props calls the sync unconditionally (scene_editor.py L6580-6581):
  6580  if props._source_npc is not None:
  6581      self._sync_npc_canvas_after_commit(old_npc_id, props._source_npc)

_sync_npc_canvas_after_commit ends by refreshing the anim, with no diff of what changed (L6402-6408):
  6402  elif isinstance(item, _DraggableCircle):
  6403      item.setPos(float(npc.get("x", 0)), float(npc.get("y", 0)))   # cheap circle move
  6404      item.set_interaction_range(...)
  ...
  6408      self._refresh_one_scene_npc_anim(new_id)                       # always

_refresh_one_scene_npc_anim pops + removeItem()s the old sprite, then passes FRESH empty memos (L5878-5887):
  5878  old = self._scene_npc_runtimes.pop(npc_id, None)
  5879  if old is not None and old.item.scene() is not None:
  5880      old.item.scene().remo
- **复核补充**: Verdict 'partial' only because the visible-flash symptom is inaccurate; the underlying perf mechanism (re-parse JSON + re-decode QPixmap + rebuild sprite item on every NPC Apply, driven by fresh-per-call empty memos at L5885-5886) is exactly as described and severity 'low' is correct.

Cheap fix if desired: in _refresh_one_scene_npc_anim, only rebuild the runtime when anim-affecting fields (animFile / initialAnimState / initialFacing / visibility / patrol-preview state) actually changed; for pure x/y moves, reuse the existing runtime and just call rt.draw_at(nx, ny) (the same primitive already used at L5850) instead of pop+removeItem+_try_add_scene_npc_anim. Module-level persistent json_memo

### LOW-9. Stale _saved_item_z can hold a deleted item; _restore_pick_z_order calls .scene() on it which raises RuntimeError if the wrapper was destroyed without going through clear_scene
- **文件**: `tools/editor/editors/scene_editor.py`  **行**: 1180, 1220-1226, 1769-1804, 1531-1566
- **类别**: qt-lifecycle-crash  |  **复核**: partial → low  |  **置信**: speculative
- **现象**: Latent: a RuntimeError on the next left-click if a pick-cycle-stacked item is destroyed out-of-band. Not reproducible through current UI flows, but the guard is unsafe (uses the dangling wrapper to test liveness).
- **机理**: mousePressEvent stores self._saved_item_z = [(it, z) ...] for the pick-cycle stack and raises one item's Z. _restore_pick_z_order iterates and tests `if it.scene() is self._gfx`. If any item in that saved list had its underlying C++ object deleted (e.g. via remove_*_graphics / _gfx.removeItem) between the press and the next restore — without _saved_item_z being reset — then `it.scene()` raises 'wrapped C/C++ object has been deleted'. Today the deletion paths that matter (_delete_selected, scene reload) route through clear_scene() which nulls _saved_item_z, so it is currently masked; but remove_*_graphics does not null _saved_item_z, so a future code path that removes a stacked item mid-gesture would trip it.
- **修复方向**: Wrap the .scene() check in try/except RuntimeError, or use sip.isdeleted()/shiboken liveness check, or clear _saved_item_z in remove_*_graphics. Prefer not dereferencing potentially-deleted wrappers to test liveness.
- **证据**: _restore_pick_z_order (lines 1220-1226):
  for it, z in self._saved_item_z:
      if it.scene() is self._gfx:   # line 1224 — probes liveness via the wrapper itself
          it.setZValue(z)
  self._saved_item_z = None

mousePressEvent (lines 1776-1804): on LeftButton FIRST calls self._restore_pick_z_order() (1777), THEN rebuilds self._saved_item_z = [(it, it.zValue()) for it in stack] (1801) and raises target Z (1803). So the saved list persists across gestures.

remove_*_graphics (lines 1531-1566): each does `if it is not None and it.scene() is self._gfx: self._gfx.removeItem(it)` and does NOT null _saved_item_z. Confirmed.

clear_scene (lines 1210-1218): nulls self._saved_item_z = None (1211) and is the ONLY place self._gfx.clear() is called (1215) — verified by grep: `_gfx.clear()` appears exactly once in the file.

_delete_selected (6721-6767): ends with self._load_scene(...) (6767)
- **复核补充**: Partial: the defensive-coding weakness is genuine — _restore_pick_z_order uses the (potentially dangling) wrapper `it.scene()` to test liveness rather than sip.isdeleted()/try-except, so it WOULD raise RuntimeError if a stacked item's underlying C++ object were ever destroyed out-of-band while _saved_item_z still referenced it. Severity 'low' is correct (latent, not reachable through any current UI flow). But the finding's core mechanism is mis-described: it names remove_*_graphics / _gfx.removeItem as the deletion vector, and those CANNOT trigger the raise — removeItem detaches without destroying, so it.scene() returns None safely. The only thing that destroys the C++ objects is _gfx.clear(

### LOW-10. flush_to_model signature mismatch forces a TypeError-driven fallback in Save All
- **文件**: `tools/editor/editors/scene_editor.py`  **行**: 6302-6304
- **类别**: save-roundtrip  |  **复核**: confirmed → low  |  **置信**: certain
- **现象**: No user-visible bug today, but Save All always triggers a caught TypeError for the scene editor and the editor can never react to for_save_all (e.g. to skip redundant canvas rebuilds during a bulk save).
- **机理**: MainWindow._flush_editors_to_model (main_window.py:727-735) calls inst.flush_to_model(for_save_all=True) and only falls back to flush() inside an except TypeError. SceneEditor.flush_to_model(self) (6302) takes no for_save_all kwarg, so every Save All raises and catches a TypeError for this editor before retrying. It works, but relies on exception-as-control-flow and silently ignores the for_save_all intent (e.g. any save-all-specific batching/skip behavior other editors get).
- **修复方向**: Change the signature to flush_to_model(self, *, for_save_all: bool = False) and honor it (e.g. skip the canvas viewport rebuild work in _apply_props when for_save_all is True) so the call path is intentional rather than exception-driven.
- **证据**: scene_editor.py:6302 — `def flush_to_model(self) -> None:` (no for_save_all kwarg), body just calls `self._apply_props()`.
main_window.py:732-735 — `try: result = flush(for_save_all=True) / except TypeError: result = flush()`. Calling the kwarg-less scene-editor method with for_save_all=True raises TypeError, so the scene editor always hits the fallback retry on Save All.
The kwarg is a real, live interface: narrative_state_editor.py:684 `def flush_to_model(self, *, for_save_all: bool = False) -> bool:` and branches on it at :695 (`if not for_save_all: QMessageBox.warning(...)`) and :705 to suppress per-editor dialogs during bulk save. So for_save_all carries real save-all-specific intent the scene editor cannot see.
scene_editor.py:6542 `_apply_props` (the delegate target) unconditionally does heavy canvas work: `_refresh_scene_canvas_viewport_after_commit` (6575), `reload_spawn_items_f
- **复核补充**: Mechanism is literally true as written. One framing caveat (not a refutation): the except-TypeError branch in main_window is a deliberate duck-typed compatibility shim, and the scene editor is NOT uniquely affected — most flush_to_model implementations also omit the kwarg (filter_editor.py:209, water_minigame_editor.py:1236, sugar_wheel_editor.py:2257, overlay_images_editor.py:208, player_avatar_editor.py:138, narrative_data_editors.py:1130/1846 — all `def flush_to_model(self) -> None:`). So 'every Save All raises and catches a TypeError for this editor' is accurate, but it is a project-wide pattern, not a scene-editor-specific defect; only narrative_state_editor actually opted into the kwar

### LOW-11. _on_item_deselected unconditionally reloads scene props (clear_pending_edits=False) on every empty-canvas click — re-deepcopies staging_scene and can stomp/skip mid-edit state
- **文件**: `tools/editor/editors/scene_editor.py`  **行**: 6086-6091, 2587-2613, 1848-1849
- **类别**: selection-sync  |  **复核**: confirmed → low  |  **置信**: speculative
- **现象**: Rapid clicking on empty canvas thrashes the scene property panel (rebuilds, flag-context resets) and can flicker the '未应用' indicator.
- **机理**: Any mouseReleaseEvent with no selection emits item_deselected (L1848-1849) -> _on_item_deselected -> load_scene_props(sc, clear_pending_edits=False) (L6090). load_scene_props re-runs flush_active_panel_widgets_to_staging + a fresh copy.deepcopy(sc) for _staging_scene and re-deepcopies spawnPoints/spawnPoint (L2596-2611), switching the stack to the scene panel each time. This fires on every stray click on empty canvas, even mid-gesture, re-allocating staging and re-building the scene panel widgets; combined with the QueuedConnection pending-dirty toggle (L5555-5559) it can momentarily clear/reset the un-applied indicator. It does not lose entity staging (clear_pending_edits=False) but is unnecessary work and a re-entrancy surface during rapid select/deselect.
- **修复方向**: Make _on_item_deselected a no-op when the scene panel is already current and staging_scene already targets the current scene; only switch panels/rebuild when actually transitioning away from an entity panel.
- **证据**: L6086-6091 has NO early-return guard (contrast the spawn branch's guard at L6076-6080):
  def _on_item_deselected(self) -> None:
      if self._current_scene_id:
          sc = self._model.scenes.get(self._current_scene_id)
          if sc:
              self._props.load_scene_props(sc, clear_pending_edits=False)
      self._refresh_npc_patrol_overlay()

L1822-1849 mouseReleaseEvent emits on every release with no selection (empty-canvas click; items are ItemIsSelectable L490-491/566-567, view is NoDrag L1174, so a plain click on empty space clears selection via super().mouseReleaseEvent):
  else:
      self.item_deselected.emit()

L2587-2626 load_scene_props does the unconditional heavy work each call:
  L2593 self.flush_active_panel_widgets_to_staging(only_shared_scene_staging=True)
  L2594 self._set_pending_dirty(False)
  L2596 st = copy.deepcopy(sc)
  L2604/2606 st["spawnPoints"] = co
- **复核补充**: Mechanism is REAL and severity 'low' is correct, but two descriptive points need correction (hence the auditor's wording is partially off even though the defect stands):

1. "even mid-gesture" is an overstatement. item_deselected is emitted from mouseReleaseEvent (L1849), i.e. at the END of a click/release, not during an active drag. Qt deselects-on-empty-click happens on the press/release cycle, not mid-drag. So it fires on each completed stray click, not "during a gesture."

2. The effect is actually a bit STRONGER than "flicker the indicator," which slightly under-describes one aspect while the finding over-describes the data risk. On a genuine mid-edit (e.g. hotspot panel active with una

### LOW-12. Programmatic setPos during after-commit canvas sync re-enters _on_item_position_live, redundantly rewriting staging and re-dirtying right after Apply clears it
- **文件**: `tools/editor/editors/scene_editor.py`  **行**: 6373-6375, 6402-6404, 541-554, 6226-6252
- **类别**: selection-sync  |  **复核**: confirmed → low  |  **置信**: likely
- **现象**: Extra work and a transient dirty-true/dirty-false flip on each Apply; the hotspot display image is destroyed and recreated an extra time. No persistent corruption observed, but it is a latent re-entrancy hazard if ordering changes.
- **机理**: _DraggableCircle has ItemSendsGeometryChanges and itemChange emits item_position_live on ItemPositionHasChanged for ANY position change, including programmatic setPos. In _sync_hotspot/npc_canvas_after_commit the editor calls item.setPos(...), which synchronously fires item_position_live -> _on_item_position_live, which re-writes staging x/y, re-runs refresh_*_visuals (a removeItem/addItem on the hotspot display image) and rt.draw_at, and calls sync_*_xy_widgets -> _emit_props_changed -> _set_pending_dirty(True). In _apply_props this happens (lines 6579/6581) before rebind_*_after_commit (6592/6597) sets dirty False, so it nets out, but it is wasteful re-entrancy and an unnecessary display-image rebuild on every Apply.
- **修复方向**: Guard programmatic repositioning: temporarily set a flag (e.g. self._suppress_live_pos) checked in _on_item_position_live, or block the item's geometry-change emission while calling setPos in the after-commit sync.
- **证据**: _DraggableCircle has the flag — lines 490-492: `self.setFlags(... | self.GraphicsItemFlag.ItemSendsGeometryChanges)`. itemChange emits unconditionally on position change — lines 547-553: `if change == ...ItemPositionHasChanged and self._scene_view is not None: ... self._scene_view.item_position_live.emit(self.entity_kind, self.entity_id, p.x(), p.y())`. Signal wired at line 5525: `self._canvas.item_position_live.connect(self._on_item_position_live)`. After-commit sync calls setPos — line 6374 `item.setPos(float(hs.get("x", 0)), float(hs.get("y", 0)))` (npc: line 6403). Re-entrant handler rewrites staging + rebuilds image + syncs widgets — lines 6235-6238: `hs["x"] = rx; hs["y"] = ry; self._canvas.refresh_hotspot_visuals(hs); self._props.sync_hotspot_xy_widgets(eid, rx, ry)`. refresh_hotspot_visuals destroys/recreates the display image — lines 1290-1293: `old_disp = self._entity_items.pop
- **复核补充**: Mechanism is accurate end-to-end and severity low is correct (net-zero outcome: dirty ends False, staging rebound to source, display image correctly rebuilt; cost is wasteful re-entrancy + extra display-image destroy/recreate + transient dirty flip + latent ordering hazard). One minor correction: the finding's "on every Apply" is slightly overstated. ItemPositionHasChanged only fires when the new pos differs from the item's current pos, so a spinbox-only edit (uses blockSignals, no canvas setPos before Apply) or an Apply where the committed rounded x/y already equals the item's current pos is a no-op. The re-entrancy reliably triggers on the drag-then-Apply path because staging stores round(

### LOW-13. NPC anim sprite item is unparented from the draggable handle, so nothing structurally keeps it in sync with the handle during a drag
- **文件**: `tools/editor/editors/scene_editor.py`  **行**: 5824-5851, 1415-1423, 478-553
- **类别**: sprite-handle-sync  |  **复核**: partial → low  |  **置信**: likely
- **现象**: The big NPC sprite and the small drag handle can be in different places mid-drag; the sprite appears to lag, snap, or sit at the pre-drag location while the handle is under the cursor.
- **机理**: The NPC visual sprite is a standalone QGraphicsPixmapItem added directly to the scene (self._canvas.graphics_scene().addItem(item), L5830) and stored in _scene_npc_runtimes; it is NOT a child of the _DraggableCircle handle created in add_npc (L1417-1422). The handle only auto-moves its own _label child (QGraphicsTextItem parented in __init__ L499). So the sprite's position is maintained purely imperatively: handle drag -> itemChange emits item_position_live -> _on_item_position_live -> rt.draw_at. Any code path that moves the handle without going through that signal (or that the 8ms timer overrides) desyncs the sprite from the handle. Because the sprite is also the visually dominant element (handle is a tiny ~0.008*world radius circle, handle_radius L1206-1208), the desync is exactly what the user perceives as 'the NPC doesn't follow.'
- **修复方向**: Either parent the anim sprite to the handle (so Qt moves it for free and the timer only animates frames, not position) — accounting for the handle's world-unit transform — or ensure the single position resolver (see timer finding) is the only thing that ever sets sprite position, and that it's driven by the same source as the handle.
- **证据**: STRUCTURAL CLAIM — CONFIRMED. The NPC anim sprite is unparented and synced imperatively:
- L5824-5830: `item = QGraphicsPixmapItem()` ... `self._canvas.graphics_scene().addItem(item)` — added directly to the scene, NOT as a child of the handle. Stored in a `_SceneNpcAnimRuntime` (L5831) kept in `self._scene_npc_runtimes[npc_id]` (L5851).
- L1417-1422 (`add_npc`): the draggable handle is a separate `_DraggableCircle(...)` stored in `self._entity_items[f"npc:{id}"]`. The sprite is never parented to it.
- L499 (`_DraggableCircle.__init__`): only `self._label = QGraphicsTextItem(entity_id, self)` is a child; Qt auto-moves only that label, not the sprite.
- L541-554 (`itemChange`): on `ItemPositionHasChanged` it emits `item_position_live`; L6240-6249 (`_on_item_position_live`) handles kind=="npc" by writing x/y and calling `rt.draw_at(rx, ry)`. So sprite position is maintained purely imperati
- **复核补充**: Net: the defect is REAL but only under one condition (dragging the currently-selected NPC), and the finding's stated root cause is wrong. It is not the unparenting per se — the imperative signal path keeps the sprite synced fine when the dragged NPC writes to the same dict the timer reads. The true root cause is the per-entity `_staging_npc = copy.deepcopy(npc)` fork (L4811-4812): the live drag updates the deepcopy while the 8ms preview timer (`_tick_scene_npc_anims`, L5893-5916) keeps reading the un-mutated model-list element and redrawing the sprite at the pre-drag position. Fix options: have `_on_item_position_live` also mirror x/y onto the shared model npc, OR have the timer prefer the s

### LOW-14. draw_at called directly from the drag handler does not update facing/_prev, so facing can be wrong vs the timer-driven facing
- **文件**: `tools/editor/editors/scene_editor.py`  **行**: 385-405, 407-441, 6247-6250, 5942-5945
- **类别**: sprite-handle-sync  |  **复核**: partial → low  |  **置信**: speculative
- **现象**: While dragging an NPC horizontally, the sprite may face the wrong way or flip a frame late compared to the drag direction.
- **机理**: Facing (facing_x) is only updated inside _SceneNpcAnimRuntime.tick from the delta between _prev_x and npc_x (L398-404). The drag/spinbox handlers call rt.draw_at(rx, ry) directly (L6249, L5945) without updating _prev_x/_prev_y or facing_x, while the 8ms timer calls rt.tick(...) reading the COMMITTED model position. Because draw_at uses self.facing_x for the horizontal scale sign (sx = (world_w/fw)*facing_x, L433), the sprite drawn by the drag handler uses whatever facing the last tick left, and the next tick computes dx from the stale model x to the (still stale until commit) model x, so facing can lag or flip relative to the actual drag direction.
- **修复方向**: Have the drag handler update facing based on the live delta (or expose a draw_at variant that takes an explicit facing), and unify the position source so tick computes dx from the same coordinates the drag uses.
- **证据**: _SceneNpcAnimRuntime only updates facing in tick():
L398-401: `if self._have_prev: / dx = npc_x - self._prev_x / if abs(dx) > 1e-4: / self.facing_x = 1 if dx > 0 else -1`; L402: `self._prev_x = npc_x`.
draw_at() (L407-441) uses facing for horizontal sign but never writes it:
L433: `sx = (self.world_w / fw) * self.facing_x`.

Direct draw_at call sites bypass facing/_prev_x:
- Drag-live _on_item_position_live (npc): L6244 `npc["x"] = rx`; L6248-6249 `if rt is not None: / rt.draw_at(float(rx), float(ry))`.
- Drag-end _on_item_moved (npc): L6281 `npc["x"] = rx`; L6286 `rt.draw_at(float(rx), float(ry))`.
- Spinbox-live _on_npc_xy_live_changed: L5945 `rt.draw_at(float(n.get("x", 0)), float(n.get("y", 0)))`.

Only the 8ms timer recomputes facing, reading the COMMITTED model dict:
L5431 `setInterval(8)`; L5905-5915: `x = float(npc.get("x", 0)) ... rt.tick(dt, x, y)`, npc from `sc.get("npcs")` (L
- **复核补充**: Mechanism confirmed: draw_at never updates facing_x/_prev_x; only tick() does, and tick reads the committed sc["npcs"] x via the 8ms timer. The direct draw_at calls at L6249 (drag-live), L6286 (drag-end), L5945 (spinbox-live) therefore draw with stale facing. Marked 'partial' because the finding mis-describes the dominant case: dragging the SELECTED NPC mutates a deepcopy staging dict (L2332-2333) the timer never reads, so facing is fully FROZEN for the whole drag, not "a frame late". Lag/flip-late only happens for non-selected NPCs (staging lookup falls through to the real dict, L6330-6335). Severity 'low' is correct: editor-preview cosmetic only; no save-data effect (JSON initialFacing unt

### LOW-15. load_scene_props deliberately shares hotspots/npcs/zones list references between staging scene and model, creating dual sources of truth for the same entities
- **文件**: `tools/editor/editors/scene_editor.py`  **行**: 2596-2611, 6569-6573
- **类别**: staging-vs-model  |  **复核**: partial → low  |  **置信**: likely
- **现象**: Edge-case inconsistencies where a value visible on canvas (driven by one source) disagrees with the panel (driven by the other), and Apply non-deterministically keeps whichever source the commit order favors. Underlies the divergence in the non-selected-drag finding.
- **机理**: load_scene_props deep-copies the scene into _staging_scene EXCEPT hotspots/npcs/zones, which are aliased to the model's lists (st[lk] = sc[lk]). Meanwhile per-entity editing keeps an independent _staging_hotspot/_staging_npc/_staging_zone deepcopy of ONE element. So a given NPC can simultaneously have: (a) the shared list element in model/staging-scene, and (b) the per-entity staging deepcopy. Canvas drags of the selected entity write to (b); canvas drags of a non-selected entity write to (a); _apply_props commits (b) into _source (the list element) unconditionally for all three kinds. These can diverge (e.g. (a) mutated by a non-selected drag while (b) holds different selected-entity edits), and Apply resolves them in a fixed order that can clobber one with the other.
- **修复方向**: Pick a single ownership model: either keep entity lists fully deep-copied in staging and funnel ALL adds/deletes/drags through staging+commit, or drop per-entity staging deepcopies and edit the shared list elements directly with explicit dirty-marking. Document and enforce which dict the canvas writes to.
- **证据**: The structural sharing is real and deliberate:
- load_scene_props lines 2599-2601: `for lk in ("hotspots","npcs","zones"): if lk in sc: st[lk] = sc[lk]` with the comment at 2597-2598 "hotspots/npcs/zones 故意共享 model 引用".
- load_hotspot_props lines 3721-3723: `self._source_hotspot = hs` (the model list element) and `st = copy.deepcopy(hs); self._staging_hotspot = st` — confirming (a)=list element, (b)=per-entity deepcopy. Same pattern for npc (4810-4812) and zone (5244-5246).
- _staging_hotspot_for_canvas_drag lines 6314-6324: returns the staging deepcopy (b) when its id matches eid, ELSE iterates `sc.get("hotspots", [])` and returns the model list element (a). So selected-entity drags write (b); non-selected-entity drags write (a). Confirmed.

BUT the load-bearing clobber claim is refuted by commit_scene_staging_to_source lines 2911-2926: `skip = {"hotspots","npcs","zones"}` ... `for key,
- **复核补充**: The finding correctly identifies the deliberate list-aliasing (two references to the same entity dict) but mis-describes the consequence. Its central claim — that _apply_props commits (b) into the list element "unconditionally for all three kinds" and that scene-staging commit "resolves them in a fixed order that can clobber one with the other" — is false: commit_scene_staging_to_source skips the three lists entirely (line 2917), and the per-entity commit only affects the one selected entity. The posited same-entity divergence-and-clobber scenario does not arise. The real, much milder wart: canvas right-click add/delete and non-selected drags mutate the model dict immediately (bypassing the 

### LOW-16. Charge-button default offset/diameter is derived from the live scene rect at form-fill time, can disagree with the canvas-drawn default
- **文件**: `tools/editor/editors/sugar_wheel_editor.py`  **行**: 1458-1473, 407-435, 79-85
- **类别**: coordinate-math  |  **复核**: confirmed → low  |  **置信**: speculative
- **现象**: On a brand-new instance with no chargeButton keys, the charge spinboxes may briefly show offsets that don't match where the blue charge circle is drawn until the next refresh; potential for the user to 'fix' a non-problem.
- **机理**: When a doc has no explicit chargeButton* keys, _fill_form computes default offsets def_ox=def_oy=R*0.72 where R=_preview_wheel_radius_px(d, scene rect w/h) reading self._canvas._scene.sceneRect() (1458-1461). _fill_form runs in _on_row_changed BEFORE self._canvas.refresh() (1434 then 1435). refresh sets the rect to a fixed 960x720 (298) and the canvas charge R=size/2 uses the same size formula (333-336,407), so values match only when the rect is already 960x720. If the scene rect is ever not yet canonical at _fill_form time (e.g. before the first refresh), the spinbox-shown default and the canvas-drawn charge circle diverge.
- **修复方向**: Compute the charge default from the fixed canonical scene dimensions (960x720) used by refresh, independent of the live scene rect, or call refresh before _fill_form so the rect is guaranteed canonical. Keep a single source of truth for R between _preview_wheel_radius_px and the canvas size formula.
- **证据**: Canvas __init__ never sets a scene rect — line 254 `self._scene = QGraphicsScene(self)` only; the only setSceneRect is inside refresh() at line 298 `self._scene.setSceneRect(QRectF(0, 0, 960, 720))`. Verified empirically that an un-set QGraphicsScene returns sceneRect (0,0,0,0).

_on_row_changed orders fill before refresh:
  1434  self._fill_form()
  1435  self._canvas.refresh(self._doc)

_fill_form derives the default from the LIVE rect (lines 1458-1461):
  1458  rr = self._canvas._scene.sceneRect()
  1459  R = _preview_wheel_radius_px(d, float(rr.width()), float(rr.height()))
  1460  def_ox = R * 0.72
  1461  def_oy = R * 0.72
and applies it when no chargeButton keys exist (1470-1473).

_preview_wheel_radius_px (79-85) and the canvas charge math (333-336, 407-417) are the SAME formula but fed different sizes. Computed: on a cold first selection the rect is (0,0,0,0) → size=max(160, min
- **复核补充**: Mechanism confirmed exactly as described; severity 'low' is correct. The wrong default is purely a transient display mismatch and never corrupts data: (a) the setValue() during _fill_form runs under self._loading=True, and _on_charge_geometry_spin_changed (1271) early-returns when _loading, so it does not dirty _doc; (b) the save/collect path only persists chargeButton* keys when _charge_json_explicit is True (1691), which is False for a doc lacking those keys (set False at 1462 via any() over absent keys), and otherwise pops them (1696). So no bad value reaches JSON — only the spinboxes briefly disagree with the drawn blue circle on a first-ever selection of an instance with no chargeButton

### LOW-17. SugarWheelEditor.flush_to_model only validates the model; it does not flush the active sector-action / before-charge editor buffers before Save All
- **文件**: `tools/editor/editors/sugar_wheel_editor.py`  **行**: 2257-2296, 1336-1353, 1091-1109, 846-850, 735-742
- **类别**: save-roundtrip  |  **复核**: partial → low  |  **置信**: likely
- **现象**: Edit a sector's actions or the before-charge condition, then Ctrl+Shift+S without first changing sector selection or rows. If the inner editor's change signal didn't fire for that particular edit, the change is not in self._doc and is lost on save with no warning.
- **机理**: main_window._flush_editors_to_model calls inst.flush_to_model(for_save_all=True) before model.save_all (main_window.py:727-741). SugarWheelEditor.flush_to_model (2257+) is a pure validator: it walks self._model.sugar_wheel_instances and raises on bad data but never calls _flush_sector_actions_row (1336) or _flush_before_charge_from_editors (1091) to push the currently-open ActionEditor/condition-editor buffers into self._doc. Persistence of the active row's action edits relies entirely on the live ActionEditor.changed signal (wired 850 -> _on_sector_actions_editor_changed -> flush) and on _on_row_changed's flush of the previous row (1410-1413). If ActionEditor.changed does not fire for some mutation path (or a value is mid-edit at Save All time), that edit is silently dropped because flush_to_model does not defensively re-pull the open editors.
- **修复方向**: Have flush_to_model (or a new for_save_all path) first call _flush_sector_actions_row(self._selected_sector_row) and _flush_before_charge_from_editors() to guarantee the open buffers land in self._doc before validation/serialization, mirroring what _on_row_changed already does on scene switch.
- **证据**: STRUCTURAL CLAIM = TRUE. sugar_wheel_editor.py:2257-2297 is the ENTIRE flush_to_model body (file is exactly 2297 lines). It is a pure validator: `def flush_to_model(self):` then `for iid, doc in self._model.sugar_wheel_instances.items():` followed only by `raise ValueError(...)` checks (wheelImage/pointerImage non-empty, sectors non-empty, sector id unique, weight finite/non-negative, action lists are arrays of objects with non-empty type). It returns None and NEVER calls `_flush_sector_actions_row` (1336) or `_flush_before_charge_from_editors` (1091). So persistence of the open editors does rely entirely on the live `changed` signal chain: ActionEditor.changed -> _on_sector_actions_editor_changed (850/1404-1408) -> _flush_sector_actions_row, and _before_charge_cond/_ae_before_charge_*.changed -> _on_before_charge_changed (735/742/1111) -> _flush_before_charge_from_editors, plus _on_row_
- **复核补充**: Mechanism is correctly described at the structural level (flush_to_model is validate-only, no defensive re-pull) but the root-cause framing implies an actual lost-update bug that the code does not exhibit. Best characterized as a robustness/defensive-coding weakness, not a confirmed save-roundtrip data-loss defect. To make it a real bug the auditor would need to exhibit a mutation path where ActionEditor.changed fails to fire; none was shown, and the per-keystroke textChanged wiring rules out the "mid-edit" scenario. Reasonable hardening (matching the more defensive pattern of explicitly flushing the active row before save) would be: have flush_to_model first call _flush_sector_actions_row(s

### LOW-18. Speech-anchor drag silently materializes preset anchors into JSON, mixing presets with authored data (non-idempotent round-trip)
- **文件**: `tools/editor/editors/sugar_wheel_editor.py`  **行**: 88-118, 384-405, 1224-1252
- **类别**: staging-vs-model  |  **复核**: partial → low  |  **置信**: likely
- **现象**: Author drags one default bubble to reposition it; on save the JSON suddenly contains a hardcoded copy of that one preset, changing which anchors are 'explicit'. If preset defaults later change in code, this instance is pinned to the old values. Editor round-trip is non-idempotent: a drag that visually 'does nothing meaningful' mutates persisted content.
- **机理**: The canvas always draws all 6 preset speech anchors even when doc.speechAnchors is empty (_merge_speech_anchors_for_canvas, 99-118, drawn at 384-405). Dragging a preset-only anchor calls _on_canvas_speech_anchor, which, finding no matching entry in self._speech_rows(), appends a full dict(preset) with the new xRatio/yRatio into doc.speechAnchors (1235-1243) and marks dirty. So merely nudging a default bubble writes a previously-implicit preset (including its label/tailDirection) into the saved JSON. There is no way via this path to move one preset without persisting it; the data model silently grows from 0 to N anchors.
- **修复方向**: If intentional, make it explicit: only persist a preset anchor when its position actually deviates from the preset, or surface in the UI which anchors are preset vs authored. At minimum document that touching a default bubble materializes it. Confirm with design whether partial materialization (one anchor) is desired vs all-or-nothing.
- **证据**: Mechanism confirmed end-to-end:

(1) Canvas always draws all 6 presets regardless of doc state. _merge_speech_anchors_for_canvas (lines 99-118) iterates _SPEECH_ANCHOR_PRESETS unconditionally:
  109  for tmpl in _SPEECH_ANCHOR_PRESETS:
  112      merged = {**tmpl, **by_role.get(rid, {})}
  114      out.append(merged)
and refresh draws each (lines 384-405): `for entry in _merge_speech_anchors_for_canvas(doc): ... ax = _SugarWheelSpeechAnchorItem(...)`. So even with empty speechAnchors all 6 draggable dots render.

(2) Dragging a preset-only anchor materializes it (lines 1235-1243):
  1235  if found is None:
  1236      preset = next((p for p in _SPEECH_ANCHOR_PRESETS if str(p.get("role")) == role), None)
  1237      if preset:
  1238          na = dict(preset)
  1239          na["xRatio"] = xr
  1240          na["yRatio"] = yr
  1241          anchors.append(na)
A full copy of the preset (
- **复核补充**: Mechanism fully verified including the two links the finding did not spell out: _speech_rows() returns the same list object stored under _doc["speechAnchors"] (line 1555), and _doc itself is the exact instance object in model.sugar_wheel_instances (line 1432) that project_model.py:423 writes to disk verbatim with no preset-stripping. So the in-place append survives to JSON.

Correction to symptom framing: the finding says the drag "visually does nothing meaningful" — that is inaccurate; the drag intentionally repositions the bubble. The real wart is (a) implicit->explicit anchor-set growth and (b) pinning label/tailDirection to the code preset values at drag time, so a later code-side preset

### LOW-19. _on_canvas_speech_anchor lacks the _loading re-entrancy guard the other two canvas handlers have
- **文件**: `tools/editor/editors/sugar_wheel_editor.py`  **行**: 1207-1208, 1224-1226, 1254-1256
- **类别**: timer-vs-drag  |  **复核**: confirmed → low  |  **置信**: likely
- **现象**: No reproducible failure today (protected by _move_silent), but the inconsistent guard is a latent re-entrancy hazard if the silent/loading invariants ever diverge.
- **机理**: _on_canvas_layout_offsets (1208) and _on_canvas_charge_button (1255) both early-return on `not self._doc or self._loading`. _on_canvas_speech_anchor (1224-1226) only checks `not self._doc` — it omits the `self._loading` check. In practice the canvas suppresses anchor itemChange emissions during programmatic setPos via _move_silent (sugar_wheel_editor.py:398-402,483-487), so speech_anchor_changed should not fire while _loading is True. But the guard asymmetry is fragile: any future code path that moves an anchor while _loading is set (without _move_silent) would let this handler mutate speechAnchors and call _mark_dirty re-entrantly.
- **修复方向**: Add `or self._loading` to the early-return at line 1225 to match the other two canvas handlers, making the guard uniform.
- **证据**: The guard asymmetry is exactly as claimed.

_on_canvas_layout_offsets (1207-1209):
  if not self._doc or self._loading:   # has _loading
      return
_on_canvas_charge_button (1254-1256):
  if not self._doc or self._loading:   # has _loading
      return
_on_canvas_speech_anchor (1224-1226):
  if not self._doc:                    # OMITS _loading
      return

The "protected today by _move_silent" claim is also accurate. speech_anchor_changed is emitted ONLY from _after_speech_anchor_move (line 488), which early-returns on self._move_silent (line 473). Every programmatic anchor setPos is wrapped in _move_silent=True/False: canvas _draw (398-402) and the snap reposition (483-487); the itemChange override (174-181) also gates on `not self._canvas._move_silent`. So no emit reaches the handler during programmatic moves.

Key structural fact: _move_silent is a flag on the SugarWheelCanvas; _l
- **复核补充**: Finding is factually accurate and not overstated; it explicitly frames itself as a latent guard-consistency hazard with "no reproducible failure today," which matches the code. Two clarifications: (1) The situation is slightly more reassuring than implied — the editor-side re-entry _loading would catch is already independently neutralized by the handler's own local _loading wrap (1247-1251), and _mark_dirty uses refresh_canvas=False (1252). For a future bug you'd need editor _loading=True at handler entry AND a non-silent user-drag emit interleaving; no synchronous path leaves editor _loading True across a user-initiated canvas emit, since _fill_form() resets _loading before _canvas.refresh(

### LOW-20. Backdrop texture pixmap is re-decoded and re-scaled from disk on every canvas refresh, even when only entities changed
- **文件**: `tools/editor/editors/water_minigame_canvas.py`  **行**: 158-183, 471-472
- **类别**: perf-reload  |  **复核**: confirmed → low  |  **置信**: likely
- **现象**: Adding/removing entities or stepping bounds re-decodes and re-scales the (potentially large) water-bottom texture from disk each time, contributing to the rebuild flicker.
- **机理**: refresh() unconditionally calls _load_runtime_pixmap(model, texture_url) (disk stat + full QPixmap decode) and set_backdrop(), which scales the pixmap to bounds with SmoothTransformation and rebuilds the QGraphicsPixmapItem, on every refresh — including refreshes triggered purely by entity add/remove or bounds nudges where the texture URL did not change. There is no caching of the decoded/scaled backdrop keyed by (url, bounds).
- **修复方向**: Cache the decoded backdrop QPixmap by URL and the scaled result by (url, bw, bh); skip set_backdrop work when neither changed since the last refresh.
- **证据**: refresh() in water_minigame_canvas.py lines 471-472 unconditionally re-decodes and re-scales the backdrop on every call:
  471  pm = _load_runtime_pixmap(self._model, texture_url)
  472  self._scene.set_backdrop(pm, tint_hex)

_load_runtime_pixmap (lines 30-34) does a disk stat + full decode every time, no caching:
  30  disk = disk_path_for_runtime_url(model, u)
  31  if disk is None or not disk.is_file():   # disk stat
  33  pm = QPixmap(str(disk))                   # full decode

set_backdrop (lines 158-183) tears down + rebuilds the item, full SmoothTransformation rescale each call:
  160  if self._texture_item is not None:
  161      self.removeItem(self._texture_item)
  169  scaled = base_pm.scaled(bw, bh, IgnoreAspectRatio, SmoothTransformation)
  175  self._texture_item = QGraphicsPixmapItem(scaled)

grep for cache/_last/_cached/_tex_url confirms NO caching state exists — only _t

### LOW-21. Spinbox-driven position writes the unclamped value to the model but clamps the sprite silently, diverging model from visual
- **文件**: `tools/editor/editors/water_minigame_editor.py`  **行**: 1058-1067
- **类别**: coordinate-math  |  **复核**: confirmed → low  |  **置信**: likely
- **现象**: Type a pos x/y outside the bounds rectangle: the sprite snaps to the edge but the saved JSON keeps the out-of-bounds coordinate; reopening shows a mismatch between the field value and the sprite location.
- **机理**: _on_ent_pos_changed writes self._cur_ent['pos']={x,y} from the spinboxes (full -50000..50000 range) BEFORE calling canvas.set_marker_center(r,x,y). set_marker_center sets _suppress_moved=True then setPos(visual center); setPos triggers EntitySpriteItem.itemChange ItemPositionChange, which CLAMPS the center into sceneRect (canvas lines 300-310). Because _suppress_moved is True, the clamped position is NOT written back to the model. Result: if the user types an x/y outside bounds, the JSON stores the out-of-bounds value while the sprite sits at the clamped edge — the visible position no longer matches the saved data. (During mouse drag this is consistent, because there the clamped pos.() is read back and emitted; only the spinbox path diverges.)
- **修复方向**: After set_marker_center clamps, read back it.pos() and write the clamped container pos into the model (and reflect it in the spinboxes), or clamp the spinbox input against bounds before storing. Make the spinbox path symmetric with the drag path which already round-trips the clamped value.
- **证据**: water_minigame_editor.py:1058-1067 `_on_ent_pos_changed`:
  x = self._ent_px.value(); y = self._ent_py.value()
  self._cur_ent["pos"] = {"x": x, "y": y}   # raw spinbox value written to model
  self._mark_wm_dirty()
  ... self._canvas.set_marker_center(r, float(x), float(y))   # called AFTER model write

Spinbox range allows out-of-bounds input — water_minigame_editor.py:257/259: self._ent_px.setRange(-50000, 50000); self._ent_py.setRange(-50000, 50000), while sceneRect = (0,0,bw,bh) with bw,bh in [64,8192] (lines 188/190).

water_minigame_canvas.py:520-530 `set_marker_center`: sets self._suppress_moved = True, then it.setPos(QPointF(float(x), cy)).

water_minigame_canvas.py:300-310 `itemChange` ItemPositionChange CLAMPS center into sceneRect inset by half-sprite:
  clamped = QPointF(max(sr.left()+self._half_w, min(sr.right()-self._half_w, new_center.x())), max(sr.top()+self._half_h, min
- **复核补充**: Mechanism is exactly as described and reproduces only when a user types an x/y outside the (sceneRect inset by half-sprite) rectangle. Severity low is correct: no crash, no loss of other data, narrow trigger; it is a model-vs-visual / save-vs-display inconsistency. Note the runtime would actually consume the out-of-bounds stored value, so the divergence persists into the game, not just the editor — but still minor. Depth-offset handling is symmetric across both paths (set_marker_center adds it_._depth_off at line 527, _on_entity_position_changed subtracts it at line 425), so no additional bug there. A clean fix would clamp x/y before writing self._cur_ent["pos"] (mirror the itemChange clamp 

### LOW-22. _entities_list() rebuilds and reassigns self._doc['entities'] on every call, including inside hot handlers
- **文件**: `tools/editor/editors/water_minigame_editor.py`  **行**: 766-777, 846-852, 1058-1067
- **类别**: perf-reload  |  **复核**: confirmed → low  |  **置信**: likely
- **现象**: No visible bug, but every canvas drag step and field edit reallocates the entities list. Minor GC churn; a latent hazard if any code caches the entities list reference.
- **机理**: _entities_list() always constructs a new filtered list and does self._doc['entities'] = out, even when nothing was malformed. It is called from many per-event handlers (_on_canvas_entity_moved on every drag step, _on_ent_pos_changed, every scalar handler via _entities_list() for the canvas refresh). Per drag-move this allocates a fresh list and reassigns the model key. The element dicts are preserved (so pos writes still target the live entity), but the repeated list churn during a drag is wasteful and means any external reference to the previous list object becomes stale. It also makes the model object identity unstable mid-edit.
- **修复方向**: Filter/normalize entities once on load/instance-switch, and have _entities_list() return the existing list without reassigning when it is already a clean list. Only rebuild when a non-dict element is actually found.
- **证据**: _entities_list() at tools/editor/editors/water_minigame_editor.py:766-777 unconditionally rebinds the model key:
  772  out: list[dict] = []
  773  for e in ents:
  774      if isinstance(e, dict):
  775          out.append(e)
  776  self._doc["entities"] = out   # <-- runs EVERY call, no malformed-check guard
  777  return out
No conditional gates line 776; a fresh list is allocated and reassigned even when `ents` was already a clean list of dicts.

Hot call path confirmed:
- line 153: self._canvas.entity_moved.connect(self._on_canvas_entity_moved)
- _on_canvas_entity_moved (line 849): ents = self._entities_list()
- canvas emits entity_moved from _on_entity_position_changed (water_minigame_canvas.py:426), triggered by ItemPositionHasChanged in itemChange (canvas:312-313) => fires per drag-step, not on release.
- Scalar/field handlers also call it per edit: lines 1038, 1047, 1056, 1067(s
- **复核补充**: Mechanism is accurate and severity (low) is correct: minor per-drag/per-edit list reallocation with no observable defect; the stale-cache concern is latent only (no code currently caches the list). Adjacent observation: the validation path at lines 1242-1247 uses the correct conditional form (only assigns doc["entities"]=[] when missing), demonstrating _entities_list() could trivially adopt the same guard to avoid the churn.

### LOW-23. flush(for_save_all=True) TypeError fallback can mask an internal TypeError raised inside flush_to_model
- **文件**: `tools/editor/main_window.py`  **行**: 732-735
- **类别**: save-roundtrip  |  **复核**: partial → low  |  **置信**: likely
- **现象**: Confusing double-execution / double-error if a sugar-wheel doc ever triggers a TypeError inside validation; harder to diagnose because the first occurrence is swallowed.
- **机理**: Save All does `try: result = flush(for_save_all=True) except TypeError: result = flush()`. SugarWheelEditor.flush_to_model(self) takes no for_save_all kwarg, so the first call always raises TypeError (arity mismatch) and the fallback flush() runs — fine. But the except clause catches ANY TypeError, including one raised deep inside flush_to_model's body (e.g. float(None), a bad comparison). In that case the validator is silently re-invoked a second time via flush(); the second run hits the same TypeError, which now propagates unguarded — so the real failure is reported, but the editor's validation side effects run twice and a genuine logic TypeError is conflated with the benign arity mismatch.
- **修复方向**: Detect kwarg support via inspect.signature once, or use a sentinel: only fall back to flush() when the TypeError is the arity mismatch. Cleanest: give all flush_to_model a uniform (self, *, for_save_all=False) signature so no try/except arity dance is needed.
- **证据**: main_window.py:731-741 is exactly as described:
  t0 = time.perf_counter()
  try:
      result = flush(for_save_all=True)
  except TypeError:
      result = flush()
  ...
  if result is False:
      ... raise RuntimeError(...)

Arity premise confirmed: only narrative_state_editor.py:684 `def flush_to_model(self, *, for_save_all: bool = False) -> bool` accepts the kwarg; sugar_wheel_editor.py:2257, water_minigame_editor.py:1236, filter_editor.py:209, scene_editor.py:6302, player_avatar_editor.py:138, overlay_images_editor.py:208, narrative_data_editors.py:1130/1846 are all `def flush_to_model(self) -> None`. So for those, `flush(for_save_all=True)` raises TypeError at call-binding and the fallback `flush()` runs — the duck-typing trick works. `narrative_state_editor` honors for_save_all to suppress modal QMessageBox spam during Save All (lines 695,705).

Smell is real: a bare `except Type
- **复核补充**: Severity "low" is generous — this is a latent code-quality nit, not a demonstrated bug; it borders on not-a-bug because no flush_to_model body is shown to raise an unguarded TypeError, and the title's named editor (SugarWheel) provably cannot. The robustness fix is trivial and worthwhile: inspect the signature instead of catching by exception type, e.g. `import inspect; if "for_save_all" in inspect.signature(flush).parameters: flush(for_save_all=True) else: flush()`. That removes the conflation entirely and avoids any risk of re-running side-effecting _apply()/_apply_props() paths.

Adjacent observation while reading: in _flush_editors_to_model the `if result is False:` check (738) is dead f

### LOW-24. blend_overlay_preview: re-reads and re-decodes both source images from disk on every position/size tweak (no pixmap cache)
- **文件**: `tools/editor/shared/blend_overlay_preview.py`  **行**: 120-176, 105-112
- **类别**: perf-reload  |  **复核**: confirmed → low  |  **置信**: likely
- **现象**: Dragging the xPercent/yPercent/widthPercent spinboxes makes the preview stutter and momentarily reload large images from disk even though only the composition geometry changed.
- **机理**: _reload_scene always constructs fresh QPixmap(str(path_from)) / QPixmap(str(path_to)) from disk (lines 150-151) and re-scales them. It is wired (action_editor.py:3013-3019) to schedule_refresh on xPercent/yPercent/widthPercent/duration/delay valueChanged as well as image path changes. For a pure position/size change the source images are identical, yet both full-resolution files are re-read and re-decoded from disk every refresh. QPixmap(path) does not use Qt's QPixmapCache, so nothing is cached. The 220ms debounce (DEBOUNCE_MS) coalesces rapid changes but every settled change still pays a full disk read + decode + smooth-scale, which can flicker/stutter on large overlay images.
- **修复方向**: Cache the loaded source QPixmaps keyed by resolved disk path (and mtime), reload from disk only when from_url/to_url actually change; on geometry-only refresh reuse cached pixmaps and only re-scale/reposition. Optionally split into _reload_images() vs _relayout() so spinbox changes hit only the layout path.
- **证据**: blend_overlay_preview.py:150-151 — `pm_from = QPixmap(str(path_from)) if path_from else QPixmap()` / `pm_to = QPixmap(str(path_to)) if path_to else QPixmap()` are built fresh from the file path on every `_reload_scene` call. The scene is wiped first (line 122 `self._scene.clear()`) and there is NO member caching the decoded source pixmaps — only the disposable scene items `self._item_from`/`self._item_to` are stored. Lines 167-176 then re-scale both with SmoothTransformation each call.

Wiring confirmed at action_editor.py:3013-3019:
  from_row.changed.connect(bprev.schedule_refresh)
  to_row.changed.connect(bprev.schedule_refresh)
  dur.valueChanged.connect(bprev.schedule_refresh)
  del_sp.valueChanged.connect(bprev.schedule_refresh)
  self._param_widgets["xPercent"].valueChanged.connect(bprev.schedule_refresh)
  self._param_widgets["yPercent"].valueChanged.connect(bprev.schedule_refres
- **复核补充**: Mechanism is accurately described; the code does exactly what the finding claims. Downgrading medium -> low: this is a dev-only PyQt authoring-tool preview panel, not the shipped game runtime. Three mitigating factors the finding underweights: (1) the preview section is collapsed by default (action_editor.py:3010 CollapsibleSection start_open=False), so redundant reloads only fire when the author expands it; (2) the 220ms debounce already coalesces an active drag into a single settled reload; (3) it only affects editor responsiveness, never gameplay. Real perf-reload inefficiency worth a small fix (cache decoded source pixmaps keyed by resolved path+mtime, re-scale only on geometry change), 

### LOW-25. blend_overlay_preview: naturally-finished QVariantAnimation is not cleared, leaving a stale anim object until next play/stop
- **文件**: `tools/editor/shared/blend_overlay_preview.py`  **行**: 247-261, 263-271
- **类别**: qt-lifecycle-crash  |  **复核**: partial → low  |  **置信**: likely
- **现象**: Minor: a stale finished animation object and its connection persist after each preview playthrough until the next play/stop; no user-visible effect under current call paths.
- **机理**: _start_blend_after_delay assigns self._opacity_anim and starts it. On natural completion only the finished lambda runs (lines 258-260); it does not null out self._opacity_anim or call deleteLater. Only _stop_all (lines 265-268) clears it. So after a normal playthrough a finished QVariantAnimation lingers referenced by self._opacity_anim with its valueChanged/_apply connection still bound to self._item_to. It is parented to self so it is freed on widget destruction, but a subsequent _reload_scene that clears the scene (deleting _item_to's C++ object) before _stop_all is called would leave a dangling connection; in practice _on_play and schedule_refresh both call _stop_all first, so it is latent rather than live.
- **修复方向**: In the finished handler, also disconnect/clear: set self._opacity_anim = None and deleteLater it (or route completion through _stop_all-style cleanup) so a completed animation does not retain a reference to _item_to.
- **证据**: The leak is real and described accurately. _start_blend_after_delay creates a fresh anim and binds two connections without any natural-completion cleanup:

L247-261:
  self._opacity_anim = QVariantAnimation(self)
  ...
  self._opacity_anim.valueChanged.connect(_apply)        # _apply references self._item_to (L253-255)
  self._opacity_anim.finished.connect(
      lambda: self._status.setText(...))                 # finished handler ONLY sets status text
  self._opacity_anim.start()

The finished lambda (L258-260) does NOT null self._opacity_anim nor call deleteLater. The only cleanup site is _stop_all (L263-268):
  if self._opacity_anim is not None:
      self._opacity_anim.stop(); self._opacity_anim.deleteLater(); self._opacity_anim = None

So after a normal playthrough the finished QVariantAnimation lingers, referenced by self._opacity_anim with its valueChanged/_apply connection still
- **复核补充**: Mechanism is real but the category "qt-lifecycle-crash" is wrong: there is no reachable crash/use-after-free. The stale finished animation never re-emits valueChanged (a fresh anim is created every play, the old one is never restarted), and _apply self-guards on _item_to. This is a benign lifetime-hygiene leak (one stale anim object + its connections kept alive until next play/stop, then deleteLater'd). Severity low is fair (arguably trivial). Suggested precise fix: in the finished handler, set self._opacity_anim = None and deleteLater the sender, or connect finished to a small cleanup slot. Adjacent note: _reload_scene does self._scene.clear() which invalidates the old _item_from/_item_to C

### LOW-26. Save contract test suite never exercises the MainWindow editor-flush path — the staging-flush gap is fully untested
- **文件**: `tools/editor/tests/test_save_contract.py`  **行**: 23-66, 121-165, 489-519
- **类别**: save-roundtrip  |  **复核**: partial → low  |  **置信**: certain
- **现象**: Regressions in editor flush wiring (e.g. a SceneEditor that forgets to flush staging, or a close path that skips flush) pass CI green.
- **机理**: Every test in test_save_contract.py and test_project_save.py drives ProjectModel.save_all() directly after manually mutating model attributes and calling model.mark_dirty(...). None construct a MainWindow or call _flush_editors_to_model()/_save_all(), so the editor staging→model commit (SceneEditor.flush_to_model → _apply_props) and the close/switch gates are outside test coverage. The format/round-trip guarantees (ensure_ascii=False, indent=2, trailing newline — centralized in file_io._json_text, file_io.py:15-19) ARE exercised at the model layer, but the guarantee that an in-flight Scene canvas drag reaches the model before save_all is not. This is why the data-loss bugs above can regress undetected.
- **修复方向**: Add a GUI-level test that instantiates MainWindow (or at least SceneEditor + _flush_editors_to_model), performs a simulated canvas drag, then asserts (a) model.is_dirty becomes True and (b) after save_all the scene JSON on disk reflects the new x/y. Also add a close-path test asserting a staged-but-unApplied drag triggers the save prompt.
- **证据**: The finding's scoping claim about the two named files is fully accurate. In test_save_contract.py every test (lines 33-635) and in test_project_save.py every test (lines 31-107) follows the same shape: construct ProjectModel() directly, mutate model attrs, mark_dirty, call save_all() — e.g. test_save_contract.py:147-165 (`m=ProjectModel(); m.load_project(root); m.items[0]["name"]=...; m.mark_dirty("item"); ... m.save_all()`) and test_project_save.py:80-107. None instantiate MainWindow or call _flush_editors_to_model/_save_all (grep over tests/ returns no editor-MainWindow import or instantiation; the only `_save_all` hit is the unrelated method NAME test_save_all_project_path_none_is_silent_noop, and the only QMainWindow() is a bare Qt window in test_production_workbench_console.py:122).

The genuinely-uncovered code is the MainWindow orchestration in main_window.py:716-742 (`_flush_edit
- **复核补充**: Mechanism is correct but mis-described in scope. The true gap is narrow: the MainWindow save orchestration (_save_all → _flush_editors_to_model loop, including TimelineEditor pending-changes gate and pop_flush_error propagation) has no integration test. It is NOT true that the staging-flush concept is "fully untested" — narrative close-gate flush, scene-panel staging, and map-editor live-commit all have targeted tests. Severity should be low, not medium: a SceneEditor that "forgets to flush staging" would still be caught at the panel layer by test_scene_editor_cutscene_only, and the highest-risk class (Scene canvas drag reaching the model before save) is mitigated by the staging-aware _stagi

---

## 驳回（复核认定非缺陷或影响不成立）
- `tools/editor/editors/scene_editor.py:5924-5946, 5909-5915, 6246` — During patrol preview, NPC x/y live edits don't redraw the sprite at all before the timer asserts the preview position
  - 原因: Spinbox path `_on_npc_xy_live_changed` (L5924-5946) — when patrol preview is active the NPC IS in `_patrol_preview_ids`, so the redraw is guarded out:
L5944  if npc_id not in self._patrol_preview_ids:
L5945      rt.draw_at(float(n.get("x", 0)), float(n.get("y", 0)))
L5946      self._canvas.viewport(
- `tools/editor/editors/scene_editor.py:1831-1849, 6028-6062` — mouseReleaseEvent emits item_moved then item_selected; correct ordering relies on _on_item_selected short-circuit which depends on staging id == model id, fragile after an id rename
  - 原因: The finding's central premise — that editing an entity's id in the panel (without Apply) makes the staging dict's id diverge from the canvas-handle eid, breaking the short-circuit — is contradicted by the actual wiring.

1) The id fields are bare QLineEdits with NO signal connections:
   - L3081: `s
- `tools/editor/editors/scene_editor.py:6254-6263,6306-6312,5360-5415` — Spawn drag write target diverges from panel write target (staging vs model split source)
  - 原因: The finding's premise — that the spawn-drag write dict and the spawn-panel write dict can diverge (one to staging, one to live model) — does not hold, because `_staging_scene` is an established invariant whenever a scene is current.

1. `_load_scene` is the ONLY method that sets `self._current_scene
- `tools/editor/editors/scene_editor.py:5613-5617, 5824-5851, 5853-5865, 5918-5922` — _clear_scene_npc_anim_layers clears the runtimes dict and stops the timer but never removeItem()s the NPC sprite pixmaps — orphaned ghost sprites on the empty-id rebuild path
  - 原因: The structural observation is accurate but the claimed trigger does not exist. _clear_scene_npc_anim_layers (5613-5617) indeed only stops the timer and clears dicts, never removeItem()-ing the QGraphicsPixmapItem added at 5830 — unlike _refresh_one_scene_npc_anim (5878-5880) which does `old.item.sce
- `tools/editor/editors/map_editor.py:254-257 (_clear_edge_items), reached from 156 itemChange -> 275 _redraw_edges -> 356` — _clear_edge_items removeItem loop runs inside itemChange (event dispatch) during drag — latent removeItem-during-dispatch hazard
  - 原因: The literal call chain is real but harmless. itemChange (line 154-156) fires on ItemPositionHasChanged -> _on_node_item_moved (259) -> _redraw_edges (275) -> _clear_edge_items (356) -> self._map_scene.removeItem(it) loop (lines 254-257). However the claimed HAZARD is false for this code:

1) The dis
- `tools/editor/editors/water_minigame_editor.py:379-392, 469-472, 550-558, 1236-1237, 1260-1263` — Action edits are not committed to the model dict at edit time — only on row/instance switch or Save (deferred-write divergence)
  - 原因: The deferred-write observation is factually correct but the claimed IMPACT (any model-reading consumer sees stale actions) is false because every consumer flushes first.

Deferred write (true): the three ActionEditors only connect `changed -> _mark_wm_dirty` (line 384), and action data is written in
- `tools/editor/shared/move_entity_map_picker.py:137-145` — Map picker: division by zero when scaling a non-null background pixmap with zero width/height
  - 原因: File tools/editor/shared/move_entity_map_picker.py, lines 137-145:

  137  if img_path is not None and img_path.is_file():
  138      pm = QPixmap(str(img_path))
  139      if not pm.isNull():
  140          self._bg_item = QGraphicsPixmapItem(pm)
  141          self._bg_item.setZValue(-100)
  142  
- `tools/editor/project_model.py:299-312` — ProjectModel.save_all early-returns on is_dirty==False, so any unflushed staging at save time is silently skipped
  - 原因: project_model.py:305-307 save_all early-returns:
    if not self.is_dirty:
        maybe_stamp(clk, "无 dirty，跳过保存与校验")
        return

Production path in main_window.py _save_all (757-762):
    if not self._flush_editors_to_model():   # 759
        return False
    self._model.save_all()            
