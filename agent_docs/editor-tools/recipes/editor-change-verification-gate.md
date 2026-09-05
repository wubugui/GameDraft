---
id: editor-change-verification-gate
title: 改编辑器后的验证门
summary: 三件套(全树测试+素材审计+validate-data)+ 挂死分流 + 测试环境三条硬规矩 + 已知盲区对策 + "输出字节不变"强验收;跨机绿灯必须在验收机重放
domain: editor-tools
type: recipe
status: active
authority:
  - tools/editor/shared/asset_reference_audit.py
  - tools/editor/tests/test_gate_collects_all_editor_tests.py
  - tools/editor/tests/test_canvas_roundtrip_safety.py
  - tools/conftest.py
  - dev.sh
triggers:
  paths: ["tools/editor/*", "tools/dialogue_graph_editor/*", "tools/narrative_editor_web/*"]
  topics: [验证门, 黄金往返, 格式保真, 字节验收, 挂死, 跨平台]
  tasks: [改编辑器收尾验证, 证明导出格式不变]
last_governed: 2026-09-03
---

实测环境与日期:macOS 与 Windows 各多轮实测,2026-06-20 至 2026-08-21。解释器一律用项目
venv(`scripts/py.sh` 会自己挑 `.tools/venv` 的 Scripts/bin,**不是** `.venv`;宿主 python 上
PySide6/xdist 未必齐)。离屏平台与 `-n auto --dist loadfile` 已由 `tools/conftest.py` 与根
`pytest.ini` 固化,不必手打;并行依赖 `pytest-xdist`,缺它全线 `unrecognized arguments: --dist`。

## 三件套(每次改完必跑)

```bash
sh scripts/py.sh -m pytest tools/editor -q -p no:cacheprovider
sh scripts/py.sh -m tools.editor.shared.asset_reference_audit . --strict   # 应 issues: 0
./dev.sh validate-data                                                     # 应 exit=0、0 error
```

⚠ **门必须是 `tools/editor` 全树,不是 `tools/editor/tests`。** 编辑器测试实际分两处
(第二处在 `tools/editor/editors/tests/`),少写一层目录就整个收不到——**跑绿了也说明不了
什么**。收集完整性由 `tools/editor/tests/test_gate_collects_all_editor_tests.py` 守着
(登记目录之外不许有测试 + 全树收集数须严格大于主目录),但那条只让"漏了"变得看得见,
门命令本身仍要照上面写。目录登记面以该测试文件为准。

⚠ **2026-08-05 那条 `--deselect` 已作废**:打桩早已跟着实现改回
(`test_scene_entity_tree_multiselect.py` 现打 `ReferencePickerDialog`),再排除等于白扔
十几条真测试。撞到挂死走下一节分流,不要靠 deselect 绕。

改图对话另跑 `pytest tools/dialogue_graph_editor/tests/`;改叙事网页另跑
`npx vitest run tools/narrative_editor_web` + `npm run build:narrative-editor`。
关键测试:`test_canvas_roundtrip_safety.py`(黄金往返)、`test_all_editors_construct.py`
(离屏可构造,py_compile 查不出的运行期错误靠它)、`test_form_editor_persistence.py`。

## 挂死分流(先证伪,别直接归因)

挂死表现**永远是"停在某个百分比不动",不是失败**,极易被误判成"变慢/机器忙"。按下面顺序断:

1. **收尾挂死 ⇒ 先怀疑 pytest 缓存插件,一句话就能证伪**:加 `-p no:cacheprovider` 重跑,
   秒过即是它。根因与 xdist、与 Qt 都**无关**——`.pytest_cache` 在仓库内,`tools/testing/`
   的仓库写保护拦下建目录,而 `mkdtemp` 会换随机名重试到上限,每次都走一遍守卫的
   `resolve()`,把收尾拖成分钟级,再被 `tools/conftest.py` 的收尾守卫强退
   (退出码保真,但摘要行被冲掉)。`-n0` 且完全不碰 Qt 的纯 stdlib 测试上同样复现。
2. **跑到一半不动 ⇒ 离屏模态 `exec()` 永不返回。** 两个来源:新加的二次确认弹窗
   (见下节),以及**打空的桩**——实现换了交互控件而测试还在 patch 旧 API,补丁成空操作、
   真弹窗弹出来没人应答。**打空的桩不是失败,是挂死**;改交互控件时必须同步排查所有打它桩
   的测试。定位:`-X faulthandler` 起后台跑再 `kill -ABRT <pid>` 拿栈,或 `-n0 -v` 看
   最后一条测试名;栈顶会直接指到那个槽函数。
3. 以上都不是,再去看 xdist worker / QtWebEngine 残留;`tools/conftest.py` 的守卫会在超时时
   dump 全线程栈并用 py-spy 拍卡死 worker,凭那份栈定罪,不要凭猜。

## Qt 生命周期与测试环境硬规矩(前两条是生产代码约束,不只测试)

- **真实工作树硬只读**:仓库写保护、QSettings 隔离、对话布局侧档重定向都装在
  `tools/conftest.py`,任何测试写进真实根即失败(踩过:打开图会自动修 sidecar,跑测试即污染
  真实数据)。**别用 `python -m unittest`**——它不加载 conftest,把这三层连同控件销毁收尾
  一起绕过。
