"""场景灯位的坐标换算与校验。

这份 Python 换算是 `src/utils/worldReconstruct.ts` 的镜像——口径必须一致，
否则编辑器里摆的位置与游戏里渲的位置对不上，而且**不会报错**，只会"看着差一点"。
"""
from __future__ import annotations

import math
import sys
from pathlib import Path

import pytest

_ROOT = Path(__file__).resolve().parents[4]
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

from tools.editor.editors import scene_lights as scene_lights_mod  # noqa: E402
from tools.editor.editors.scene_lights import (  # noqa: E402
    CHARACTER_HEIGHT_WU, DEFAULT_LAMP_RADIUS_WU, DEFAULT_LIGHT_RANGE_WU,
    DEFAULT_SHADOW_BIAS_WU,
    DEFAULT_SHADOW_THICKNESS_WU, MAX_LIGHTS,
    REMOVED_LIGHT_FIELDS, RENAMED_LIGHT_FIELDS,
    SHADOW_LIGHT_BUDGET, SceneLightSpace, default_light,
    LightingSyncClient, LightingSyncTransport, is_sync_doc_stale,
    normalize_dev_base_url, runtime_lighting_base_url,
    set_runtime_lighting_endpoint, should_apply_doc, validate_pulled_lighting,
    default_lighting_block, shadow_budget_status, spot_dir_from_angles,
    validate_lights,
)

C = math.sqrt(0.5)
SCENE = {
    'worldWidth': 4000.0,
    'worldHeight': 2251.2,
    'depthConfig': {
        'depth_map': 'raw_depth_rg.png',
        # 游戏约定 det=+1（**不是**实验室那份 det=−1 的 world.M）
        'M': {'R': [[1, 0, 0], [0, C, -C], [0, C, C]], 'ppu': 450.56, 'cx': 1024.0, 'cy': 576.0},
        'depth_mapping': {'invert': False, 'scale': 3.0, 'offset': -1.0},
    },
}


@pytest.fixture
def space() -> SceneLightSpace:
    return SceneLightSpace('测试场景', SCENE)


class TestCoordChain:
    def test_q_翻Y就在这一步(self, space: SceneLightSpace) -> None:
        # 主点上方一个 ppu → q.y = +1；下方 → −1
        assert space.q_from_native(1024.0, 576.0 - 450.56, 0.0)[1] == pytest.approx(1.0)
        assert space.q_from_native(1024.0, 576.0 + 450.56, 0.0)[1] == pytest.approx(-1.0)
        # x 不翻号
        assert space.q_from_native(1024.0 + 450.56, 576.0, 0.0)[0] == pytest.approx(1.0)

    def test_q_与像素互为逆变换(self, space: SceneLightSpace) -> None:
        for px, py in [(0.0, 0.0), (137.5, 900.25), (2047.0, 1151.0)]:
            q = space.q_from_native(px, py, 0.7)
            bx, by = space.q_to_native(q)
            assert bx == pytest.approx(px, abs=1e-6)
            assert by == pytest.approx(py, abs=1e-6)

    def test_world_与q互为逆变换(self, space: SceneLightSpace) -> None:
        q = (0.31, -0.72, 1.15)
        w = space.q_to_world(q)
        back = space.world_to_q(w)
        for a, b in zip(q, back):
            assert a == pytest.approx(b, abs=1e-9)

    def test_场景坐标与原生像素互为逆变换(self, space: SceneLightSpace) -> None:
        space._native = (2048, 1152)
        for sx, sy in [(0.0, 0.0), (1234.5, 800.0), (3999.0, 2251.0)]:
            px, py = space.scene_to_native_px(sx, sy)
            bx, by = space.native_px_to_scene(px, py)
            assert bx == pytest.approx(sx, abs=1e-6)
            assert by == pytest.approx(sy, abs=1e-6)

    def test_抬高只动世界Y_不换算(self, space: SceneLightSpace) -> None:
        w = (1.0, 0.2, -0.5)
        up = space.raise_world(w, 300.0)        # 抬 300 wu（约 2 个人高）
        assert up[0] == pytest.approx(w[0])
        assert up[2] == pytest.approx(w[2])
        # 抬高只动世界 Y，不碰 x/z；单位就是 wu（角色高 150 wu）
        assert up[1] - w[1] == pytest.approx(300.0)
        assert space.height_wu_above(up, w) == pytest.approx(300.0)


