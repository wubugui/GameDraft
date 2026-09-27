"""游戏预览首屏看门狗:黑屏时必须自己重载一次,页面活着时绝不许乱动。

守的是 2026-09-08 那次事故:编辑器给游戏预览用的持久磁盘缓存烂了,revalidate 时把坏
掉的响应体喂回来,`/src/ui/debugLightingSection.ts` 变成 SyntaxError,模块图断掉、
`main.ts` 一行没跑,窗口停在 index.html 的 `#111` 上——**纯黑、点不动、
`loadFinished` 还是 True、日志里一个字都没有**。看门狗是那次的唯一自愈通道,
所以这里把它的判据(什么算"没起来")和补救(只重载一次)钉死。预览现在跑在 WebView2 里
(`tools/qt_webgpu.WebGpuView`,游戏只有 WebGPU),每进程一份新的用户数据目录、没有可清的缓存。
"""
from __future__ import annotations

import sys
from pathlib import Path

import pytest

_ROOT = Path(__file__).resolve().parents[4]
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

pytest.importorskip('PySide6.QtWidgets')

from PySide6.QtWidgets import QApplication            # noqa: E402

from tools.editor.editors import game_browser as gb   # noqa: E402


@pytest.fixture(scope='module')
def app():
    return QApplication.instance() or QApplication([])


class _FakeView:
    """够用的视图替身:WebGpuView 的 run_js / reload 两个口子,回答由测试决定什么时候给。"""

    def __init__(self) -> None:
        self.pending: list = []
        self.reloads = 0

    def run_js(self, _code, callback=None) -> None:
        if callback is not None:
            self.pending.append(callback)

    def reload(self) -> None:
        self.reloads += 1

    def answer(self, verdict: str) -> None:
        """把页面的回答一次性交给所有在等的探针。"""
        pending, self.pending = self.pending, []
        for callback in pending:
            callback(verdict)


@pytest.fixture()
def rig(app):
    """看门狗 + 假视图(手动打拍,不等真定时器)。"""
    view = _FakeView()
    dog = gb._GameBootWatchdog(view, 'test')
    dog.arm()
    dog._timer.stop()
    yield dog, view
    dog.disarm()


def _tick(dog, view, verdict: str) -> None:
    dog._tick()
    view.answer(verdict)


def test_booted_page_is_left_alone(rig) -> None:
    """页面自证 main.ts 跑过了就收工——绝不能重载(会把玩家踢回开头)。"""
    dog, view = rig
    for _ in range(4):
        _tick(dog, view, 'booted')
    assert view.reloads == 0
    assert dog._done is True


@pytest.mark.parametrize('verdict', ['fatal', 'blocked'])
def test_game_error_screens_are_left_alone(rig, verdict: str) -> None:
    """游戏自己的错误屏(启动失败 / 入口卫兵拦截)是人能读的画面,不是"没起来"。"""
    dog, view = rig
    for _ in range(4):
        _tick(dog, view, verdict)
    assert view.reloads == 0


def test_blank_shell_reloads_after_grace(rig) -> None:
    """空壳:宽限拍内不动手,到点重载一次(WebView2 宿主没有可清的缓存,重载就是全部补救)。"""
    dog, view = rig
    _tick(dog, view, 'blank:complete')
    assert view.reloads == 0, '第一拍就动手会把慢机上的正常启动误伤'

    _tick(dog, view, 'blank:complete')
    assert view.reloads == 1


def test_unanswered_probe_counts_as_blank(rig) -> None:
    """页面连探针都答不上(None:WebView2 还没起来 / 脚本没跑)按空壳算,同样只补救一次。"""
    dog, view = rig
    for _ in range(3):
        _tick(dog, view, None)
    assert view.reloads == 1


def test_recovery_happens_only_once(rig) -> None:
    """补救过还是白的,就不是加载偶发的事:闭嘴交给人,别无限刷请求。"""
    dog, view = rig
    for _ in range(2):
        _tick(dog, view, 'blank:complete')
    for _ in range(gb._GameBootWatchdog._MAX_TICKS + 2):
        _tick(dog, view, 'blank:complete')

    assert view.reloads == 1
    assert dog._done is True


def test_disarm_stops_probing(rig) -> None:
    """占位页/关窗后再打拍不该碰视图——视图随时可能已经析构。"""
    dog, view = rig
    dog.disarm()
    dog._tick()
    assert view.pending == []
