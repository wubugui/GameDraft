---
id: debug-ui-persistence
title: 调试/游戏内 UI 偏好持久化范式
domain: runtime
type: mechanism
summary: 调试/编辑器 UI 的用户偏好必须落工程文件;传输两种:vite 中间件(游戏内)/QWebChannel bridge(内嵌编辑器);localStorage-only 被用户明确否决(2026-07-07)
status: active
authority:
  - vite.config.ts#debugDockPinsApi
  - resources/editor_projects/editor_data/debug_dock_pins.json
  - tools/editor/editors/narrative_state_editor.py#_write_editor_sidecar
triggers:
  paths: ["src/ui/**", "vite.config.ts", "tools/narrative_editor_web/src/bridge.ts"]
  topics: [调试面板, 偏好持久化, localStorage, F2, bridge, sidecar]
  tasks: [加调试UI, 记用户偏好]
last_governed: 2026-07-13
---

## 是什么(一句话)

UI 要记住用户偏好(pin/收藏/布局)时的合规范式:**持久化落
`resources/editor_projects/editor_data/*.json` 工程文件**;传输按宿主选——
游戏内 UI 走 vite dev 服 `/__gamedraft-api/...` 中间件;QWebEngine 内嵌编辑器
(叙事状态机)vite 中间件不可达,走 QWebChannel bridge slot(同一原则的两种传输)。

## 权威源(读代码从哪进)

`vite.config.ts` 的 `debugDockPinsApi` / flag 收藏中间件;现成落盘例子
`debug_flag_favorites.json`、`debug_dock_pins.json`。bridge 线:
`narrative_state_editor.py` 的 `_write_editor_sidecar`(slot 收到即写,不经脏桶)+
`tools/narrative_editor_web/src/bridge.ts`,落盘例子 `narrative_editor_preferences.json`、
`narrative_canvas_groups.json`。

## 硬契约

- **禁止只用 localStorage**(2026-07-07 用户拍板,被否方案)。原因:项目在多端口
  (5173/5174/5178/5180)与编辑器内嵌 Qt WebEngine 里开游戏,localStorage 按 origin
  隔离、WebEngine 可能不落盘——换端口/重启即"失忆"。localStorage 只许作首帧种子
  或无 bridge 纯 Web 开发态的降级,绝不作权威。
- 构造时 + 每次打开面板时 GET 同步;改动即 POST;非 dev 构建降级为内存并 log 提示。
- 不要先做 localStorage 版再返工。
- 这类偏好/布局 sidecar 文件运行时(src/)永不加载,与游戏数据文件严格隔离。

## 已知坑

- 新偏好键先看现成两个 JSON 的范式再加,同一面板的偏好别散多个文件。

## 怎么验证

改完重启 dev 服 + 换端口打开,偏好仍在;`editor_data/` 下对应 JSON 有落盘内容。
