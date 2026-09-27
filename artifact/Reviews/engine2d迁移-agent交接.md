# engine2d / RHI 迁移 · 本机 agent 交接(2026-09-27 更新)

> 给接手的 agent 读。**先读第 0 节(最新进度)和第 0.5 节(下一步)**,第 1 节起是原有规矩与背景,仍然有效。
> 逐轮审查细节见 `artifact/Reviews/engine2d迁移审查-2026-09-25.md`。

## 0. 最新进度(2026-09-27,制作人本机 Windows / Intel Iris Xe / 10 GB 内存,机器到期前停在这里)

分支 `claude/festive-cray-g72t2o` 已推送。制作人本轮要求:**合并 master,之后游戏跑出来的结果必须与 master 一模一样**
(画面、逻辑、玩法、UI 全部),只动这个 worktree,不碰主工作区。

**已完成**
- **合并 master**(`df4ac78`,含 origin/master `86571649` / `0faee8d`):master 新效果全部补了 WGSL——场景前景层覆盖图
  (`foregroundMaskWgsl.ts`)、三支实体遮挡滤镜与四套粒子程序的前景取样、接触阴影胶囊 AO、雷身不被前景挡等;孪生守门已登记。
- **第 5 轮静态审查**(6 片,工作流 `.claude/workflows/engine2d-migration-review-serial.js`:分片串行、核实串行、显式 model,适合 10 GB 机器)确认 5 条低级别,已处理:
  GC 重传读采样现值对齐 master(`d565a88`);RT gather 噪声种子;render_parity 钉 RT gather 旋转;
  多 pass 模糊对齐见下;LitBackground 雾用 q 空间量(**master 同样如此,未改,等制作人定**)。
- **D23 对齐 master**(HTMLText 生成中途改字丢掉,同 Pixi)。
- **带素材的整局 A/B:36 个场景全部与 master 逐像素一致**(阈值 1、噪声 0)。途中查出并修掉的真差异:
  1. 画布半像素水平边差一行(对白框 / UI 边框 / 调试网格):画布改为照 WebGL 自下而上画进中间纹理、帧末翻转上屏(`b470a3b`);
  2. 多 pass 模糊中间 pass 改走 Pixi 的 **WebGL** 分支(不清屏、关混合覆盖写),投影阴影下沿对齐(`263c34c`、`a8064b5`);
  3. 光柱噪声哈希第一步按融合乘加精确算(master 的 FXC mad),义庄光柱 6 级 → 0(`0144ec2`)。
  另查实:茶馆 / 崖墓几场 / 跑马梁此前的大差异来自 **master 冷缓存下 WebGL 首绘卡 9–13 s、粒子预热 8 s 限时被墙钟耗光**,
  不是本分支问题——对照工具已加 `--warm`(热缓存预热)解决。
- **对照工具 `tools/ab_compare` 大幅扩充**:`feature`(71 项游戏功能:时段外观 / 燃烧 / 落雷 / 特效 / 呼吸 / 镜头 / 闪屏黑场 /
  实体 / UI 面板 / 商店 / 前景层 / 走动)、`mainline`(主线 18 拍按故事顺序逐拍推进 + 整链,拍末打开背包 / 任务 / 规矩 / 书架 /
  地图 / 日志 / 菜单)、`--list`(不起任何东西,对 master 逐项校验引用)、`--warm`、`--freeze pump`(锁步装载:
  游戏一出现就冻逻辑并停假时钟,装载期由驱动方逐帧推;牛头凼 / 跳转点这类装载期要跑逻辑的也能确定性启动)。
  `--freeze pump` 验收:牛头凼、茶馆 A/A、B/B 噪声 0,A/B 0.000%(`fec6a3a`)。
- 真机检查:rhi_smoke 全过;engine2d_parity 36/36;tsc 零错;vitest 307 文件 4267 用例全过;
  编辑器 pytest 除 1 条外全过(那条 master 同样失败,见下);validate-data 与 master 同一批 42 个数据错误(都是 master 已有的内容问题)。

## 0.5 下一步(按顺序,一次只跑一项——10 GB 内存同时跑多个会卡死整机,已发生过一次)

统一参数:`export PLAYWRIGHT_CORE=<playwright-core 包目录>`(仓库不装,`npm i --prefix <任意目录> playwright-core`),
`node tools/ab_compare/run.mjs --warm --freeze pump --threshold 1 --keep-raw ...`。
大批量可以加 `--repeats 1`(每侧一局,省一半时间);`--freeze pump` 已证明两侧各自噪声为 0。

1. **主线 18 拍**:`--only mainline`(或 `--beats 听书,...` 分批)。本轮只试跑过「听书」(旧的 ready 冻结下,游戏状态与
   拍末 7 个 UI 面板全部一致,过场中段的雾粒子差异是装载快慢造成的——改用 pump 后应归零,**未复跑**)。