class TestBudget:
    def test_只数带影且启用且非平行光(self) -> None:
        lights = [
            {'kind': 'point', 'castShadow': True, 'enabled': True},
            {'kind': 'point', 'castShadow': True, 'enabled': False},    # 关掉的不算
            {'kind': 'point', 'castShadow': False, 'enabled': True},    # 不投影的不算
            {'kind': 'directional', 'castShadow': True, 'enabled': True},  # 平行光走另一条
        ]
        n, budget, over = shadow_budget_status(lights)
        assert (n, budget, over) == (1, SHADOW_LIGHT_BUDGET, False)

    def test_超预算要能判出来(self) -> None:
        lights = [{'kind': 'point', 'castShadow': True, 'enabled': True}
                  for _ in range(SHADOW_LIGHT_BUDGET + 1)]
        n, _, over = shadow_budget_status(lights)
        assert over and n == SHADOW_LIGHT_BUDGET + 1


class TestValidate:
    def test_缺省灯合法(self) -> None:
        for kind in ('point', 'spot', 'area', 'directional'):
            assert validate_lights([default_light(1, kind)]) == []

    def test_抓_id重复(self) -> None:
        a, b = default_light(1), default_light(1)
        assert any('重复' in s for s in validate_lights([a, b]))

    def test_抓_range非正(self) -> None:
        l = default_light(1)
        l['range'] = 0
        assert any('range 必须 > 0' in s for s in validate_lights([l]))

    def test_抓_聚光锥角内外反了(self) -> None:
        l = default_light(1, 'spot')
        l['innerAngleDeg'], l['outerAngleDeg'] = 50.0, 20.0
        assert any('锥角' in s for s in validate_lights([l]))

    def test_抓_面光缺尺寸(self) -> None:
        l = default_light(1, 'area')
        l.pop('size')
        assert any('size' in s for s in validate_lights([l]))

    def test_抓_超灯数上限(self) -> None:
        many = [default_light(i) for i in range(MAX_LIGHTS + 2)]
        assert any('上限' in s for s in validate_lights(many))


class TestDefaults:
    def test_缺省块刻意不写_day_hemi(self) -> None:
        """day.hemi 是原画自己的遮蔽响应，由烘焙拟合。手填必错（角落会黑两遍）。"""
        block = default_lighting_block()
        assert 'hemi' not in block['day']

    def test_缺省块四个必需键齐全(self) -> None:
        block = default_lighting_block()
        for k in ('sky', 'day', 'lights', 'display'):
            assert k in block, k

    def test_平行光不带位置与半径(self) -> None:
        d = default_light(1, 'directional')
        assert 'pos' not in d and 'range' not in d and 'softeningRadius' not in d
        assert 'elevationDeg' in d and 'azimuthDeg' in d


def test_聚光方向与运行时同式() -> None:
    """与 `SceneLightingPass.directionFromAngles` 逐项一致。"""
    for elev, azim in [(0, 0), (45, 90), (30, 210), (80, 359)]:
        e, a = math.radians(elev), math.radians(azim)
        want = [math.cos(e) * math.sin(a), math.sin(e), math.cos(e) * math.cos(a)]
        got = spot_dir_from_angles(elev, azim)
        for x, y in zip(want, got):
            assert x == pytest.approx(y, abs=1e-12)


# ---------------------------------------------------------------- 角色阴影绑定
# 守的是制作人定死的那条：**必须手动指定，禁止自动 resolve**。
# 所以"绑丢了"必须当场看得出来 —— 运行时的表现是"没有影子",
# 而画面上分不清那是配错了还是本来就该没有。

from tools.editor.editors import scene_lights as scene_lights_mod  # noqa: E402
from tools.editor.editors.scene_lights import (  # noqa: E402
    MAX_SHADOW_BINDINGS, default_shadow_binding, shadow_binding_label,
    validate_shadow_bindings,
)

_LIGHTS = [{'id': 'lamp', 'kind': 'point'}, {'id': 'moon', 'kind': 'directional'}]


