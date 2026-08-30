"""时段视图的**底图**这一半:与运行时逐条对账。

时段轴此前只管「实体显不显」。制作人 2026-08-30 定的模型是**夜靠换一张夜原画**得到
(原画即最终光照),于是切到夜视图却不换底图,画布上就是「白天的街 + 夜里的人」——
策划照着那张图排位必然排歪,而画布上一切看着都正常。

这份测试锁两件事:
1. Python 侧的时段背景解析与运行时 `resolveSceneAppearance` 的背景那一支**同口径**;
2. 图名白名单与运行时 `AssetManager.loadSceneData` 的那道闸**同口径**
   (放宽了但没拆:只认场景自己声明过的)。

编辑器规范第 8 条:手工镜像必须配语义级对账,不只锁存在性。
"""
from __future__ import annotations

import sys
from pathlib import Path

_ROOT = Path(__file__).resolve().parents[3]
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

from tools.editor.shared.scene_view_filters import (  # noqa: E402
    declared_background_images, phase_backgrounds, phase_primary_background,
)

_DAY = [{"image": "background.png", "x": 0, "y": 0}]
_NIGHT = [{"image": "background-night.png", "x": 0, "y": 0}]


def _scene(**kw) -> dict:
    sc = {"backgrounds": list(_DAY)}
    sc.update(kw)
    return sc


# ---------------------------------------------------------------------------
# 解析口径
# ---------------------------------------------------------------------------

def test_没开日夜的场景_时段视图不换底图() -> None:
    """总闸没开时整条时段轴不生效 —— 底图这一半也一样。

    口径抄运行时 `resolveSceneAppearance` 的 `scene.dayNight?.enabled === true`。
    这里若按 truthy 判,一个写了 `dayNight: {}` 的旧场景会在夜视图下去找一张
    根本不存在的图,画布画占位灰底,而游戏里好好的。
    """
    sc = _scene(timeVariants={"夜": {"backgrounds": list(_NIGHT)}})
    assert phase_primary_background(sc, "夜") == "background.png"
    sc["dayNight"] = {}
    assert phase_primary_background(sc, "夜") == "background.png"
    sc["dayNight"] = {"enabled": "true"}          # 真值字符串不算开
    assert phase_primary_background(sc, "夜") == "background.png"
    sc["dayNight"] = {"enabled": True}
    assert phase_primary_background(sc, "夜") == "background-night.png"


def test_该时段没配变体_回落白天那张() -> None:
    sc = _scene(dayNight={"enabled": True},
                timeVariants={"夜": {"backgrounds": list(_NIGHT)}})
    assert phase_primary_background(sc, "暮") == "background.png"
    assert phase_primary_background(sc, "") == "background.png"


def test_变体配了别的键但没配背景_仍用白天那张() -> None:
    """只想给夜换套环境参数、底图沿用白天 —— 这是合法配置,不该解析成空。"""
    sc = _scene(dayNight={"enabled": True},
                timeVariants={"夜": {"lighting": {"fog": {"sigma": 0.4}}}})
    assert phase_primary_background(sc, "夜") == "background.png"
    assert phase_backgrounds(sc, "夜") == _DAY


def test_空背景数组按没配处理() -> None:
    """与运行时 `v.backgrounds?.length ? ... : base` 同式 —— 空数组不顶掉基底。

    判成"顶掉"的话画布会是一张空白,而游戏里显示的是白天那张。
    """
    sc = _scene(dayNight={"enabled": True}, timeVariants={"夜": {"backgrounds": []}})
    assert phase_backgrounds(sc, "夜") == _DAY


def test_多层背景整组替换而不是逐层合并() -> None:
    """运行时是整个 `backgrounds` 数组换掉,不按层号对位合并。

    逐层合并会造出一个作者从没配过的组合(夜的第一层 + 白天的第二层),
    而且只在多层场景上才出错。
    """
    day = [{"image": "background.png"}, {"image": "fg.png"}]
    sc = {"backgrounds": day, "dayNight": {"enabled": True},
          "timeVariants": {"夜": {"backgrounds": list(_NIGHT)}}}
    assert phase_backgrounds(sc, "夜") == _NIGHT      # 前景层不残留


