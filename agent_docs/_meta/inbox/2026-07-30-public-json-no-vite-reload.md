---
target: headless-visual-verification
date: 2026-07-30
session: object-examine A1 特写真机验证
---

现象: 配方说「改 public/ 下 JSON 触发 vite 整页刷新」,实际改 public/assets/data/object_examine/*.json 后页面未刷新,运行中的会话仍用旧数据(热区旧坐标继续命中)。
证据: 2026-07-30 无头驱动物件检视会话,编辑 demo_waterlogged_corpse.json 热区坐标后连续点击仍按旧坐标命中;location.reload() 后才生效。
建议: 配方中该条限定为「src/ 与已 import 的模块」;public/ 静态 JSON 需手动 reload 页。
