---
target: debug-ui-persistence
date: 2026-08-14
session: 对白逐字显示（打字机开关+速度）落地
---

现象: 卡说"UI 偏好禁止只用 localStorage、一律落 editor_data sidecar + vite 中间件",但**玩家侧设置**（新增的逐字显示开关/速度，在设置页里调）走不了那条路——中间件只在 dev 存在、卡自己也写明 sidecar "运行时永不加载"，prod 构建等于记不住任何玩家设置。
证据: `agent_docs/runtime/mechanisms/debug-ui-persistence.md` 硬契约第 1 条 vs 新增 `src/core/TextDisplaySettings.ts`（落 localStorage，与 `src/core/SaveManager.ts` 同一存放面）；音量三条至今根本不持久化，说明玩家设置这一面此前没被任何卡覆盖。
建议: 卡里补一句作用域——"调试/编辑器偏好"归它，"玩家设置（音量/文字/按键）"归玩家数据面（localStorage，与存档同源）；两条别混。
