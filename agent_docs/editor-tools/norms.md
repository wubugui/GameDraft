---
id: editor-tools-norms
title: 编辑器/策划工具开发规范
domain: editor-tools
type: norm
summary: PyQt 编辑器改动的不变量(零丢失往返/真实脏态/唯一写盘口/选择器铁律)、布局纪律、验收门与红线
status: active
triggers:
  paths: ["tools/editor/**", "tools/dialogue_graph_editor/**", "tools/parallax_editor/**", "tools/narrative_editor/**"]
  topics: [编辑器, PyQt, 往返保真, 布局, 选择器]
  tasks: [改编辑器, 加编辑器面板, 改策划工具]
last_governed: 2026-07-13
---

# 编辑器/策划工具开发规范

适用:`tools/editor` 及各 `tools/*_editor` 策划工具(PyQt/PySide 桌面工具及其内嵌 Web
编辑器)。此类改动同时是技术改动,叠加适用 meta 域分类闸门与工程通则。

## 不变量

1. **数据零丢失往返**:编辑器打开→不动→保存,输出与磁盘等价;对业务数据只做格式
   规范化(ensure_ascii=False + 2 空格缩进 + 末尾换行 + 不排序键),禁止静默丢弃
   列表顺序、键序或未显示在表单里的键;数值表示保真(int 不得漂成 float)。
2. **脏态真实性**:只有真实用户变更才 mark_dirty;flush 到模型必须门控真实变更
   (pending 信号或内容 diff),禁止无条件 mark_dirty。
3. **Discard 必须中和**:关闭路径的放弃分支必须把 UI 回滚到模型值,防止后续统一
   flush 把已放弃的改动写回。
4. **唯一写盘出口**:所有落盘走统一保存出口(两阶段暂存,全部成功才落盘);
   新增数据域必须三处同步(dirty 桶登记 + 保存分支 + mark_dirty)。
5. **选择器铁律**:非自由文本字段(可枚举/引用/受约束的值)禁止裸 QLineEdit,一律用
   现成选择器,候选取自 ProjectModel 的 id-provider;"定义自身新 id"是唯一例外。
   **下拉/弹窗边界**(2026-07-11 拍板):只有很短的枚举列表才允许下拉;其它(大候选集、
   跨文件引用、视觉资产选择)一律弹窗选择器,禁止长下拉
   (见 [decisions/2026-07-11-dropdown-vs-popup-selector.md](decisions/2026-07-11-dropdown-vs-popup-selector.md))。
6. **共享控件保值**:选择器对未知/悬垂值必须保值展示,禁止静默顶替或清空。
7. **兜底校验是子集**:Python 侧兜底校验必须保持为 TS 权威校验的子集,不得更严
   (否则编辑器拒存合法数据)。
8. **镜像清单配对账**:任何手工镜像清单(运行时↔编辑器↔校验器)必须同时配**语义级**
   parity 测试(不只锁存在性);**宁可消灭镜像**(读单一真相源)也不维护两份。注释里
   写「有护栏」= 没有护栏——声称的护栏必须能 grep 到对应测试。
9. **fail-safe 不 fail-open**:取不到状态/超时/未知返回时一律取安全默认(当脏 / 当失败 /
   如实报错),绝不乐观放行(fail-open = 静默丢数据)。「成功」回报必须基于**真实结果**,
   不能基于「函数被调用了」。区分写盘原子性(全有全无)与校验否决面(只否决本次将写盘
   的脏域,不连坐全局)。

## 过程义务

1. 新面板先判编辑模式、对齐同类编辑器骨架(主从列表 + `_refresh/_on_select/_apply`
   样板、命名 dirty 桶),不造一次性写法。
2. **布局纪律**:新表单必用 compact_form;短字段用 setMaximumWidth 上限(禁
   setMinimumWidth 地板堆叠顶爆小屏);重块默认折叠;说明进 tooltip;字号/主题只动
   theme.py,禁止在 QSS 写死 font-size。
3. **护栏从最外层用户入口进**:修流程类 bug 须配流程探针(编辑→切走/Discard→断言模型层
   结果);交互/拖拽/门控特性的护栏必须发**真实用户事件**从最外层入口触发(拖拽测
   `QMouseEvent` 不测 `setPos`,门控测「编辑→操作→断言模型」不测单个 commit 函数)。
   model 层测试绿、或「手动把系统摆到断言点」的测试,都不算断点之前那条路能走通的证据。
4. **rename/delete 提交前答三问**:任何改名/删除入口提交前必须回答——谁引用它(全工程
   扫描)、改名是跟随还是拦、删除是拦/警告/连带;实体改名删除走重构引擎、不手搓引用网
   (见 [content/mechanisms/entity-refactor-engine.md](../content/mechanisms/entity-refactor-engine.md))。
5. 含跨域选择器的面板必须实现跨面板刷新约定(切页时从模型重载候选)。
6. **偏差记录义务**:发现现实与本库文档打架或超出,收尾向 `agent_docs/_meta/inbox/`
   丢一条三行偏差记录(零门槛,格式见该目录 README)。

## 验收门

- 编辑器测试全量绿(`.tools/venv` 解释器;含离屏构造冒烟、小屏护栏、黄金往返);
- 素材引用审计 `--strict` 零问题;
- `./dev.sh validate-data` 零 error;
- 声称"格式零影响"的改动须字节级验收(见 [recipes/editor-change-verification-gate.md](recipes/editor-change-verification-gate.md))。

## 红线

- 打开即脏 / 什么都没干关闭却弹保存;
- 往返改字节、丢用户数据、清空悬垂引用;
- 裸 QLineEdit 承载引用/枚举字段;
- Python 兜底比 TS 权威更严;
- 绕过统一保存出口自行写盘(限业务数据;编辑器专用 sidecar 文件——UI 偏好/画布布局/
  分组框等,运行时永不加载——按 debug-ui-persistence 范式改动即直写,不算违反,
  2026-07-13 用户批准)。