2. `--only cutscene`(32 段)、`--only minigame --minigames all`、`--only npc`、`--only feature`(71 项)、`--only warp`、
   `--only resize,dpr`。
3. 每个超出噪声的差异:先看 `raw/<项>/{A1,B1}/*__canvas.png` 与 run.json 的 probe;状态一致而画面不同 → 渲染差异,追到代码修,
   补「修前失败、修后通过」的回归测试;两局都要在热缓存 + pump 下复跑确认。
4. 之后:T1 宿主(第 3 节;Tauri 打包版本机没有 Rust 工具链,没测)、T5 真显卡性能(`--perf`)、收尾全量门。

**等制作人定的事**
- LitBackground 雾用 q 空间高度 / 距离(违反铁律 0),**master 同样如此**,对齐 master 就没改;要修是单独一件事。
- master 自身的问题(不是本分支引起,未改):`tools/editor/tests/test_held_prop_editor_surfaces.py` 的过场白名单用例
  (master 把 setPropState 加进白名单没同步用例);义庄出口指向的出生点 `from_yizhuang` 在雾津街头不存在;
  validate-data 的 42 个数据错误(test_room_a 连通性、eco_眼力 / eco_风评 未登记等)。
- 光柱融合乘加的修法依赖「GPU 的 mad 是融合的」(Iris Xe / 多数现代卡是);在不融合的卡上 master 自己会变,本分支按融合算。

**环境坑**
- worktree 没有自己的 DVC 缓存:`.dvc/config.local` 把缓存指到主工作区 `D:/GameDraftNew/GameDraft/.dvc/cache`;
  拉对象用 `python scripts/sync-dvc-cache.py --root <主仓> pull <worktree 里 .dvc 的绝对路径…>`(注意 `--root` 要放在 pull 前)。
- worktree 的 Python venv 用主仓 `.tools/Python311` 建;装依赖要 `PYTHONUTF8=1`(requirements 有中文注释);编辑器测试还缺
  `numba==0.67.0 llvmlite==0.49.0 networkx`,要另装。pytest 收尾会被 conftest 看门狗强退,看结果用 `-v` 找 FAILED 行。
- 子代理默认模型在这台机器上配错(minimax),工作流 / Agent 一律显式 `model: 'opus'`。
- `tmp/review/` 下的审查复现会被主 vitest 扫进去,审查完要删。
- 对照的 A / B 树在 `.tools/ab/`,B 树按提交建;主工作区未提交的改动不在 B 里。

## 1. 制作人定的规矩(违反 = 返工)

- **不在 master 上动。** 一律在这个分支上工作;自动测试的对照对象就是 master。
- **只要 WebGPU,不做 WebGL2 回落。**
- **数据格式绝对不准碰。** `public/` 下的 JSON、各工作区的文件格式都不改。
- **编辑器不能动。** 例外只有两个:anim_preview 和 parallax_editor 已获批迁到 engine2d。
  其余编辑器(`tools/editor/**` 等 PyQt 工具)一律不改;如果非改不可(例如给 Qt 宿主加 WebGPU 启动参数),先停下来问制作人。
- **和 master 对照,必须两个分支各自独立跑起来比**,不许把 master 的代码拿进本分支比。
  现成工具是 `tools/ab_compare`。`tools/render_parity` 只能当着色器单元级的辅助检查,不算对照证据。
- **修复做完之前不跑 A/B**:改了代码,之前的 A/B 结果就作废。先把代码改完、审完,最后跑一次完整 A/B。
- **不许自己写 flag**,做内容走叙事状态机(见 CLAUDE.md)。本任务本来就不涉及内容。
- **独立模块交给子代理做**;子代理在 git worktree 里提交的东西,由你 cherry-pick 回来。

## 2. 开工前准备

```
git fetch origin && git checkout claude/festive-cray-g72t2o && git pull
dvc pull                      # 素材:public/resources/runtime 等
./bootstrap.sh                # Python venv(validate-data / 素材审计 / 编辑器 pytest 要用)
npm ci
```

- **playwright-core** 仓库不装。装到任意目录,例如 `npm i --prefix D:\pw playwright-core`,然后把 `PLAYWRIGHT_CORE` 指到它的包目录。
  浏览器类工具都读这个环境变量:ab_compare、rhi_smoke、engine2d_parity、render_parity。
- **`pixi.js` 故意留在 devDependencies**,只给对照测试当参照。运行时代码不许 import 它,有守门测试 `src/engine2d/noPixiInRuntime.test.ts`。

## 3. 按顺序要做的事(每项都有验收标准)