- **`QTimer.singleShot` 必须带 context 对象**(3 参版):2 参版没有 receiver,宿主销毁后照样
  触发,回调碰 C++ 即 `RuntimeError`,且 PySide 会沿最近的 Python-override 边界外抛、炸在
  **毫不相干的下一段操作**里。护栏 `test_single_shot_context_parity.py`,但它**只静态扫几个
  硬编码目录**(疆域以该文件为准),覆盖面外的工具"绿了"不代表被查过(norms 不变量 8)。
  画布手势里排下一拍的时序纪律见 [画布手势安全](../mechanisms/canvas-gesture-safety.md)。
- **测试里 `deleteLater()` 销毁不掉控件**(loopLevel 0 下 `processEvents()` 不投递
  `DeferredDelete`),由 `tools/editor/tests/conftest.py` 的 autouse fixture 收尾(护栏
  `test_qt_widget_teardown.py`)。控件堆积会让全套耗时对存活控件数呈 **O(N²)**
  (`setStyleSheet()` 全应用重刷)——新面板堆重控件树前先算这笔账。**别把该 fixture 上提到
  `tools/conftest.py`**,图对话编辑器测试会段错误退出。

## 已知盲区(绿灯≠对,按需补探针)

- 黄金往返在 model 层 serialize、不经 UI 的行收集 → "Apply 时改写顺序/归一化"抓不到;对策是
  编辑器级往返探针(样板 `tools/dialogue_graph_editor/tests/test_inspector_roundtrip.py`)。
- 真实数据探针覆盖不到"数据里暂时没有"的形状 → 潜伏破口靠合成 fixture(样板
  `test_latent_roundtrip_fidelity.py`)。
- **含动作编辑器的表单,合成 fixture 走不通**:ActionEditor 会把参数 schema 里未填的参数
  materialize 成空串,于是手写的 action fixture 打开→不动→Apply 就多出 `"type": ""` 这类键,
  字节级往返**必红**——测的是 ActionEditor 的归一化,不是被测编辑器的往返。真实数据不红只是
  因为它本来就是编辑器写出来的。对策:按 `tools/editor/shared/action_editor.py` 的
  `_PARAM_SCHEMAS` 把参数补全,或改用只有单参数的动作。
- **测"对不上"的用例不许硬编码具体值,必须从被测对象派生。** 踩过:硬写死的"假指纹"
  恰好等于新加的单帧素材包的真指纹,用例反而判"对上了"。
- 几百个 model 层测试全绿仍漏掉门控/切换/取消/悬垂回退整族 bug → 修流程类问题必配
  "编辑→切走/Discard→断言模型"探针(样板 `test_close_path_flow.py`)。
- **布局塌陷 model 层测不出来**:动态加行/切模式显隐这类缺陷,构造冒烟与上千条 model 测试
  全绿也照样漏,只有离屏截图或断言实际高度(`host.height() >= host.sizeHint().height()`)
  看得见。生产侧纪律见 [editor-tools norms](../norms.md) 过程义务「布局纪律」。

- **护栏本身可能是假的,写之前先证明它会红**(2026-09-03 盲重建实测的三处):
  - pytest 配置里的严格标记/严格配置两个开关**写在默认参数里不生效**(只有命令行显式给才生效),
    配置文件自己的注释就承认这是"假护栏";
  - 默认只收 `tools/` 一棵树,`scripts/` 下的测试**收不到,且那里没有仓库写保护**——
    该目录现存一批"实现比测试新"因而恒红的用例,裸跑全量看不到它们,读起来像全绿;
  - 仓库写保护、设置项隔离这些保护也只在被收集到的那棵树下生效。
  **判据**:新加一条护栏后,先把被护的东西改坏一次,确认它真的红,再提交。

## 跨机绿灯必须在验收机重放(2026-08-09)

**实现机声称全绿、验收机一跑必挂/必红**是真实发生过的形状,不是理论风险:同一条弹窗类用例
在实现机绿,换机离屏一跑先撞模态挂死,打桩之后又被自家哨兵拦住断言失败——它与自己的修法
互相矛盾,从未在交付版代码上真跑绿过。所以:**"另一台机器上是绿的"不是证据**,验收在验收机
重放。给弹窗类流程写用例时,**宿主/主窗缺省形状**(找不到主窗时走哨兵的那条分支)是必测分支。

## 平台差异(会把"没跑"伪装成"全绿")

- **macOS 没有 `timeout`**(GNU coreutils 才有)。用 `for f in ...; do out=$(timeout N pytest "$f" | tail -2); rc=$?` 这类循环扫挂死文件时,每条都 command not found,而 `rc=$?` 取的是管道
  **最后一段**的退出码恒为 0 ⇒ **扫描等于什么都没跑,却给出"全绿"的假结论**。要么
  `(cmd > log 2>&1 &)` + 看日志尾 + `pgrep` 判活,要么装 `gtimeout`;套管道就必须显式取
  `PIPESTATUS`。
