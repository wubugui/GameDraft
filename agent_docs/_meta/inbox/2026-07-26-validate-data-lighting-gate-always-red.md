---
target: content-validation-gate
date: 2026-07-26
session: 规矩系统迁移 Phase 0
---

现象: 配方说 `validate-data` 零 error 才算过门,实测**全部 34 个场景恒报 lighting-bake error(共 84 条)**,内容侧收尾门永远是红的、真问题被淹没。
证据: `tools/editor/validate.py:107-109` 期望 `pn*K*4*4*2`(旧四列块布局),而 baker 早已改成单块固化输出(`tools/character_lighting_lab/pipeline.py:1394-1403` 注释明写"单块最终 E 球谐"),实际文件恰好是期望值的 1/4;`python -m tools.editor.validate | grep -c '^\[ERR '` = 84,全部 category=lighting-bake,内容类 error 为 0。
建议: 期望值改成 `pn*K*4*2`;并在配方里补一句「lighting-bake 与内容 error 要分开看」,以及记明 `.tools/Python311` 无 PySide6、跑校验必须用带 PySide6 的解释器(否则静默 exit 0 假绿)。
