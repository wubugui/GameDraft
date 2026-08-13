---
target: missing
date: 2026-08-12
session: 日夜循环系统落地
---

现象: 内容侧早就用一张叫 `eco_时辰` 的叙事图当「时辰」条件（生态类对话图的 root switch 大量分支写 `{narrative:'eco_时辰', state:'夜'/'午'}`），但这张图**已不在 narrative_graphs.json 里**——validate-data 97 个 error 里有 50 个是它，运行时这些分支恒为 false，等于所有「夜里才说的话」全哑了。
证据: `.tools/venv/bin/python -m tools.editor.validate --errors-only | grep -c eco_时辰` → 50；`python3 -c "import json;print([c['id'] for c in json.load(open('public/assets/data/narrative_graphs.json'))['compositions']])"` 里没有 `eco_时辰`。同类还有 `flow_xungou_main`（11 个 error，且 XungouMainFlowIntegration.test.ts 3 个用例与 NarrativePackageDirectorFlow.test.ts 1 个用例因它红着）。
建议: 2026-08-12 落地的日夜系统已提供正规替代——条件叶 `{timePhase:'night'}`（由 DayManager 的时刻派生，见 docs/玩法功能需求清单.md H3/H4）。这 50 处宜迁到 timePhase 叶，`eco_时辰` 图不再重建；`flow_xungou_main` 那批是主线图改名（现为 `xungou_demo_main`）后的测试/内容漂移，属另一件事。
