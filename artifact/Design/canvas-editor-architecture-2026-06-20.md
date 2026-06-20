# 画布编辑器统一架构 + 数据零丢失重构（2026-06-20）

> 背景：审查发现 63 条画布编辑/数据同步/保存缺陷，根因是"实体位置/数据的真相源三向割裂 +
> 编辑不入脏标 + 切换/关闭静默丢弃 + 各编辑器手搓同步"。本次重构确立统一范式并修复高危簇。
> 详细缺陷清单见 `artifact/Reviews/canvas-editors-审查-2026-06-20.md`。

## 1. 确立的统一范式（所有画布编辑器对齐）

1. **单一真相源**：同一实体的位置/几何，画布渲染、动画定时器、保存必须读同一处。
   - 场景编辑器保留"staging 深拷贝"作编辑事务，但**新增唯一位置解析器**
     `SceneEditor._npc_render_pos_dict(rid, model_npc)`：正在编辑的实体读 staging，其它读模型，
     与拖拽写入处（`_staging_npc_for_canvas_drag`）同源。动画定时器 `_tick_scene_npc_anims`
     不再直读已提交模型 → 消除"精灵每 8ms 被拍回旧位"的闪烁。
2. **一切画布编辑即时入脏**：`SceneEditor._mark_canvas_edit()` 统一入口——拖实体/出生点、改多边形/
   巡逻顶点都 `mark_dirty('scene', sid)` + 点亮未应用提示。关闭/切项目门控读 `is_dirty` 即可感知，
   不再静默丢弃。
3. **commit-on-leave（离开即提交）**：`SceneEditor._commit_pending_scene_edits()` 在切场景
   (`_load_scene` 顶部)、切实体(`_on_item_selected` 各 `load_*_props` 前) 时把未应用 staging 提交回模型，
   杜绝"切走丢编辑"。`confirm_close()` 让关闭/切项目门控也先提交挂起编辑。
4. **画布是模型的投影**：数值框改 x/y 时 `SceneCanvas.move_entity_handle()` 让可拖图元跟随精灵，
   反向脱节消除；画布项尽量原地更新而非删-重建。
5. **懒回写按身份、不按行号**：水玩法实体动作回写改为 `_ae_owner`（实体 dict 身份），删除/重排后
   行号漂移也不会把动作串台进别的实体。

## 2. 数据零丢失安全网（永久回归护栏）

- `tests/test_canvas_roundtrip_safety.py`：以**真实工程全部 JSON**为黄金样本，断言
  "加载 → 序列化/`save_all` → 重载" **语义深层零变化**。证明编辑器序列化对业务数据零篡改。
  （字节差异仅是历史紧凑写法/缺末换行被规范化，无损。）
- `tests/test_scene_editor_drag_persistence.py`：拖实体/出生点/改名后，标脏 + 切场景/切实体/关闭
  门控不丢。
- `tests/test_scene_editor_sprite_sync.py`：精灵跟随拖拽（定时器读 staging）、图元跟随数值框、
  displayImage 原地平移（不每帧重载）。
- `tests/test_water_minigame_delete_corruption.py` / `test_paper_craft_correct_paper.py` /
  `test_sugar_wheel_flush.py` / `test_map_editor_live_commit.py`：各编辑器数据损坏/丢失回归。

## 3. 本次修复的缺陷（按编辑器）

- **场景编辑器**：精灵闪烁/不跟随（定时器-拖拽抢位）、拖拽/改名不入脏、切场景/切实体/关闭/切项目
  静默丢弃、多边形/巡逻/出生点不入脏、数值框改坐标图元不动、displayImage 拖拽闪烁（磁盘重载）。
- **地图编辑器**：`_refresh` 选择丢失（clear 触发 selectionChanged 清 `_current_idx`）、销毁期
  `selectionChanged` 命中已删场景崩溃、别处改场景后连线过期不刷新。
- **水玩法**：删实体把被删动作串台进补位实体（数据损坏）。
- **扎纸**：空/未知 correctPaper 被静默写成第一种纸张（判分被改）。
- **糖盘**：`flush_to_model` 只校验不提交，当前 sector 动作在保存时丢失。
- **地图点选器**：载入时把已授权终点/途经点夹到边界，仅查看点 OK 也会改写坐标。
- **任务图**：点图节点不同步树选择（`_current_selection` 过期，编辑落到上一个实体）。

## 4. 已知遗留（纯性能/打磨，不影响数据正确性，后续可跟进）

- 水玩法/糖盘改单个标量即整画布从磁盘重建（闪烁/卡顿）；blend_overlay 每次重载两张源图；
  任务图 `_refresh_graph` 每次 Apply 重置缩放；地图连线每次拖动重建全量。
- 这些是"低效但正确"，可按 perf-reload 思路逐个改为增量/缓存更新；不属于"ad-hoc 同步"或丢数据。

## 4b. 表单类编辑器"编辑后不丢失"统一收口（后续补全）

审查后扩展到**所有**编辑器：apply-gated 表单编辑器（只有点 Apply 才写回模型）此前在
切条目 / Save All / 关闭时静默丢弃未应用编辑。逐个补齐为统一范式：

- **脏判断**：snapshot（UI 对比载入时的 UI，避开旧数据自动迁移误判，如 rule 的
  description→layers）或 deepcopy-write-compare（把 UI 写进模型副本比对，保留未受管字段）。
- **commit-on-leave**：切条目前提交上一项（apply 会 _refresh 重建列表时，用 id 重新定位 +
  `_suppress` 防递归/悬挂——见 quest/rule）。
- **flush_to_model**：Save All 前提交（主窗口 `_flush_editors_to_model` 已在写盘前统一调用）。
- **confirm_close**：关闭/切项目门控（`_confirm_pending_editor_changes` 逐编辑器调）提示保存/放弃。

已完成（全治）：item、shop、encounter、game_config、pressure_holds、signal_cues、string、
quest、rule。复杂嵌套编辑器（archive 角色/传说/文档/书页、audio 多声道表）补 **flush_to_model
无条件提交活动选区**，堵住主路径（Save All）；其 commit-on-leave/confirm_close 因嵌套列表
重建风险大暂留，属已知残留。本就在保存时提交活动编辑的编辑器（filter、narrative_state、
dialogue_graph、player_avatar、overlay_images、narrative_data、timeline）无需改。

护栏：`tests/test_form_editor_persistence.py` 逐编辑器验证"编辑→切条目/Save All 不丢"。

## 5. 验证门（全部通过）

- 编辑器测试：264 passed（新增 23 条护栏），0 回归（2 个失败为既有 `/var` vs `/private/var`
  临时目录符号链接问题，与画布无关）。
- `./dev.sh validate-data`：exit 0，0 error。
- 资源引用审计 `--strict`：0 issue。
- 黄金往返：59/59 文件语义无损；`save_all` 强制全脏→重载 0 属性变化。
