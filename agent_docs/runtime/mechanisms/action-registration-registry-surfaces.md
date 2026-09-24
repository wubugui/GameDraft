---
id: action-registration-registry-surfaces
title: 加 Action 的登记面
domain: runtime
type: mechanism
summary: 新 action 要同步的登记面分必填(运行时注册 / TS 参数清单 / 编辑器登记与持久化分类 / 校验器)与条件性(容器槽位 / 实体引用 / 内容 id 引用 / 宿主语境分类表);漏哪一处的报错通道各不相同,有的四条门全绿只有一条编辑器测试红,有的哪里都不红
status: active
authority:
  - src/core/ActionRegistry.ts
  - src/core/actionParamManifest.ts#ACTION_PARAM_MANIFEST
  - tools/editor/shared/action_editor.py#ACTION_PERSISTENCE
  - tools/editor/shared/action_editor.py#_ACTION_SCOPED_OMIT_WHEN_ABSENT_AND_DEFAULT
  - tools/editor/shared/action_editor.py#_OMIT_ONLY_WHEN_ABSENT
  - tools/editor/shared/action_structure.py#NESTED_ACTION_SLOTS
  - tools/editor/shared/entity_refactor.py#ENTITY_REF_PARAMS
  - tools/json_lang/schema_build.py#CONTENT_ID_PARAMS
  - tools/editor/tests/test_param_schema_manifest_parity.py#_BESPOKE_BUILT_REQUIRED
triggers:
  paths: ["src/core/ActionRegistry.ts", "src/core/actionParamManifest.ts", "tools/editor/shared/action_editor.py", "tools/editor/shared/entity_refactor.py", "tools/editor/shared/action_structure.py", "tools/json_lang/schema_build.py"]
  tasks: [加 action, 新命令, L2 升级, 加可选参数, 加容器动作, 加引用参数]
  topics: [ActionRegistry, actionParamManifest, 动作参数, 实体引用登记, ENTITY_REF_PARAMS, CONTENT_ID_PARAMS, 容器槽位, 可选参数往返, ACTION_PERSISTENCE]
verified_by:
  - tools/editor/tests/test_entity_refactor.py
  - tools/editor/tests/test_action_manifest_parity.py
  - tools/editor/tests/test_param_schema_manifest_parity.py
  - tools/editor/tests/test_nested_action_walkers.py
  - tools/editor/tests/test_shared_widget_selectors.py
  - tools/editor/tests/test_action_row_owned_params.py
  - tools/editor/tests/test_action_row_global_omit_cleared.py
  - tools/editor/tests/test_run_actions_detached.py
last_governed: 2026-09-23
---

## 是什么(一句话)

游戏行为原语(action)的注册契约:**多个登记面必须同步**,而漏掉不同的面报错通道完全不同——
有的导入即炸,有的运行时静默跳过,有的**四条门全绿只有一条编辑器测试红**,有的**哪里都不红**。
对称的两张:新条件叶走 [加条件叶的登记面](condition-leaf-registration-surfaces.md);
新增"哪个 JSON 字段装着动作列表"走 [动作宿主字段登记面](../../editor-tools/mechanisms/action-host-fields.md)。

## 登记面(漏了会怎样)

**必填**

| 登记面 | 权威源 | 漏了的表现 |
|---|---|---|
| 运行时执行注册 | `ActionRegistry.register`(第三参 = 参数名,只供 DEV 互查) | DEV 屏上报错后跳过、生产静默跳过;**"编辑器能选、运行时没 handler" 没有 pytest 硬门**,DEV 启动互查只 `console.warn` |
| TS 参数清单 | `actionParamManifest.ts`(required / nonEmpty / optional 的唯一权威) | `tsc` 与 `validate-data` 都不报;叙事图里用到它 = 未知类型,**编辑器拒存**;parity 测试红 |
| 编辑器登记 | `action_editor.py` 的 `ACTION_TYPES` + **`ACTION_PERSISTENCE`**(两者必须双向相等,**模块导入期断言**——漏它编辑器、校验器、所有测试一起起不来,是最先炸的一面) | 下拉里选不到;校验器报未登记 error |
| 参数表单 | 泛型 `_PARAM_SCHEMAS`,或专用表单 `ActionRow._CUSTOM_FORMS`(写出函数 + 接管键集) | 参数编辑不出;**专用表单承载的 required 参数必须登进 `_BESPOKE_BUILT_REQUIRED`**,漏了只有反向对账一条红 |
| 校验器认可 | `tools/editor/validator.py` | 合法数据被误报,或该 type 的专项检查整片缺席 |