class TestShadowBindingDefaults:
    def test_缺省是不投影(self) -> None:
        assert default_shadow_binding()['source'] == 'none'

    def test_虚拟灯缺省给一组看得见的角度(self) -> None:
        v = default_shadow_binding('virtual')['virtual']
        assert 0 <= v['azimuthDeg'] <= 360
        assert 25 <= v['elevationDeg'] <= 80
        assert 0 < v['darkness'] <= 1
        assert v['length'] == 0      # 0 = 按仰角自动算


class TestShadowBindingLabel:
    def test_绑到不存在的灯当场标出来(self) -> None:
        s = shadow_binding_label({'source': 'light:nope'}, _LIGHTS)
        assert '⚠' in s and 'nope' in s

    def test_绑到存在的灯不报警(self) -> None:
        assert '⚠' not in shadow_binding_label({'source': 'light:lamp'}, _LIGHTS)

    def test_不投影与虚拟灯各有可读标签(self) -> None:
        assert shadow_binding_label({'source': 'none'}) == '不投影'
        assert '虚拟灯' in shadow_binding_label(default_shadow_binding('virtual'))


class TestShadowBindingValidate:
    def test_合法组合零问题(self) -> None:
        ok = [{'source': 'light:lamp'}, default_shadow_binding('virtual'), {'source': 'none'}]
        assert validate_shadow_bindings(ok, _LIGHTS) == []

    def test_绑到不存在的灯报错(self) -> None:
        issues = validate_shadow_bindings([{'source': 'light:ghost'}], _LIGHTS)
        assert len(issues) == 1 and 'ghost' in issues[0]

    def test_virtual缺块报错(self) -> None:
        issues = validate_shadow_bindings([{'source': 'virtual'}], _LIGHTS)
        assert issues and 'virtual' in issues[0]

    def test_未知source报错(self) -> None:
        assert validate_shadow_bindings([{'source': 'auto'}], _LIGHTS)

    def test_缺source报错(self) -> None:
        assert validate_shadow_bindings([{}], _LIGHTS)

    def test_覆盖字段必须是数值(self) -> None:
        issues = validate_shadow_bindings([{'source': 'none', 'darkness': 'dark'}], _LIGHTS)
        assert issues and 'darkness' in issues[0]

    def test_超过条数上限报错(self) -> None:
        many = [{'source': 'none'}] * (MAX_SHADOW_BINDINGS + 1)
        assert any('上限' in i for i in validate_shadow_bindings(many, _LIGHTS))


# ------------------------------------------------- 作者面 wu vs 伪世界 q
#
# 灯摆在**世界空间**,单位 **wu** —— 与 NPC、热区、spawn、碰撞同一把尺
# (`worldWidth` 就是世界宽度;角色高 **150 wu**,28 个场景恒定)。
#
# shader 里 march 走的是**伪世界 q**(深度重建出来的),两者差一个逐场景的比例
# `wu_per_q = worldWidth / (native_w / ppu)`(雾津街头 880、teahouse 154)。
# 那一次 transform 在 `packLights` 与 `SceneLightSpace` 里,作者不必知道。
#
# 这里错过两次,都不要回退:
# ① 给所有长度加 `*Meters` 后缀,换算系数取 `1.7 / char_wu`(假设角色 1.7 米高)
#    ——游戏里没有米,凭空造的单位。
# ② 把**伪世界 q 单位**叫成 wu,还说"同一个 wu 在不同场景差 5.7 倍"
#    ——那是把相机变换当成了世界单位的变化。判据:角色在 wu 里 28 个场景**恒为 150**。

def test_角色高度在所有场景都是_150_wu() -> None:
    """这是 wu 一致的判据。若哪天它不再恒定,说明标定链断了。"""
    import json
    rt = _ROOT / 'public' / 'resources' / 'runtime' / 'scenes'
    heights = []
    # 烘焙产物按背景图名分目录，probe 与几何场同住 lighting/<背景基名>/。

    for meta in rt.glob('*/lighting/*/geometry.json'):
        sc = json.loads(meta.read_text('utf-8')).get('scale') or {}
        if sc.get('char_wu') and sc.get('scene_per_wu'):
            heights.append(sc['char_wu'] * sc['scene_per_wu'])
    assert len(heights) >= 20, len(heights)
    assert all(abs(h - CHARACTER_HEIGHT_WU) < 0.5 for h in heights), sorted(set(
        round(h, 2) for h in heights))


