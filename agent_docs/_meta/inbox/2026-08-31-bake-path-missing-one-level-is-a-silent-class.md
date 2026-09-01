---
target: scene-lighting
date: 2026-08-31
session: 光照烘焙管线收束到单一工具/单一目录
---

现象：烘焙产物 2026-08-30 改成按背景图名分目录（`lighting/<背景基名>/…`）之后，**四处**消费方的路径少写了那一层。四处的共同表现是**不报错**：`fnmatch`/正则/`Path` 拼接都合法，只是匹配到空集或落到不存在的路径，然后各自"优雅降级"了过去。①`tools/build/manifest_rules.json`：`lighting/<文件名>` 匹配 0 条 ⇒ **probe 载荷一个都没进过发行包**（release 清单里 `/lighting/` 下 0 个文件）；②`scripts/verify_build.mjs` 的 `checkBakeFreshness`：正则同样少一层 ⇒ 过滤后为空 ⇒ 打印"没有角色光照载荷，跳过"，那道**新鲜度门一直在空转**；③`tools/editor/editors/scene_lights.py` 的 `wu_per_q`：读不到就 `except` 回落 **1.0**，而真值逐场景 154–880 ⇒ 编辑器里摆灯的世界尺度差三个数量级；④`tools/character_lighting_lab/audit_depth.py`：对 **28/28** 个场景一律报「缺 lighting/」——全量误报，等于这道门也没了。同期 `audit_walkable.py` 写对了（它按背景图名推），所以四处坏、一处好，肉眼看不出是一类问题。

证据：本次收束时逐条实测并修复。修复前后：release 清单 `/lighting/` 下 0 → 232 个文件（8 类 × 29）；`audit-depth` 28 张有问题 → 0；`SceneLightSpace('雾津街头').wu_per_q` 1.0 → 880.0。新增护栏 `tools/build/tests/test_asset_manifest.py::test_光照载荷规则必须匹配磁盘上的真实布局`——它对着**真实磁盘**验而不是对着规则字符串验。

建议：这不是四个 bug，是一个**缺陷类**：「派生产物的目录结构变了，而消费方各自写死路径」。值得在库里立一条通则——凡是"约定路径"被多方消费的，要么由单一函数产出（运行时侧已经是 `sceneBakeDirUrl` 一处），要么就得有一条对着真实布局验的护栏；只靠"改的时候记得全改"必然漏，因为漏了的那几处**全都不报错**。四处里三处的降级分支（`except → 1.0`、`filter 后为空 → 跳过`、`匹配 0 条 → 静默`）本身也值得单独说一句：**降级必须出声**。
