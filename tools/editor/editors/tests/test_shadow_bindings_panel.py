"""阴影绑定在**真实的 ScenePropertyPanel 里**能不能编辑、能不能往返。

`test_shadow_bindings_ui.py`（控件级）只证明那个控件自己对；这一份证明它**真的接进了
编辑器**——三处挂载点（NPC / 热区 / 玩家）都建出来了、载入真场景能填对、
改一下能写回、且**不碰其余字段**。

## 为什么必须单独测这一层

控件对 ≠ 接对。历史上这类缺口都是同一个形态：控件写得好好的，但
① 载入时忘了喂灯表（下拉是空的）② 写回时忘了调 `dump()`（改了不落盘）
③ 写回顺序不对，把整块 `lighting` 覆盖没了。这三种都**不报错**，
只有打开编辑器点一遍才发现——所以用离屏 Qt 把那一遍点击自动化。
"""
from __future__ import annotations

import copy
import json
import os
import sys
from pathlib import Path

import pytest

os.environ.setdefault('QT_QPA_PLATFORM', 'offscreen')

_ROOT = Path(__file__).resolve().parents[4]
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

pytest.importorskip('PySide6.QtWidgets')

from PySide6.QtWidgets import QApplication            # noqa: E402

from tools.editor.editors import scene_lights          # noqa: E402
from tools.editor.editors.shadow_bindings_ui import (  # noqa: E402
    MODE_LIGHT, MODE_NONE, MODE_VIRTUAL,
)

SCENE = _ROOT / 'public' / 'assets' / 'scenes' / '雾津街头.json'


@pytest.fixture(scope='module')
def app():
    return QApplication.instance() or QApplication([])


@pytest.fixture()
def scene() -> dict:
    if not SCENE.exists():
        pytest.skip('雾津街头.json 不在（内容仓未同步）')
    return json.loads(SCENE.read_text(encoding='utf-8'))


@pytest.fixture()
def panel(app, scene):
    from tools.editor.editors.scene_editor import ScenePropertyPanel
    from tools.editor.project_model import ProjectModel
    p = ScenePropertyPanel(ProjectModel())
    p._load_scene_lights(scene)
    return p


class TestWiring:
    def test_三处绑定面板都建出来了(self, panel) -> None:
        """少一个都意味着那一类实体在编辑器里**没法配阴影**。"""
        for attr in ('_player_shadow_bind', '_npc_shadow_bind', '_hs_shadow_bind'):
            assert hasattr(panel, attr), f'缺 {attr} —— 该挂载点没接进编辑器'

    def test_玩家绑定从场景数据填对了(self, panel, scene) -> None:
        """期望值从**场景数据本身**推，不写死某个灯 id。

        写死的话，制作人在编辑器里把玩家阴影改绑到另一盏灯上（这是完全正常的
        创作动作，落盘就在 `雾津街头.json` 里），这条测试就会红 —— 而红的是
        「作者改了数据」，不是「编辑器坏了」。实测踩过：绑定从 lamp_5 改到
        lamp_2，这条当场变红，代码一行没动。
        """
        expect = scene['playerShadowBindings'][0]['source']
        assert expect.startswith('light:'), '这个场景的玩家阴影不是绑灯，用例前提变了'
        w = panel._player_shadow_bind
        assert w._mode.currentData() == MODE_LIGHT
        assert w._light.currentData() == expect.split(':', 1)[1]
        assert w.dump() == scene['playerShadowBindings']

    def test_灯表喂进下拉了(self, panel, scene) -> None:
        """忘了喂灯表 ⇒ 下拉是空的，作者根本选不到灯，而且不报错。"""
        w = panel._player_shadow_bind
        ids = {w._light.itemData(i) for i in range(w._light.count())}
        assert {l['id'] for l in scene['lighting']['lights'] if l.get('pos')} <= ids