def test_缺省值按角色身高定() -> None:
    assert CHARACTER_HEIGHT_WU == 150
    assert DEFAULT_LIGHT_RANGE_WU / CHARACTER_HEIGHT_WU == pytest.approx(3.0, abs=0.1)
    assert DEFAULT_LAMP_RADIUS_WU / CHARACTER_HEIGHT_WU == pytest.approx(1 / 15, abs=0.01)
    assert DEFAULT_SHADOW_THICKNESS_WU / CHARACTER_HEIGHT_WU == pytest.approx(1.76, abs=0.1)
    # 刻意不取整：精确等于 wu 重构之前那一版的效果（÷880 = 0.035 / 0.3）
    assert DEFAULT_SHADOW_BIAS_WU / 880 == pytest.approx(0.035, abs=1e-12)
    assert DEFAULT_SHADOW_THICKNESS_WU / 880 == pytest.approx(0.3, abs=1e-12)


def test_缺省灯不带任何场景相关的入参() -> None:
    """防回退:一旦有人再引入"按场景折算缺省值",这条签名就会变。"""
    import inspect
    assert list(inspect.signature(default_light).parameters) == ['index', 'kind']
    assert default_light(1, 'point') == default_light(1, 'point')
    assert not hasattr(scene_lights_mod, 'seed_length'), '播种函数应当已删'


def test_缺省块的长度字段都是_wu() -> None:
    blk = default_lighting_block()
    flat = repr(blk)
    assert 'Meters' not in flat, blk
    sb = blk['shadowBias']
    assert sb['bias'] == DEFAULT_SHADOW_BIAS_WU == 30.8
    assert sb['thickness'] == DEFAULT_SHADOW_THICKNESS_WU == 264
    # 角色高 150 wu —— 厚度窗约 1.7 个人高，一堵墙的进深
    assert 1.0 < sb['thickness'] / 150 < 3.0


def test_与运行时缺省同值() -> None:
    """编辑器这份是运行时 `lightPacking.ts` 的镜像，分家了不会报错、只会不一致。"""
    src = (_ROOT / 'src' / 'rendering' / 'lighting' / 'lightPacking.ts').read_text('utf-8')
    for name, val in (
        ('DEFAULT_LAMP_RADIUS_WU', DEFAULT_LAMP_RADIUS_WU),
        ('DEFAULT_LIGHT_RANGE_WU', DEFAULT_LIGHT_RANGE_WU),
        ('DEFAULT_SHADOW_BIAS_WU', DEFAULT_SHADOW_BIAS_WU),
        ('DEFAULT_SHADOW_THICKNESS_WU', DEFAULT_SHADOW_THICKNESS_WU),
    ):
        assert (f'export const {name} = {val};' in src
                or f'export const {name} = {val:g};' in src), name


def test_运行时侧已经没有米这个概念() -> None:
    """防回退:只要有人再往光照里加 `*Meters` 字段或换算系数,这条就红。"""
    for rel in ('src/rendering/lighting/lightPacking.ts',
                'src/rendering/entityShadowBinding.ts'):
        src = (_ROOT / rel).read_text('utf-8')
        code = [ln for ln in src.splitlines()
                if not ln.strip().startswith(('*', '//', '/*'))]
        joined = ' '.join(code)
        assert 'Meters' not in joined, rel
        assert 'metersPerWu' not in joined, rel


def test_删掉的字段留在数据里必须报出来() -> None:
    for gone in REMOVED_LIGHT_FIELDS:
        l = default_light(1)
        l[gone] = 2
        assert any(gone in t for t in validate_lights([l])), gone


def test_删除表覆盖两个且各带理由() -> None:
    assert set(REMOVED_LIGHT_FIELDS) == {'shadowSamples', 'dynamic'}
    for why in REMOVED_LIGHT_FIELDS.values():
        assert len(why) > 10, why


def test_运行时类型里确实没有这两个字段了() -> None:
    """删了类型却留着数据契约文档，等于没删。"""
    src = (_ROOT / 'src' / 'data' / 'types.ts').read_text('utf-8')
    for gone in REMOVED_LIGHT_FIELDS:
        assert f'{gone}?:' not in src, gone