`_PARAM_SCHEMAS` 与 TS manifest 是 parity 关系;**Python 侧是投影,冲突以 TS 为准**。
manifest 的 required **可以比运行时更严**(例:容器分支动作不写条件时运行时当恒真,manifest 与校验器仍要求必填)。

**条件性**

- **带子动作列表(容器)**:`action_structure.NESTED_ACTION_SLOTS` 是槽位唯一登记表(读它的遍历器由
  `test_nested_action_walkers` 按槽位参数化锁住),TS 叙事校验另有逐槽镜像(对账测试锁)。**仍是手写分支、
  不读登记表也没对账的**:校验器 `_walk_action_defs` 的容器 elif 链、运行时脱手批音效预热的下钻——加容器要手补。
  槽位漏登记的表现是子动作对所有遍历器**隐形且不报错**。
  **容器 handler(以及任何间接执行一张动作列表的 handler)必须把 `originContext` 与 `scope` 原样往下传**——
  丢了 scope,脱手批里的子动作会重新拿"探索锁"把玩家当场钉住(锁的来历见下一条)。
- **实体 / 场景 / 出生点引用**:`ENTITY_REF_PARAMS`(重构、引用扫描、校验器可达性共同消费,漏登记 = 双双隐形)。
  参数是对象(位置引用 `at`)登 kind `position_ref`;新 kind 还要同步 json_lang 的 `REF_KIND_UNIVERSE` / `_KNOWN_REF_KINDS`
  (parity 拦)。走专用表单的 action 由 `test_custom_branch_actions_pinned` 钉单,新增要补钉。
- **内容 id 引用**(物品 / 过场 / 音频 / 档案…,非实体):json_lang `CONTENT_ID_PARAMS` + 新宇宙的装载
  (`id_universes`)+ 编辑器 `_SELECTOR_KIND_UNIVERSE` + 叙事关联 `TARGET_SPECS`;前两者漏了宇宙级 parity 红。
  **校验器不读这张表做存在性检查**——想让悬垂 id 报 error 得在校验器里手写分支(见已知坑)。
- **宿主语境分类表**:过场白名单(`cutscene_action_allowlist.json`)、纯演出 / 脱手禁用表(manifest 文件内)、
  叙事 warp 重放静默表——各表缺省取向不同,见 [脱手演出会话](detached-performance-session.md)。
  **写存档的动作不许进纯演出表**(`test_run_actions_detached` 拦)。普通动作批在探索态会**逐条**把玩家锁进
  动作序列态;要写"玩家能走的背景演出",用脱手容器,别指望新动作自己不锁(机制见同一张卡「为什么需要它」)。
- **宿主注入的隐式参数只作用于顶层**:有的宿主给顶层动作注入上下文(例:挂件状态的进入动作里,省略目标的
  挂件粒子动作 = 这件挂件自己),嵌进容器就不注入、必须写全;校验器同口径只在顶层放行。
  新动作若要吃这类注入,先读 [手持挂件](held-prop-system.md) 那条规则。

## 硬契约(违反即 bug)