- **Windows 上 `Path.write_text` 默认做换行转换**:用它写测试种子文件会写成 CRLF,而保存出口
  写回 LF,字节级往返/哈希相等类用例**恒红且与改动无关**。测试造种子一律 `write_bytes` 或
  `newline=""`。
- **Windows 全量 pytest 有成规模的环境性存量失败**(缺可选依赖、临时目录 PermissionError、
  DPI/布局差异等),库内其它地方的"编辑器 pytest 全绿"口径在该平台**不成立**。该平台的有效
  判据是:**靶向跑受影响文件全绿 + 与 HEAD 双树对照失败集合完全一致**(stash 到 HEAD 各跑
  一遍,比集合而不是比数字)。

## 静态门:undefined name 零容忍(2026-08-06 加)

`tools/editor/tests/test_no_undefined_names.py` 对若干包跑 pyflakes,**只收 undefined name**
(运行到就炸的真缺陷),数秒。疆域以该文件的 `_SCANNED_PACKAGES` 为准(其余 PyQt 工具仍在覆盖
面外,改那些时"绿了"不代表被查过)。

由来:图对话编辑器的「删除本条件」按钮 100% 抛 `NameError`——从闭包里抽方法时用了另一个方法
闭包里的局部名,从抽方法起就一直是死的。**异常打断后续步骤,于是控件没移除、模型没变、
也不标脏,策划看着像「按钮坏了」,直到改点别的才延迟生效**——删除动作与生效时刻错位,最难查
的一类。上百个测试全绿也没抓到(没人从按钮 `click()` 进),而 pyflakes 一秒就能报。
**从闭包里抽方法/搬回调时必跑**;缺 pyflakes 该测试自动 skip,依赖记在
`tools/editor/requirements.txt`。

同型二例(chronicle_sim_v2 `gui/main_window.py`):`closeEvent` 引用 `__init__` 里的**局部**
控件(从没挂到 `self`),关窗必抛 `NameError`,**并把它后面的客户端释放一并跳过**。教训同上:
**跨方法用的控件必须挂 `self`**;更狠的是 PySide 对 Qt 事件循环派发的 `closeEvent` 只把
traceback 打到 stderr 就继续(窗口照关、进程不失败),所以这条**从来没人发现**——写
closeEvent 类收尾钩子时,别指望异常会自己冒出来(签名跑偏也走同一条路,见
[主窗口编辑器接入钩子](../mechanisms/mainwindow-editor-hooks.md))。

**同一次扫出的另一种静默**:往设置里存值时把控件本体传了进去(该传它序列化出来的那份),
**Qt 直接丢弃类型不认识的值**——几何尺寸从来没存上,而它只在 stderr 留一行
`QVariant::save: unable to save type '...'`。这条错误签名值得记住:**看见它,就是"存了个寂寞"**,
不是读取侧的问题。

## 新加确认弹窗 = 可能挂死既有测试(2026-08-06 实测)

给某个删除/危险操作**新加二次确认**时,**必须同时排查所有会点到该按钮的既有测试**——
离屏下 `QMessageBox.question` 的 `exec()` 永不返回,整跑挂死不动,而且**表现得像"变慢"
而不是"失败"**。排查命令:`grep -rn 'btn_del"\]\.click()' tools/*/tests/ | grep -v _SilencedBoxes`。
打桩件:`tools/dialogue_graph_editor/tests/_qt_dialog_stubs.py` 的 `_SilencedBoxes`
(共享件,别在各测试模块里复制);它记录下来的文案本身可断言,「问没问」和「问的是什么」
一起验。

## 两道升级门(2026-07-14 二轮审查加,原三件套对该轮 2P0+19P1 全无感)

- **流程探针门**:交互/拖拽/门控特性的护栏必须从用户触发的**最外层入口**进(拖拽发真实
  `QMouseEvent`、门控测「编辑→操作→断言模型」)。踩过:节点拖不动,6 例全绿而特性对用户
  完全不可用。
- **镜像 parity 门**:每处手工镜像清单必须有**语义级** parity 测试;注释里写「有护栏」=
  没有护栏。宁可消灭镜像(读单一真相源)。归纳见
  `artifact/Reviews/主编辑器-防再犯归纳-2026-07-14.md`。

## "输出字节不变"强验收(声称零格式影响时用)

`git stash` 隔离 HEAD 版与改后版 → 两版对同一份数据各跑一次 save_all 到独立目录 →
`diff -rq` 应为空。**必须固定 `PYTHONHASHSEED`**(hash 随机化造假 diff);working tree 里手写
的内联 JSON 会被 save_all 规范化,所以要 stash 隔离而不是"改前先跑一次"。叙事编辑器另有单
文件幂等探针(`_normalize_file` 结果与磁盘逐字节相等)。种子文件的写法见上面的 Windows 注记。

## 布局类改动附加冒烟

`pytest tools/editor/tests/test_all_editors_construct.py -q`;小屏回归
`test_small_screen_layout.py`(面板最小宽护栏)。动态增删表单行的改动另加"实际高度 ≥
sizeHint 高度"断言或离屏 grab——见上面「布局塌陷」那条。