def test_面光双面是布尔且只对面光有意义() -> None:
    area = default_light(1, 'area')
    assert area['twoSided'] is False
    assert validate_lights([area]) == []
    area['twoSided'] = True
    assert validate_lights([area]) == []
    area['twoSided'] = 'yes'
    assert any('twoSided' in t for t in validate_lights([area]))
    # 点光勾双面 = 作者以为它有用
    pt = default_light(1, 'point')
    pt['twoSided'] = True
    assert any('twoSided' in t for t in validate_lights([pt]))


# ---------------------------------------------------------------------------
# 「从运行时拉取灯位」的校验
#
# 拉取是**整块替换** lighting。这一组锁的是"半个对象进不来"——不然会把这个场景
# 调好的天光/雾/显示变换一起冲掉，而且当场看不出来，要下次跑起来才发现。
# ---------------------------------------------------------------------------

GOOD_PAYLOAD = {
    'sceneId': 'wujin',
    'lighting': {
        'sky': {'intensity': 0.05, 'hemi': 0.85},
        'day': {'sunIntensity': 0.0, 'sunElevationDeg': 50.0, 'sunAzimuthDeg': 180.0},
        'lights': [{'id': 'lamp_1', 'kind': 'point', 'intensity': 2.5}],
        'display': {'ev': 0.0, 'tonemap': 'filmic'},
        'fog': {'sigma': 0.0},
    },
}


def test_pull_accepts_full_block():
    lit, err = validate_pulled_lighting(GOOD_PAYLOAD, 'wujin')
    assert err == ''
    assert lit is not None
    # 整块透传：编辑器面板不显示的键（fog）也必须原样带过来
    assert lit['fog'] == {'sigma': 0.0}
    assert len(lit['lights']) == 1


@pytest.mark.parametrize('drop', ['sky', 'day', 'lights', 'display'])
def test_pull_rejects_missing_required_key(drop):
    payload = {'sceneId': 'wujin',
               'lighting': {k: v for k, v in GOOD_PAYLOAD['lighting'].items() if k != drop}}
    lit, err = validate_pulled_lighting(payload, 'wujin')
    assert lit is None
    assert drop in err


def test_pull_refuses_cross_scene():
    """游戏停在别的场景时拉取 = 把灯摆进错的场景。必须拒绝，不能"反正拉回来了"。"""
    lit, err = validate_pulled_lighting(GOOD_PAYLOAD, 'teahouse')
    assert lit is None
    assert 'wujin' in err and 'teahouse' in err


def test_pull_rejects_non_dict_and_missing_lighting():
    assert validate_pulled_lighting(None, 'wujin')[0] is None
    assert validate_pulled_lighting({'sceneId': 'wujin'}, 'wujin')[0] is None
    assert validate_pulled_lighting({'lighting': {}}, 'wujin')[0] is None


def test_localhost_is_normalized_to_ipv4():
    """vite 只监听 IPv4，urllib 先试 ::1 —— 照抄 vite 日志里的 localhost 会每次白等到超时，
    而且表现为"同步没反应"不报错。实测 localhost 3 秒超时、127.0.0.1 0.00 秒返回。"""
    assert normalize_dev_base_url('http://localhost:5173/') == 'http://127.0.0.1:5173'
    assert normalize_dev_base_url('http://127.0.0.1:5173') == 'http://127.0.0.1:5173'
    assert normalize_dev_base_url('') == ''


def test_endpoint_registration_roundtrip():
    """没装基址时同步整体不启用——不能默默去连一个猜出来的端口。"""
    assert runtime_lighting_base_url() == ''
    try:
        set_runtime_lighting_endpoint(lambda: 'http://localhost:5173/')
        assert runtime_lighting_base_url() == 'http://127.0.0.1:5173'
        # 取地址炸了也只是同步不可用，不能把异常抛进编辑器
        set_runtime_lighting_endpoint(lambda: 1 / 0)
        assert runtime_lighting_base_url() == ''
    finally:
        set_runtime_lighting_endpoint(None)
    assert runtime_lighting_base_url() == ''


# ---------------------------------------------------------------------------
# 双向同步的判定规则
#
# 同一套规则两边各实现一份（这里 Python、运行时 `src/dev/runtimeLightingSync.ts`）。
# 规则分家不报错，只表现为"某一边偶尔不跟"——极难查。两边各锁一份同口径的测试。
# ---------------------------------------------------------------------------

