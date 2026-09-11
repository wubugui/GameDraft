---
target: editor-tools-norms
date: 2026-09-09
session: 照明实验室补「烘几何场」按钮
---

现象: 「入口接上了」的判据一直是"路由/端口能 grep 到"(实验室 README 写着"页内也能点",
测试 `TestEntryPoints` 也只断言 `/api/bake_fields` 在 `do_GET` 里),但查看器里**一个按钮都没有**,
`export_depth` 回带的 `fields_stale` 也无人读 —— 作者在软件内走不完「导出深度→几何场过期→重烘」。
证据: `tools/character_lighting_lab/tests/test_gi_hitmap.py::TestEntryPoints`(改前只查 serve.py 源码串)
+ 改前的 `viewer/app.js` 全文零 `bake_fields`;README 第 82 行「页内也能点」空头支票挂了 9 天。
建议: 规范里「入口」的验收判据补一句:**后端路由 + 前端触发件 + 回包字段的消费方,三样都要能 grep 到**;
服务端专门为查看器回带的旗标(如 `fields_stale`)必须配一条"谁在读它"的断言,否则就是写了没人看。
