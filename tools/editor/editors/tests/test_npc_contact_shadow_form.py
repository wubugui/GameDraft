"""脚底接触 AO（胶囊 AO）作者面在**真实的 ScenePropertyPanel 里**的往返、校验与缺省值对账。

作者面（制作人 2026-09-24 定）：勾「接触 AO」就有；「方向 AO」缺省也勾着（所有 NPC 与主角默认都开，同日改口）；
明暗、大小和方向 AO 的参数都能调。数据：NPC `contactAo` / 场景 `playerContactAo`（`ContactAoDef`）。

这里证明：
① 关了投影的 NPC（雾津街头送葬队）载入后「接触 AO」「方向 AO」都勾着、明暗 / 大小在「场景值」档（跟随场景）；
② 不动就写回，一个字节不多（不写 `contactAo`，`castShadow: false` 原样）；
③ 勾 / 改能落盘，改回缺省字段消失；没动过的数按原值写回、不认识的键原样保留；
④ 玩家那一块同一套；
⑤ 校验器拦类型与越界；编辑器缺省值与运行时逐字相同。
"""
from __future__ import annotations

import copy
import json
import os
import re
import sys
from pathlib import Path

import pytest

os.environ.setdefault('QT_QPA_PLATFORM', 'offscreen')

_ROOT = Path(__file__).resolve().parents[4]
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

pytest.importorskip('PySide6.QtWidgets')

from PySide6.QtWidgets import QApplication            # noqa: E402

from tools.editor.shared import contact_ao as cao      # noqa: E402
from tools.editor.validator import _npc_contact_ao_issues  # noqa: E402

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


def _cast_off_npc(scene: dict) -> dict:
    npc = next((n for n in scene['npcs'] if n.get('castShadow') is False and 'contactAo' not in n), None)
    if npc is None:
        pytest.skip('场景里已没有「关了投影、没配接触 AO」的 NPC，用例前提变了')
    return npc


