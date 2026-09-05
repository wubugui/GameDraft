---
id: dialogue-graph-editor
title: 图对话编辑器
domain: editor-tools
type: mechanism
summary: 独立包内嵌主编辑器的图对话编辑;分层架构 + 表单形状保真回写 + 语义零变化时原样字节回写;往返探针是改 inspector 的必跑门
status: active
authority:
  - tools/dialogue_graph_editor/graph_document_model.py
  - tools/dialogue_graph_editor/node_inspector.py
  - tools/dialogue_graph_editor/editor_widget.py
  - tools/dialogue_graph_editor/graph_analysis.py
triggers:
  paths: ["tools/dialogue_graph_editor/*", "tools/editor/editors/dialogue_graph_editor_tab.py", "public/assets/dialogues/graphs/*"]
  topics: [图对话, 对话编辑器, node_inspector, 往返探针, 叙事归属分组]
  tasks: [改图对话编辑器, 加对话节点类型或字段]
verified_by:
  - tools/dialogue_graph_editor/tests/test_inspector_roundtrip.py
  - tools/dialogue_graph_editor/tests/test_latent_roundtrip_fidelity.py
  - tools/dialogue_graph_editor/tests/test_open_clean_and_save_fidelity.py
  - tools/dialogue_graph_editor/tests/test_switch_node_safety.py
  - tools/dialogue_graph_editor/tests/test_inspector_panel_width.py
  - tools/dialogue_graph_editor/tests/test_gui_review_2026_08_06.py
last_governed: 2026-08-06
---

## 是什么(一句话)

编辑 `public/assets/dialogues/graphs/*.json`(唯一权威对话源——`.ink` 已于 2026-06-30 用户拍板全部废弃,别当真值)的图编辑器:独立包 `tools/dialogue_graph_editor/`,主编辑器页只是薄壳 tab。

## 权威源(读代码从哪进)

分层:`graph_document_model.py`(单一真相源+信号+dirty)/ `dialogue_topology.py`(声明式节点出口 slot 表,加节点出口改这里)/ `flow_oden_controller.py`(画布投影)/ `node_inspector.py`(单节点表单)/ `graph_analysis.py`(信号→章节归属推导)/ `editor_widget.py`(宿主胶水)。画布坐标存独立 sidecar,不污染图 JSON、不标脏。

## 硬契约

1. **表单形状保真回写**:磁盘上同语义有多种形状(裸 next vs conditions、缺省 vs 空列表、有无 op/status 键)——加载时记形状基线,回写按原形状,不注入默认键、不做"顺手规范化"(一次 conditions→condition 重排会改 30+ 文件)。
2. **表单表达不了的形状走只读 raw-passthrough**(原样保留,编辑改走结构化模式),不是"当空值加载再写回"。
3. **语义零变化 → 原样字节回写**:磁盘图是外部工具按不一致风格预格式化的,无序列化器能复现;保存时与加载基线比对,语义没变就原字节写回;保存前还有外部改动覆盖确认(拦 last-writer-wins)。
4. **画布增量更新**:纯视觉编辑原地更新;只有连线目标/端口签名变化才整图重建;可达性诊断色只随拓扑变。
5. 自动布局用 grandalf(所有输入按 id 排序保跨进程确定性);手搓 Sugiyama 变体已弃,别重写。
6. **左栏「叙事归属」是推导出来的只读展示,不是字段**(2026-07-19 起):本图 emit 的信号 → 监听它的叙事图 → 卷到该图的章节包(`graph_analysis.py` 三个纯函数),粒度=章节。保存**不写** `meta.scenarioId`;老口径(手填 meta + scenarios.json)已废,别当真值恢复。守护 `test_chapter_grouping.py`。
7. **inspector 的 `getter()` 绝不抛异常**(2026-08-06 定):它是该节点数据进模型的**唯一出口**,一抛异常宿主 `_on_inspector_changed` 就整条通道断掉——表单上的字都在、模型里一个字没进、`is_dirty` 仍是 False,于是关窗口不提示、整段编辑无声蒸发(踩过:choice 空 id、line 空 lines 两处 `raise ValueError`)。**非法数据一律交给校验层报 error + 保存门拦**,不许用「让编辑进不去」来拦。
8. **空集合不许替用户造内容**:`cases: []` / `options: []` / `options: null` 一律如实显示空 + 一句引导,禁止注入 `some_flag` 分支或「选项甲」——那会随保存落盘成用户没写过的内容。新建节点想要有一条起始项,改 `graph_document.default_node`(磁盘与画布口径一致),不要在 inspector 里凭空补。
9. **常量条件三分判定收口 `dialogue_condition_text.case_verdict`**:`ALWAYS`(`{all:[]}`、无 condition/conditions)/ `NEVER`(`{}`、`{any:[]}`、运行时认不出的形状)/ `NORMAL`。依据是 `evaluateGraphCondition.ts` 的求值顺序(`every([])===true`、`some([])===false`、unrecognized→false),**别凭直觉判**——第一版把 `{}` 判成恒真、漏掉 `{all:[]}`,校验报错方向正好相反。叶子识别是对 TS 八个 `isXxxLeaf` 守卫的镜像,配 parity 测试;运行时增删条件叶必须同步。
10. **条件的两种写法双向无损**:「多条条件(全部满足)」↔「结构化」切换时自动搬运;顶层是 `any`/`not` 摊不平就**退回并弹窗说明**,绝不清空。切了下拉但没在新写法里真改东西 → 仍按磁盘原写法回写(`_orig_shape` + `mode_edited`),免得误点在 diff 里留下与内容无关的形状变化。
11. **`_on_inspector_changed` 在 `new_node == old_node` 时直接 return**:不标脏、不进撤销栈、不重建画布。这是「什么都没干却提示保存」的总闸。
12. **撤销合并必须有边界**:`_NodeDataChangedCmd` 按 `focus_key` + `time.monotonic()` 分段(换控件或停顿 >0.9s 断开)。只按节点 id 无脑合并 = 在一个节点上改二十分钟、误按一次 Ctrl+Z 全没。
13. **数组里的非 dict 元素也要只读透传**(元素级,不只容器级):`options` / `cases` / `lines` / `actions` 五处容器共用
    `_split_dict_items` + `_reinsert_junk` + `_junk_notice`——坏元素按原下标塞回、橙字明示第几条与内容、
    校验照旧报 `选项 i 不是对象`、保存门照旧拦。`if not isinstance(x, dict): continue` 之后不还原
    = 「打开图→点一下这个节点→点走」就把那条从磁盘上抹掉,连校验证据一起没了(内存里已无它)。
    production-mode 下 agent 直接写 JSON,数组里混个字符串/null 是现实可能。
