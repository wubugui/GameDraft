---
id: anim-preview-tool
title: 统一动画资源工作台(tools/anim_preview)
domain: asset-pipeline
type: mechanism
summary: 人工审查驱动的 A→H 版本图、R 多动作实时装配、Agent 结构化接口和游戏真实渲染终验
status: active
authority:
  - tools/anim_preview/workspaceStore.mjs
  - tools/anim_preview/workspacePlugin.ts
  - tools/anim_preview/workbench.ts
  - tools/anim_preview/sequenceReviewer.ts
  - tools/anim_preview/assemblyWorkbench.ts
  - tools/anim_preview/animScanPlugin.ts
  - tools/anim_preview/__main__.py
  - tools/anim_preview/remoteBootstrap.ts
  - tools/anim_preview/export_remote.mjs
  - tools/anim_preview/remote_mutation.mjs
  - tools/anim_preview/workspace_cli.mjs
  - tools/anim_preview/migrate_legacy.mjs
  - tools/anim_preview/README.md
  - package.json#dev:anim-preview
triggers:
  paths: ["tools/anim_preview/**"]
  topics: [动画预览, anim preview, 动画验收, 动画工作台, 动画资源管理, 动画版本图]
  tasks: [验收动画, 预览动画, 改预览工具, 管理动画阶段, 回退动画版本, 迁移动画]
last_governed: 2026-08-05
---

## 是什么(一句话)

独立本机 Web IDE(vite dev):管理一个角色 A→H 的不可变版本图与人工审查/回退,R 阶段同屏
预览多动作并手调 root/尺度/世界尺寸,终验用游戏**真** `SpriteEntity` 渲染。IDE 不嵌 AI。

## 权威源(读代码从哪进)

- `workspaceStore.mjs` 是语义本体(节点契约、candidate/head、依赖状态、检查点、内容寻址、
  Agent context、发布回执);其余文件都是它的 UI / 本地 API / 远程通道 / CLI 外壳。
- 启动入口 `__main__.py`(同时注册在 dev 总控台与 `package.json#dev:anim-preview`)。
- deep-link:资源工作区 `?folder=<中文角色目录>`;游戏预览 `?char=<id>&state=<state>`。

## 图与推进权

- 静态支线 `A→B→C→H_STATIC`(裸 PNG)与 `A→B→C→H_STATIC_BUNDLE`(单帧动画包,与 `H` 写
  同一个 bundle 目录、正式包上线即取代它,见
  [单帧静态动画包](static-single-frame-bundle.md));动画支线每动作独立 `B→D→E→F→G`,
  所有启用动作的 G 汇入纯人工 `R→H`。
- **只有人**能通过/拒绝/失效/切 head/恢复检查点/启停动作/提交 R;Agent 只能提交 immutable
  candidate,**图不调度 Agent、IDE 不调模型**。接受新 head 后下游才按精确 parent revision
  变 stale;回退不删历史。
- 固化的是各阶段的语义输入/输出/验收契约,**不是提示词**;prompt/model 只作可选 provenance。
- Agent 侧只有 `workspace_cli.mjs`(读图 + 提交 candidate + 登记发布回执),**没有 review/R/head
  接口**——这是边界不是遗漏。

## A→H 阶段硬语义

- **E**:显式帧号、保持 D 的完整原视频画布;loop 指标只是审查辅助,首尾必须目验。
- **F**:先逐帧 bbox 再取**一次 union bbox**,同一矩形用于所有帧;禁逐帧重心锁/平移/缩放,
  任何一帧主体都不得被 clip。
- **G**:只做抠图/边缘处理;帧数、顺序、逐帧宽高必须与 F 完全一致,不再裁剪对齐。
- **R**(纯人工):每动作一个自定义 `sourceRoot` + 一个统一等比 `scale`(该动作全帧共用),所有
  动作对准共同 `targetRoot`;`worldSize` 控角色间相对大小(≠视口 zoom),必须用世界网格/标尺
  可视化;动作切换用**无 crossfade 的同 phase 硬切**查位移。
- **H**:只把 R 的共同 cell 打包成 `atlas.png + anim.json`,不再改几何;atlas 每边≤2048。
- **H_STATIC**:accepted C 的透明 PNG 逐字节复制;静态目标路径必须由人显式配置,**不许按
  bundle/角色名猜**。

