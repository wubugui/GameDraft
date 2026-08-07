"""静态护栏：策划工具里不许存在「引用了不存在的名字」的死代码路径。

由来（2026-08-06）：图对话编辑器的「删除本条件」按钮 **100% 抛 NameError** ——
`do_c_del` 用了 `cond_rows_layout`，而那是另一个方法闭包里的局部变量，从
`_build_switch_and_cond_row` 被抽成独立方法起就没传进来过。表现极其阴险：
行已从数据列表里 pop 掉、异常打断后续四步，于是控件没移除、模型没变、也不标脏；
策划看着像「按钮坏了」，直到他改点别的触发一次 get_node()，这次删除才**延迟生效**。

这类缺陷只在「真的点那个按钮」时才暴露，靠 model 层测试永远抓不到；而它
**完全可以被静态分析秒杀**（pyflakes 的 undefined name 检查）。一次全仓扫描 1 秒，
比事后逐个补交互护栏便宜得多——两手都要，这里补静态那只手。
"""
from __future__ import annotations

import importlib.util
import subprocess
import sys
import unittest
from pathlib import Path

_PROJECT_ROOT = Path(__file__).resolve().parents[3]

#: 策划直接使用的编辑器包——这些里面的死按钮会直接砸在策划脸上。
_SCANNED_PACKAGES = (
    "tools/editor",
    "tools/dialogue_graph_editor",
    # 2026-08-06 加入：chronicle_sim_v2 的 MainWindow.closeEvent 引用了 __init__ 里的
    # 局部变量 `splitter`，关窗必抛 NameError，且把后面的 release_all_clients() 一并跳过
    # ——正是本护栏要拦的同一类缺陷（`./dev.sh chronicle-sim-v2` 是活入口，不是死代码）。
    "tools/chronicle_sim_v2",
)


class NoUndefinedNamesTests(unittest.TestCase):
    def test_editor_packages_have_no_undefined_names(self) -> None:
        if importlib.util.find_spec("pyflakes") is None:
            self.skipTest("未安装 pyflakes（pip install pyflakes 后本护栏才生效）")

        targets = [str(_PROJECT_ROOT / p) for p in _SCANNED_PACKAGES]
        proc = subprocess.run(
            [sys.executable, "-m", "pyflakes", *targets],
            capture_output=True,
            text=True,
            cwd=str(_PROJECT_ROOT),
        )
        # pyflakes 把「未使用的 import」等风格问题也一并报出来，这里只收
        # undefined name —— 那是**运行到就炸**的真缺陷，零容忍。
        offenders = [
            line
            for line in (proc.stdout + proc.stderr).splitlines()
            if "undefined name" in line
        ]
        self.assertEqual(
            offenders,
            [],
            "下列位置引用了不存在的名字，运行到就抛 NameError（详见本文件模块注释）：\n  "
            + "\n  ".join(offenders),
        )


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
