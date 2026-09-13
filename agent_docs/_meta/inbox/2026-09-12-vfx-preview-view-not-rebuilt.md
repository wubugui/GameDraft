---
target: vfx-workbench
date: 2026-09-12
session: 跑马梁场景风 / 纸钱薄片
---

现象: 联动 applyPreviewEffect 只重建模拟,渲染视图按"实例/发射器"键复用;改外观里决定 program 的项(lit / 薄片与否)时旧 shader 继续用,看起来"改了没生效"。
证据: 跑马梁上把 paper_money 的 lit 从 true 改 false 走 applyPreviewEffect,vfxRenderer.views 里那条仍 lit:true;vfxRenderer.clear() 后下一帧才换。
建议: applyPreviewEffect 顺手让渲染器丢掉引用该效果的视图(或按外观签名重建)。