class TestRoundTrip:
    def test_不编辑就写回_玩家绑定逐字节不变(self, panel, scene) -> None:
        out: dict = {}
        panel._writeback_scene_lights(out)
        assert out['playerShadowBindings'] == scene['playerShadowBindings']

    def test_不编辑就写回_lighting整块保值(self, panel, scene) -> None:
        """F2 里调的天光/雾/显示变换本面板不显示，但必须原样带回去。"""
        out: dict = {}
        panel._writeback_scene_lights(out)
        a = json.dumps(out['lighting'], sort_keys=True, ensure_ascii=False)
        b = json.dumps(scene['lighting'], sort_keys=True, ensure_ascii=False)
        assert a == b

    def test_改成虚拟灯能写回(self, panel) -> None:
        w = panel._player_shadow_bind
        w._mode.setCurrentIndex(w._mode.findData(MODE_VIRTUAL))
        w._azim.setValue(42.0)
        w._elev.setValue(55.0)
        out: dict = {}
        panel._writeback_scene_lights(out)
        b = out['playerShadowBindings'][0]
        assert b['source'] == 'virtual'
        assert b['virtual']['azimuthDeg'] == 42.0
        assert b['virtual']['elevationDeg'] == 55.0

    def test_改成不投影则不写字段(self, panel) -> None:
        """「不投影」与「不写字段」是两回事，但只有一条绑定且选了不投影时，
        写回 None ⇒ 不写字段 ⇒ 回落手调单影。这是刻意的。"""
        w = panel._player_shadow_bind
        w._mode.setCurrentIndex(w._mode.findData(MODE_NONE))
        out: dict = {}
        panel._writeback_scene_lights(out)
        assert 'playerShadowBindings' not in out

    def test_换灯能写回(self, panel) -> None:
        w = panel._player_shadow_bind
        i = w._light.findData('lamp_1')
        assert i >= 0, '场景里应当有 lamp_1'
        w._light.setCurrentIndex(i)
        out: dict = {}
        panel._writeback_scene_lights(out)
        assert out['playerShadowBindings'] == [{'source': 'light:lamp_1'}]


class TestNoCollateralDamage:
    def test_写回不动场景其余字段(self, panel, scene) -> None:
        """写回只该碰 lighting / playerShadowBindings，别的一个不许动。"""
        out = copy.deepcopy(scene)
        before = {k: json.dumps(v, sort_keys=True, ensure_ascii=False)
                  for k, v in out.items()
                  if k not in ('lighting', 'playerShadowBindings')}
        panel._writeback_scene_lights(out)
        for k, v in before.items():
            assert json.dumps(out[k], sort_keys=True, ensure_ascii=False) == v, f'{k} 被改了'

    def test_没有lighting块时玩家绑定也能写回(self, app) -> None:
        """恒等占位之前的场景没有 lighting 块。那条分支提前 return 过，
        曾经会顺带把玩家绑定一起吞掉。"""
        from tools.editor.editors.scene_editor import ScenePropertyPanel
        from tools.editor.project_model import ProjectModel
        p = ScenePropertyPanel(ProjectModel())
        p._load_scene_lights({'id': 'x'})
        p._player_shadow_bind.set_lights([{'id': 'L', 'kind': 'point'}])
        p._player_shadow_bind.load([{'source': 'light:L'}])
        out: dict = {'lighting': {'stale': 1}}
        p._writeback_scene_lights(out)
        assert 'lighting' not in out, '没有 lighting 块时该把陈旧的键清掉'
        assert out['playerShadowBindings'] == [{'source': 'light:L'}]


class TestValidatorParity:
    def test_面板产出的绑定能过校验(self, panel, scene) -> None:
        out: dict = {}
        panel._writeback_scene_lights(out)
        issues = scene_lights.validate_shadow_bindings(
            out.get('playerShadowBindings') or [], scene['lighting']['lights'], '玩家')
        assert issues == [], issues

    def test_绑到不存在的灯会被校验拦下(self, panel, scene) -> None:
        """编辑器允许保留悬垂绑定（不悄悄换灯），但校验必须报出来。"""
        issues = scene_lights.validate_shadow_bindings(
            [{'source': 'light:不存在的灯'}], scene['lighting']['lights'], '玩家')
        assert len(issues) == 1 and '不存在的灯' in issues[0]


class TestNpcAndHotspotRoundTrip:
    """NPC / 热区走的是**各自的实体写回**（`_write_npc_widgets_to_dict` /
    `_write_hotspot_widgets_to_dict`），与玩家那条场景级写回是两条独立路径。
    玩家那条通了不代表这两条也通——历史上这类"接了一半"的缺口都不报错。
    """

    def test_NPC绑定往返(self, panel, scene) -> None:
        npc = next(n for n in scene['npcs'] if n.get('shadowBindings'))
        panel.load_npc_props(copy.deepcopy(npc))
        w = panel._npc_shadow_bind
        assert w._mode.currentData() == MODE_LIGHT, 'NPC 面板没按数据填上'
        assert w._light.currentData() == npc['shadowBindings'][0]['source'].split(':', 1)[1]
        out = copy.deepcopy(npc)
        panel._write_npc_widgets_to_dict(out)
        assert out['shadowBindings'] == npc['shadowBindings']

    def test_NPC虚拟灯往返(self, panel, scene) -> None:
        npc = next(n for n in scene['npcs']
                   if (n.get('shadowBindings') or [{}])[0].get('source') == 'virtual')
        panel.load_npc_props(copy.deepcopy(npc))
        assert panel._npc_shadow_bind._mode.currentData() == MODE_VIRTUAL
        out = copy.deepcopy(npc)
        panel._write_npc_widgets_to_dict(out)
        assert out['shadowBindings'] == npc['shadowBindings']

    def test_没配绑定的NPC写回后仍然没有这个键(self, panel, scene) -> None:
        """没配 ≠ 不投影。误写成 `[{'source':'none'}]` 会把这些 NPC 的
        手调单影一起关掉，而画面上只表现为"影子没了"。"""
        npc = next(n for n in scene['npcs'] if 'shadowBindings' not in n)
        panel.load_npc_props(copy.deepcopy(npc))
        out = copy.deepcopy(npc)
        panel._write_npc_widgets_to_dict(out)
        assert 'shadowBindings' not in out

    def test_热区绑定往返(self, panel, scene) -> None:
        hs = (scene.get('hotspots') or [None])[0]
        if hs is None:
            pytest.skip('场景没有热区')
        src = copy.deepcopy(hs)
        src['shadowBindings'] = [{'source': 'light:lamp_1'}]
        panel.load_hotspot_props(src)
        assert panel._hs_shadow_bind._mode.currentData() == MODE_LIGHT
        out = copy.deepcopy(src)
        panel._write_hotspot_widgets_to_dict(out)
        assert out['shadowBindings'] == [{'source': 'light:lamp_1'}]


