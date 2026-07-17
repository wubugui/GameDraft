---
target: headless-visual-verification
date: 2026-07-18
session: 运镜easing迭代真机验证
---

现实:dev 模式下用 window 派发 Escape 跳过场,DebugTools 的 Dev Mode 全屏列表面板会同帧被切出来,盖住画面且不随 cutscene 结束关闭——后续截图全被面板污染;该面板是 PIXI/内部 UI,不是 DOM 的 #debug-dock,`document.querySelector` 藏不掉。

文档说:配方只警告"Esc 连打会误开暂停菜单",没提 dev 模式下单次 Esc 即弹 Dev Mode 面板、也没给关闭手段。

建议:配方补一条——dev 模式跳过场后若需截图,先确认 Dev Mode 面板状态;或改用 cutsceneManager.skip() 直调绕开 Esc 键路径(未验证,待下次实测)。
