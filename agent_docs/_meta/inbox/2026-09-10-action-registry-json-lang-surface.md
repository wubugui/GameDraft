---
target: action-registration-registry-surfaces
date: 2026-09-10
session: 三把火/气味 HUD 首次出场教程与说明卡
---

- 现实：新增带"内容 id 引用"参数的 action（showSystemNote.noteId）时，除卡上列的四个登记面外，还得同步 `tools/json_lang/schema_build.py#CONTENT_ID_PARAMS`、`tools/json_lang/id_universes.py`（新宇宙的 id 装载）与 `action_editor.py` 的 `_SELECTOR_KIND_UNIVERSE`；漏了 `test_shared_widget_selectors` 的宇宙级 parity 会红、json-lang schema 也不给该参数枚举。**不要**把编辑器只读镜像的桶（如 system_notes）塞进 `lsp_client._SIMPLE_OVERLAY_FILES`——那张表只登记 save_all 有写盘分支的脏桶，`test_lsp_overlay_parity` 会判它过时。
- 文档：`agent_docs/runtime/mechanisms/action-registration-registry-surfaces.md` 的登记面清单没写这三处（只在"条件性"提了 ENTITY_REF_PARAMS）。
- 建议：在该卡"条件性"一节补一行"参数是内容 id 引用（非实体）→ CONTENT_ID_PARAMS + id_universes + _SELECTOR_KIND_UNIVERSE 三处，只读镜像桶不进 overlay 表"。
