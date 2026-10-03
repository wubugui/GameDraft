来源：src/main.ts；制作人要求取消开局“点击开始”黑幕，入口检查通过后已改为直接启动游戏。
偏差：runtime/mechanisms/start-gate-audio-unlock.md 仍将首启遮罩列为硬契约；遮罩及其输入监听已删除。
现状：Electron 客户端与专用预览窗均允许免手势播放，AudioManager 继续负责音频自动解锁与保活；机制卡和相关旧注释待治理更新。
