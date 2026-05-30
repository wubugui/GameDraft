# CI / Workspace 一键检查链小计划

## 目标

把主入口工具链纳入一键检查，让 content build、diagnostics、LSP smoke、VS Code extension compile、simulator tests 和 runtime compatibility tests 都能统一运行。

---

## 范围

本计划覆盖：

```text
1. content build。
2. diagnostics-json。
3. LSP smoke。
4. VS Code extension compile。
5. simulator tests。
6. runtime compatibility tests。
7. workspace 一键命令。
8. CI workflow 接入。
```

本计划不覆盖：

```text
1. 每个工具内部的完整实现。
2. 真实内容迁移。
3. Webview 功能开发。
```

---

## 前置依赖

```text
1. 每个子工具有可脚本化入口。
2. package scripts 或 workspace command 可扩展。
3. CI 环境能安装依赖并运行 Node / extension 编译。
```

---

## 任务清单

### T1. 梳理现有命令

列出现有入口：

```text
1. content build。
2. diagnostics-json。
3. LSP 启动或 smoke。
4. VS Code extension compile。
5. simulator tests。
6. runtime compatibility tests。
```

### T2. 补缺失命令

为缺失部分补：

```text
1. npm script。
2. workspace script。
3. smoke test runner。
4. JSON report 输出。
```

### T3. 统一一键命令

建议命令：

```text
npm run check:content-toolchain
```

执行顺序：

```text
1. content build。
2. diagnostics-json。
3. simulator tests。
4. runtime compatibility tests。
5. LSP smoke。
6. VS Code extension compile。
```

### T4. 统一报告

输出：

```text
1. 每步开始和结束。
2. 每步耗时。
3. 失败命令。
4. 失败摘要。
5. artifacts 路径。
```

### T5. 接入 CI

添加或扩展 workflow：

```text
1. 安装依赖。
2. 运行一键命令。
3. 上传 diagnostics / trace artifacts。
4. PR 上显示失败阶段。
```

---

## 输出物

```text
1. check:content-toolchain 命令。
2. LSP smoke 命令。
3. simulator tests 命令。
4. runtime compatibility tests 命令。
5. CI workflow。
6. 检查报告 artifacts。
```

---

## 验收标准

```text
1. 本地一条命令可以跑完整链路。
2. 任一步失败都会返回非零退出码。
3. 失败摘要能定位到阶段。
4. CI 能运行同一条链路。
5. diagnostics / trace artifacts 可下载或查看。
```

---

## 风险点

```text
1. extension compile 和内容检查依赖环境不同。
2. simulator tests 可能因为内容波动不稳定。
3. 一键链路过慢时需要拆 fast / full 两档。
```