14. **「表单行 ↔ 数据元素」的配对一律过 `_dict_items()`**:表单行只由 dict 元素构成,而数据数组里还夹着
    坏元素,拿行号当数据下标会在坏元素之后整体错位——画布上拉的线同步不到检查器,随后任意一次编辑
    还会把它静默打回。**画布侧(`iter_output_slots` 的 `enumerate`)、校验、坏元素提示统一用数据下标**,
    只有 `update_topology_from_data` 这一处是行空间,必须显式对齐;弹窗文案宁可不写序号只印内容
    (行号会与数据下标打架,存原下标又会在重排后失效)。

14b. **给某个节点类型单独加 error 之前,先查同一语义有没有别的免检入口**。只堵一个入口的
    "铁律"拦不住任何东西,只是**把作者推去用另一个节点**,还顺带违反「Python 兜底不得比
    TS 权威更严」(不变量 7)。真实案例:"某节点不许读实体 wrapper"被实现成 error,而同一次
    读取换成条件叶完全免检、运行时也不查归属——现网绝大多数读取本来就走那条免检路。
    附带的固定形状:**判据布尔把"目标不存在"与"目标类型不对"压成同一个假值**,于是真毛病
    (悬垂引用)被套上错措辞报出来,**盖住了近一年**。三分判定(ok / 类型不对 / 不存在)是最低要求。

## 界面硬契约(2026-08-06 GUI 专项审查立)

15. **检查器面板预算 280px**(主窗 `setSizes([200, 820, 280])`)。**每种节点、每种展开态、三套主题**下
    `minimumSizeHint().width()` 都不得超——超了不是"有点挤",是**行尾的删除/上移/下移按钮被挤出
    可视区、策划够都够不着**。护栏 `test_inspector_panel_width.py`(逐主题 + 折叠态 + 展开条件行)。
    量宽度**必须上主题**:主题样式表的内边距会再顶高 30~45px,不上主题的"达标"是假绿。
15b. **六类列表行的删除手感统一**:有内容才二次确认、**允许删空**、删空由校验提示
    (switch 分支 / choice 选项 / line 多拍 / switch 条件行 / ownerState / contextState)。
    2026-08-06 收口:ownerState/contextState 原为硬拦「至少保留一条」——那是用
    「让编辑进不去」拦非法数据,与 §7 取向相反,也让策划想清空重来时只能留一条占位。
    **放开的前提是删空不能静默**:先给这两类补上与 switch 同款的「没有状态分支,
    将始终走…」warning,再放开;顺序反了就是把硬拦换成静默。
