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
last_governed: 2026-09-03
---

# 编辑器/策划工具开发规范

适用:`tools/editor` 及各 `tools/*_editor` 策划工具(PyQt/PySide 及其内嵌 Web 编辑器)。
此类改动同时是技术改动,叠加适用 meta 域分类闸门与工程通则。

## 不变量

1. **数据零丢失往返**:打开→不动→保存,输出与磁盘等价;对业务数据只做既定格式规范化
   (ensure_ascii=False + 2 空格缩进 + 末尾换行 + 不排序键),禁止丢列表顺序、键序或
   表单未显示的键;数值表示保真(int 不得漂成 float)。
2. **脏态真实性**:只有真实用户变更才 mark_dirty;flush 到模型必须门控真实变更
   (pending 信号或内容 diff),禁止无条件 mark_dirty。
3. **Discard 必须中和**:关闭路径的放弃分支必须把 UI 回滚到模型值,否则后续统一 flush
   把已放弃的改动写回。
4. **唯一写盘出口**:业务数据落盘一律走统一保存出口(两阶段暂存)。新增数据域必须把
   **全部**同步面逐处对齐——**别记数字**,清单以
   [save-all-dirty-buckets](mechanisms/save-all-dirty-buckets.md) 为准(它比"登记 + 分支 +
   标脏"那三处多)。已知的正当例外只有两类:编辑器专用 sidecar(见红线那条的括注),
   以及**与游戏共写同一份配置的加工台**——那是双进程共写的有意设计,按
   [audio-workbench-config-write](mechanisms/audio-workbench-config-write.md) 的两层身份
   与磁盘反算办,**不要把它"修"回统一出口**。
5. **选择器铁律**:非自由文本字段(可枚举/引用/受约束的值)禁止裸 QLineEdit,候选取自
   ProjectModel 的 id-provider;"定义自身新 id"是唯一例外。**只有很短的枚举才允许下拉**,
   大候选集/跨文件引用/视觉资产选择一律弹窗
   (见 [decisions/2026-07-11-dropdown-vs-popup-selector.md](decisions/2026-07-11-dropdown-vs-popup-selector.md))。
6. **共享控件保值**:选择器对未知/悬垂值必须保值展示,禁止静默顶替或清空。
7. **兜底校验是子集**:Python 侧兜底校验必须是 TS 权威校验的子集,不得更严
   (更严 = 编辑器拒存合法数据)。
8. **镜像清单配对账**:任何手工镜像清单(运行时↔编辑器↔校验器)必须配**语义级** parity
   测试(不只锁存在性);注释里写「有护栏」= 没有护栏,声称的护栏必须能 grep 到测试;
   **宁可消灭镜像**(读单一真相源)也不维护两份。
9. **fail-safe 不 fail-open**:取不到状态/超时/未知返回一律取安全默认(当脏 / 当失败 /
   如实报错),绝不乐观放行(fail-open = 静默丢数据);「成功」回报必须基于**真实结果**,
   不能基于「函数被调用了」。写盘原子性(全有全无)与校验否决面(只否决本次将写盘的
   脏域,不连坐全局)分开对待。

## 过程义务

1. 新面板先判编辑模式、对齐同类编辑器骨架(主从列表 + `_refresh/_on_select/_apply`、
   命名脏桶),不造一次性写法。
2. **布局纪律**:新表单用 compact_form;短字段设宽度上限(禁 setMinimumWidth 地板堆叠
   顶爆小屏);**重块默认折叠且懒建**(首次展开才造控件——未展开块原样透传磁盘值,
   既保往返保真又躲开控件数的 O(N²) 成本);说明进 tooltip;
   字号/主题只动 theme.py,禁止 QSS 写死 font-size。
   动态加行时另有两条 Qt 纪律:**加进布局的控件要显式 `show()`**(未显示项被布局整个跳过,
   同一回合的行高按"零行"算);**按模式切换显隐的容器增删子控件后,要自内向外逐层刷新几何**
   (中间层不 invalidate,外层行高就冻在旧 sizeHint)。两条的症状都是**整行被压成一条缝**,
   而 model 层测试与构造冒烟全绿也照样漏——判据见
   [验证门配方](recipes/editor-change-verification-gate.md)「布局塌陷」。
3. **护栏从最外层用户入口进**:交互/拖拽/门控类特性的护栏必须发真实用户事件从入口触发;
   model 层全绿或「手动把系统摆到断言点」的测试,都不算断点之前那条路能走通的证据
   (判据与样板见 [验证门配方](recipes/editor-change-verification-gate.md))。
4. **rename/delete 提交前答三问**:谁引用它(全工程扫描)、改名是跟随还是拦、删除是拦/
   警告/连带;实体改名删除走重构引擎
   (见 [entity-refactor-engine](../content/mechanisms/entity-refactor-engine.md))。
5. 含跨域选择器的面板必须实现跨面板刷新约定(切页时从模型重载候选)。
6. **偏差记录义务**:发现现实与本库文档打架或超出,收尾向 `agent_docs/_meta/inbox/`
   丢一条三行偏差记录(零门槛,格式见该目录 README)。

## 验收门

- 编辑器测试**不新增失败**(`.tools/venv` 解释器;含离屏构造冒烟、小屏护栏、黄金往返)。
  **判据是平台相关的**:有的平台上全量本来就带一批环境性存量失败,"全量绿"在那儿不可达 ⇒
  有效判据 = 靶向跑受影响文件全绿 **+** 与 HEAD 双树对照失败集合一致。口径见
  [验证门配方](recipes/editor-change-verification-gate.md),别拿"绿不了"当放行理由;
- 素材引用审计 `--strict` 零问题;
- `./dev.sh validate-data` 零 error;
- 声称"格式零影响"的改动须字节级验收(见 [验证门配方](recipes/editor-change-verification-gate.md))。

## 红线

- 打开即脏 / 什么都没干关闭却弹保存;
- 往返改字节、丢用户数据、清空悬垂引用;
- 裸 QLineEdit 承载引用/枚举字段;
- Python 兜底比 TS 权威更严;
- 绕过统一保存出口自行写盘(限业务数据;编辑器专用 sidecar——UI 偏好/画布布局等运行时
  永不加载的文件——按 debug-ui-persistence 范式直写不算违反,2026-07-13 用户批准)。

> **这条今天有活的违例**(2026-09-03 盲重建实测):几个独立工具与主编辑器写同一批业务数据,
> 却各走各的写盘口、安全等级不一,其中一处还与统一保存互删。**违例都在现役可达路径上,
> 不是死码**——动这些工具前先读
> [save-all-dirty-buckets](mechanisms/save-all-dirty-buckets.md) 的已知坑,别照现状抄。
