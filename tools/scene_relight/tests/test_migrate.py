"""恒等迁移的配置锁。

`identity_lighting()` 的每一项都在**兑现一个承诺**：迁移后画面逐像素不变。
改坏任何一项都不会报错、不会崩，只会让 28 个场景一起悄悄变脸——
而"到底是哪一次改动让画面变了"事后极难归因。所以逐项锁死。

数学恒等的推导见 `migrate.py` 模块头；这里锁的是**配置本身**。
"""
from __future__ import annotations

import sys
from pathlib import Path

import pytest

_ROOT = Path(__file__).resolve().parents[3]
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

from tools.scene_relight.migrate import (  # noqa: E402
    MAX_SAFE_DAY_HEMI, identity_lighting,
)


@pytest.mark.parametrize('hemi', [0.0, 0.44, 0.92, 0.99])
class TestIdentityContract:
    def test_天光半球权重等于烘焙的day_hemi(self, hemi: float) -> None:
        """恒等的核心：两侧半球项用**同一个数**，比值才恒为 1。"""
        assert identity_lighting(hemi)['sky']['hemi'] == hemi

    def test_天光是纯白且强度为1(self, hemi: float) -> None:
        """任何染色或增益都会让 S_new ≠ S_day。"""
        sky = identity_lighting(hemi)['sky']
        assert sky['color'] == [1.0, 1.0, 1.0]
        assert sky['intensity'] == 1.0

    def test_day不写hemi(self, hemi: float) -> None:
        """刻意留空 → 运行时回落烘焙值，与 sky.hemi 同源。

        写出来会触发项目自己的「day.hemi 别手填」告警，28 个场景一起响
        会把警告通道淹掉——那正是那条规则想防的事。
        """
        assert 'hemi' not in identity_lighting(hemi)['day']

    def test_日光项为0(self, hemi: float) -> None:
        """S_day 里的 `daySun·max(N·L,0)` 一旦非 0，S_new 就配不平。"""
        assert identity_lighting(hemi)['day']['sunIntensity'] == 0.0

    def test_一盏灯都不摆(self, hemi: float) -> None:
        """摆灯是美术的事。恒等迁移不替他做决定，也不能——加灯就不恒等了。"""
        assert identity_lighting(hemi)['lights'] == []

    def test_不去霾(self, hemi: float) -> None:
        """去霾是**故意改变原画**（把白天的大气散射除掉），开着就不是恒等。"""
        assert identity_lighting(hemi)['dehaze'] == 0.0

    def test_不加GI(self, hemi: float) -> None:
        """没有灯时反弹光就是天光照亮的表面，加进去角色会比迁移前亮。"""
        assert identity_lighting(hemi)['giGain'] == 0.0

    def test_灯体自发光为0(self, hemi: float) -> None:
        assert identity_lighting(hemi)['emissive']['gain'] == 0.0

    def test_显示变换是恒等(self, hemi: float) -> None:
        """曝光/tonemap/对比/饱和/提升任一非恒等，输出就不等于原画。

        ⚠ `whiteKelvin` 必须是 **6500**：本仓库的色温表把 6500K 归一为 (1,1,1)
        （见 `kelvin.golden.json`），换个数就等于给整幅画染色。
        """
        d = identity_lighting(hemi)['display']
        assert d['ev'] == 0.0
        assert d['tonemap'] == 'none'
        assert d['whiteKelvin'] == 6500.0
        assert d['contrast'] == 1.0
        assert d['saturation'] == 1.0
        assert d['lift'] == 0.0

    def test_AO强度为1(self, hemi: float) -> None:
        """运行时是 `mix(1, skyvis, aoStrength)`；不为 1 就与 S_day 的裸 skyvis 配不平。"""
        assert identity_lighting(hemi)['aoStrength'] == 1.0

    def test_带占位标记(self, hemi: float) -> None:
        """`placeholder` 是**角色不切新路径**的开关。丢了它，27 个场景的角色会
        一起从烘焙 probe 变成平光——恒等只对背景成立。"""
        assert identity_lighting(hemi)['placeholder'] is True


def test_恒等在数值上成立() -> None:
    """按运行时的式子直接算一遍：任意 skyvis 下比值都是 1。"""
    import numpy as np
    sky = np.linspace(0.0, 1.0, 257)
    for hemi in (0.0, 0.1, 0.5, 0.92, MAX_SAFE_DAY_HEMI):
        cfg = identity_lighting(hemi)
        h = cfg['sky']['hemi']
        ao = cfg['aoStrength']
        s_day = (1.0 - h) + h * sky                    # day.hemi 回落成同一个 h
        vis = 1.0 + ao * (sky - 1.0)                   # mix(1, skyvis, ao)
        s_new = cfg['sky']['intensity'] * ((1.0 - h) + h * vis)
        assert np.abs(s_new / np.maximum(s_day, 1e-4) - 1.0).max() < 1e-9, hemi