- **长在数据结构里的实体引用不进 `ENTITY_REF_PARAMS`**(不是 action、没有 `type`/`params` 壳;硬登记会被
  parity 拦——键必须是真 action)。单写一条改写函数,接进 **scan / rename / move / undo-move 四条路径**并配跟随测试。
  四条路径各自怎么处置,判据是**引用所在的数据能不能跟着实体走**,不是引用长什么样:
  能跟 → 机械跟随(场景限定写法零歧义);裸 id 有歧义 → 只在全局唯一时跟;引用方是源场景的家具
  (如场景灯的跟随目标)→ rename 跟、move 只报不改、undo 对称不动;唯一写者是别的进程 → 不扫不改不报。
  先例都在 `entity_refactor.py`。
- **过场内的存档保护有两道,口径不同**:校验器按 `ACTION_PERSISTENCE=="save"` 拦过场**顶层**步(staging 例外表放行);
  运行时策略栈用的是 `CutsceneManager` 里**手写**的存档黑名单(递归到嵌套)——它与 `ACTION_PERSISTENCE` 没有对账,
  较新的写存档动作不在里面。新原语要进过场,先判它是否纯表演,再看两道各认不认它。
- **可选参数缺省不写键**:登 `_OMIT_WHEN_ABSENT_AND_DEFAULT`(按参数名全局)或
  `_ACTION_SCOPED_OMIT_WHEN_ABSENT_AND_DEFAULT`(按 `(action, param)`);同名参数在别的 action 里可能 required,
  **这种一律用作用域表**。两张表都剔"原本没有且仍中性"与"盘上非中性、被清回中性";判"原本中性"按语义比
  (三态 `"true"`≙`true`)。全局表的例外 `_OMIT_ONLY_WHEN_ABSENT` 只剔缺键——凡在任一 action 里 required、
  或运行时"中性值 ≠ 缺键"的名字都必须进例外表(`test_action_row_global_omit_cleared` 按 manifest 守着)。
- **控件自己不写的键不许被末尾透传塞回来**:`_to_dict_raw` 末尾透传磁盘上未写出的参数(保未登记参数)但跳过接管集。
  泛型循环里有控件的参数自动接管;循环之后手写的键要自己 `owned.add`;专用表单的接管集**要含表单有意不写的键**
  (被新写法取代的老键、另一档模式的键…)。漏了都是"清空存不下去",由 `test_every_passthrough_action_keeps_an_unknown_key`
  与同文件的逐表单清空用例拦。

## 已知坑

- 新增可选参数后"打开→什么都不改→保存"凭空多出键,把支点/光照/翻面等写成中性值 = **改行为不是格式漂移**;
  反方向"盘上有值→清空→保存"键还在也探不到。两条都要从控件入口单独探(样板 `test_action_row_owned_params.py`,
  全量复扫见 [数值往返保真](../../editor-tools/mechanisms/numeric-roundtrip-fidelity.md))。
- **运行时默认为 true 的可选 bool 不能用勾选框**(控件中性值 false ≠ 运行时缺省 true,false 配不出来);走三态字符串。
- **内容 id 悬垂引用 validate-data 基本不报**(2026-09-23 探针:任务奖励里写不存在的物品 / 过场 / BGM / 遭遇 / 任务 id,
  零条;少数参数只有 warning)。唯一的构建期信号是 json_lang schema 的 warning;校验器里某处注释声称会补这类检查,与实测不符。
- **过场白名单里有一项与持久化分类互斥**:白名单放行、`ACTION_PERSISTENCE` 记为 save 的动作,时间轴能选、选了校验必报 error。
- manifest 里写 json_lang 解析不了的 TS 语法(展开、计算值…),json_lang 整层降级成**一条 warning**,门照样绿。
- 纯演出 / 脱手禁用两张 TS 表由 Python 文本解析;解析失败返回**空集**不报错,唯一防线是表长下限断言。

## 怎么验证

`npx tsc --noEmit` + 数据校验 + **`tools/editor` 全树 pytest**(TS manifest、持久化分类、专用表单必填那几面只有这里抓得到)
+ DEV 启动看 `[actionParamManifest 漂移]` 零告警;编辑器里能选到新类型,**最小形态**与**填满形态**两条往返都无漂移。