16. **列表行一律用共享行头 `_RowHeaderBar`**(摘要 `_ElidingLabel` + 操作按钮;窄面板两行、
    ≥520px 并成一行、右键菜单兜底)。line 多拍 / choice 选项 / switch 分支 / switch 条件行 /
    ownerState / contextState 六处**一个都不能落**——连续两轮栽在"switch 改好了、其余没跟",
    表现是同一面板两套手感。护栏 `test_gui_review_2026_08_06.py::RowHeaderParityTests` 逐类型点名。
17. **凡是显示给人的下标,都只能由"写盘那条唯一路径"反算,不许由表单行位置推。**
    检查器 / 画布端口 / 校验消息 / 删除弹窗四处同口径,术语统一「分支 N」(不许再出现 `case N`)。
    同一条规律已经踩过**两次**,两次都是"编号看着权威却在骗人"——校验说「分支 2 坏了」,
    策划打开标着 2. 的那条(完全正常)改半天,真正坏的标着别的号:
    - 第一次:坏元素塞回用 `min(index, len(out))`,而序号从"加载时记的 junk 原下标"推
      → 删行后两边规则打架。修法:`_row_data_indices()` **复刻 `_reinsert_junk` 的算法**。
    - 第二次:ownerState/contextState 的 getter 刻意丢弃"新加但从未填写"的空行,
      而序号按行位置算 → 空行占了数据里不存在的号,其后每行顺移。修法:算下标前先用
      **与 getter 逐字相同的判据**过滤;不会写盘的行不给号,明说「未填完,暂不写入」。
    - 推论:某行"填没填"会改变**其后所有行**的号,所以任何一行变化都要**全体重刷**摘要。
18. **界面文案不许直接用 JSON 字段名**,枚举显示中文但 **`itemData` 必须保原值**(取值一律
    `currentData()`,否则中文化直接写坏数据);节点类型走 `graph_document.node_type_label_zh`、
    说话人走 `SPEAKER_KIND_LABELS_ZH`,画布/列表/检查器/弹窗同一套叫法。
19. **颜色只走 `theme.semantic_text_color/css`**(muted/faint/warn/error/info/ok)。写死十六进制
    只在当时那套主题下能看——`#ccc` 落在浅色主题 `#ececec` 上几乎隐形,而摘要行正是
    "不展开就要看懂"的关键信息。Qt 标准按钮的中文翻译挂在 `apply_application_theme` 里
    (不装的话"丢弃全部未保存改动"那颗按钮写的是 `Discard`)。
20. **局部撤销必须有 `editor_undo`/`editor_redo` 钩子**(见 [主窗钩子卡](mainwindow-editor-hooks.md))。
    缺钩子不是"Ctrl+Z 没反应",而是主窗回落**全局** ProjectModel 栈——图纹丝不动,
    每按一次却在悄悄回退**别的编辑器**的改动。
21. **行内每颗交互按钮都要登记进 `_topology_refs` 的行记录**(`btn_up`/`btn_down`/
    `btn_before`/`btn_after`/`btn_del`),六类列表行口径一致。没登记 ≠ 按钮坏,
    而是**任何测试都够不着它**——本卡范围内已经连栽三次:「删除本条件」100% 抛
    NameError 无人发现、多拍行没进 `_topology_refs` 导致 `KeyError: 'beat_rows'`、
    switch 分支行的前插/后插长期无护栏。新增行内按钮时同步补登记,并在
    `test_gui_review_2026_08_06.py` 的六类点名测试里加一次真点击。

## 已知坑

- 构造 NodeInspector 必须传 `project_model_getter`,否则 ActionEditor 的 id 选择器回填不了,探针误报"丢参数"。
- error 强制保存弹窗保留默认 No(不硬拦)——用户工作流拍板(2026-07-11),别"顺手"改成阻断。
- **条件原子吃叶子**:条件原子模式对**未识别叶子**(plane / scenarioLine / 未来新叶)必须原样透传只读,禁止兜底强转 `{"flag":""}`——曾吃掉一批带 `{"plane":…}` 的图。**新增条件叶子必须检查本控件的透传分支**。
- 列表控件从 QListWidget 换 QTreeWidget 这类改造:单参 `it.data(role)` 调用要带列号,否则删除入口炸。
- **Qt 会缓存每层布局的最小尺寸**:在布局建好之后才收窄控件(封顶/折行),外层拿到的仍是旧值
  ——实测 choice+promptLine 停在 502px,`invalidate()` 一遍才降到 359。任何"事后收窄"都要自下而上失效。