def test_不同hemi产出不同配置() -> None:
    """防呆：万一 identity_lighting 忘了用形参，这条会红。"""
    assert identity_lighting(0.2)['sky']['hemi'] != identity_lighting(0.8)['sky']['hemi']


def test_hemi等于1是真边界_不是测试写松了() -> None:
    """`hemi = 1.0` 时恒等会在**全封闭处**塌掉——这条把那个边界钉住。

    `S_day = (1−1) + 1·skyvis = skyvis`，全封闭点 skyvis = 0 ⇒ S_day = 0，
    运行时 `sNew / max(sDay, 1e-4)` 被 epsilon 兜住、比值塌成 0 ⇒ 那些像素**变黑**。

    所以上面那组参数化**刻意不含 1.0**——不是把测试改松躲开失败，
    而是这个取值本来就不该进产线：`migrate()` 用 `MAX_SAFE_DAY_HEMI` 挡掉了它。
    """
    import numpy as np
    cfg = identity_lighting(1.0)
    sky = np.array([0.0, 0.5, 1.0])
    s_day = (1.0 - 1.0) + 1.0 * sky
    s_new = cfg['sky']['intensity'] * ((1.0 - 1.0) + 1.0 * sky)
    ratio = s_new / np.maximum(s_day, 1e-4)
    assert ratio[0] == 0.0, 'skyvis=0 处比值应当塌成 0（这正是要挡掉 hemi=1 的原因）'
    assert np.allclose(ratio[1:], 1.0), '非全封闭处仍然恒等'
    assert MAX_SAFE_DAY_HEMI < 1.0, '守卫上限必须严格小于 1'


def test_守卫挡住过高的hemi(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """拟合出 hemi > 上限的场景必须**拒绝迁移**，而不是静默出黑块。

    用真临时目录，不 mock `Path`：`migrate()` 里有好几处 `Path` 调用，
    把类方法整个换掉会顺带改变别处的行为，测出来的就不是被测逻辑了。
    """
    from tools.scene_relight import migrate as M
    (tmp_path / 'fake.json').write_text(
        '{"id": "fake", "depthConfig": {"M": {"ppu": 1}}}', encoding='utf-8')
    monkeypatch.setattr(M, 'SCENES_JSON', tmp_path)
    monkeypatch.setattr(M, 'baked_day_hemi', lambda _sid: 0.995)
    assert M.migrate('fake').startswith('day-hemi-too-high')

    # 反面：在上限之内就该正常迁移，且原有字段一个不丢
    monkeypatch.setattr(M, 'baked_day_hemi', lambda _sid: MAX_SAFE_DAY_HEMI)
    assert M.migrate('fake') == 'migrated'
    import json as _json
    got = _json.loads((tmp_path / 'fake.json').read_text(encoding='utf-8'))
    assert got['lighting']['placeholder'] is True
    assert got['id'] == 'fake'


def test_已配过的场景不被覆盖(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """手调过的场景**绝不能**被恒等块盖掉——那等于把调好的夜景一键清空。"""
    from tools.scene_relight import migrate as M
    (tmp_path / 'x.json').write_text(
        '{"id": "x", "depthConfig": {"M": {}}, "lighting": {"sky": {"intensity": 0.045}}}',
        encoding='utf-8')
    monkeypatch.setattr(M, 'SCENES_JSON', tmp_path)
    monkeypatch.setattr(M, 'baked_day_hemi', lambda _sid: 0.5)
    assert M.migrate('x') == 'already-configured'
    import json as _json
    got = _json.loads((tmp_path / 'x.json').read_text(encoding='utf-8'))
    assert got['lighting']['sky']['intensity'] == 0.045, '手调参数被覆盖了！'


def test_没烘载荷的场景不迁移(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """没有 `day_hemi` 就无从构造恒等，只能拒绝——不能拿个兜底数糊过去。"""
    from tools.scene_relight import migrate as M
    (tmp_path / 'y.json').write_text(
        '{"id": "y", "depthConfig": {"M": {}}}', encoding='utf-8')
    monkeypatch.setattr(M, 'SCENES_JSON', tmp_path)
    monkeypatch.setattr(M, 'baked_day_hemi', lambda _sid: None)
    assert M.migrate('y') == 'not-baked'
