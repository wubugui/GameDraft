---
target: scene-acoustics
date: 2026-09-07
session: 场景声学落地
---

现象: 新增 `scene.acousticSpace` → `acoustic_spaces.json` 的引用关系后，六道收尾门一个都查不到它（`grep acousticSpace tools/ scripts/ schemas` 零命中），而这层引用运行时不报错、不回落，写错一个字只是那个场景彻底没有回音、毫无痕迹。
证据: 已补 `tools/editor/validator.py` 的 `check_acoustic_space_ref`（记 error），回归在 `tools/editor/tests/test_acoustic_space_ref.py`；机制卡 `runtime/mechanisms/scene-acoustics.md`；踩坑与设计全文在 `artifact/BeishiAtmosphere_20260906/声学系统设计.md`。
建议: 「新增跨文件引用字段必须同时加校验」值得进 content/runtime norms —— 这是第二次因为「运行时静默跳过」而事后补门。