class TestNpcContactAoForm:
    def test_关了投影的NPC_接触AO与方向AO缺省都勾着_跟随场景(self, panel, scene) -> None:
        npc = _cast_off_npc(scene)
        panel.load_npc_props(copy.deepcopy(npc))
        w = panel._npc_contact_ao
        assert panel._npc_cast_shadow.isChecked() is False
        assert w._enabled.isChecked() is True
        assert w._directional.isChecked() is True, '所有 NPC 默认都开方向 AO（制作人 2026-09-24）'
        for k in ('darkness', 'size'):
            sb = w._spins[k]
            assert sb.value() == sb.minimum(), f'{k} 应在「场景值」档'
            assert sb.specialValueText().startswith('场景值')

    def test_不动就写回_一个字段不多(self, panel, scene) -> None:
        npc = _cast_off_npc(scene)
        panel.load_npc_props(copy.deepcopy(npc))
        out = copy.deepcopy(npc)
        panel._write_npc_widgets_to_dict(out)
        assert out['castShadow'] is False
        assert 'contactAo' not in out

    def test_取消接触AO落false_再勾回字段消失(self, panel, scene) -> None:
        npc = _cast_off_npc(scene)
        panel.load_npc_props(copy.deepcopy(npc))
        w = panel._npc_contact_ao
        out = copy.deepcopy(npc)
        w._enabled.setChecked(False)
        panel._write_npc_widgets_to_dict(out)
        assert out['contactAo'] == {'enabled': False}
        assert out['castShadow'] is False, '关接触 AO 不许连带动投影'
        w._enabled.setChecked(True)
        panel._write_npc_widgets_to_dict(out)
        assert 'contactAo' not in out

    def test_调参数能落盘_取消方向AO写false_改回缺省字段消失(self, panel, scene) -> None:
        npc = _cast_off_npc(scene)
        panel.load_npc_props(copy.deepcopy(npc))
        w = panel._npc_contact_ao
        w._spins['darkness'].setValue(0.5)
        w._spins['dirLength'].setValue(1.2)
        out = copy.deepcopy(npc)
        panel._write_npc_widgets_to_dict(out)
        assert out['contactAo'] == {'darkness': 0.5, 'dirLength': 1.2}, '方向 AO 是缺省开，不写 directional'
        w._directional.setChecked(False)
        panel._write_npc_widgets_to_dict(out)
        assert out['contactAo'] == {'directional': False, 'darkness': 0.5, 'dirLength': 1.2}
        w._directional.setChecked(True)
        w._spins['darkness'].setValue(w._spins['darkness'].minimum())
        w._spins['dirLength'].setValue(cao.DIR_LENGTH_DEFAULT)
        panel._write_npc_widgets_to_dict(out)
        assert 'contactAo' not in out

    def test_原来显式写了directional_true_不替作者删(self, panel, scene) -> None:
        src = copy.deepcopy(scene['npcs'][0])
        src['contactAo'] = {'directional': True}
        panel.load_npc_props(src)
        out = copy.deepcopy(src)
        panel._write_npc_widgets_to_dict(out)
        assert out['contactAo'] == {'directional': True}

    def test_没动过的数按原值写回_未知键保留(self, panel, scene) -> None:
        src = copy.deepcopy(scene['npcs'][0])
        src['contactAo'] = {'enabled': False, 'spread': 0.333, 'darkness': 0.4, 'futureKey': 7}
        panel.load_npc_props(src)
        w = panel._npc_contact_ao
        assert w._enabled.isChecked() is False
        out = copy.deepcopy(src)
        panel._write_npc_widgets_to_dict(out)
        assert out['contactAo'] == src['contactAo']

    def test_方向来源缺省按光照_不写字段_改了才写(self, panel, scene) -> None:
        """制作人 2026-09-24：方向来源是个选项；缺省「ao 方向本来就和间接光强度要一致」。"""
        npc = _cast_off_npc(scene)
        panel.load_npc_props(copy.deepcopy(npc))
        w = panel._npc_contact_ao
        assert w._dir_source.currentData() == 'lighting'
        assert w._dir_source.currentText() == '按光照'
        out = copy.deepcopy(npc)
        panel._write_npc_widgets_to_dict(out)
        assert 'contactAo' not in out, '缺省档不写 dirSource'
        w._dir_source.setCurrentIndex(w._dir_source.findData('binding'))
        panel._write_npc_widgets_to_dict(out)
        assert out['contactAo'] == {'dirSource': 'binding'}
        w._dir_source.setCurrentIndex(w._dir_source.findData('lighting'))
        panel._write_npc_widgets_to_dict(out)
        assert 'contactAo' not in out

    def test_方向来源不认识的值保值展示并原样写回(self, panel, scene) -> None:
        src = copy.deepcopy(scene['npcs'][0])
        src['contactAo'] = {'directional': True, 'dirSource': 'light:lamp_4'}
        panel.load_npc_props(src)
        w = panel._npc_contact_ao
        assert w._dir_source.currentData() == 'light:lamp_4'
        assert '未知' in w._dir_source.currentText()
        out = copy.deepcopy(src)
        panel._write_npc_widgets_to_dict(out)
        assert out['contactAo'] == src['contactAo']
        # 换一个 NPC 再载入，上一次的「未知」项不许残留在下拉里
        panel.load_npc_props(copy.deepcopy(_cast_off_npc(scene)))
        assert w._dir_source.count() == len(cao.DIR_SOURCES)

    def test_关了接触AO时参数框不可点_方向参数只在勾方向AO时可点(self, panel, scene) -> None:
        panel.load_npc_props(copy.deepcopy(_cast_off_npc(scene)))
        w = panel._npc_contact_ao
        assert w._spins['darkness'].isEnabled() and w._spins['dirStrength'].isEnabled()
        assert w._dir_source.isEnabled()
        w._directional.setChecked(False)
        assert not w._spins['dirStrength'].isEnabled() and not w._dir_source.isEnabled()
        w._directional.setChecked(True)
        assert w._spins['dirStrength'].isEnabled() and w._dir_source.isEnabled()
        w._enabled.setChecked(False)
        assert not w._spins['darkness'].isEnabled() and not w._spins['dirStrength'].isEnabled()
        assert not w._dir_source.isEnabled()