- **`QComboBox.minimumSizeHint` 不吃 `setMinimumContentsLength`**(长 id 列表能顶到 330px+),
  只有 `setMaximumWidth` 夹得住;而封顶必须**按行分配**,每个都封同一个死值时同排两个下拉就翻倍。
- **数据来的文本(节点 id、未知类型名)进面板一律走省略标签**:富文本 QLabel 的
  `minimumSizeHint` 是**整行宽**、`wordWrap=True` 也不折行,一个长 node id 就能单枪匹马顶爆
  280px 预算(真实数据里的长 id 同样会),完整内容进 tooltip。**元教训**:宽度护栏的报错文案
  按**节点类型**归因,而真凶可能**在表单之外**(顶部那条 id 标签)——于是护栏"红着但指错人",
  下一个改检查器的人会以为是自己弄坏的。**护栏指错人比不报还费人**,成因自检单要写进测试文件。
- **嵌套容器的左右边距是隐形大头**:条件行在六层嵌套里,Qt 默认每层左右各 9px,累起来 100px+
  全是白占的缩进,正好卡在超不超 280 的分界上(`_fit_panel_width` 统一清零,纵向保留)。
- **画布视野只能走框架自己的账本**:OdenGraphQt 的 `NodeViewer` 用内部 `_scene_range`
  记录"当前显示哪块世界矩形",`_update_scene()` 据此 `setSceneRect + fitInView`。
  对 viewer 直接调 QGraphicsView 的 `fitInView` 会被框架下一次刷新覆盖;更坏的是事后用
  `v.scale(...)` 修正——**NodeViewer 重写了 `scale()`**、按 `_scene_range` 累乘,与
  `fitInView` 直写 transform 不在同一坐标系,于是每点一次「适应画布」就在上一次基础上
  再乘一遍(实测连点 6 次 1.16→2.60→5.85→13.15→29.54→66.39→149.18)。正确写法:
  `v._scene_range = target; v._update_scene()`。
  **并且不许给「适应画布」设缩放下限**——加了下限大图就装不下,命令名在骗人;
  想看清字本来就该放大,而看全局只有这一个入口。
- **"相对量"的改动必须验语义,不能只验阈值**:上面那条缩放下限,连着两轮验收都只断言
  "单次调用后缩放 ≥ 0.55",**两轮都放过了**指数累积。护栏要断言"连点 N 次不变"
  和"全图是否真的在视野内"(`visible.contains(itemsBoundingRect)`)。
- **OdenGraphQt 的 `set_name(name)` 不收 `push_undo`**,传了直接 TypeError 打断整次 `rebuild`,画布停在半成品。要免撤销改名走 `set_property("name", …, push_undo=False)`。踩过:幽灵节点(连线指向还没建的 id——策划最常见的操作)一出现就炸。
- **折叠策略只许「只剩一条时强制展开」**,其余尊重每条自己的状态;增删条目一律不批量重置,新加的条目 `collapsed=False`。switch 分支 / choice 选项 / line 多拍三处同一套规矩,改一处要想到另两处。
- **条件行/选项行的横向控件不许超过一屏宽**:flag / quest / narrative 三种叶子都排两行。挤一行在 560px 下会切掉值下拉与删除按钮并顶出横向滚动条。
- **`outcome` 这类 `string|number|boolean` 字段禁止 `str()` 强转**:运行时 `evalScenarioLeaf` 用 `===` 严格比较,`3` 变 `"3"` 条件就永不命中。走「类型 + 值」两件套。
- **不写 `wrapperGraphId` 是 ownerState 的一种语义**(按当前 owner 动态解算、同图多实体复用),自动选中只能作 UI 展示,禁止顺手写进 JSON。同理不注入 `missingWrapperNext: ""`。
- 头像/说话人语义见 runtime 域对话头像机制卡。

## 怎么验证

**改 node_inspector 后必跑** `test_inspector_roundtrip.py`(逐真实图逐节点 set_node→get_node 深等);真实数据覆盖不到的形状靠合成 fixture `test_latent_roundtrip_fidelity.py`;打开即脏/字节回写由 `test_open_clean_and_save_fidelity.py` 锁定;上面 7–12 条硬契约由 `test_switch_node_safety.py` 锁定(含恒真/恒假真值表与 TS 叶子守卫 parity 对账)。

**测试里遇模态弹窗必须打桩**(该文件里的 `_SilencedBoxes`),否则离屏 `exec()` 永不返回、整跑挂死。**0ms `QTimer.singleShot` 靠 `processEvents()` 投递不到**,验去抖/画布重建这类要用真事件循环(`QEventLoop + QTimer.singleShot(ms, loop.quit)`)。离屏拿键盘焦点要先 `show()`,拿不到就按仓库惯例 `skipTest`。