SYNC_DOC = {
    'rev': 5,
    'writer': 'game:1',
    'sceneId': 'wujin',
    'lighting': {'sky': {}, 'day': {}, 'lights': [], 'display': {}},
}


def test_sync_applies_fresh_foreign_doc_of_same_scene():
    assert should_apply_doc(SYNC_DOC, 'editor:9', 4, 'wujin') is True


def test_sync_ignores_own_writes():
    """自己写的读回来再写一遍 = 回声写循环，两边会一直互相刷。"""
    assert should_apply_doc(SYNC_DOC, 'game:1', 4, 'wujin') is False


def test_sync_ignores_seen_or_older_rev():
    assert should_apply_doc(SYNC_DOC, 'editor:9', 5, 'wujin') is False
    assert should_apply_doc(SYNC_DOC, 'editor:9', 6, 'wujin') is False


def test_sync_never_applies_across_scenes():
    """跨场景套用 = 把灯摆进错的场景，且当场看不出来。"""
    assert should_apply_doc(SYNC_DOC, 'editor:9', 4, 'teahouse') is False
    assert should_apply_doc(SYNC_DOC, 'editor:9', 4, '') is False


def test_sync_rejects_malformed_docs():
    assert should_apply_doc(None, 'editor:9', 0, 'wujin') is False
    assert should_apply_doc({'rev': 'x', 'writer': 'g', 'sceneId': 'wujin'},
                            'editor:9', 0, 'wujin') is False
    broken = dict(SYNC_DOC, lighting={'sky': {}, 'day': {}, 'display': {}})
    assert should_apply_doc(broken, 'editor:9', 0, 'wujin') is False


def test_sync_client_does_not_echo_what_it_just_applied():
    """吃进来之后不能立刻又发回去——那就是两边互相刷到天荒地老。"""
    c = LightingSyncClient('editor:9')
    lit = c.plan_apply(SYNC_DOC, 'wujin')
    assert lit is not None
    c.note_applied(lit, SYNC_DOC['rev'])
    assert c.needs_publish(lit) is False
    # 本地真改了才发
    changed = dict(lit, lights=[{'id': 'lamp_1', 'kind': 'point'}])
    assert c.needs_publish(changed) is True


def test_sync_client_ignores_editor_only_height_field():
    """`_editorHeightWu` 是派生量：它变了不代表参数变了，不该触发一轮发布。"""
    c = LightingSyncClient('editor:9')
    base = {'sky': {}, 'day': {}, 'display': {},
            'lights': [{'id': 'l1', 'kind': 'point', 'pos': [0, 0, 0]}]}
    c.note_published(base, 1)
    withh = {'sky': {}, 'day': {}, 'display': {},
             'lights': [{'id': 'l1', 'kind': 'point', 'pos': [0, 0, 0],
                         '_editorHeightWu': 300.0}]}
    assert c.needs_publish(withh) is False


def test_sync_client_records_rev_of_own_doc_so_it_stops_reevaluating():
    c = LightingSyncClient('game:1')
    assert c.plan_apply(SYNC_DOC, 'wujin') is None      # 自己写的
    assert c.last_seen_rev == 5


def test_sync_client_reset_forces_republish_after_scene_change():
    """换场景后基线作废：新场景的第一份内容不是"已与对面对齐"。"""
    c = LightingSyncClient('editor:9')
    lit = {'sky': {}, 'day': {}, 'lights': [], 'display': {}}
    c.note_published(lit, 3)
    assert c.needs_publish(lit) is False
    c.reset()
    assert c.needs_publish(lit) is True


def test_stale_slot_is_not_auto_applied():
    """槽是“当前会话的对讲机”不是状态存档。与运行时 isDocStale 同口径。"""
    assert is_sync_doc_stale(6 * 60 * 1000) is True
    assert is_sync_doc_stale(60 * 1000) is False
    assert is_sync_doc_stale(None) is False


# ---------------------------------------------------------------------------
# 连接层：不许"连着连着就没了"
#
# 制作人的硬要求。三种真实死法：请求挂死、失败后死磕、断了没人知道；
# 第四种是 dev server 换了端口就永远连不上。这一组逐条锁住。
# ---------------------------------------------------------------------------


