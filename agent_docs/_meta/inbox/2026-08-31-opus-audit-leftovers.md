---
target: meta
date: 2026-08-31
session: opus 对抗审计的"可以放"残留清单(已修项不在此,见各文件注释)
---

当日审计判"记录、不必现在动"的账,集中立案防散失:

- **dev 包 0→638MB**:manifest_rules 修复 always_extract 后 dev 目标多进
  vol_rad/vol_emit/atlas_bin 共 +319 文件/+637.7MB(按 _targets 出处是有意的),
  release +232 文件/+17.1MB。数字本身正确,但包体涨了要有人知道。
- **verify_build.mjs:307 写死 `.png`**:非 png 背景走 note+skip——"静默跳过"老形状。
  背景现全是 png,休眠。
- **desktop_shell 显式 --port 路径**:allow_reuse_address 在 Windows 允许双绑同端口,
  两 server 不确定分流;bind 失败 OSError 裸逃逸。缺省端口 0 路径无此问题,
  显式 --port 只在调试用。
- **窗口模式每次启动清 localStorage**:off-the-record profile 顺带把
  viewer/app.js `clab.folds`(折叠状态跨会话保持)灭了,--serve 模式正常。
  要保就得把折叠状态挪到 serve 端落盘。
- **dev_console/app.py:909 仍是裸 Popen**:从 dev_console 起的工具不随它死。
  是否该随死是 UX 决策(可能故意让工具独立存活),别顺手改。
- **test_room_b/lighting/background/lighting.json 是 CRLF**(其余 26 份 LF,存量);
  27 份迁移版 geometry.json 也是 CRLF(migrate 脚本 write_text 没 newline='',
  正是 python-write-text-crlf-on-windows 那条老坑)——重烘会自愈,不必专修。
- **teahouse 带 beta=3.0, mode=1**(存量):placeholder=true 场景照样能带活 beta
  (placeholder 只 gate 统一角色路径,beta 的消费者是老 probe 路径)。
- **实验室↔运行时 probeE/CHAR_FS 是两份手工复制,零 parity 闸**:本日法线回归的
  根因级土壤。worldSpaceShading.test.ts 已补"场景侧 vs 角色侧"闸,但 app.js
  那份仍无闸——收编实验室查表口径时(见 probe-lookup 翻案条)一起立。
