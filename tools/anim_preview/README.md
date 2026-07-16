# 统一动画资源工作台

本机 Web IDE，负责角色动画 A→H 阶段的资源目录、不可变版本、人工审查、依赖失效、
检查点/回退、纯人工 R 装配和已发布 SpriteEntity 终验。IDE 不嵌入 AI，也不发起 Agent 任务；
Agent 主动读取结构化状态、在外部完成任务，再提交 candidate 等待人工通过。

## 启动与验证

```bash
./dev.sh anim-preview
npm run typecheck:anim-preview
npm run test:anim-preview
```

正常启动器会只向它新打开的浏览器页签交付一次人工写能力。能力放在 URL fragment 中，页面读取后
立即清掉，不进入 query、localStorage 或公开 API；刷新后该页签会退回只读，需要重新运行启动器。
直接打开 Vite 地址以及 `--no-open` 都是只读模式，适合 Agent 查看状态，不能审核、失效、回退或编辑 R。
这是一条本机协作边界，不把同一 OS 账号下的恶意进程当作安全隔离对象。

页面按人工操作顺序分成三个工作区。首屏只突出“选角色 → 看下一步 → 看素材 →
通过或退回”，静态与动画分支分别展示；动作规格、导出位置、整列失效和技术详情默认收起：

- 流程与审查：角色缩略图、下一项待办、静态/动画两条真实分支、素材大画布、人工决定和版本回退。
- 角色与动作设置：低频抽屉；人工编辑动作规格/启停动作，按单节点或 D/E/F/G 整列标记失效；
  程序自动计算下游重建。
- 锚点与缩放 R：全部 accepted G 动作同屏，拖拽各动作脚点对准统一落脚点，逐动作统一等比缩放；
  硬切检查动作切换位移，世界网格与“1 世界单位”标尺实时显示角色 world size。
- 游戏真实预览：运行时扫描已发布 bundle，也可直接加载未发布 H revision；两者都使用游戏真实
  `SpriteEntity` 渲染，候选明确标为“未发布”，不会触发发布。

E/F/G 的 PNG 序列按 `manifest.frames` 权威顺序播放，支持循环、FPS、逐帧、scrub 和首尾叠加；
manifest 异常会显式标红 fallback，不能被误认为权威帧序。

## Agent 接口

```bash
node tools/anim_preview/workspace_cli.mjs list
node tools/anim_preview/workspace_cli.mjs status --folder 土狗
node tools/anim_preview/workspace_cli.mjs context --folder 土狗
node tools/anim_preview/workspace_cli.mjs audit --folder 土狗 --verify-hashes
node tools/anim_preview/workspace_cli.mjs add-action --folder 土狗 --id jump --label 跳跃 --fps 8
node tools/anim_preview/workspace_cli.mjs submit --folder 土狗 --node E/jump --source /abs/new-E-output
```

`context` 同时刷新工作区里的 `agent-context.json/.md`。固定的是阶段输入/输出/验收语义，
不固定 prompt；模型、prompt、工具与 fallback 可随 candidate 写入 provenance。

审核、标记失效、历史 head 切换、compatible cache 恢复、检查点和 R 没有 Agent CLI，必须由人
在 IDE 操作。Agent submission 不会替换 accepted head；只有人接受后才使依赖它的下游变 stale。

## 远程验收镜像

GitHub Pages 版是本机 IDE 的并行部署形态，不替换本地启动器、localhost API、工作区文件或
Agent CLI。它复用同一套 UI 和游戏真实 `SpriteEntity`，但读取 FindingDogDist 中经脱敏的公开快照与
内容寻址素材，因此可远程查看目录、阶段图、历史和预览。

远程写操作不在网页内保存 GitHub token，也不让网页直接改仓库。页面把操作编码成预填的 GitHub
Issue；用户确认提交后，仓库 workflow 只接受仓库所有者账号创建的、通过 endpoint 白名单和
generation CAS 的命令，再调用同一个 `workspaceStore.mjs` 人工接口提交结果。处理回执会写入公开快照，
页面可轮询显示。R 草稿只存在当前浏览器的 IndexedDB，提交 R 才走上述人工命令通道。

