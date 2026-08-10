---
target: narrative-template-system
date: 2026-08-09
session: 藏钱点模板化（制作人反馈抽取全手填没法用）
---

# 抽取参数自动发现 + from 绑定进 UI（模板卡待补）

- **新增**：`tools/narrative_editor_web/src/templateParamDiscovery.ts` —— 「从作曲创建模板」自动扫图出候选：
  整值引用按出处定类型（dialogueBlackbox.refId→dialogueRef、activePlane→planeRef、动作参数按 catalog 反查），
  命名串（图id/ownerId/信号/emits）公共 token = 实例 id 形状（预填首参数样值，实体 wrapper 自动建议 from:entity.id）；
  共用私有信号名与 reactive 占位信号刻意不进命名源。vitest：templateParamDiscovery.test.ts。
- **新增**：两处参数表单加「来源绑定」下拉（手填/entity.id/entity.kind/entity.label/scene.id），候选由
  `authoring_catalog` 新键 `paramSources` 喂（权威 = shared/narrative_templates.PARAM_SOURCES；TS 兜底镜像有
  parity 测试 test_authoring_catalog_param_sources_match_authority_and_web_fallback），未知 from 值保值展示不静默改写。
- **新增**：零洞参数护栏——抽取表单参数行实时显示样值命中数（0处/缺样值标红），存在零洞参数时禁创建；
  桥回传的 validate_template issues 此前被网页丢弃，现上屏且有 issue 不创建（真实事故：制作人用旧表单
  抽出「藏钱事件」空壳模板，4 参数零洞零提示，盖章必撞名）。
- **新增**：模板抽取跟随当前视图——制作人在 wrapper 子图里点「从当前作曲创建模板」，此前抽的是整张
  母作曲（真实事故：藏钱机器在 wrapper 元素内嵌图里，抽出来全是主图的东西）。现
  `editorModel.liftSubgraphForTemplate(comp, graphRef)` 把子图抬成独立作曲喂 TemplatesPanel；
  实体图还是画布自动名（wrapper_graph_N）时抬升按 `wrap_<ownerId>` 惯例定名（否则批量盖第二份撞名）。
  发现器同步：扫 element.graph 内嵌子图、实体 ownerId 恒出候选（不受 ≥2 命名源门槛）、停用词补
  wrapper/composition 等画布自动名碎片。
- **存量 P0（本轮真根因）**：`stampTemplate` slot 漏传 `existing_signal_rows=`（批量那条路一直传着），
  于是模板里凡是抽取时原样抄下来的信号声明、以及共用私有信号，第一次盖章就判「已存在且声明不一致」，
  **叙事页盖章按钮对这类模板永久变灰**，官方 pickable 种子模板也盖不出第二份。发货时无人从单张
  盖章路径跑过。回归锁 `test_single_stamp_reuses_shared_signal_row_like_batch_does`。
- **批量盖章顺带接显隐**（新）：勾选后每个实体写 `conditions=[{narrative: 自己那份作曲, state: 选中}]`
  + `conditionHidesEntity`；只写本来没有条件的实体、不勾零改动、plan 期零副作用、脏桶 `("scene", sid)`。
  不接的话策划盖完 20 张图要手填 20 次**逐个不同**的图 id，打错还静默不生效（条件恒假→热点永不出现）。
- **顺带**：test_narrative_private_signals 的「现网零私有信号」发货快照断言已过期（首条真私有信号
  「私有事件完结」落地），改为守长期性质（scope 只许 private + 校验零 issue）。

## 样值误伤（子串替换的固有风险）：三条判据

抽取 = 整树子串替换，所以样值会连带改坏"包含它"的别的名字。检测分三层，缺一层就有静默事故：

1. **语料**：目录登记 id（对话图/实体/场景/位面…）**+ 图里用到的信号名**。只查目录 id 会漏掉
   作者信号——`label=藏钱` 把 `藏钱_取走` 抽成 `{{label}}_取走`，盖出的图监听一个没人发的名字，
   那一跳永远不走，且校验器不查"改了名的新信号"（比断引用更隐蔽）。
2. **假阳性剔除**：抽取按样值**长度降序**替换，被更长样值罩住的命中在轮到本样值前已被挖成洞
   （`藏钱` 之于 `主线s1藏钱点A`）。判据 `effectiveOverMatches(sample, hits, allSamples)`，
   必须拿**当前这组样值**一起算，而且**采不采用**与**挡不挡创建**两处都要用同一口径
   （只修红条那一半 = 显示名参数被白白跳过，N 个实例画布上仍全同名）。
