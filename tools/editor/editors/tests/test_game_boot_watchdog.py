"""游戏预览首屏看门狗:黑屏时必须自己清缓存重来,页面活着时绝不许乱动。

守的是 2026-09-08 那次事故:编辑器给游戏预览用的持久磁盘缓存烂了,revalidate 时把坏
掉的响应体喂回来,`/src/ui/debugLightingSection.ts` 变成 SyntaxError,模块图断掉、
`main.ts` 一行没跑,窗口停在 index.html 的 `#111` 上——**纯黑、点不动、
`loadFinished` 还是 True、日志里一个字都没有**。看门狗是那次的唯一自愈通道,
所以这里把它的判据(什么算"没起来")和补救时序(先清完缓存,再绕缓存重载)钉死。
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


class _FakeSignal:
    """够用的信号替身:记连接,让测试自己决定什么时候"清完了"。"""

    def __init__(self) -> None:
        self.slots: list = []

    def connect(self, slot) -> None:
        self.slots.append(slot)

    def disconnect(self, slot) -> None:
        self.slots.remove(slot)

    def emit(self) -> None:
        for slot in list(self.slots):
            slot()


class _FakeProfile:
    def __init__(self) -> None:
        self.clearHttpCacheCompleted = _FakeSignal()  # noqa: N815 — 对齐 Qt 命名
        self.cleared = 0

    def clearHttpCache(self) -> None:  # noqa: N802 — 对齐 Qt 命名
        self.cleared += 1


class _FakePage:
    def __init__(self) -> None:
        self.pending: list = []
        self.actions: list = []

    def runJavaScript(self, _code, callback) -> None:  # noqa: N802 — 对齐 Qt 命名
        self.pending.append(callback)

    def triggerAction(self, action) -> None:  # noqa: N802 — 对齐 Qt 命名
        self.actions.append(action)

    def answer(self, verdict: str) -> None:
        """把页面的回答一次性交给所有在等的探针。"""
        pending, self.pending = self.pending, []
        for callback in pending:
            callback(verdict)


class _FakeView:
    def __init__(self) -> None:
        self._page = _FakePage()

    def page(self):
        return self._page


@pytest.fixture()
def rig(app, monkeypatch):
    """看门狗 + 假视图 + 假 profile;`_game_webengine_profile()` 被引到假的那份上。"""
    profile = _FakeProfile()
    monkeypatch.setattr(gb, '_GAME_WEB_PROFILE', profile)
    view = _FakeView()
    dog = gb._GameBootWatchdog(view, 'test')
    dog.arm()
    dog._timer.stop()          # 手动打拍,不等真定时器
    yield dog, view, profile
    dog.disarm()


def _tick(dog, view, verdict: str) -> None:
    dog._tick()
    view.page().answer(verdict)


def test_booted_page_is_left_alone(rig) -> None:
    """页面自证 main.ts 跑过了就收工——绝不能去碰缓存或重载(会把玩家踢回开头)。"""
    dog, view, profile = rig
    for _ in range(4):
        _tick(dog, view, 'booted')
    assert profile.cleared == 0
    assert view.page().actions == []
    assert dog._done is True


@pytest.mark.parametrize('verdict', ['fatal', 'blocked'])
def test_game_error_screens_are_left_alone(rig, verdict: str) -> None:
    """游戏自己的错误屏(启动失败 / 入口卫兵拦截)是人能读的画面,不是"没起来"。"""
    dog, view, profile = rig
    for _ in range(4):
        _tick(dog, view, verdict)
    assert profile.cleared == 0
    assert view.page().actions == []


def test_blank_shell_clears_cache_then_reloads(rig) -> None:
    """空壳:宽限拍内不动手,到点先清缓存,**清完了**才绕缓存重载。"""
    dog, view, profile = rig
    _tick(dog, view, 'blank:complete')
    assert profile.cleared == 0, '第一拍就动手会把慢机上的正常启动误伤'

    _tick(dog, view, 'blank:complete')
    assert profile.cleared == 1
    assert view.page().actions == [], '缓存还没清完就重载会把这次加载吊死(实测 loadFinished 永不来)'

    profile.clearHttpCacheCompleted.emit()
    assert view.page().actions == [gb.QWebEnginePage.WebAction.ReloadAndBypassCache]
    assert profile.clearHttpCacheCompleted.slots == [], '一次性连接必须断开,否则重复补救会叠加'


def test_recovery_happens_only_once(rig) -> None:
    """补救过还是白的,就不是缓存的事:闭嘴交给人,别无限清缓存刷请求。"""
    dog, view, profile = rig
    for _ in range(2):
        _tick(dog, view, 'blank:complete')
    profile.clearHttpCacheCompleted.emit()

    for _ in range(gb._GameBootWatchdog._MAX_TICKS + 2):
        _tick(dog, view, 'blank:complete')

    assert profile.cleared == 1
    assert len(view.page().actions) == 1
    assert dog._done is True


def test_disarm_stops_probing(rig) -> None:
    """占位页/关窗后再打拍不该碰 page()——视图随时可能已经析构。"""
    dog, view, _profile = rig
    dog.disarm()
    dog._tick()
    assert view.page().pending == []