def _transport(primary='http://localhost:5173/'):
    return LightingSyncTransport(lambda: primary)


def test_transport_backs_off_and_recovers_immediately():
    """连不上时逐步放慢（别白占 UI 线程），一成功立刻回到全速。"""
    t = _transport()
    assert t.poll_ms() == 400
    t._note_fail('boom')
    assert t.poll_ms() == 800
    for _ in range(8):
        t._note_fail('boom')
    assert t.poll_ms() == 3000          # 封顶
    t._note_ok('http://127.0.0.1:5173', 1000.0)
    assert t.poll_ms() == 400           # 一成功立刻恢复


def test_transport_due_respects_backoff():
    t = _transport()
    assert t.due(1000.0, 700.0) is False        # 才过 300ms
    assert t.due(1000.0, 600.0) is True         # 满 400ms
    t._note_fail('boom')
    assert t.due(1000.0, 600.0) is False        # 退避到 800ms 了


def test_transport_sticks_to_the_port_that_answered():
    """试通了就钉住：每拍重新轮候选会让请求打到别的服务上。"""
    t = _transport()
    t._note_ok('http://127.0.0.1:5178', 1000.0)
    assert t._current_base() == 'http://127.0.0.1:5178'
    assert t.candidates()[0] == 'http://127.0.0.1:5178'


def test_transport_rotates_ports_when_the_stuck_one_dies():
    """dev server 换了端口（或用户自己在别的端口起的服）：死盯一个地址就是永远连不上。"""
    t = _transport(primary='')
    t._note_ok('http://127.0.0.1:5173', 1000.0)
    first = t._current_base()
    t._note_fail('connection refused')
    second = t._current_base()
    assert first == 'http://127.0.0.1:5173'
    assert second != first              # 松开钉子、换下一个候选
    assert second in t.candidates()


def test_transport_never_lets_a_broken_primary_url_getter_kill_sync():
    t = LightingSyncTransport(lambda: 1 / 0)
    assert t.candidates()               # 还有端口候选表兜着
    assert t._current_base().startswith('http://127.0.0.1:')


def test_transport_status_line_makes_disconnection_visible():
    """断了必须看得见——静默掉线是最难查的一种坏。

    ⚠ 2026-08-22 收紧：光"连没连上"不够。那次编辑器半边一次都没跑过，而状态行
      只报连通性，于是看着完全正常。现在"连着但没收发过"必须自己喊出来，
      "同步中"只留给真的收发过的情形。完整四态见 tests/test_lighting_sync_status.py。
    """
    t = _transport()
    assert '等待连接' in t.status_line(1000.0)          # 还没连过
    t._note_ok('http://127.0.0.1:5173', 1000.0)
    # 连上了但还没收发过 —— 不许说"同步中"
    assert '一次都没收发过' in t.status_line(1100.0)
    t.published = 1
    assert '同步中' in t.status_line(1100.0)
    t._note_fail('connection refused')
    line = t.status_line(6000.0)
    assert '已断' in line and '重连' in line



def test_换灯型不丢时段归属() -> None:
    """`phases` 是与类型无关的作者意图（这盏灯在哪些时段亮），换型必须跟着走。

    漏了它的症状：把点光换成聚光，夜里那组灯就全天亮了，而换型那一刻画面上看不出来。
    """
    from tools.editor.editors.scene_lights import retype
    src = {'id': 'lamp_1', 'kind': 'point', 'intensity': 2.0,
           'pos': [1, 2, 3], 'phases': ['夜']}
    for kind in ('spot', 'area', 'directional', 'point'):
        got = retype(src, kind)
        assert got.get('phases') == ['夜'], f'换成 {kind} 后丢了 phases: {got.get("phases")!r}'
    # 拷贝而不是共享引用：改新灯的 phases 不该动到旧灯
    got = retype(src, 'spot')
    got['phases'].append('暮')
    assert src['phases'] == ['夜']


def test_没配时段的灯换型后仍然没有这个键() -> None:
    """缺省=全时段。换型不该凭空造出一个空数组（那会让人以为"配过了"）。"""
    from tools.editor.editors.scene_lights import retype
    got = retype({'id': 'a', 'kind': 'point', 'intensity': 1}, 'spot')
    assert 'phases' not in got