3. **信号侧的边界收敛**：实例 id 编进信号名是**正当模式**（`藏钱点A__已取` 该挖），
   撞进无关信号才是意外（`门` 之于 `开门_完成` → 幽灵信号）。判据：两侧都得是串边界或分隔符
   （`_ - : . 空格 / |`），任一次出现不满足就算撞。**只用于 entity.id + 信号语料**；
   目录 id 侧刻意不加（现网 18 对互为子串的实体 id 如 `fx_steam_2 ⊂ fx_steam_2_copy` 边界对齐、
   却确实是误伤，加了会漏报）。
   固有假阴性：`A_章节开始` 与 `藏钱点A__已取` 从字符串上同形，靠命名分不出。
   **未做的进一步判据**（现网够不着，留待办）：查这条信号是不是只有这张图在用——
   逐实例信号只出现在自己图里，共享信号必然还有别人引用。
   同样未做：短样值打穿 JSON 结构键（`A` → `onEnter{{ownerId}}ctions`），正确位置是
   抽取出口比对骨架 JSON 键集合与源，**不该继续往误伤语料里堆**；现网最短 id 3 字符，降级。

## plan/apply 两步式的对账义务

`plan_batch_stamp` 是纯计算、`apply_batch_stamp` 才落地，中间世界会变（对话框开着时另一头照样改）。
**每一样要写的东西都得在 apply 期重新对一遍现实**，缺一样就是静默数据破坏：

- 实体不在了（改名/删除）→ 整批不写（否则给不存在的实体暂存无主 wrapper，弹窗还报成功）；
- 实体这中间被写入了条件 → 跳过不覆盖（**照 plan 期的结论盲写 = 吃掉作者刚写的编排**）；
- **作曲/信号侧同样要对账**：plan 产出的是**整份** narrative 快照，直接 `model.narrative_graphs = plan[...]`
  会把这中间别处新加的图/注册的信号一起抹掉。基线记在 plan 里（`baselineNarrative`），apply 期比 id 集。

判"实体有没有作者条件"的判据必须是**只有确认是空/缺失才写**，不能是"是 list 且非空才算有"——
坏值（dict/字符串/老数据）会被当空白覆盖掉。库内 norms：空集合与数组坏元素一律只读透传。

## 其它落点

- `conditionHidesEntity` 只有 HotspotDef / NpcDef 有（`src/data/types.ts`），**zone 没有**——写给 zone 是垃圾键。
- 状态 id 自己可能带占位符（`{{ownerId}}_出现`，发现器会把实体 id 从状态键里一起挖走）：
  下拉给骨架键、校验比盖出来的键，必须先做同一次替换，否则每一项都点不通、整批恒被拦而骨架只读没出口。
  且要防替换后互撞（参数化键与写死键并存 → dict 后写覆盖先写，状态凭空少一个、转移变自环，ok=True 零警告）；
  **互撞计数必须递归数全部图**（主图 + 内嵌子图），只数 mainGraph 会漏掉 wrapper 元素里的同型塌陷。
- 实体推导参数**只有喂 owner 字段的**（ownerType/ownerId）才必须必填：那两个字段拼运行时 owner 索引键，
  空串 = 这张图谁也找不到；显示名为空只是画布没名字，一刀切会堵死正当模板。
- 同理 `entity.id` 才不许绑两个参数（身份鉴别符，重复=一实体多份产物）；
  显示名/类型绑多处是**正当需求**（图 label 与镜像任务标题本就同一个值）。
- 跨场景同名实体：运行时按**裸 id** 建 owner 索引，同名 = 同一个 owner、本就该共用一张图。
  别建议"加个 scene.id 参数区分"（那会给同一个 owner 造两张图）。

## 方法论教训（值得单独入 method）

用**策划角色 subagent 反复验收**（自己发明用例、真跑引擎、只报不修、不合格打回）比自测有效得多。
五轮共报 12 条阻断，其中**第二轮 3 条全是第一轮修复自己引入的回归**，典型形状是
「为了防 A 而少做一步，结果掉进比 A 更坏的 B」（overMatches 命中就不自动采用 ownerId →
模板整个没有 ownerId 洞 → 每个实体盖出同一份、绑错实体）。

三条可复用的教训：
1. **安全措施不能靠「少做」实现，必须靠「挡住 + 说清楚」**——必需字段永远采用，风险由显式拦截表达。
2. **护栏收窄要看真实数据再拍**：几条"该不该拦"的判断（目录 id 侧要不要加边界规则、单字母 id
   要不要防）都是靠扫现网 272 个实体的命名分布定的，不是靠想。
3. **自称修好之前先从用户那条路真跑一遍**：本轮最狠的存量 P0（单张盖章按钮永久变灰、
   官方种子模板盖不出第二份）能藏住，就是因为发货时没人从单张盖章路径走过。
