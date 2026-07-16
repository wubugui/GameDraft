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
  - package.json#dev:anim-preview
triggers:
  paths: ["tools/anim_preview/**"]
  topics: [动画预览, anim preview, 动画验收, 动画工作台, 动画资源管理, 动画版本图]
  tasks: [验收动画, 预览动画, 改预览工具, 管理动画阶段, 回退动画版本, 迁移动画]
last_governed: 2026-07-16
---

## 是什么(一句话)

独立本机 Web IDE(vite dev):统一管理一个角色从 A 到 H 的不可变版本图、人工审查与回退，
在 R 阶段同时预览多个动作并手调 root/动作尺度/角色世界尺寸，最后仍用游戏**真**
`src/rendering/SpriteEntity.ts` 做发布态终验。IDE 不嵌入 AI，也不主动发起 Agent 任务。

## 权威源(读代码从哪进)

- `workspaceStore.mjs`:工作区 schema、节点契约、candidate/head、依赖状态、历史、检查点、
  内容寻址对象、人工权限边界、Agent context 与发布回执
- `workspacePlugin.ts`:仅监听 `127.0.0.1` 的本地 API；session token + same-origin 写保护，
  artifact/raw 只读流和工作区 watcher
- `workbench.ts`:目录、图、artifact 审查、动作规格/启停、单节点与整列失效、历史切换和检查点 UI
- `sequenceReviewer.ts`:E/F/G 按 manifest 权威顺序播放、scrub、首尾叠加；异常 fallback 明示
- `assemblyWorkbench.ts` + `assemblyViewport.ts`:纯人工 R 装配；多动作同屏、共享 phase、
  overlay/split/硬切、拖拽自定义 root、每动作统一等比 scale、共同 targetRoot 与 worldSize；
  worldSize 不重采样帧，但由固定世界网格和「1 世界单位」标尺实时可视化
- `animScanPlugin.ts`:发现机制核心(`GET /api/anim/index` 现扫
  `public/resources/runtime/animation/*/anim.json` + 文件 watcher 经 vite WS 推 `anim:changed`)
- `__main__.py`:启动器(起 vite + 开浏览器,`--char/--state`);入口注册在 dev 总控台
  (`tools/dev_console/app.py` 的 TOOLS)与 `package.json` 的 `dev:anim-preview`
- deep-link:资源工作区 `?folder=<中文角色目录>`；游戏预览 `?char=<id>&state=<state>`

## 人工能力页签

- 正常启动器生成一次性高熵 token，只通过它新打开页签的 URL fragment 交付；页面读入内存后立即
  `history.replaceState` 清掉 fragment，不写 query/localStorage，也没有公开的 token GET 接口。
- 直接打开 Vite URL、刷新已授权页签以及 `--no-open` 都只能只读。要恢复审核、失效、回退、动作编辑
  或 R 提交，必须重新运行启动器，让人明确获得一个新的能力页签。
- 这是防止普通 Agent 通过工作台 API 自我升级为“人”的本机协作边界，不承诺隔离同一 OS 账号下的
  恶意进程；所有写请求仍必须同时满足 localhost、same-origin、token 和 generation CAS。

## 本地与远程双运行模式

- 本地仍由 `./dev.sh anim-preview` 启动，继续使用 localhost API、一次性 capability 和文件系统工作区；
  远程部署是独立 Vite 构建与 fetch adapter，不能替换、重定向或削弱本地运行路径。
- GitHub Pages 读取 FindingDogDist `docs/data/` 中经脱敏的公开快照与 `docs/media/sha256/` 内容寻址素材，
  复用同一套工作台 UI 与游戏真实 `SpriteEntity`；不把整个 GameDraft `public/` 搬入远程仓库。
- 远程页面不嵌入或存储 PAT。人工操作由页面打开预填 GitHub Issue，仓库 workflow 只接收仓库所有者
  创建的命令，并同时校验 marker、endpoint 白名单、request id 和 generation CAS；随后调用同一
  `workspaceStore.mjs` 的 `human-ui` 权限路径，提交新快照与公开回执。
- 远程 R 草稿只存浏览器 IndexedDB；它不是权威工作区历史。R commit、审核、失效、回退等权威操作
  必须走所有者 Issue 通道。图依然不主动调度 Agent，Agent 仍主动从本地 IDE/CLI 读取状态并执行阶段任务。
- 远程导出与组装必须 copy-only 对待 GameDraft 源素材，部署前后源树哈希相同；不得公开
  `agent-context.*`、锁、临时文件、本机绝对路径或凭据。FindingDogDist 为公开镜像，入镜的 A/D/H
  素材和历史也公开可见。

## 图与推进权

- 静态支线:`A → B → C → H_STATIC`。
- 动画支线:每个动作独立 `B → D/<action> → E/<action> → F/<action> → G/<action>`，
  所有启用动作的 G 汇入纯人工 `R → H`。
- Agent 主动用 `workspace_cli.mjs context/status` 读取图，完成外部任务后只提交 immutable candidate；
  **图不调度 Agent，IDE 不调用模型**。
- 只有人在 IDE 中可以通过、拒绝、标记失效、切换历史 head、恢复检查点、启停动作和提交 R。
  新 candidate 不影响当前 accepted head；只有接受新 head 后，下游才按精确 parent revision 自动变 stale。
