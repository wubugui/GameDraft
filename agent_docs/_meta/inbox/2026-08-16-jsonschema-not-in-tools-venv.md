---
target: json-lang-schema-tooling
date: 2026-08-16
session: json_lang 补 posture/timePhase 条件叶 schema 建模(Windows 机)
---

# 本台 Windows 机的 .tools/venv 缺 jsonschema(与机制卡口径相反)

- **现象**:机制卡与 build.py 提示都说「--validate 需 jsonschema 包(在 .tools/venv)」;
  本机(Windows)`.tools/venv/Scripts/python.exe` 跑 `--validate` 输出「跳过:当前
  python 环境没有 jsonschema」,反而宿主 `python`(Python310)装了,能真校验。
- **限定**:`.tools/` 不入库、venv 每台机器各建——这可能只是**本机 venv 建漏了**,
  Mac 侧 venv 未必有此问题;修复方向优先「查 venv 依赖清单/重建脚本是否含 jsonschema」,
  而不是改机制卡。
- **影响**:在缺包的机器上照卡片用 venv 跑收尾门会静默降级成"没校验",误以为数据全过;
  且本机宿主 pytest 坏(logfire 插件 + 缺 xdist)、只能用 venv 跑测试——两个解释器各半套。
