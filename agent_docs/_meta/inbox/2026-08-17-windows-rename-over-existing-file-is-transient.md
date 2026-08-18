---
target: anim-preview-tool
date: 2026-08-17
session: K3 事件日志 + K7 二阶段（收尾时发现 npm test 存量红）
---

# Windows 上「rename 覆盖已存在文件」会瞬时失败，原子写必须退避重试

- **现象**：`npm test` 在本机长期是红的（`tools/anim_preview/workspaceStore.test.mjs`
  的「two stale-lock contenders cannot ABA-delete the newly acquired lock」）。
  报错是子进程 exit 1 + `EPERM: operation not permitted, rename
  'workspace.json.tmp-<pid>-<hex>' -> 'workspace.json'`（`writeJsonAtomic` 里那一行）。
- **为什么一直没被当回事**：**单跑这个文件 23/23 全过、退出 0**；只有两个测试文件一起跑
  （`npm test` 的 `node --test tools/anim_preview/*.test.mjs`）才炸，串行跑同样炸。
  它是**时序敏感**的，机器一忙窗口就变宽——很容易被归成"环境性存量失败"放着。
- **根因**：POSIX 的 `rename()` 无条件原子替换，目标正被别的进程打开也照换；
  Windows 的 `MoveFileEx(REPLACE_EXISTING)` 在目标被**任何**进程持有句柄时抛
  `EPERM`/`EACCES`/`EBUSY`。持有者不一定是我们：另一个进程刚读完还没关、
  杀毒软件扫描、搜索索引器都算。写盘锁只串行化**写者**，挡不住这些。
- **影响**：不只是测试红——`workspaceStore` 是动画工作台的存盘出口，
  这一脚在真机上就是**保存失败/丢一次编辑**，只是概率低、复现难。
- **本次处理**：`writeJsonAtomic` 的 rename 改成退避重试
  （`EPERM`/`EACCES`/`EBUSY` → 1/2/5/10/25/50/100/200ms，用尽则连临时文件一起清掉再抛）。
  **不是加平台分支**：POSIX 上第一次就成功，一次都不重试。改完连跑三轮 29/29 全过，
  `npm test` 整条门退出 0（此前长期非 0）。
- **顺手一起修了编辑器的写盘出口**：`tools/editor/file_io.py` 是全工程唯一写盘口
  （save-all-dirty-buckets 卡），它的 5 处就位调用（`write_json` 的 replace、commit 的
  旧版转备份 / `os.link` 建档 / `os.replace` 就位、回滚的 `os.link` 复位）是同一形状。
  加了 `_retry_transient`：**只吃 EACCES/EPERM/EBUSY**，`os.link` 的 EEXIST（并发抢名的
  原子护栏）与测试注入的裸 `OSError`（errno 为 None）一律原样抛——失败语义三层不变。
  这里的现实威胁很具体：vite dev server 的 watcher 就盯着 `public/assets/data/**`，
  策划那边的表现是「Save All 偶尔失败」。新增 `test_atomic_write_retry.py` 锁边界（6 例），
  连同 save 路径三套（parity / save_contract / canvas_roundtrip）共 39 例全过。
- **全仓扫完了**：`os.replace` 形式的原子写共 8 处（editor/file_io ×5、audio_editor 的
  config 与 ledger、chronicle_sim v2 的 run_manager 与 world/fs、chronicle_sim v3 的
  engine/io、graph_editor/serializer、json_lang/build），**统一走新建的
  `tools/atomic_io.py`**（`retry_transient`）——不复制 8 份，边界只有一处可改。
  `tools/editor/file_io.py` 也改成 import 它；`test_atomic_write_retry.py` 里有一条
  「file_io 用的就是这一份实现」的身份断言，谁另抄一份就红。
  受影响模块逐个跑过基线对比：audio_editor 21 红、chronicle_sim 76 红均为**存量**
  （`Path.read_text(newline=)`、Qt 无头桩、缺依赖），改动前后逐字相同；json_lang 4 绿。
- **待办**：① `shutil.move` 形式的就位（asset_browser / asset_ingest / audio_editor server /
  chronicle 的 workspace 落位）尚未过——它们多数是移到**不存在**的目标，风险低于
  replace-existing，但值得单独判一遍；② anim-preview-tool 与 save-all-dirty-buckets
  两张卡里各补一条「原子写在 Windows 上不原子」的坑（本条 intake 的正事）。
