# ChronicleSim v2

编年史模拟器 v2 — 完全重构版。

## 架构

- **零 SQLite** — 所有状态用 JSON/MD 文件 + ChromaDB 向量检索
- **Agent 独立** — 各槽位使用 CrewAI（单 Agent + Task）与 LangChain 工具调用文件/Chroma
- **文件即数据库** — 每个 run 是一个文件夹，内容可直接阅读、grep、git 版本控制
- **NPC 分层** — S 类独立 Agent、A 类共享模型但独立运行、B/C 类统一群演

## 运行

```bat
pip install -r tools\chronicle_sim_v2\requirements.txt
python -m tools.chronicle_sim_v2
```

## 流程

1. **设定库** — 录入灵感、导入 MD 文件
2. **种子编辑** — 从设定库生成或手填种子，写入世界
3. **模拟** — 按周推进，NPC 驱动事件发展
4. **编年史** — 浏览、搜索、导出模拟结果
