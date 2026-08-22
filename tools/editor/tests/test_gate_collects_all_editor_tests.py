"""门命令必须收得到**全部**编辑器测试。

## 为什么需要这条

编辑器测试实际分两处：`tools/editor/tests/`（主）与 `tools/editor/editors/tests/`
（scene_lights / shadow_bindings 那几组）。而钦定门命令历史上写的是
`pytest tools/editor/tests` —— **差一层目录，收不到后者**。

后果很隐蔽：往 `editors/tests/` 加的测试跑起来是绿的、本地单跑也是绿的，
但它们在标准门里**等于不存在**，谁把它们改红了都没人知道。
2026-08-21 实测：门收 1549 条，全树 1602 条，53 条在门外。

这条断言的作用是：一旦有人再把测试放进门收不到的目录，**这条会红**，
并直接告诉他门命令该怎么写。
"""
from __future__ import annotations

import subprocess
import sys
from pathlib import Path

_ROOT = Path(__file__).resolve().parents[3]

#: 编辑器测试允许出现的目录。新增目录要么加进来并同步改门命令，要么别新增。
_TEST_DIRS = ('tools/editor/tests', 'tools/editor/editors/tests')


def _collect_count(target: str) -> int:
    r = subprocess.run(
        [sys.executable, '-m', 'pytest', target, '--collect-only', '-q',
         '-p', 'no:cacheprovider'],
        cwd=_ROOT, capture_output=True, text=True, encoding='utf-8', errors='replace',
    )
    for line in reversed((r.stdout or '').splitlines()):
        line = line.strip()
        if line.endswith('tests collected') or ' tests collected' in line:
            return int(line.split()[0])
        if line.endswith('test collected'):
            return int(line.split()[0])
    raise AssertionError(f'解析不出收集数：\n{r.stdout[-2000:]}\n{r.stderr[-2000:]}')


def test_测试目录没有跑到登记之外() -> None:
    """有人新开了测试目录 ⇒ 那些测试很可能没进门。"""
    found = sorted({
        p.parent.relative_to(_ROOT).as_posix()
        for p in (_ROOT / 'tools' / 'editor').rglob('test_*.py')
        if '__pycache__' not in p.parts
    })
    unknown = [d for d in found if d not in _TEST_DIRS]
    assert not unknown, (
        f'这些目录下的测试不在登记的门覆盖范围里：{unknown}。\n'
        f'要么把它们挪进 {_TEST_DIRS[0]}，要么把目录加进本文件的 _TEST_DIRS '
        f'**并同步改门命令**（门必须是 `pytest tools/editor`，不是 `tools/editor/tests`）。')


def test_门命令收得到全部编辑器测试() -> None:
    """`pytest tools/editor`（全树）必须 ≥ 主目录单收 —— 且**严格大于**，
    因为 `editors/tests/` 里确实有测试。相等就说明全树没把它们收进来。"""
    whole = _collect_count('tools/editor')
    main_only = _collect_count('tools/editor/tests')
    assert whole > main_only, (
        f'全树收 {whole} 条、主目录收 {main_only} 条，两者相等 ⇒ '
        f'`tools/editor/editors/tests/` 没被收进来，那批测试等于不存在')