class TestPlayerContactAo:
    def test_玩家那一块_缺省方向AO也开_不动不写_改了写playerContactAo(self, panel, scene) -> None:
        assert 'playerContactAo' not in scene
        assert panel._player_contact_ao._directional.isChecked() is True, '主角也默认开方向 AO'
        out: dict = {}
        panel._writeback_scene_lights(out)
        assert 'playerContactAo' not in out
        panel._player_contact_ao._directional.setChecked(False)
        panel._writeback_scene_lights(out)
        assert out['playerContactAo'] == {'directional': False}

    def test_玩家那一块载入已有配置(self, panel, scene) -> None:
        sc = copy.deepcopy(scene)
        sc['playerContactAo'] = {'size': 1.5, 'dirConeDeg': 20}
        panel._load_scene_lights(sc)
        w = panel._player_contact_ao
        assert w._spins['size'].value() == pytest.approx(1.5)
        assert w._spins['dirConeDeg'].value() == pytest.approx(20)
        out: dict = {}
        panel._writeback_scene_lights(out)
        assert out['playerContactAo'] == {'size': 1.5, 'dirConeDeg': 20}


class TestSceneDefaults:
    def test_跟随场景显示的值走运行时同一条链(self, panel, scene) -> None:
        d, s, note = panel._scene_contact_ao_defaults(scene)
        # 雾津街头没配 lightEnv、全局也没写 contact → 落到基线（与 lightEnv.ts BASELINE 同值，另有对账测试）
        from tools.editor.editors.scene_editor import _LC_BASELINE_ENV
        assert (d, s) == (_LC_BASELINE_ENV['shadow']['contact'], _LC_BASELINE_ENV['shadow']['contactSize'])
        assert note == ''
        sc = copy.deepcopy(scene)
        sc['lightEnv'] = {'shadow': {'contact': 0.3}}
        sc['lightEnvCurve'] = {'points': [{'x': 0, 'y': 0, 'env': {}}]}
        d2, _s2, note2 = panel._scene_contact_ao_defaults(sc)
        assert d2 == 0.3 and note2 == '随光照曲线'


class TestContactAoValidation:
    def test_类型与越界报错(self) -> None:
        sc = {
            'playerContactAo': {'enabled': 'false'},
            'npcs': [
                {'id': 'a', 'contactAo': {'darkness': 1.5}},
                {'id': 'b', 'contactAo': 'yes'},
                {'id': 'c', 'contactAo': {'dirConeDeg': 'soft'}},
                {'id': 'd', 'contactAo': {'dirSource': 'closest'}},
            ],
        }
        issues = _npc_contact_ao_issues(sc)
        assert len(issues) == 5
        assert any('NPC d' in t and 'dirSource' in t for t in issues)
        assert any('玩家' in t and 'enabled' in t for t in issues)
        assert any('NPC a' in t and 'darkness' in t for t in issues)
        assert any('NPC b' in t for t in issues)
        assert any('NPC c' in t and 'dirConeDeg' in t for t in issues)

    def test_合法与缺省都不报(self) -> None:
        sc = {'npcs': [
            {'id': 'a'},
            {'id': 'b', 'contactAo': {'enabled': False}},
            {'id': 'e', 'contactAo': {'directional': True, 'dirSource': 'scene'}},
            {'id': 'c', 'contactAo': {'directional': True, 'darkness': 0.5, 'size': 2, 'spread': 0.3,
                                      'dirStrength': 1, 'dirLength': 0.7, 'dirConeDeg': 32, 'futureKey': 1}},
        ]}
        assert _npc_contact_ao_issues(sc) == []


