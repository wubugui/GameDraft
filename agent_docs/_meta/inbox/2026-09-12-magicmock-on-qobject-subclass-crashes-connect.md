---
target: editor-change-verification-gate
date: 2026-09-12
session: 收尾门存量清理(vitest 误收 + port_conflict 用例 access violation)
---

现象: `test_port_conflict_dialog.py::TestStartGameBackendGate` 两条本机必 `Windows fatal exception: access violation`,打死 xdist worker 后 xdist 重调度抛 `INTERNALERROR KeyError: <WorkerController gwN>`,编辑器全树门跑不完、失败汇总也不打印——卡里「挂死分流」只讲"停着不动",没有"worker 被打死"这一形。根因与离屏/模态/父窗无关:`patch.object(SomeQObjectSubclass, "exec", return_value=...)` 往**接收者自己的类字典**挂了 MagicMock,PySide6 6.11 在 `signal.connect(self.<方法>)` 时扫该类字典读每个可调用物的 `_slots`,MagicMock 回子 Mock,C++ 当 list 读即崩(基类如 `QDialog.exec` 挂 MagicMock 不触发;`requirements.txt` 只写 `PySide6>=6.5.0`,别的机器版本不同可能不崩)。
证据: 最小复现——任意 QObject 子类挂一个 MagicMock 类属性再 connect 到自身方法即崩,换普通函数即过;修法见 tools/editor/tests/test_port_conflict_dialog.py 顶部 `_exec_returning` 注释(其余弹窗测试本来就用普通函数桩)。
建议: 挂死分流补一条"access violation / worker 被打死 ⇒ 先查是否往被测 Qt 子类上 patch 了 MagicMock";打 Qt 子类方法的桩一律用普通函数/lambda。