### T1【P0】宿主能不能跑 WebGPU:只能在本机验

渲染只有 WebGPU,下面每个宿主都要**真启动游戏**,确认画面出来、F2 日志里没有 RHI 报错:

| 宿主 | 入口 | 注意 |
|---|---|---|
| 打包版(Tauri / WebView2) | `src-tauri`,地址 `http://gamedraft.localhost/` | WebView2 默认应带 WebGPU;确认是安全上下文 |
| 编辑器内嵌预览(QtWebEngine) | `tools/editor/editors/game_browser.py` | 编辑器代码,改之前要问 |
| 桌面壳 | `tools/desktop_shell.py` | 同上 |
| 场景工作台 | `tools/scene_workbench/app.py` | 同上 |
| 发布验收扫描 | `python -m tools.build.scene_sweep`(`scripts/release.mjs` 缺省会跑) | 已改成放开 WebGPU、不再藏 `navigator.gpu`,但**没在 Qt 下实测过** |

- 已知风险:2026-09-06 实测**离屏** QtWebEngine 6.11 建 WebGPU 上下文失败,真窗口下还没验证过。
- 起不来的话,把宿主、错误原文和尝试过的启动参数(如 `--enable-unsafe-webgpu`)报给制作人,**不要自己改编辑器**。
- 验收:五个宿主都能进游戏、切一次场景、开一个 UI 面板,都不报错。

### T2 D23:请制作人拍板

HTMLText 在生成纹理期间文字又被改了(打字机字幕逐字更新时会出现):
- master(Pixi):丢掉这次改动,末尾的字可能不显示;
- 本分支:补生成一次。

二选一:对齐 master,或者登记为已知差异(写进 engine2d 卡「与 Pixi 的已知差异」)。
代码在 `src/engine2d/text/html/HTMLText.ts`,生成期间变更的那段处理。

### T3 第 5 轮审查(静态),直到收敛

用已入库的工作流 `.claude/workflows/engine2d-migration-review.js`(`Workflow({ name: 'engine2d-migration-review', args })`),参数:

- `repo`:仓库绝对路径。
- `master`:master 的**只读**检出路径。可以用 A/B 工具建的 `.tools/ab/A-<sha10>`,或者自己 `git worktree add --detach .tools/master-ro origin/master`。
- `customSlices`:`[{key, focus}]`。云端计划中、还没跑的第 5 轮是这 4 片:
  1. `r5-fix-review`:审第 4 轮的修复(`git log ff1ee36..HEAD`)。
  2. `r5-filters-deep`:所有游戏滤镜经 FrameBuilder 的完整数据流,和 Pixi FilterSystem 逐值对照。
     涉及 CharacterShading、EntityLighting、DepthOcclusion、BackgroundDebug、Burn、Water×2、contactAo、WorldFilterPipeline / FilterLoader。
  3. `r5-lighting-glue`:光照 / 阴影 / probe 的 TS 胶水代码和 master 的差异(RT 格式、尺寸、清屏、资源与采样器成对、销毁)。
  4. `r5-ui-paths`:UI 组件的实际调用路径,在 node 里和 Pixi 并排对照(包围盒、中文换行、遮罩、hitArea、事件序列、光标)。
- `extraFocus`:写明这一轮只做静态审查(不开浏览器、不起服务),已知问题见 `.claude/review-repros/engine2d-r{1..4}/findings.json`,不要重报。

规则:
- 审出的问题先把复现改写成 `src/` 下的正式回归测试,**确认它失败**,再修,**确认它通过**。
- 连续两轮没有新的确认项才算收敛。
- 严重度逐轮下降:第 1 轮严重和高 → 第 2 轮高 → 第 3 轮中 → 第 4 轮只剩低。

### T4 带素材的完整 A/B(代码定稿后跑一次)

```
node tools/ab_compare/run.mjs                        # 全部场景,很久;可以先用 --scenes / --only 分批
node tools/ab_compare/run.mjs --dpr 2 --only scene,dpr
node tools/ab_compare/run.mjs --perf --only scene --repeats 1
```

- 工具会为 A(`origin/master`)和 B(HEAD 提交)各建一棵独立工作树,各自 `npm ci`,并把本机的素材目录链进两边。
- 判读方法:
  - 以**画布层**为准。整页层混着 dev 报错面板的顺序噪声。
  - 差异 ≥95% 能用 ±1 行位移解释的,是已知的 WebGL / WebGPU 半像素横边差异,可以接受(`--ignore-row-shift` 就是这个口径)。
  - 出现「状态分歧」时,加 `--freeze boot` 复核。多半是两边加载快慢不同造成的,不是真差异。