## 硬契约(违反即 bug)

- 每阶段结果落 `tmp/原始素材/<角色>/animation-workbench/` 的不可变 revision,重复字节进内容
  寻址库,**不覆盖已生成版本**。
- candidate 与 accepted head 必须分离;程序只算 runnable/stale/blocked/compatible,
  **不代替人工判通过**。
- R 的草稿与提交必须绑定当时全部 G heads;任何 G 变化后旧草稿不得静默复用。
- H 无 `bundleId`、H_STATIC 无人工 `staticTargetPath` 时必须 blocked;目标变了旧发布回执不得
  继续显示 current。
- **发布是 Agent 的外部显式动作,IDE 只登记回执**;登记前必须核验文件哈希 = accepted head,
  并查**漂移与 symlink/hardlink**——只比哈希不查链接,伪发布会被当成 current。
- 两套写保护都不许削弱:本地 = localhost + same-origin + session token + generation CAS;
  远程 = 仓库所有者 Issue + endpoint 白名单 + CAS,**网页不得持 GitHub token**;两种模式的
  artifact 路径都不得逃逸。
- **发现必须是运行时 fs 扫描 + watcher,不能改回 `import.meta.glob`**:动画在 `public/` 下是
  静态资源、不在 vite 模块图里,且 glob 是构建期静态、新增目录进不来。
- **atlas.png 变更必须 cache-bust**(URL 挂 `?v=<mtime>` + 重 loadFromDef),否则看的是旧图。
- 为工具加游戏侧能力只允许 **additive**(如 SpriteEntity 的 scrub/逐帧 getter),不改游戏行为。
- **场景背景模式铁律**:角色保持舒适大小(≈屏高 55%)、背景按同一世界比例放大、镜头怼在 spawn
  上只显示一块——**不是**把整场景塞进画面(会把角色缩成芝麻,**被用户明确否过**)。
- 远程是**公开**只读镜像:对源素材 copy-only(部署前后源树哈希相同),不得公开 agent-context/锁/
  本机绝对路径/凭据;远程 R 草稿只存浏览器 IndexedDB,**不是权威工作区历史**。三条红线:
  远程**不得替换、重定向或削弱本地运行路径**;**不把整个 `public/` 搬进远程仓库**;
  入镜的 A/D/H 素材与历史**一并对外公开可见**(这是隐私后果,不是实现细节)。
- `migrate_legacy.mjs` 只认精确证据(A=`setup.png` / D=`<action>.mp4` / H=已发布 bundle 逐字节
  副本),其余阶段一律 unavailable——**绝不从 atlas 反推或伪造**,旧 H 只登记为 legacy baseline
  不是 active head;apply 必须 `--confirm-copy-only`,禁 move/delete/overwrite。

## 已知坑

- 人工能力靠一次性 token 经新页签 URL fragment 交付(读入内存即清 fragment):直接开 vite URL、
  刷新已授权页签、`--no-open` 都只剩只读——**审核/失效/回退/R 提交按钮不响应不是 bug,是要重跑
  启动器换一个能力页签**。这条边界只防 Agent 自升为"人",不防同账号恶意进程。
- 浮动设置面板必须是 fixed 居中 modal;固定像素偏移的 absolute 浮层会随分辨率乱飘遮控件。
- **工作区存盘的「原子写」在 Windows 上是概率性失败的**(`workspaceStore.mjs` 的
  tmp→rename),表现为丢一次编辑;测试上的表现是**单跑绿、连着跑红**,极易被当成环境问题。
  已按退避重试修好——见 [atomic-write-windows](../../meta/mechanisms/atomic-write-windows.md)。

## 怎么验证

- 接手一个工作区先验字节完整性:`node tools/anim_preview/workspace_cli.mjs audit --folder
  <中文角色目录> --verify-hashes`;Agent 自己的上下文落在该工作区的
  `animation-workbench/agent-context.json` 与 `.md`。
- `npm run typecheck:anim-preview && npm run test:anim-preview`。
- 丢一个新 bundle 进 `public/resources/runtime/animation/`,列表应不刷新页自动 +1。
- 真浏览器走通"资源流程 / 人工装配 R / 游戏真实预览"三页;已发布资源与 H 候选都必须由
  SpriteEntity 渲染,候选必须明确标"未发布"。
