---
target: scene-relight-tool
date: 2026-09-07
---
现象: tools/scene_relight/RESEARCH.md 将 Marigold 总括为 Apache-2.0，但 IID 模型权重卡明确标注 OpenRAIL++；代码与权重许可不同。
证据: artifact/AlbedoCliff_20260907/marigold_native/lighting-model-card.md 的 license 字段与 Model Details；同目录 space-app.py 的代码版权头为 Apache-2.0。
建议: 后续治理分别记录代码许可、权重许可与具体模型版本，不以代码许可替代模型权重许可。
