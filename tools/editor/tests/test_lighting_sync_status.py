"""光照同步的**状态行**必须能一眼看穿死活。

## 这条为什么值一个测试文件

2026-08-22：编辑器那半边因为拿错对象（`_stack.currentWidget()` 是 `_StackPageHost`
外壳），整条 tick **一次都没跑过**。而当时两边的状态行**只报传输连通性**：

- 游戏侧确实连着 → 显示"↔ 与编辑器同步中"
- 编辑器侧的 `set_sync_status` 从没被调过 → 标签停在初始文案
  "↔ 等待游戏（同步会自动连上，不用点任何按钮）"

两边看起来都正常，排查花了一整轮，最后是靠**直接 curl 同步槽**发现
"rev=59、59 次全是 writer=game"才定位的。

制作人 2026-08-22：「你他妈必须把那些连接的关键信号给老子写到双方的 GUI 上啊，
这样发不就一目了然了」。

所以状态行必须带这四样，缺一不可：
1. **收发计数** —— "发 0 收 0" 是最直接的死亡证明
2. **最后写入者 + 多久前** —— 一直是自己写的 ⇒ 对面根本没在写
3. **此刻被什么闸挡着** —— 静默抑制（忙／场景不符／太旧）是最贵的一种坏
4. 连着但从没收发过 ⇒ **自己喊出来**，不许伪装成"同步中"

与游戏侧 `src/dev/runtimeLightingSync.ts` 的 `statusLine()` 同口径，
那边由 `runtimeLightingSync.test.ts` 锁同样四条。
"""
from __future__ import annotations

import sys
from pathlib import Path

_ROOT = Path(__file__).resolve().parents[3]
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

from tools.editor.editors import scene_lights  # noqa: E402


def _t():
    """一个"已连上"的传输层。构造要个取基址的回调，测状态行用不到，给个常量。"""
    tr = scene_lights.LightingSyncTransport(lambda: 'http://localhost:5173')
    tr.fail_streak = 0
    tr.last_ok_ms = 1000.0
    tr._stuck = 'http://localhost:5173'
    tr.applied = 0
    tr.published = 0
    tr.last_writer = ''
    tr.last_doc_age_ms = None
    tr.suppressed = ''
    return tr


def test_没连过时说等待连接且带计数() -> None:
    tr = _t()
    tr.last_ok_ms = 0
    line = tr.status_line(5000.0)
    assert '等待连接' in line
    assert '发0 收0' in line


def test_连着但一次都没收发过_必须自己喊出来() -> None:
    """这就是那次事故的样子。不喊出来 = 看着像正常。"""
    tr = _t()
    line = tr.status_line(5000.0)
    assert '一次都没收发过' in line, line
    assert line.startswith('⚠'), '必须是 ⚠ 开头，否则一眼扫过去不会停'
    assert '发0 收0' in line


def test_真收发过了才叫同步中() -> None:
    tr = _t()
    tr.published, tr.applied = 3, 2
    line = tr.status_line(5000.0)
    assert '同步中' in line
    assert '发3 收2' in line


def test_断了也要看得见计数() -> None:
    tr = _t()
    tr.published, tr.applied = 3, 2
    tr.fail_streak = 4
    tr.last_error = 'HTTP 500'
    line = tr.status_line(9000.0)
    assert '已断' in line
    assert 'HTTP 500' in line
    assert '发3 收2' in line, '断线时把计数藏起来，就又看不出"从来没通过"了'


def test_最后写入者与年龄看得见() -> None:
    tr = _t()
    tr.published = 1
    tr.last_writer = 'game:abc'
    tr.last_doc_age_ms = 12_000
    line = tr.status_line(5000.0)
    assert '最后写入:游戏' in line
    assert '12s前' in line

    tr.last_writer = 'editor:xyz'
    assert '最后写入:编辑器' in tr.status_line(5000.0)


def test_被闸挡住时说明是哪道闸() -> None:
    tr = _t()
    tr.published = 1
    tr.suppressed = '本侧忙（灯表里在打字／正在画布上定位）只发不收'
    line = tr.status_line(5000.0)
    assert '⏸' in line
    assert '只发不收' in line


def test_槽空时也有话说() -> None:
    tr = _t()
    tr.published = 1
    line = tr.status_line(5000.0)
    assert '槽里还没有任何文档' in line


def test_初始标签不许再撒谎() -> None:
    """旧的初始文案是「等待游戏（同步会自动连上，不用点任何按钮）」——

    在同步整条死掉的那一轮里，这句话原样挂了一整场，把人往"一切正常"上带。
    初始态就该说"还没启动"，并带上 0/0。
    """
    src = (_ROOT / 'tools' / 'editor' / 'editors'
           / 'scene_editor.py').read_text(encoding='utf-8')
    assert '同步会自动连上，不用点任何按钮' not in src, '那句会撒谎的初始文案回来了'
    assert '↔ 同步未启动　发0 收0' in src


def test_tick_里三个诊断量都被写() -> None:
    """状态行再好，tick 不填它也是空的。锁住填写点。"""
    src = (_ROOT / 'tools' / 'editor' / 'main_window.py').read_text(encoding='utf-8')
    i = src.index('def _tick_lighting_sync')
    body = src[i:i + 4000]
    for token in ('tr.last_writer', 'tr.last_doc_age_ms', 'tr.suppressed',
                  'self._lighting_transport.applied += 1',
                  'self._lighting_transport.published += 1'):
        assert token in body, f'tick 里没写 {token}'


def test_四道静默闸都会说明理由() -> None:
    """槽空 / 太旧 / 场景不符 / 本侧忙 —— 四种静默跳过都必须留下理由。"""
    src = (_ROOT / 'tools' / 'editor' / 'main_window.py').read_text(encoding='utf-8')
    i = src.index('def _tick_lighting_sync')
    body = src[i:i + 4000]
    for why in ('槽是空的', '太旧', '场景对不上', '本侧忙'):
        assert why in body, f'少了「{why}」这道闸的说明'