def test_脏数据不抛异常_回落白天() -> None:
    """场景 JSON 是人手改的,画布不许因为一个坏键整页崩。"""
    for bad in (None, [], [{}], [{"image": "  "}], "background.png"):
        sc = {"backgrounds": list(_DAY), "dayNight": {"enabled": True},
              "timeVariants": {"夜": {"backgrounds": bad}}}
        assert phase_primary_background(sc, "夜") == "background.png"
    assert phase_primary_background({}, "夜") == "background.png"


# ---------------------------------------------------------------------------
# 白名单:与运行时那道闸对账
# ---------------------------------------------------------------------------

def test_白名单_恒含白天那张且含声明过的时段背景() -> None:
    sc = _scene(timeVariants={"夜": {"backgrounds": list(_NIGHT)},
                              "暮": {"backgrounds": [{"image": "bg-dusk.png"}]}})
    assert declared_background_images(sc) == {
        "background.png", "background-night.png", "bg-dusk.png"}


def test_白名单不受总闸影响() -> None:
    """闸是「这名字**允许**出现吗」,与「此刻用哪张」是两件事。

    把总闸并进白名单会让一个没开日夜、但主背景写着时段图名的场景在编辑器里
    解析失败 —— 而运行时的白名单里根本没有这道闸,两边就漂了。
    """
    sc = _scene(timeVariants={"夜": {"backgrounds": list(_NIGHT)}})
    assert "background-night.png" in declared_background_images(sc)


def test_白名单没被拆掉_任意图名照旧拒绝() -> None:
    sc = _scene(timeVariants={"夜": {"backgrounds": list(_NIGHT)}})
    assert "raw_depth_rg.png" not in declared_background_images(sc)
    assert "collision.png" not in declared_background_images(sc)


def test_白名单与运行时那道闸逐条同形() -> None:
    """镜像对账:运行时的 `declared` 集合怎么攒的,这边就得怎么攒。"""
    src = (_ROOT / 'src' / 'core' / 'AssetManager.ts').read_text(encoding='utf-8')
    assert "const declared = new Set<string>(['background.png']);" in src, (
        '运行时白名单的基底变了 —— 编辑器这份镜像要跟着改')
    assert 'raw.timeVariants ?? {}' in src, (
        '运行时不再从 timeVariants 收集声明过的图名 —— 两边口径已漂')


# ---------------------------------------------------------------------------
# 落到画布:两个画布都得换底图
# ---------------------------------------------------------------------------

def test_老画布切时段会换底图() -> None:
    from tools.editor.editors import scene_editor as SE
    src = Path(SE.__file__).read_text(encoding='utf-8')
    i = src.find('def _apply_phase_view_to_canvas')
    assert i > 0
    body = src[i:i + 400]
    assert '_apply_phase_background' in body, (
        '切时段只贴了实体显隐、没换底图 —— 画布会是「白天的街 + 夜里的人」')
    # 场景切换路径同样要一步落到正确那张,不能先画白天再纠正
    j = src.find('def _load_scene_body')
    assert '_phase_view_id()' in src[j:j + 4000], (
        '切场景时没带上当前时段视图 —— 停在夜视图切场景会看到白天的底图')


def test_新画布切时段会换底图() -> None:
    from tools.editor.editors.scene_v2 import page as P
    src = Path(P.__file__).read_text(encoding='utf-8')
    i = src.find('def _on_axis_combo_changed')
    assert i > 0
    assert '_refresh_background' in src[i:i + 600], (
        'v2 画布切时段没换底图 —— 两个画布对同一份数据长相不同')
    j = src.find('def _refresh_background')
    assert '_phase_view_id()' in src[j:j + 900], (
        'v2 的底图解析没带时段 —— 轴变了也只会重画同一张')


def test_世界尺寸不跟着底图变() -> None:
    """各时段共享碰撞/深度,所以背景**必须同尺寸**(校验器有闸)。

    画布若按夜图重算世界尺寸,一张尺寸配错的夜图会让画布坐标系整体跑偏,
    而作者看到的是"实体位置全变了"——反推不到根因在一张图的像素尺寸上。
    """
    from tools.editor.editors import scene_editor as SE
    src = Path(SE.__file__).read_text(encoding='utf-8')
    i = src.find('def _apply_phase_background')
    assert i > 0
    body = src[i:src.find('def ', i + 10)]
    assert 'setup_world' not in body, '切时段重设了世界尺寸 —— 尺寸配错的夜图会让坐标系跑偏'