- **重点看云端没比到的**:光照(日 / 夜时段外观、实体灯、probe)、阴影、GI、燃烧、呼吸、VFX(粒子 / 光柱 / 雷)、原画和精灵、物件查看的接触 AO(高倍放大 + 2 倍 DPR)。
- 验收:本分支没有 master 没有的报错;所有画布差异都属于已知差异类;报告交给制作人过目。

### T5 真显卡性能

- 用 `--perf` 看帧时间和 JS 堆。云端 SwiftShader 的结论是:帧时间卡在 GPU 那一侧;engine2d 每帧 JS 渲染时间约为 master 的 2 倍(约 2.0 ms 对 0.9 ms),原因是每帧重建指令。
- **重点**:文字画布走 `copyExternalImageToTexture` 上传,在 SwiftShader 下会同步卡主线程 110–140 ms。要在真显卡上看对话打字机逐字出字卡不卡。
  卡的话,可以考虑合并上传或改上传路径;改完要保持输出字节不变。
- 云端高负载时,dev_room 以 2 倍 DPR 跑 A/B 出现过「推进 1 帧超时」,空闲机器上没能复现,在真显卡上确认一下。

### T6 收尾全量门

- validator 子代理:tsc、vitest、validate-data、素材审计、编辑器与对话图 pytest。
  - vitest 唯一允许的失败是 `scripts/lib/build_helpers.test.mjs` 的「拒绝盘符根」,master 上同样失败。
- `node tools/engine2d_parity/run.mjs`:要求 36/36 逐位一致。最后一批(第 4 轮)修复之后还没重跑。
- `node tools/rhi_smoke/run.mjs`:要求全部通过,含 MSAA、mip、坏管线、设备丢失这几个用例。
- 两个编辑器真机打开检查:`tsc -p tools/anim_preview`、`tsc -p tools/parallax_editor/tsconfig.json`、`npm run test:anim-preview`。
- 过门后执行 `sh scripts/py.sh scripts/agent_hooks/validation_gate.py --mark <session>`,然后推送。**合并由制作人决定**。

## 4. 东西在哪

| 内容 | 位置 |
|---|---|
| 逐轮审查结论与第二轮起的任务 | `artifact/Reviews/engine2d迁移审查-2026-09-25.md` |
| 每轮的完整记录与复现 | `.claude/review-repros/engine2d-r{1,2,3,4}/`(`findings.json` + 用例) |
| 跑复现 | `npx vitest run --config .claude/review-repros/vitest.config.mts <路径>`。写法不统一:有的写成「偏差存在就通过」,修好之后变红是正常的 |
| 审查工作流 | `.claude/workflows/engine2d-migration-review.js`(支持 `slices` / `customSlices` / `extraFocus`) |
| A/B 工具 | `tools/ab_compare/`(README 写了方法与局限) |
| RHI 真机冒烟 | `tools/rhi_smoke/`(`--headed`,Linux 另加 `--swiftshader`) |
| engine2d 对 Pixi 逐位对照 | `tools/engine2d_parity/` |
| GLSL / WGSL 孪生守门 | `src/rendering/shaderTwins.test.ts`:工作台编 GLSL,游戏画 WGSL,两份要一起改 |
| 机制卡 | `agent_docs/runtime/mechanisms/{engine2d,rhi,scene-hierarchy}.md` |

## 5. 踩过的坑(别再踩)

- **别 `git add -A`。** 子代理的 worktree 里 `node_modules` 是软链接,混进提交就会把真正的依赖目录顶掉。只 add 明确的路径,提交前看一眼 `git status`。
- **子代理 worktree 的起点可能是 master。** 让它先 `git reset --hard <当前 HEAD>` 再动手;合并时 cherry-pick,并检查提交里有没有 `node_modules`、`tmp/`、`public/`、`tools/editor` 这些不该有的路径。
- **`tmp/review/` 下的复现会被主 vitest 扫进去**(主配置只排除了 `**/.claude/**` 和 `**/.tools/**`),弄完要挪走或删掉。
- **两个 dev 服共用一份 `node_modules/.vite` 会互相判对方的预构建过期。** A/B 工具已经让每棵树用各自的依赖。
- **Linux 无头 Chromium 的 WebGPU 一上屏就丢设备**,要有头运行加 `xvfb-run`,并带 `--enable-unsafe-webgpu --enable-features=Vulkan --use-vulkan=swiftshader`。Windows 真机不需要这些。
- **A/B 工具在 Windows 上还没实测过**(`npm.cmd`、junction、`taskkill`、Chrome 起不来时退到 Edge),第一次先小范围跑。
- **不要用 `pkill -f <含自身命令的模式>`**,会把自己的 shell 杀掉;改用 `ps | grep | awk | xargs kill`。
