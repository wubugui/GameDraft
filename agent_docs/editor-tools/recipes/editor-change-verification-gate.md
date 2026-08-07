---
id: editor-change-verification-gate
title: 改编辑器后的验证门
domain: editor-tools
type: recipe
summary: 三件套(全量测试+素材审计+validate-data)+ 测试环境三条硬规矩 + 已知盲区对策 + "输出字节不变"强验收法;解释器 .tools/venv + offscreen
status: active
authority:
  - tools/editor/shared/asset_reference_audit.py
  - tools/editor/tests/test_canvas_roundtrip_safety.py
  - tools/conftest.py
  - dev.sh
triggers:
  paths: ["tools/editor/*", "tools/dialogue_graph_editor/*", "tools/narrative_editor_web/*"]
  topics: [验证门, 黄金往返, 格式保真, 字节验收]
  tasks: [改编辑器收尾验证, 证明导出格式不变]
last_governed: 2026-08-05
---

实测环境与日期:macOS、`.tools/venv/bin/python`(带 PySide6,**不是** `.venv`);2026-06-20 至 2026-08-05 多轮实测。离屏平台与 `-n auto --dist loadfile` 已由 `tools/conftest.py` 与根 `pytest.ini` 固化,不必手打;并行依赖 `pytest-xdist`,缺它全线 `unrecognized arguments: --dist`。

## 三件套(每次改完必跑)

```bash
.tools/venv/bin/python -m pytest tools/editor/tests/ -q \
  --deselect "tools/editor/tests/test_scene_entity_tree_multiselect.py::SceneEntityTreeMultiselectTests::test_assign_group_write_and_undo"
.tools/venv/bin/python -m tools.editor.shared.asset_reference_audit . --strict   # 应 issues: 0
./dev.sh validate-data                                                           # 应 exit=0、0 error(既有 [WARN] 非本改动)
```

⚠ 不带那条 `--deselect` 会**永久挂死**(HEAD 即如此,不是机器慢):该测试的 monkeypatch 目标与实现已漂移、补丁成空操作,offscreen 下模态 `exec()` 永不返回,表现是停在 98% 不动。**pytest 对拼错的 node id 静默忽略**(`MultiSelect` ≠ `Multiselect`),会让你以为在绕过、实际每次都跑进挂死——请**整串照抄**。带 deselect 后约 1024 passed / 40 秒(2026-08-05 实测)。挂死定位:`python -X faulthandler -m pytest ... &` 后 `kill -ABRT <pid>` 拿栈,或 `-n0 -v` 看最后一条测试名。单步调试加 `-n0`(`--pdb` 与 xdist 不兼容)。

关键测试:`test_canvas_roundtrip_safety.py`(黄金往返)、`test_all_editors_construct.py`(离屏可构造,py_compile 查不出的运行期错误靠它)、`test_form_editor_persistence.py`。改图对话另跑 `pytest tools/dialogue_graph_editor/tests/`;改叙事网页另跑 `npx vitest run tools/narrative_editor_web` + `npm run build:narrative-editor`。

## Qt 生命周期与测试环境硬规矩(前两条是生产代码约束,不只测试)

- **真实工作树硬只读**:仓库写保护、QSettings 隔离、对话布局侧档重定向都装在 `tools/conftest.py`,任何测试写进真实根即失败(踩过:打开图会自动修 sidecar,跑测试即污染真实数据)。**别用 `python -m unittest`**——它不加载 conftest,把这三层连同控件销毁收尾一起绕过。
- **`QTimer.singleShot` 必须带 context 对象**(3 参版):2 参版没有 receiver,宿主销毁后照样触发,回调碰 C++ 即 `RuntimeError`,且 PySide 会沿最近的 Python-override 边界外抛、炸在**毫不相干的下一段操作**里。护栏 `test_single_shot_context_parity.py`,但它**只静态扫三个硬编码目录**——`tools/parallax_editor`、`tools/narrative_editor`、`tools/video_to_atlas` 等在覆盖面之外,改那些工具时"绿了"不代表被查过(norms 不变量 8:声称的护栏必须能 grep 到疆域)。
- **测试里 `deleteLater()` 销毁不掉控件**(loopLevel 0 下 `processEvents()` 不投递 `DeferredDelete`),由 `tools/editor/tests/conftest.py` 的 autouse fixture 收尾(护栏 `test_qt_widget_teardown.py`)。控件堆积会让全套耗时对存活控件数呈 **O(N²)**(`setStyleSheet()` 全应用重刷)——新面板堆重控件树前先算这笔账。**别把该 fixture 上提到 `tools/conftest.py`**,图对话编辑器测试会段错误退出。

## 已知盲区(绿灯≠对,按需补探针)

