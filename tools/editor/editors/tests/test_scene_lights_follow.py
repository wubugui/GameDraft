"""场景灯的「跟随实体」绑定（`LightDef.follow`）在**真实的 ScenePropertyPanel 里**的作者面。

## 为什么必须测这一层（而不是只测控件）

控件对 ≠ 接对。这一族缺口的形态都一样、而且**都不报错**：
① 载入时忘了喂候选（下拉是空的，作者根本选不到）；② 写回时忘了调 `dump()`（改了不落盘）；
③ 写回时无条件写键（**最小形态的灯打开保存一次就凭空多出 `follow`**）；
④ 手柄没门控（作者在画布上摆了半天，而 `pos` 早就不参与光照了）。

所以这里用离屏 Qt 把"打开编辑器点一遍"自动化，判据全部落在**写回产物**与**最外层入口**上。

## 往返判据只有一条

`lighting` 整块 `json.dumps` 逐字符相等。`follow` 里的 `heightWu` / `offset` 是数值，
`QDoubleSpinBox` 既会把 int 漂成 float、又会按 `decimals` **量化**，两种都由
`light_follow_ui` 兜住（`preserve_numeric_repr` + 种子快照），这里只验结果。
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

from PySide6.QtWidgets import QApplication              # noqa: E402

from tools.editor.editors import scene_lights            # noqa: E402

#: 往返验收用的场景。义庄有一盏灯（最小形态），teahouse 有 lighting 块但一盏灯都没有。
SCENES = ('义庄.json', 'teahouse.json', '雾津街头.json')


def _canon(obj) -> str:
    """逐字符比较用：**不排序键**（键序漂了也是往返破坏）。"""
    return json.dumps(obj, ensure_ascii=False, indent=2)


@pytest.fixture(scope='module')
def app():
    return QApplication.instance() or QApplication([])


@pytest.fixture()
def model(app):
    from tools.editor.project_model import ProjectModel
    m = ProjectModel()
    # 只读真实工程的路径（候选面要读 game_config 的 playerAvatar 与动画包的 sockets.json）。
    m.project_path = _ROOT
    m.game_config = {'playerAvatar': {
        'animManifest': '/resources/runtime/animation/player_anim/anim.json'}}
    return m


def _scene(name: str) -> dict:
    p = _ROOT / 'public' / 'assets' / 'scenes' / name
    if not p.exists():
        pytest.skip(f'{name} 不在（内容仓未同步）')
    return json.loads(p.read_text(encoding='utf-8'))


def _panel(model, scene: dict):
    from tools.editor.editors.scene_editor import ScenePropertyPanel
    p = ScenePropertyPanel(model)
    p._editing_scene_id = str(scene.get('id') or '')
    model.scenes = {p._editing_scene_id: scene}
    p._load_scene_lights(scene)
    return p


# 合成一盏跟随灯：**真实数据里暂时还没有这种形状**，潜伏破口只能靠合成 fixture 抓
# （editor-change-verification-gate 的「已知盲区」第二条）。整数写法是刻意的：
# `heightWu: 100` 与 `offset: [0, 0, 0]` 一旦被 QDoubleSpinBox 漂成 float，往返就红。
FOLLOW_LIGHT = {
    'id': 'lantern_watchman',
    'kind': 'point',
    'pos': [10, 20, 30],
    'kelvin': 2400,
    'intensity': 6,
    'range': 450,
    'softeningRadius': 10,
    'castShadow': True,
    'enabled': True,
    'follow': {'target': 'npc_甲', 'socket': 'right_hand', 'heightWu': 100,
               'offset': [0, 0, 0]},
}


def _scene_with_follow(follow: dict | None = None, *, extra_light: dict | None = None) -> dict:
    light = copy.deepcopy(FOLLOW_LIGHT)
    if follow is None:
        light.pop('follow', None)
    else:
        light['follow'] = copy.deepcopy(follow)
    lights = [light] + ([extra_light] if extra_light else [])
    block = scene_lights.default_lighting_block()
    block['lights'] = lights
    return {
        'id': 'sc_follow', 'name': 'sc', 'worldWidth': 4000, 'worldHeight': 2251,
        'npcs': [{'id': 'npc_甲', 'label': '甲',
                  'animFile': '/resources/runtime/animation/player_anim/anim.json'},
                 {'id': 'npc_乙', 'label': '乙'}],
        'lighting': block,
    }


# ---------------------------------------------------------------- 最小形态（重点）
class TestMinimalShape:
    """**没有 follow 的灯，打开→保存不得凭空多出 `follow` 键。**

    这是本次改动最容易犯的那一脚：表单字段一律无条件写回（面板里 `range` /
    `softeningRadius` 就是那样写的），照抄一遍就会给全工程每一盏灯塞一个 `follow`。
    """

    def test_没有follow的灯_打开保存不多出follow键(self, model) -> None:
        scene = _scene_with_follow(None)
        panel = _panel(model, scene)
        out: dict = {}
        panel._writeback_scene_lights(out)
        assert 'follow' not in out['lighting']['lights'][0]

    def test_没有follow的灯_跟随块根本没建控件(self, model) -> None:
        """懒建：没展开过就不造控件——这既是省控件，也是往返保真那一道最硬的门
        （`dump()` 直接回吐载入时的深拷贝，一个字节都不经过 Qt 数值控件）。"""
        panel = _panel(model, _scene_with_follow(None))
        assert panel._sl_follow._built is False
        assert panel._sl_follow.dump() is None

    def test_没有follow的灯_改别的字段也不写follow(self, model) -> None:
        """`_on_sl_field_changed` 是**共用**写回口：改强度会把整份表单写一遍。"""
        panel = _panel(model, _scene_with_follow(None))
        panel._sl_intensity.setValue(3.5)
        out: dict = {}
        panel._writeback_scene_lights(out)
        light = out['lighting']['lights'][0]
        assert 'follow' not in light
        assert light['intensity'] == 3.5

    def test_真实场景每一盏灯写回后都没有follow(self, model) -> None:
        scene = _scene('雾津街头.json')
        panel = _panel(model, scene)
        out: dict = {}
        panel._writeback_scene_lights(out)
        for a, b in zip(out['lighting']['lights'], scene['lighting']['lights']):
            assert ('follow' in a) == ('follow' in b), a.get('id')


# ---------------------------------------------------------------- 往返保真
class TestRoundTrip:
    @pytest.mark.parametrize('name', SCENES)
    def test_打开不动就写回_整块逐字符不变(self, model, name) -> None:
        scene = _scene(name)
        panel = _panel(model, scene)
        out: dict = {}
        panel._writeback_scene_lights(out)
        assert _canon(out['lighting']) == _canon(scene['lighting'])

    @pytest.mark.parametrize('name', SCENES)
    def test_逐盏点过一遍再写回_整块逐字符不变(self, model, name) -> None:
        """作者真实动作是"逐盏点开看一眼"。选中会填满表单（跟随灯还会把控件建出来），
        那一遍走完仍然不许改一个字节。"""
        scene = _scene(name)
        panel = _panel(model, scene)
        for i in range(len(scene['lighting'].get('lights') or [])):
            panel._sl_selected = i
            panel._sync_sl_form()
        out: dict = {}
        panel._writeback_scene_lights(out)
        assert _canon(out['lighting']) == _canon(scene['lighting'])

    def test_合成跟随灯_打开不动就写回逐字符不变(self, model) -> None:
        scene = _scene_with_follow(FOLLOW_LIGHT['follow'])
        panel = _panel(model, scene)
        out: dict = {}
        panel._writeback_scene_lights(out)
        assert _canon(out['lighting']) == _canon(scene['lighting'])
        # int 不许漂成 float（`100` ≠ `100.0`，在 JSON 里是两个字节序列）
        got = out['lighting']['lights'][0]['follow']
        assert isinstance(got['heightWu'], int)
        assert all(isinstance(v, int) for v in got['offset'])

    def test_跟随灯选中即把控件建出来并展开(self, model) -> None:
        """折着看不见等于没接进来——配了 follow 的灯必须当场展开。"""
        panel = _panel(model, _scene_with_follow(FOLLOW_LIGHT['follow']))
        w = panel._sl_follow
        assert w._built is True
        assert w._section.is_expanded() is True
        assert w._on.isChecked() is True
        assert w._target.current_id() == 'npc_甲'
        assert w._socket.current_id() == 'right_hand'
        assert w._height.value() == pytest.approx(100.0)

    def test_改同一盏灯的别的字段_follow逐字节不变(self, model) -> None:
        """**这条才是重建路径的判据。**`_on_sl_field_changed` 是共用写回口：改个强度
        就会把 `follow` 整块按控件重建一次。上面那条"打开不动"走的是懒建透传，
        对重建路径一个字节都没验到。"""
        scene = _scene_with_follow(FOLLOW_LIGHT['follow'])
        panel = _panel(model, scene)
        panel._sl_intensity.setValue(7.0)
        out: dict = {}
        panel._writeback_scene_lights(out)
        assert _canon(out['lighting']['lights'][0]['follow']) == \
            _canon(scene['lighting']['lights'][0]['follow'])
        assert out['lighting']['lights'][0]['intensity'] == 7.0

    def test_控件量化不漂移(self, model) -> None:
        """`decimals=3` 会把 `100.123456` 截成 `100.123`，那时数值已不相等、
        `preserve_numeric_repr` 兜不住 ⇒ 靠种子快照回吐磁盘原字面值。

        必须**触发一次重建**（改强度）才测得到——否则走的是懒建透传，恒绿。
        """
        orig = {'target': 'npc_甲', 'heightWu': 100.123456, 'offset': [1.5555555, 0, 0]}
        scene = _scene_with_follow(orig)
        panel = _panel(model, scene)
        panel._sl_intensity.setValue(7.0)
        out: dict = {}
        panel._writeback_scene_lights(out)
        assert out['lighting']['lights'][0]['follow'] == orig

    def test_表单不认识的键原样透传(self, model) -> None:
        """将来给 `LightFollowDef` 加字段时，本版编辑器不许把它吞掉。"""
        scene = _scene_with_follow(
            {'target': 'npc_甲', '__future__': {'lagMs': 80}})
        panel = _panel(model, scene)
        panel._sl_follow._height.setValue(55.0)       # 真动一下，逼着走重建那条路
        out: dict = {}
        panel._writeback_scene_lights(out)
        f = out['lighting']['lights'][0]['follow']
        assert f['__future__'] == {'lagMs': 80}
        assert f['heightWu'] == 55.0

    def test_键序按磁盘原序(self, model) -> None:
        """重建 dict 时原有键回原位置（numeric-roundtrip 契约 4）。键序漂了照样是
        往返破坏——JSON 不排序键，`git diff` 会把整块标成改动。"""
        scene = _scene_with_follow(
            {'offset': [1, 2, 3], 'target': 'npc_甲', 'heightWu': 9, 'socket': 's'})
        panel = _panel(model, scene)
        panel._sl_intensity.setValue(7.0)             # 触发重建
        out: dict = {}
        panel._writeback_scene_lights(out)
        assert list(out['lighting']['lights'][0]['follow']) == \
            ['offset', 'target', 'heightWu', 'socket']

    def test_盘上是坏follow时只读透传_不趁改别的字段删掉它(self, model) -> None:
        """坏元素（`follow` 有块但没 target）必须**显式标记后只读透传**：
        只凭"表单读出来是空的"就重建，会趁作者改强度时把这块静默删掉
        （shared-widget-value-fidelity 契约 5）。"""
        scene = _scene_with_follow({'socket': 'right_hand', 'heightWu': 90})
        panel = _panel(model, scene)
        assert panel._sl_follow._bad_passthrough is True
        panel._sl_intensity.setValue(7.0)                 # 改别的字段
        out: dict = {}
        panel._writeback_scene_lights(out)
        assert out['lighting']['lights'][0]['follow'] == {
            'socket': 'right_hand', 'heightWu': 90}
        assert 'follow' in panel._sl_follow._section._plain_title

    def test_坏follow上作者一动这块_他的意图就算数(self, model) -> None:
        """保值必须与"用户动没动过"配对（契约 6）：不配对的保值会把用户刚改的值盖回去，
        而且那个字段从编辑器里**永远修不好**。"""
        scene = _scene_with_follow({'socket': 'right_hand'})
        panel = _panel(model, scene)
        w = panel._sl_follow
        w._target.set_current('npc_乙')
        w._target.value_changed.emit('npc_乙')            # 真动这一块
        assert w._bad_passthrough is False
        out: dict = {}
        panel._writeback_scene_lights(out)
        assert out['lighting']['lights'][0]['follow'] == {
            'socket': 'right_hand', 'target': 'npc_乙'}

    def test_悬垂目标保值不被清空(self, model) -> None:
        """目标不在本场景（改名了 / 还没建）时必须保值展示，绝不静默顶替成第一候选。"""
        scene = _scene_with_follow({'target': 'npc_根本不存在'})
        panel = _panel(model, scene)
        assert panel._sl_follow._target.current_id() == 'npc_根本不存在'
        out: dict = {}
        panel._writeback_scene_lights(out)
        assert out['lighting']['lights'][0]['follow']['target'] == 'npc_根本不存在'


# ---------------------------------------------------------------- 编辑
class TestAuthoring:
    def test_勾掉跟随_不写follow键(self, model) -> None:
        """不是写 null、不是写空对象——是**这个键不存在**。"""
        panel = _panel(model, _scene_with_follow(FOLLOW_LIGHT['follow']))
        panel._sl_follow._on.setChecked(False)
        out: dict = {}
        panel._writeback_scene_lights(out)
        assert 'follow' not in out['lighting']['lights'][0]

    def test_勾上跟随但还没选目标_不写键且当场说出来(self, model) -> None:
        """`{"target": ""}` 是往数据里塞垃圾（运行时永远解不出目标 ⇒ 这盏灯永远不亮，
        而作者以为配好了）。宁可不写，并在面板上标红。"""
        panel = _panel(model, _scene_with_follow(None))
        w = panel._sl_follow
        w.ensure_built()
        w._on.setChecked(True)
        assert w._on.isChecked() is True, '勾上之后不许被数据重填弹回去'
        out: dict = {}
        panel._writeback_scene_lights(out)
        assert 'follow' not in out['lighting']['lights'][0]
        assert '还没选目标' in w._note.text()

    def test_勾上跟随并选目标_写进follow(self, model) -> None:
        panel = _panel(model, _scene_with_follow(None))
        w = panel._sl_follow
        w.ensure_built()
        w._on.setChecked(True)
        w._target.set_current('npc_乙')
        w._target.value_changed.emit('npc_乙')
        out: dict = {}
        panel._writeback_scene_lights(out)
        assert out['lighting']['lights'][0]['follow'] == {'target': 'npc_乙'}

    def test_缺省值不落键(self, model) -> None:
        """原本没写 `heightWu` / `offset` 且仍是中性默认 ⇒ 不写进去（JSON 不被污染）。"""
        panel = _panel(model, _scene_with_follow({'target': 'npc_甲'}))
        panel._sl_follow._socket.set_current('')
        out: dict = {}
        panel._writeback_scene_lights(out)
        assert out['lighting']['lights'][0]['follow'] == {'target': 'npc_甲'}

    def test_改高度与偏移写得进去(self, model) -> None:
        panel = _panel(model, _scene_with_follow({'target': 'npc_甲'}))
        w = panel._sl_follow
        w._height.setValue(120.0)
        w._offset[0].setValue(-8.5)
        out: dict = {}
        panel._writeback_scene_lights(out)
        f = out['lighting']['lights'][0]['follow']
        assert f['heightWu'] == 120.0
        assert f['offset'] == [-8.5, 0.0, 0.0]

    def test_挂点允许保值自由值(self, model) -> None:
        """候选取不到（该动画包没标挂点）时不能把作者手打的名字清掉。"""
        panel = _panel(model, _scene_with_follow(
            {'target': 'npc_乙', 'socket': '扁担头'}))
        assert panel._sl_follow._socket.current_id() == '扁担头'
        out: dict = {}
        panel._writeback_scene_lights(out)
        assert out['lighting']['lights'][0]['follow']['socket'] == '扁担头'

    def test_换灯型带着跟随走_平行光摘掉(self, model) -> None:
        """`follow` 与 `phases` 同族：与灯型无关的作者意图。但平行光没有位置，
        跟随对它是**静默失效字段**，必须在换型那一刻摘掉。"""
        src = copy.deepcopy(FOLLOW_LIGHT)
        assert scene_lights.retype(src, 'spot')['follow'] == src['follow']
        assert scene_lights.retype(src, 'area')['follow'] == src['follow']
        assert 'follow' not in scene_lights.retype(src, 'directional')
        # 搬过去的是深拷贝：改新的不许串味回源
        out = scene_lights.retype(src, 'spot')
        out['follow']['target'] = 'X'
        assert src['follow']['target'] == 'npc_甲'


# ---------------------------------------------------------------- 手柄门控
class TestPlaceAffordance:
    """配了跟随 ⇒ `pos` 不再参与光照，画布定位必须**停用并说出跟着谁走**。

    护栏从**最外层用户入口**进（norms 过程义务 3）：按钮真点一下、
    画布定位真调一次，不靠"手动把系统摆到断言点"。
    """

    def test_跟随灯上按钮禁用且写出跟着谁走(self, model) -> None:
        panel = _panel(model, _scene_with_follow(FOLLOW_LIGHT['follow']))
        assert panel._sl_place.isEnabled() is False
        assert 'npc_甲' in panel._sl_place.text()

    def test_跟随灯上点按钮进不了定位模式(self, model) -> None:
        panel = _panel(model, _scene_with_follow(FOLLOW_LIGHT['follow']))
        panel._sl_place.click()
        assert panel._sl_place.isChecked() is False
        assert panel._sl_placing is False

    def test_已经点亮着再选中跟随灯_定位模式自动熄掉(self, model) -> None:
        """选中顺序反过来那条路：先点亮定位、再选到跟随灯。不熄的话画布还在等你点。"""
        plain = copy.deepcopy(FOLLOW_LIGHT)
        plain['id'] = 'plain'
        plain.pop('follow', None)
        scene = _scene_with_follow(FOLLOW_LIGHT['follow'], extra_light=plain)
        panel = _panel(model, scene)
        panel._sl_selected = 1                 # 普通灯
        panel._sync_sl_form()
        panel._sl_place.setChecked(True)
        assert panel._sl_placing is True
        panel._sl_selected = 0                 # 跟随灯
        panel._sync_sl_form()
        assert panel._sl_place.isChecked() is False
        assert panel._sl_placing is False

    def test_跟随灯上画布点击不改pos(self, model) -> None:
        scene = _scene_with_follow(FOLLOW_LIGHT['follow'])
        panel = _panel(model, scene)
        panel._sl_placing = True               # 绕过按钮，模拟工具还开着的那一拍
        before = copy.deepcopy(panel._sl_lights()[0]['pos'])
        assert panel.place_selected_light_at(100.0, 200.0) is True
        assert panel._sl_lights()[0]['pos'] == before
        assert 'npc_甲' in panel._sl_status.text()

    def test_普通灯上按钮照旧可用(self, model) -> None:
        panel = _panel(model, _scene_with_follow(None))
        assert panel._sl_place.isEnabled() is True
        assert panel._sl_place.text() == panel._SL_PLACE_TEXT

    def test_门控判据是follow块在不在_不是target填没填(self, model) -> None:
        """运行时 `effectiveLights` 见 `follow` 就跳过原件，管它 target 填没填 ⇒
        只要有这个块，`pos` 就一律不参与光照，画布定位照样得停。"""
        panel = _panel(model, _scene_with_follow({'heightWu': 90}))
        assert panel._sl_place.isEnabled() is False
        assert 'target' in panel._sl_place.text()


# ---------------------------------------------------------------- 布局
class TestLayout:
    """动态加行/按灯型切显隐这两族缺陷 **model 层测不出来**，只有断言实际几何看得见
    （editor-change-verification-gate 的「布局塌陷」）。"""

    def test_首次展开后跟随块不是一条缝(self, model) -> None:
        """判据 = 懒建出来的控件**真的算进了容器高度**。

        实测这条会红的形态：控件建了但没进 `_body_layout`（或建进了别的布局、
        或几何没逐层刷新）⇒ `sizeHint` 高仍是 0，作者点开看到的就是一条缝，
        而 model 层与构造冒烟全绿。
        （显式 `show()` 那一条在本控件上**证不红**——这里的子控件一出生就带 parent，
        不走 bubble_lines 那个"先做顶层再 addWidget"的坑；`show()` 留着是防御，
        不当护栏声称。）
        """
        panel = _panel(model, _scene_with_follow(None))
        w = panel._sl_follow
        assert w._body.sizeHint().height() == 0, '还没建控件时就该是空的'
        w.ensure_built()
        assert w._body.sizeHint().height() > 0, \
            '懒建出来的控件被布局跳过了（少了显式 show / 少了逐层 invalidate）'

    def test_平行光整行隐藏其余灯型显示(self, model) -> None:
        """平行光没有位置，跟随对它是静默失效字段——不许摊在作者面前。"""
        panel = _panel(model, _scene_with_follow(None))
        form = panel._sl_form_layout
        idx, _role = form.getWidgetPosition(panel._sl_follow)
        assert idx >= 0, '跟随块没被加进灯表单（整行显隐会退化成置灰）'
        assert form.isRowVisible(idx) is True
        panel._sl_kind.setCurrentIndex(panel._sl_kind.findData('directional'))
        assert form.isRowVisible(idx) is False


# ---------------------------------------------------------------- 计数口径
class TestBudgetCounting:
    """配了 follow 的灯**照旧算一盏**：运行时它由 `HeldPropSystem` 解成一盏运行时灯，
    进同一批灯槽、吃同一份阴影预算。从计数里摘掉 = 面板报的数比真实占用少，
    而超预算只表现为"跑起来掉帧"。"""

    def test_带影预算把跟随灯算进去(self) -> None:
        lights = [copy.deepcopy(FOLLOW_LIGHT)]
        n, _budget, _over = scene_lights.shadow_budget_status(lights)
        assert n == 1

    def test_灯数上限把跟随灯算进去(self) -> None:
        lights = []
        for i in range(scene_lights.MAX_LIGHTS + 1):
            l = copy.deepcopy(FOLLOW_LIGHT)
            l['id'] = f'l_{i}'
            l['castShadow'] = False
            lights.append(l)
        issues = scene_lights.validate_lights(lights)
        assert any('超过运行时上限' in t for t in issues), issues

    def test_面板状态栏把跟随灯数说出来(self, model) -> None:
        panel = _panel(model, _scene_with_follow(FOLLOW_LIGHT['follow']))
        assert '跟随实体' in panel._sl_status.text()

    def test_follow_light_count只数配了目标的(self) -> None:
        good = copy.deepcopy(FOLLOW_LIGHT)
        empty = copy.deepcopy(FOLLOW_LIGHT)
        empty['id'] = 'e'
        empty['follow'] = {'target': ''}
        plain = copy.deepcopy(FOLLOW_LIGHT)
        plain['id'] = 'p'
        plain.pop('follow', None)
        assert scene_lights.follow_light_count([good, empty, plain]) == 1


# ---------------------------------------------------------------- 候选面
class TestCandidates:
    def test_目标候选是本场景NPC加player(self, model) -> None:
        scene = _scene_with_follow(FOLLOW_LIGHT['follow'])
        panel = _panel(model, scene)
        assert [rid for rid, _ in panel._sl_follow.target_items()] == \
            ['npc_甲', 'npc_乙', 'player']

    def test_挂点候选来自该实体动画包的sockets_json(self, model) -> None:
        """npc_甲 的 animFile 指向 player_anim，那个包标过 `right_hand`。"""
        assert model.socket_names_for_actor('sc_follow', 'npc_甲') == []  # scenes 还没喂
        scene = _scene_with_follow(FOLLOW_LIGHT['follow'])
        panel = _panel(model, scene)
        assert 'right_hand' in [rid for rid, _ in panel._sl_follow.socket_items()]

    def test_没标挂点的目标给空候选(self, model) -> None:
        scene = _scene_with_follow({'target': 'npc_乙'})
        panel = _panel(model, scene)
        assert panel._sl_follow.socket_items() == []

    def test_player的挂点从game_config的animManifest解(self, model) -> None:
        assert ('right_hand', 'right_hand') in model.socket_names_for_actor(None, 'player')

    def test_切页重拉候选不动当前值(self, model) -> None:
        scene = _scene_with_follow({'target': 'npc_根本不存在', 'socket': '扁担头'})
        panel = _panel(model, scene)
        panel._sl_follow.reload_refs_from_model()
        assert panel._sl_follow._target.current_id() == 'npc_根本不存在'
        assert panel._sl_follow._socket.current_id() == '扁担头'


# ---------------------------------------------------------------- 契约对账
class TestSchemaParity:
    def test_表单管的键与TS的LightFollowDef一致(self) -> None:
        """手工镜像必配语义级 parity（norms 不变量 8）：`src/data/types.ts` 里加了字段
        而表单没跟上时，作者在编辑器里配不出来——而且不报错。"""
        from tools.editor.editors.light_follow_ui import FOLLOW_KEYS
        src = (_ROOT / 'src' / 'data' / 'types.ts').read_text(encoding='utf-8')
        i = src.find('export interface LightFollowDef {')
        assert i > 0, '找不到 LightFollowDef —— 权威 schema 改名了？'
        body = src[i:src.find('}', i)]
        for key in FOLLOW_KEYS:
            assert key in body, f'表单有 {key} 而 TS 里没有'
        # 反方向：TS 声明的每个字段名都要在表单里
        import re
        declared = set(re.findall(r'^\s{2}(\w+)\??:', body, re.M))
        assert declared <= set(FOLLOW_KEYS), (
            f'TS 的 LightFollowDef 多出字段 {declared - set(FOLLOW_KEYS)} '
            f'—— 表单没跟上，作者在编辑器里配不出来')

    def test_运行时确实跳过配了follow的作者灯(self) -> None:
        """编辑器这一整套（pos 只当参考点、手柄停用）都建立在这条上。它要是没了，
        同一盏灯会有两份：一份钉在作者写的 pos 上不动。"""
        src = (_ROOT / 'src' / 'core' / 'SceneLightingSystem.ts').read_text(encoding='utf-8')
        assert 'if (l.follow) continue;' in src
