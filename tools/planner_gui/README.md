# GameDraft Graph 工作台

独立 Python GUI，定位是“策划验收入口”，不是内容编辑器。

内容编辑仍然放在 VS Code / YAML 里完成；这个窗口只负责把检查、模拟、诊断和结果集中起来。

## 启动

从仓库根目录运行：

```powershell
npm run planner:gui
```

或者双击：

```text
tools/planner_gui/start_planner_gui.cmd
```

## 主界面

界面分成三块：

```text
左侧：工作流按钮
右上：当前状态摘要
右下：Build / 问题列表 / 关系诊断 / 命令日志
```

日常只需要：

```text
1. 一键完整检查
2. 模拟默认流程
3. 选择模拟案例
```

常用验收入口放在右侧分页：

```text
Build：Build Content / Validate Content / 一键完整检查
问题列表：刷新诊断列表 / 复制问题 / 打开问题文件
关系诊断：Signal / Flag / Quest / Dialogue / Runtime Trace 统一查看，另带 Content Index / Trace Resolve
```

低频命令放在 `其它命令` 下拉里：

```text
content:render
content:runtime-compatibility
content:lsp-smoke
content:simulate summary
content:simulate case...
content:explain summary
content:explain case...
content:trace-resolve file...
新建 dialogue YAML 模板...
新建 narrative YAML 模板...
新建 quest YAML 模板...
content:check
project:test
project:build
narrative-editor:build
vscode-extension:compile
```

`watch` 是长驻监听命令，不放在 GUI 验收面板里，避免窗口被一个不会结束的进程占住。

新建 YAML 模板会直接弹保存位置：

```text
先输入显示名称，不输入 id。
工具会根据显示名称自动生成不重名 id。
同名时会自动追加 _2 / _3。

然后选择模板：
dialogue：基础对话 / 选项对话 / 动作对话
narrative：基础状态机 / 信号切状态 / 进入状态执行 actions
quest：基础任务 / 条件任务 / 后续任务

dialogue：默认从 authoring/dialogues 开始，可选 npc / scenario 子目录。
narrative：默认从 authoring/narrative 开始，可选 flows / npc 子目录。
quest：默认从 authoring/quests 开始，可选 side 等子目录。
```

如果目标文件已存在，会先弹确认；确认后才会覆盖。模板不能保存到对应根目录之外。

## 复制问题

```text
问题列表：
  复制选中问题
  复制全部问题

命令日志：
  复制选中
  复制全部
  保存日志...
```

日志会按颜色区分：

```text
红色：error / failed / exception
黄色：warning
绿色：ok / success
蓝色：命令行
灰色：结构性 JSON
```

模拟、条件解释、诊断、Runtime 兼容性这几类命令默认只显示摘要。

```text
模拟摘要会显示：
  是否成功
  是否阻断
  走过的路线
  玩家选择
  关键状态变化
  事件数量
  诊断数量

完整 JSON 不直接刷屏，保留在 artifact/content_pipeline/ 下。
```

## 注意

```text
1. 不在 GUI 里堆具体内容文件。
2. 要改内容，打开 authoring 源目录后回到 VS Code 编辑 YAML。
3. 不要手改 artifact/ 或 public/assets/ 生成物。
4. 地图 picker、polygon/route 编辑、Graph reference Webview 仍然在 VS Code 扩展里。
```
