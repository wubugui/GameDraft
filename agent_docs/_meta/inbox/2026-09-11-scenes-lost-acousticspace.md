---
target: scene-acoustics
date: 2026-09-11
session: vfx-system
---

现象: **6 个**场景的 `acousticSpace` 键被整批抹掉（HEAD 有 6 个 → 工作树 0 个），
`test_acoustic_space_ref` 与 `test_scene_acoustic_field` 两条"断言别形同虚设"的自检因此红。
证据: `git show HEAD:public/assets/scenes/跑马梁.json | grep -c acousticSpace` = 1，工作树 = 0；
该文件 mtime 2026-09-10 00:14，本会话（09-11）没碰过它 ⇒ 是另一个会话在飞的改动，不是回归。
建议: 那个会话收尾时确认是有意去掉（那两条测试要跟着改口径）还是误删（补回）。
注: 两条红是同一个根因，别当成两个 bug 分头修。范围由 validator 2026-09-11 复核。
