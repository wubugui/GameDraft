现象：本机 Windows 上全量 pytest 有 110 个环境性失败（chronicle_sim 缺 pytest-asyncio 72 个、audio/write_guard 临时目录 PermissionError 17 个、字节往返哈希 2 个、narrative_debugger 读 HEAD 破损叙事数据 6 个、布局/DPI 2 个等），且 xdist worker 收尾间歇性挂死把 7 分钟的会话拖到 20+ 分钟。
与库内认知的冲突：validator/机制卡口径是"editor pytest 全绿"（ac7e1ff 在 mac 上 1432 绿），在本机不成立；靶向跑受影响文件全绿仍是有效判据。
处置：tools/conftest.py 已加 controller 收尾守卫（120s 超时 dump 全线程栈+py-spy 拍卡死 worker 栈+清 worker 树+保真退出码强退，py-spy 已装入 .tools/venv）；110 个失败已用 stash-to-HEAD 对比确认全部存量、与歪歌册改动无关。
根因追缉现状（2026-08-17 深夜）：守卫进驻后连续 4 轮全量零复发；QWebEngine 重度文件串行 3 连跑退出干净；挂死那轮的输出里也无 qt_teardown 的"放弃销毁"警告——排除被追踪 QThread，指向 qt_teardown 自述管不到的残留（QtWebEngine 内部线程 / execnet 管道态），疑似与系统高负载相关（两次复发都在多任务并行时段）。下次自然复发时守卫会自动产出卡死 worker 的 py-spy 栈，凭那份栈直接定罪。