- 动作小节点只使该动作后继失效；汇入 R 后才影响整个角色的 R/H。回退不会删除历史，完全匹配
  当前 parents 的 accepted revision 可作为 compatible cache 恢复。
- 人工可使 D/E/F/G 任一整列 epoch 前进；这会让所有动作的该阶段及其下游失效，但仍不删除历史。
- 固化的是各阶段的语义输入/输出/验收契约，不是提示词；prompt/model 只可作为可选 provenance。

## A→H 阶段硬语义

- E:显式帧号、保持 D 的完整原视频画布；loop 指标只是审查辅助，首尾必须播放目验。
- F:先算每帧 bbox，再取一次 union bbox，并把同一个矩形用于所有帧；禁止逐帧重心锁、平移、缩放，
  且任何一帧主体都不能被 clip。
- G:只做精确抠图/边缘处理；帧数、顺序和逐帧宽高必须与 F 完全一致，不再裁剪或对齐。
- R:完全由人操作。每个动作自定义一个 `sourceRoot` 和一个统一等比 `scale`，该动作全部帧共用；
  所有动作对准共同 `targetRoot`。角色 `worldSize` 独立控制角色间相对大小，不等于视口 zoom；
  IDE 必须用世界参考网格/标尺显示它的变化，并用无 crossfade 的同 phase 硬切检查动作切换位移。
- H:只把 R 的共同 cell 打包为 `atlas.png + anim.json` staging revision，不再次改变几何；atlas 每边≤2048。
  发布是 Agent 的外部显式动作，IDE 只在核验文件哈希与 accepted H 一致后登记回执。
- H_STATIC:把 accepted C 的透明 PNG 逐字节复制为 staging revision。项目目标必须由人在 IDE 明确配置为
  `public/resources/runtime/images/**/*.png`，不能按 bundle/角色名猜；发布回执与 H 同样校验 hash、漂移、
  symlink/hardlink 和 accepted head。

## Agent 接口

```bash
node tools/anim_preview/workspace_cli.mjs list
node tools/anim_preview/workspace_cli.mjs context --folder <中文角色目录>
node tools/anim_preview/workspace_cli.mjs audit --folder <中文角色目录> --verify-hashes
node tools/anim_preview/workspace_cli.mjs add-action --folder <目录> --id <state>
node tools/anim_preview/workspace_cli.mjs submit --folder <目录> --node E/<state> --source <新产物目录>
```

每个工作区也落盘 `animation-workbench/agent-context.json` 与 `.md`。Agent 无 review/R/head API；
发布完成后可用 `record-publication` 登记回执，但它不负责复制或覆盖项目资源。

## 旧资源迁移

`migrate_legacy.mjs` 只认有精确证据的等价物:A=`setup.png`、D=`<action>.mp4`、
H=已发布 bundle 的逐字节副本。B/C/E/F/G/R/H_STATIC 缺证据就明确 unavailable，绝不从 atlas 反推或伪造。
旧 H 只登记为 `legacy baseline`，不是新图的 active head，也不会伪造 R。迁移先 dry-run，apply 必须
显式 `--confirm-copy-only`；禁止 move/delete/overwrite，迁移前后对源树做全量哈希快照。

## 硬契约(违反即 bug)

- 每阶段结果都落在 `tmp/原始素材/<角色>/animation-workbench/` 的不可变 revision；重复字节进入
  内容寻址对象库，不覆盖已生成版本。
- candidate 与 accepted head 必须分离；程序只算 runnable/stale/blocked/compatible，不代替人工通过。
- R 的草稿和提交必须绑定当时全部 G heads，任何 G 变化后旧草稿不得静默复用。
- H 没有 `bundleId`、H_STATIC 没有人工显式 `staticTargetPath` 时必须 blocked；目标变化必须使对应
  静态 staging 历史按依赖重算，旧发布回执不得继续显示 current。
- 本地工作区写接口必须保持 localhost、same-origin、session token 与 generation CAS；远程权威写入
  必须保持“仓库所有者 Issue + endpoint 白名单 + generation CAS”，且网页不得持有 GitHub token；
  两种模式的 artifact 路径都不得逃逸。
- **发现必须是运行时 fs 扫描 + 监听,不能改回 `import.meta.glob`**:动画在 `public/` 下是静态
  资源、不在 vite 模块图里,glob 命中不了;且 glob 是构建期静态,新增目录进不来。
- atlas.png 变更必须 cache-bust(URL 挂 `?v=<mtime>` + 重 loadFromDef),否则看的是旧图。
- 为工具加游戏侧能力只允许 additive(如 SpriteEntity 的 scrub/逐帧 getter),不改游戏行为。
- 场景背景模式铁律:**角色保持舒适大小(≈屏高 55%),背景按同一世界比例放大、镜头怼在
  spawn 上只显示一块**——不是把整场景塞进画面(会把角色缩成芝麻,被用户明确否过)。

## 已知坑

- 浮动设置面板必须是 fixed 居中 modal,固定像素偏移的 absolute 浮层会随分辨率乱飘遮控件。

## 怎么验证

- `npm run typecheck:anim-preview && npm run test:anim-preview`。
- 起工具后丢一个新 bundle 进 `public/resources/runtime/animation/`,列表应不刷新页自动 +1。
- 真实浏览器走通“资源流程 / 人工装配 R / 游戏真实预览”三页；最后一页的已发布资源与 H 候选都
  必须由 SpriteEntity 渲染，候选必须明确标“未发布”。