- 黄金往返在 model 层 serialize、不经 UI 的行收集 → "Apply 时改写顺序/归一化"抓不到;对策是编辑器级往返探针(样板 `tools/dialogue_graph_editor/tests/test_inspector_roundtrip.py`)。
- 真实数据探针覆盖不到"数据里暂时没有"的形状 → 潜伏破口靠合成 fixture(样板 `test_latent_roundtrip_fidelity.py`)。
- 几百个 model 层测试全绿仍漏掉门控/切换/取消/悬垂回退整族 bug → 修流程类问题必配"编辑→切走/Discard→断言模型"探针(样板 `test_close_path_flow.py`)。

## 静态门:undefined name 零容忍(2026-08-06 加)

`tools/editor/tests/test_no_undefined_names.py` 对 `tools/editor` + `tools/dialogue_graph_editor`
+ `tools/chronicle_sim_v2` 跑 pyflakes,**只收 undefined name**(运行到就炸的真缺陷),3 秒。
疆域以该文件的 `_SCANNED_PACKAGES` 为准(其余 PyQt 工具仍在覆盖面外,改那些时"绿了"不代表被查过)。
由来:图对话编辑器的「删除本条件」按钮 100% 抛 `NameError`——`do_c_del` 用了另一个方法闭包里的
`cond_rows_layout`,从抽方法起就一直是死的。**异常打断后续步骤,于是控件没移除、模型没变、
也不标脏,策划看着像「按钮坏了」,直到改点别的才延迟生效**——删除动作与生效时刻错位,最难查的一类。
102 个测试全绿也没抓到(没人从按钮 `click()` 进),而 pyflakes 一秒就能报。
**从闭包里抽方法/搬回调时必跑**;缺 pyflakes 该测试自动 skip,依赖记在 `tools/editor/requirements.txt`。

同型二例(2026-08-06,chronicle_sim_v2 `gui/main_window.py`):`closeEvent` 引用 `__init__` 里的**局部**
`splitter`(从没挂到 `self`),关窗必抛 `NameError`,**并把它后面的 `release_all_clients()` 一并跳过**
→ chroma 客户端每次关窗都泄漏。教训同上:**跨方法用的控件必须挂 `self`**;更狠的是 PySide 对
Qt 事件循环派发的 `closeEvent` 只把 traceback 打到 stderr 就继续(窗口照关、进程不失败),
所以这条**从来没人发现**——写 closeEvent 类收尾钩子时,别指望异常会自己冒出来。
同一行邻位还有 `save_main_window_geometry(self)` 传了窗口本体而非 `self.saveGeometry()`,
Qt 静默丢弃(`QVariant::save: unable to save type 'QWidget*'`),几何尺寸从来没存上;两处已修。

## 新加确认弹窗 = 可能挂死既有测试(2026-08-06 实测)

给某个删除/危险操作**新加二次确认**时,**必须同时排查所有会点到该按钮的既有测试**——
离屏下 `QMessageBox.question` 的 `exec()` 永不返回,整跑挂死在 62% 不动,而且
**表现得像"变慢"而不是"失败"**(我先误判成并行抢资源、又误判成数据量涨了)。
定位:`python -X faulthandler -m pytest ... &` 然后 `kill -ABRT <pid>` 拿栈,
栈顶会直接指到 `do_c_del` / `do_delete` 这类槽函数。
排查命令:`grep -rn 'btn_del"\]\.click()' tools/*/tests/ | grep -v _SilencedBoxes`。
打桩件:`tools/dialogue_graph_editor/tests/_qt_dialog_stubs.py` 的 `_SilencedBoxes`
(共享件,别在各测试模块里复制);它记录下来的文案本身可断言,「问没问」和
「问的是什么」一起验。

## 两道升级门(2026-07-14 二轮审查加,原三件套对该轮 2P0+19P1 全无感)

- **流程探针门**:交互/拖拽/门控特性的护栏必须从用户触发的**最外层入口**进(拖拽发真实 `QMouseEvent`、门控测「编辑→操作→断言模型」)。踩过:节点拖不动,6 例全绿而特性对用户完全不可用。
- **镜像 parity 门**:每处手工镜像清单必须有**语义级** parity 测试;注释里写「有护栏」= 没有护栏。宁可消灭镜像(读单一真相源)。归纳见 `artifact/Reviews/主编辑器-防再犯归纳-2026-07-14.md`。

## "输出字节不变"强验收(声称零格式影响时用)

`git stash` 隔离 HEAD 版与改后版 → 两版对同一份数据各跑一次 save_all 到独立目录 → `diff -rq` 应为空。**必须固定 `PYTHONHASHSEED`**(hash 随机化造假 diff);working tree 里手写的内联 JSON 会被 save_all 规范化,所以要 stash 隔离而不是"改前先跑一次"。叙事编辑器另有单文件幂等探针(`_normalize_file` 结果与磁盘逐字节相等)。

## 布局类改动附加冒烟

`pytest tools/editor/tests/test_all_editors_construct.py -q`;小屏回归 `test_small_screen_layout.py`(面板最小宽护栏)。
