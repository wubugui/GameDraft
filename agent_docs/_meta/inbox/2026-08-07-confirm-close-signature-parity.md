# confirm_close 签名 parity 缺护栏(2026-08-07)

- 现象:`PropPresetEditor.confirm_close(self)` 少了 parent 形参,而主窗两处都按
  `confirm_close(parent)` 调(`main_window.py:1096` / `:1371`)→ `closeEvent` 首行 TypeError。
  PySide 只把 traceback 打到 stderr 就继续,`event` 既未 accept 也未 ignore(默认放行关窗),
  于是 `_flush_editors_to_model`、"未保存改动"询问、几何保存、`_stop_game()` 全被跳过
  ——脏数据静默丢失 + npm 子进程漏杀(`QProcess: Destroyed while process is still running`)。
- 与库内的关系:`mainwindow-editor-hooks` / `close-path-flush-discard` 两卡都只要求
  "必须有 confirm_close",没写**签名**也是契约的一部分;`test_flush_hook_parity.py` 原先只查
  钩子有没有、不查能不能按调用点的实参调用 → 23 个实现里跑偏 1 个,102+ 测试全绿也没抓到
  (同 chronicle_sim_v2 `closeEvent` NameError 那条"关窗异常不冒泡"的家族)。
- 已做:补 parent 形参(弹窗用 `parent or self`)+ 在 `test_flush_hook_parity.py` 加
  `test_confirm_close_accepts_parent_argument`(按 `inspect.signature().bind` 判)与调用点
  锚定测试防空转;临时回退签名实测护栏会咬。建议把"钩子签名须与调用点实参对齐"写进
  `mainwindow-editor-hooks` 硬契约第 2 条。
