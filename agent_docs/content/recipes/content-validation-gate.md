---
id: content-validation-gate
title: 内容收尾双校验门(命令与盲点)
domain: content
type: recipe
summary: 每次改完内容 JSON 必跑的两条命令(素材审计 + validate-data)、退出码语义、以及校验抓不到要自己当心的盲点
status: active
authority:
  - tools/editor/shared/asset_reference_audit.py
  - tools/editor/validator.py
  - dev.sh
triggers:
  paths: ["public/assets/data/**", "public/assets/scenes/*.json", "public/assets/dialogues/graphs/*.json"]
  topics: [validate-data, 素材审计, 数据校验, 收尾校验]
  tasks: [做内容, 改JSON, 收尾校验]
last_governed: 2026-08-05
---

**实测环境与日期**:2026-07-11,macOS(darwin),仓库根目录直接跑,两条命令均通过(素材审计 0 issues;validate-data 退出码 0、仅 warning)。
2026-08-17 Windows 复测:**`./dev.sh` 这个入口在 Windows 上零启动**(它按 POSIX 布局找 venv),
门本身没问题,换等价入口即可(见下)。

## 命令

1. **素材引用审计**(抓"引用了磁盘上不存在的图/音/动画"):

   ```sh
   sh scripts/py.sh -m tools.editor.shared.asset_reference_audit . --strict
   ```

   通过标准:`issues: 0`。

2. **全量数据校验**(抓 action type 未登记、跨文件引用断裂、必填/枚举、`[tag:]` 失效、废弃字段;等价主编辑器 Validate Data):

   ```sh
   ./dev.sh validate-data                  # POSIX 机;Windows 用下面这行
   sh scripts/py.sh -m tools.dev validate-data
   ./dev.sh validate-data -- --strict      # warning 也算失败(经 dev.sh 转参要加 --)
   ./dev.sh validate-data -- --errors-only # 只看 error
   ```

   退出码:0=无 error;1=有 error(--strict 下 warning 也算);2=工程加载失败。
   该命令内已串上 json_lang 层:schema 违例记 warning(`--strict` 升级为失败)、**对话图
   悬垂连边/悬垂外部入口记 error**、不可达节点记 warning、json_lang 自身故障降级为 warning
   不拦门。单独访问该层:`./dev.sh json-lang -- --validate --lint`
   (见 [json-lang-schema-tooling](../../editor-tools/mechanisms/json-lang-schema-tooling.md))。

   解释器入口为什么统一走 `scripts/py.sh`,见
   [挑项目 Python 的入口](../../meta/mechanisms/project-interpreter-entrypoint.md)。

不通过就继续改数据修复再跑,迭代到干净才算完成。

## 基线怎么用(**不要记数字**)

这道门长期不是零 error,所以判据是**增量**不是绝对值:

- **基线以当次实测为准**:动数据**之前先跑一次存下输出**,改完再跑一次,判据是
  **"不新增 error、warning 数不增加"**。库内、报告里、记忆里都**不写绝对条数**——
  这个数字每周都在变(实践中反复出现"照着上一条记录的数字判断,结论全错")。
- **别按上一次的结论归因**:同样的红灯数量可能换了一整族根因。判"这批 error 是不是我的",
  只能靠自己那次的前后 diff,不能靠任何写下来的历史数字。
- **红灯长期不清零就分流**:先按"来源族"把输出切开(哪些是我这次动的文件、哪些是既有
  存量),只对自己那族要求零;同时**把存量那族当账挂出来**(偏差记录 / 治理待办),
  不要让它继续占着 error 通道。
- **error 通道被噪音占满 = 这道门已经失效**:它此时分不出"新数据坏了"和"老噪音",
  必须当故障处理,而不是每次人肉略过。

## 校验器自身也会错

- **校验器的期望值必须以运行时消费端为准**。已实证的形态:校验器按某个查看器/旁支工具
  的口径算期望值,与运行时真正消费的口径差一个维度,于是**全量误报**——所有场景一起红、
  数量大到掩盖真问题,而产物一个字节没错。
- 所以看到"整整一族对象全红、且数量恰好是某个整数倍",**先怀疑校验器的公式,别先怀疑数据**;
  裁决方法是拿磁盘上的实际形态与**运行时消费端**的公式对一遍。

## 校验抓不到、要自己当心的盲点

- **素材文件存在性**——validate-data 不管,靠第 1 条命令。
- **大量引用只报 warning 不报 error**——warning 要逐条看,不能"没 error 就当对了"。
- **动作树里的 `[tag:…]` 只有白名单参数被校验**(见
  [text-ref-tag-system](../mechanisms/text-ref-tag-system.md)),白名单外打错了这道门放行。
- **叙事图校验有两套零共享的平行实现**:运行时开发校验(同时服务内嵌网页编辑器)是一套,
  这道 headless 门是**另一套手写的 Python 实现**,两者不互相调用,只靠人工同步加零星对账测试。
  ⇒ 一侧过了不等于另一侧过;网页编辑器不拦的东西这道门可能拦,反之亦然。
  报"网页能存但命令行报错"之前先想到这一条。
- **未登记 flag 只报 warning,且登记表为空时整条检查直接跳过**(否则满屏噪声)——
  别把"没报"读成"这个 flag 是对的"。
- 几个枚举字段**从来没有被枚举校验**(遭遇选项类型、规矩分类、scenario 的 phase status):
  打错了照样存、照样跑,只是从此匹配不上任何条件或退化成显示裸 id。

## 相关

契约背景见 [editor-roundtrip-contract](../mechanisms/editor-roundtrip-contract.md);工作流位置见 [production-mode-workflow](../methods/production-mode-workflow.md)。
