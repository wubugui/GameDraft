---
id: editor-change-verification-gate
title: 改编辑器后的验证门
domain: editor-tools
type: recipe
summary: 三件套(全量测试+素材审计+validate-data)+ 已知盲区对策 + "输出字节不变"强验收法;解释器 .tools/venv + offscreen
status: active
authority:
  - tools/editor/shared/asset_reference_audit.py
  - tools/editor/tests/test_canvas_roundtrip_safety.py
  - dev.sh
triggers:
  paths: ["tools/editor/*", "tools/dialogue_graph_editor/*", "tools/narrative_editor_web/*"]
  topics: [验证门, 黄金往返, 格式保真, 字节验收]
  tasks: [改编辑器收尾验证, 证明导出格式不变]
last_governed: 2026-07-11
---

实测环境与日期:macOS(darwin)、`.tools/venv/bin/python`(带 PySide6,**不是** `.venv`);2026-06-20 至 2026-07-11 多轮编辑器修复全程实测。**离屏平台与并行参数已固化**(2026-07-25):`QT_QPA_PLATFORM=offscreen` 由 `tools/conftest.py` `setdefault`,`-n auto --dist loadfile` 由根 `pytest.ini` 的 addopts 带上——两者都不必再手打。并行依赖 `pytest-xdist`(已入 `tools/editor/requirements.txt`),缺它会全线 `unrecognized arguments: --dist`。

## 三件套(每次改完必跑)

```bash
.tools/venv/bin/python -m pytest tools/editor/tests/ -q                          # 全套约 40 秒
.tools/venv/bin/python -m tools.editor.shared.asset_reference_audit . --strict   # 应 issues: 0
./dev.sh validate-data                                                           # 应 exit=0、0 error(既有 [WARN] 非本改动)
```

单步调试某条测试时加 `-n0` 关并行(`--pdb` 与 xdist 不兼容)。

关键测试:`test_canvas_roundtrip_safety.py`(黄金往返:真实工程全 JSON load→save→reparse 语义一致)、`test_all_editors_construct.py`(全编辑器离屏可构造,py_compile 查不出的运行期错误靠它)、`test_form_editor_persistence.py`(表单不丢编辑)。改了图对话另跑 `pytest tools/dialogue_graph_editor/tests/`;改了叙事网页另跑 `npx vitest run tools/narrative_editor_web` + `npm run build:narrative-editor`。

## Qt 生命周期两条硬规矩(2026-07-25 立)

- **`QTimer.singleShot` 必须带 context 对象**(3 参版)。2 参版排的定时器没有 receiver,宿主控件销毁后照样触发,回调一碰 C++ 就 `RuntimeError: Internal C++ object already deleted`,并且 PySide 会把异常沿最近的 Python-override 边界向外抛、炸在**毫不相干的下一段操作**里。护栏:`tools/editor/tests/test_single_shot_context_parity.py`(静态扫 `tools/editor` / `tools/dialogue_graph_editor` / `tools/production_workbench`)。
- **测试里 `deleteLater()` 销毁不掉控件**:测试进程没有事件循环(loopLevel 0),`processEvents()` 不投递 `DeferredDelete`。收尾由 `tools/editor/tests/conftest.py` 的 autouse fixture 显式 `sendPostedEvents(None, DeferredDelete)` 统一收(护栏 `test_qt_widget_teardown.py`)。**别把这个 fixture 上提到 `tools/conftest.py`**——图对话编辑器测试会因此段错误退出(它自己的生命周期残留还没修)。

## 已知盲区(绿灯≠对,按需补探针)

- **黄金往返在 model 层 serialize,不经过编辑器 UI 的行收集**——"Apply 时改写顺序/归一化"抓不到。对策:编辑器级往返探针(构造编辑器 → 遍历子项触发 commit-on-leave → apply → 断言 model 与输入 deep-equal)。样板:`tools/dialogue_graph_editor/tests/test_inspector_roundtrip.py`。
- **真实数据探针覆盖不到"数据里暂时没有"的形状**——潜伏破口要靠合成 fixture(样板 `test_latent_roundtrip_fidelity.py`)。
- **流程层零覆盖教训**:几百个 model 层测试全绿仍漏掉门控/切换/取消/悬垂回退整族 bug——修流程类问题要配"编辑→切走/Discard→断言模型"式流程探针(样板 `test_close_path_flow.py`)。

## 两道升级门(2026-07-14 主编辑器二轮审查加,原三件套对本轮 2P0+19P1 全无感)

- **流程探针门**(交互特性必测):交互/拖拽/门控特性的护栏必须从**用户触发的最外层入口**进——拖拽发真实 `QMouseEvent`(不调 `setPos`),门控测「编辑→操作→断言模型」(不调单个 commit 函数)。一条"手动把系统摆到断言点"的测试证明不了断点之前的路能不能走通(踩过:任务图节点拖不动,6 例全绿而特性对用户完全不可用)。
- **镜像 parity 门**(手工镜像必测语义):每一处手工镜像清单(运行时↔编辑器↔校验器,如 CONTENT_ID_PARAMS↔控件、_PARAM_SCHEMAS↔required、KNOWN_DIRTY_BUCKETS↔LSP overlay、重构引擎 speaker 通道)必须有**语义级** parity 测试(不只锁存在性);**注释里写「有护栏」= 没有护栏**,声称的护栏必须能 grep 到对应测试。宁可**消灭镜像**(读单一真相源)也不维护两份——多数需 runtime 先 export 权威常量再对账。权威归纳见 `artifact/Reviews/主编辑器-防再犯归纳-2026-07-14.md`。

## "输出字节不变"强验收(声称零格式影响时用)

1. `git stash` 隔离出 HEAD 版与改后版,两版对同一份数据各跑一次 save_all 到独立目录;
2. **固定 `PYTHONHASHSEED`**(hash 随机化会造成假 diff);working tree 里手写的内联 JSON 会被 save_all 规范化,必须用 stash 隔离而不是"改前先跑一次";
3. `diff -rq` 两输出目录应为空。
叙事编辑器另有单文件幂等探针:`_json_text(_normalize_file(json.load(disk))) == disk` 逐字节相等。

## 布局类改动附加冒烟

`.tools/venv/bin/python -m pytest tools/editor/tests/test_all_editors_construct.py -q`;小屏回归 `test_small_screen_layout.py`(面板最小宽护栏)。**别用 `python -m unittest`**——它完全不加载 conftest,等于绕过仓库写保护、QSettings 隔离、对话布局侧档重定向和控件销毁收尾。
