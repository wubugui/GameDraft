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
| `scripts/sample_arrows.mjs` | 从页面上画出的全部箭头里按种子随机抽 15 条 → `data/sample.json` |
| `scripts/build.mjs` + `page_template.html` | 校验全部出处、内嵌被引用的源码行,生成 `index.html` |
| `diagrams/*.json` | 图 2~6(启动 / 一帧 / 场景生命周期 / 状态与存档 / 渲染管线)与清单(文档对不上 / 已关停 / 抽不准)的数据。由代理照代码逐行整理、另一代理独立复核,每个节点都带出处,构建时逐条校验 |
| `data/verification.json` | 15 条抽样箭头的回代码核对结果 |

## 重新生成

需要 Node 18+ 和仓库 devDependency 里的 `typescript`(`npm install` 之后即有;也可用环境变量 `TYPESCRIPT_PATH` 指到任意一份 `node_modules/typescript`)。

```sh
node runtime_map/scripts/extract.mjs          # → data/raw.json
node runtime_map/scripts/analyze.mjs          # → data/analysis.json
node runtime_map/scripts/outline.mjs --preset # → data/outlines.json
node runtime_map/scripts/check_cites.mjs runtime_map/diagrams/*.json
node runtime_map/scripts/build.mjs            # → index.html(有任何一条出处对不上就拒绝生成)
```

代码一改,`diagrams/*.json` 里的行号可能漂移:`build.mjs` 会逐条报出对不上的出处和最近的匹配行。
模块总图、客观异常、事件、动作注册表这些部分完全由脚本从代码算出,重跑即更新。
