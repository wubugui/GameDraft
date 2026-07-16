# GameDraft Godot Port

这是把现有 TypeScript/Pixi 完整运行时逐项复刻到 Godot 4 的独立工程。Godot 与 TypeScript 读取同一套 JSON 和媒体，禁止维护第二份内容数据。

## 当前状态

逻辑/事件/存档/固定时钟强 parity 当前为 0 字段差异；Action 101/101、Condition 9/9、图对话节点 7/7、Cutscene present 16/16 及其余登记能力 strict coverage 均为 0 missing。20 个过场、27 个场景、36 个动画 manifest、四类小游戏、22 场景真实玩家路径和双向真实存档往返均有测试。叙事图/状态改名迁移、悬垂信号留痕、对话视图和四类小游戏内部状态也进入双端合同。747 个共享文件按 hash 重建导出镜像；macOS universal 包已真实启动，Windows x86_64 包已完成 PE/PCK/资源校验。

表现层不再用“看起来差不多”描述：代表动态场景、全部 27 个场景的静态装载态、`fadeWorldFromBlack` 五个 alpha 关键帧、6 组真实对话推进态、四类小游戏代表运行态均有无损截图 SSIM 门禁，且对话/小游戏内部状态同时比较；实际 BGM 包络也有跨壳墙钟归一采样门禁。仍待外部/逐帧签字的是跨引擎字体与低通核的位级像素差异、全部过场和小游戏完整时间线、离线 PCM waveform，以及 Windows 原生机运行。详见 `artifact/Reviews/Godot运行壳完全对齐复审-2026-07-13.md`。

早期 `scripts/main.gd`、`narrative_store.gd`、`dialogue_runner.gd` 等可行性样机因存在永真条件和动作缩水实现已经移除。当前工程只保留按 TypeScript 权威语义重建并有测试的正式骨架。

## 运行

```bash
/Applications/Godot.app/Contents/MacOS/Godot --editor --path godot_port
```

也可以在 Godot Project Manager 中导入 `godot_port/project.godot`，然后按 F6/F5 运行。

操作：WASD/方向键移动，Shift 奔跑，E/空格互动，F5 快速保存，F6 快速读取。

无界面全量回归：

```bash
python3 godot_port/tools/run_tests.py
npm run test:godot-visual-parity
npm run test:godot-scene-visuals
npm run test:godot-fade-visuals
npm run test:godot-dialogue-visuals
npm run test:godot-minigame-visuals
```

## P0 已完成

- 101/9/7/16/26/25/11/3/4 权威能力面盘点。
- Action 参数、场景字段、数据表字段、存档键与资源引用图合同。
- 35 个运行时命令的生成合同与 32 字段快照 Schema。
- 一条脚本同时驱动 TypeScript 与 Godot，验证协议并输出逐字段差异。

```bash
python3 godot_port/tools/build_runtime_contracts.py
python3 godot_port/tools/parity_runner.py godot
python3 godot_port/tools/parity_runner.py run
python3 godot_port/tools/run_tests.py --full-parity
python3 godot_port/tools/build_exports.py
```

## 完成定义

只有 101 个 Action、9 类条件节点、7 类对话节点、16 类过场 present、26 个系统、25 个 UI、11 个渲染类、3 个实体类和 4 个小游戏全部通过契约/行为/视觉验证，双壳存档互通，macOS 与 Windows 包在干净机器运行，并且 strict coverage 与 parity 差异清零后，才算迁移完成。

## 目录原则

Godot 工程只写 `godot_port/`。现有 TypeScript 运行时和内容 JSON 继续作为迁移期间的权威源，避免两套内容立刻分叉。
