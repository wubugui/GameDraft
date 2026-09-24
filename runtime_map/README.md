# runtime_map — 运行时引擎结构图

双击 `index.html` 打开。页面数据全部内嵌,不读本地文件;字体走 Google Fonts,断网时退回系统字体,图照常显示。

## 目录

| 路径 | 是什么 |
|---|---|
| `index.html` | 成品页面(由 `scripts/build.mjs` 生成,别手改) |
| `scripts/extract.mjs` | 机械抽取:TypeScript 编译器 API 解析 `src/`(不含 `*.test.ts`),抽 import / new / 字段持有 / 事件总线收发 / 动作注册 / 状态切换 / 帧钩子 / 动态分发点 → `data/raw.json` |
| `scripts/analyze.mjs` | 在 `raw.json` 上纯计算:大块归属、块间连线、循环依赖、分层方向、事件配对、调试代码引用、最大文件 → `data/analysis.json` |
| `scripts/blocks.mjs` | 12 个大块 + 边界块的划分规则(目录 / 文件名正则)与分层定义 |
| `scripts/outline.mjs` | 函数调用序列提取(按源码先后列每次调用,带行号、嵌套与分支条件)→ `data/outlines.json` |
| `scripts/check_cites.mjs` | 出处校验:每条 `{f, l, m}` 出处要求第 `l` 行逐字包含 `m` |
| `scripts/sample_arrows.mjs` | 从页面上画出的全部箭头里按种子(代码版本)分层随机抽 15 条 → `data/sample.json` |
| `scripts/assemble_verification.mjs` | 把独立代理逐条回代码核对的结果(`data/sample_checks.json`)与脚本机械复核合成 `data/verification.json` |
| `scripts/build.mjs` + `page_template.html` | 校验全部出处、内嵌被引用的源码行,生成 `index.html` |
| `diagrams/*.json` | 图 2~6(启动 / 一帧 / 场景生命周期 / 状态与存档 / 渲染管线)与清单(文档对不上 / 已关停 / 抽不准)的数据。由代理照代码逐行整理、另一代理独立复核,每个节点都带出处,构建时逐条校验 |
| `data/sample_checks.json` | 15 条抽样箭头各由一个独立代理回代码核对的原始结论 |
| `data/verification.json` | 抽样核对汇总(代理核对 + 脚本机械复核),页面"抽样核对"页与每页页脚即据此 |

## 页面里有什么

1. 模块总图:12 个大块 + 开发·调试边界;依赖 / 事件 / 创建 / 仅类型 四种线可分别开关;点块下钻到文件级。
2. 启动:main.ts → 第一帧,12 个阶段逐步展开,标出 await / 并行 / 发出不等。
3. 一帧:Game.tick 逐条更新顺序(带行号)+ 10 种游戏状态 × 各系统的开停矩阵,可按状态筛。
4. 场景生命周期:切场景的泳道时序(谁在做、异步在哪),入口、事件、场景记忆。
5. 状态与存档:状态住在哪、归谁、进不进存档;存 / 读档的实际步骤;存档对象的每个键;没进存档的运行时状态。
6. 渲染管线:每帧从 tick 到画面的泳道(CPU / GPU 离屏 / GPU 主渲染),读写的贴图与缓冲,显示树,加载期准备,已关停路径。
- 客观异常(最大 20 文件、循环依赖、分层违例、事件有发无收 / 有收无发、正式路径引用的调试代码)、抽不准的地方、文档与代码对不上、已关停、抽样核对。

## 重新生成

需要 Node 18+ 和仓库 devDependency 里的 `typescript`(`npm install` 之后即有;也可用环境变量 `TYPESCRIPT_PATH` 指到任意一份 `node_modules/typescript`)。

```sh
node runtime_map/scripts/extract.mjs          # → data/raw.json
node runtime_map/scripts/analyze.mjs          # → data/analysis.json
node runtime_map/scripts/outline.mjs --preset # → data/outlines.json
node runtime_map/scripts/check_cites.mjs runtime_map/diagrams/*.json
node runtime_map/scripts/sample_arrows.mjs    # → data/sample.json(需要重新核对时)
node runtime_map/scripts/assemble_verification.mjs  # 需先有 data/sample_checks.json
node runtime_map/scripts/build.mjs            # → index.html(有任何一条出处对不上就拒绝生成)
```

代码一改,`diagrams/*.json` 里的行号可能漂移:`build.mjs` 会逐条报出对不上的出处和最近的匹配行。
模块总图、客观异常、事件、动作注册表这些部分完全由脚本从代码算出,重跑即更新。