```bash
npm run build:anim-preview-remote
npm run assemble:anim-preview-remote -- \
  --target /abs/FindingDogDist \
  --dist /abs/remote-dist \
  --confirm-clear \
  --expected-head <FindingDogDist-head>
```

组装器只清理显式指定且 HEAD 完全匹配的 FindingDogDist 工作副本；它不会 move、delete 或 overwrite
GameDraft 的既有素材。远程仓库是公开仓库，A 设定稿、D 视频、H bundle 及历史镜像也随之公开；
`agent-context.*`、锁、临时文件、本机绝对路径和凭据不得进入部署产物。

## 阶段适配器

```bash
.tools/venv/bin/python -m tools.animation_pipeline.workbench_stages e \
  --video input.mp4 --indices 0,3,6,9 --loop --out /abs/new-E
.tools/venv/bin/python -m tools.animation_pipeline.workbench_stages f \
  --input /abs/new-E --out /abs/new-F
.tools/venv/bin/python -m tools.animation_pipeline.workbench_stages g \
  --input /abs/new-F --method fusion --out /abs/new-G
.tools/venv/bin/python -m tools.animation_pipeline.workbench_stages r \
  --calibration /abs/calibration.json --out /abs/new-R
.tools/venv/bin/python -m tools.animation_pipeline.workbench_stages h \
  --input /abs/new-R --out /abs/new-H
.tools/venv/bin/python -m tools.animation_pipeline.workbench_stages h-static \
  --input /abs/accepted-C.png --target-name npc_example.png --out /abs/new-H-static
```

适配器只写新目录，目标存在即失败；H/H-static 都是 staging-only，并拒绝把 runtime 目录当输出。
H-static 对 C PNG 做逐字节副本，目标名来自人在工作台明确配置的 `staticTargetPath`，绝不按角色名猜。
生成后由
Agent 用 `workspace_cli.mjs submit` 提交，由人审查。发布是审查后的外部显式动作；完成后 Agent
可用 `record-publication --receipt <json>` 登记哈希回执，回执登记本身不会复制或覆盖文件。

## 旧动画迁移

```bash
node tools/anim_preview/migrate_legacy.mjs --help
node tools/anim_preview/migrate_legacy.mjs dry-run --compact
node tools/anim_preview/migrate_legacy.mjs apply --confirm-copy-only --compact
```

迁移严格 copy-only：不 move、不 delete、不 overwrite。只映射有直接证据的 A (`setup.png`)、
D (`<action>.mp4`) 和 H（已发布 bundle 的逐字节副本）；B/C/E/F/G/R/H_STATIC 明确 unavailable。
已发布但没有可靠角色映射的 bundle 进入 `已发布存量_<bundleId>` 独立工作区，不猜角色身份。
旧 H 只是 legacy baseline，不是新图 head。apply 前后会比较排除工作台目录后的完整源树哈希；
命令可重复执行，第二次只能复用同一 migration revision。

## 落盘布局

```text
tmp/原始素材/<中文角色>/animation-workbench/
  workspace.json
  agent-context.json
  agent-context.md
  objects/sha256/...       # 内容寻址，不重复存相同字节
  revisions/<node>/<rev>/  # immutable artifact + revision.json
  drafts/calibration.json
  checkpoints/
```

不要手工编辑或清理该目录。原始 `setup.png`、视频和已发布 bundle 都是只读来源；迁移只在上述
受管目录创建副本。

动画 H 的目标由 `bundleId` 精确绑定到 `public/resources/runtime/animation/<bundleId>/`；静态
H-static 的目标必须由人在 IDE 明确填写为 `public/resources/runtime/images/**/*.png`。任一目标未配置时
对应导出节点保持 blocked。修改目标、动作规格或阶段 epoch 都会保留历史并重算依赖。