class TestLighting2PayloadValidation:
    """`lighting2/` 载荷校验。

    载荷缺失 / 代次不符 / 尺寸对不上时，运行时是**安静地不启用**——不报错、不崩，
    画面上只表现为"这个场景的光照没生效"。作者第一反应会去调参数，
    而参数根本没被读。所以这一层必须由校验器拦。
    """

    def test_已烘的场景零问题(self) -> None:
        from tools.editor.validator import _lighting2_issues
        assert _lighting2_issues('teahouse') == []

    def test_没烘的场景报警告(self) -> None:
        from tools.editor.validator import _lighting2_issues
        got = _lighting2_issues('这个场景不存在')
        assert len(got) == 1 and got[0][0] == 'warning'
        assert 'bake' in got[0][1], '提示里要给出怎么烘的命令，不然作者不知道下一步'

    def test_grid尺寸对不上报error(self, tmp_path, monkeypatch) -> None:
        """截短 8 个字节就该被抓到——这是"改了 M 或网格却没重烘"的典型形态。"""
        import shutil
        from pathlib import Path
        from tools.editor import validator as V
        src = Path(V.__file__).resolve().parents[2] / \
            'public/resources/runtime/scenes/teahouse/lighting2'
        # 2026-08-30 起烘焙产物按背景图名分目录，`lighting2/` 下只剩子目录；
        # 取真正装着 meta.json 的那一层当拷贝源（迁移期扁平布局也照样命中）。
        if src.exists() and not (src / 'meta.json').exists():
            subs = [d for d in src.iterdir() if d.is_dir() and (d / 'meta.json').exists()]
            src = subs[0] if subs else src
        if not (src / 'meta.json').exists():
            pytest.skip('teahouse 载荷不在（DVC 未拉取）')
        dst = tmp_path / 'public' / 'resources' / 'runtime' / 'scenes' / 'X' / 'lighting2'
        dst.parent.mkdir(parents=True)
        shutil.copytree(src, dst)
        raw = (dst / 'skyvis_grid.bin').read_bytes()
        (dst / 'skyvis_grid.bin').write_bytes(raw[:-8])
        monkeypatch.setattr(V, '__file__', str(tmp_path / 'tools' / 'editor' / 'validator.py'))
        got = V._lighting2_issues('X')
        assert any(s == 'error' and 'skyvis_grid.bin' in t for s, t in got), got

    def test_代次不符报error(self, tmp_path, monkeypatch) -> None:
        import json as _json
        import shutil
        from pathlib import Path
        from tools.editor import validator as V
        src = Path(V.__file__).resolve().parents[2] / \
            'public/resources/runtime/scenes/teahouse/lighting2'
        # 2026-08-30 起烘焙产物按背景图名分目录，`lighting2/` 下只剩子目录；
        # 取真正装着 meta.json 的那一层当拷贝源（迁移期扁平布局也照样命中）。
        if src.exists() and not (src / 'meta.json').exists():
            subs = [d for d in src.iterdir() if d.is_dir() and (d / 'meta.json').exists()]
            src = subs[0] if subs else src
        if not (src / 'meta.json').exists():
            pytest.skip('teahouse 载荷不在（DVC 未拉取）')
        dst = tmp_path / 'public' / 'resources' / 'runtime' / 'scenes' / 'X' / 'lighting2'
        dst.parent.mkdir(parents=True)
        shutil.copytree(src, dst)
        m = dst / 'meta.json'
        j = _json.loads(m.read_text(encoding='utf-8'))
        j['version'] = 99
        m.write_text(_json.dumps(j, ensure_ascii=False), encoding='utf-8')
        monkeypatch.setattr(V, '__file__', str(tmp_path / 'tools' / 'editor' / 'validator.py'))
        got = V._lighting2_issues('X')
        assert any(s == 'error' and '代次' in t for s, t in got), got