class TestDefaultsParity:
    """编辑器缺省值是运行时 `src/rendering/contactAo.ts` 的镜像（norms 不变量 8：镜像必须配对账）。"""

    @staticmethod
    def _ts_const(path: str, name: str) -> float:
        src = (_ROOT / path).read_text(encoding='utf-8')
        m = re.search(rf'export const {name} = ([0-9.]+);', src)
        assert m, f'{path} 里找不到 {name}——常量改名/搬家了,编辑器镜像要跟着改'
        return float(m.group(1))

    def test_接触AO缺省四项与运行时逐字相同(self) -> None:
        ts = 'src/rendering/contactAo.ts'
        assert cao.SPREAD_DEFAULT == self._ts_const(ts, 'CONTACT_AO_SPREAD_DEFAULT')
        assert cao.DIR_STRENGTH_DEFAULT == self._ts_const(ts, 'CONTACT_AO_DIR_STRENGTH_DEFAULT')
        assert cao.DIR_LENGTH_DEFAULT == self._ts_const(ts, 'CONTACT_AO_DIR_LENGTH_DEFAULT')
        assert cao.DIR_CONE_DEG_DEFAULT == self._ts_const(ts, 'CONTACT_AO_DIR_CONE_DEG_DEFAULT')

    def test_方向AO缺省开与运行时一致(self) -> None:
        src = (_ROOT / 'src' / 'rendering' / 'contactAo.ts').read_text(encoding='utf-8')
        m = re.search(r'export const CONTACT_AO_DIRECTIONAL_DEFAULT = (true|false);', src)
        assert m, 'contactAo.ts 里找不到 CONTACT_AO_DIRECTIONAL_DEFAULT'
        assert (m.group(1) == 'true') is cao.DIRECTIONAL_DEFAULT

    def test_方向来源枚举与缺省与运行时逐字相同(self) -> None:
        src = (_ROOT / 'src' / 'rendering' / 'contactAo.ts').read_text(encoding='utf-8')
        m = re.search(r"export const CONTACT_AO_DIR_SOURCES = \[([^\]]*)\] as const;", src)
        assert m, 'contactAo.ts 里找不到 CONTACT_AO_DIR_SOURCES'
        assert tuple(re.findall(r"'([a-z]+)'", m.group(1))) == cao.DIR_SOURCES
        d = re.search(r"export const CONTACT_AO_DIR_SOURCE_DEFAULT: ContactAoDirSource = '([a-z]+)';", src)
        assert d and d.group(1) == cao.DIR_SOURCE_DEFAULT
        assert set(cao.DIR_SOURCE_LABELS) == set(cao.DIR_SOURCES)

    def test_接触浓度缺省三处同值(self) -> None:
        """运行时 lightEnv 基线 / 编辑器关键帧缺省 / 画布预览缺省。改一处漏两处 = 作者看到的缺省不是游戏里的。"""
        src = (_ROOT / 'src' / 'rendering' / 'lightEnv.ts').read_text(encoding='utf-8')
        m = re.search(r'contact: ([0-9.]+), contactSize: ([0-9.]+),', src)
        assert m, 'lightEnv.ts 基线里找不到 contact / contactSize'
        runtime = (float(m.group(1)), float(m.group(2)))
        from tools.editor.editors.scene_editor import _LC_BASELINE_ENV
        from tools.editor.shared.light_env_visual import light_env_visual
        sh = _LC_BASELINE_ENV['shadow']
        assert (sh['contact'], sh['contactSize']) == runtime
        vis = light_env_visual(None)
        assert (vis.contact, vis.contact_size) == runtime

    def test_画布预览用的晕开就是缺省晕开(self) -> None:
        from tools.editor.shared import light_env_visual as lev
        assert lev.CONTACT_NEAR_FIELD == cao.SPREAD_DEFAULT

    def test_预览尺度只认角色高_contactSize越大越宽(self) -> None:
        from tools.editor.shared.light_env_visual import contact_preview_axes
        rx1, ry1 = contact_preview_axes(150.0, 1.0)
        rx2, _ry2 = contact_preview_axes(150.0, 2.0)
        assert rx2 > rx1 > 0
        # 胶囊 AO 只看比值:角色整体放大一倍,范围也正好一倍
        rx3, ry3 = contact_preview_axes(300.0, 1.0)
        assert (rx3, ry3) == pytest.approx((2 * rx1, 2 * ry1), rel=1e-6)
        # 纵向是地面纵深的投屏(俯角 45°)
        assert ry1 == pytest.approx(rx1 * 0.5 ** 0.5, rel=1e-6)

    def test_预览那一圈与运行时公式同值(self) -> None:
        """半轴处的无方向浓度应正好落在 1/10(与 CONTACT_FRAG 同式)。"""
        import math
        from tools.editor.shared import light_env_visual as lev
        rx, _ = lev.contact_preview_axes(150.0, 1.0)
        r = 0.5 * lev.CONTACT_PREVIEW_FOOT_FRAC * 150.0
        he = lev.CONTACT_NEAR_FIELD * 150.0 / math.sqrt(0.5)
        v = (2 / math.pi) * math.asin(min(1.0, r / rx)) * he * he / (he * he + rx * rx)
        assert v == pytest.approx(0.1, abs=1e-6)
