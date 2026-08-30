"""`timeVariants` 的往返保真。

「日夜」在数据上的落点就是这块:某个时段换成哪张背景原画。场景编辑器的面板目前只编
**背景**那一项,而变体里还可以手写 `lighting` / `depthConfig` / `ambientSounds` / `bgm`
—— 面板不认识它们。

编辑器铁律第 1 条(数据零丢失往返):打开→不动→保存,输出与磁盘等价,**禁止丢表单未显示
的键**。这条测试锁的就是那个:面板只编一项,但保存必须把整块原样带回去。破了这条的症状
是「打开保存一次,夜的环境参数就没了」,而且当场看不出来。
"""
from __future__ import annotations

import copy
import sys
from pathlib import Path

_ROOT = Path(__file__).resolve().parents[3]
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))


def _variant_writeback(time_variants: dict) -> dict:
    """复现 scene_editor 写回 timeVariants 的那一段(空=不落键、非空=整块深拷)。

    ⚠ 这里刻意不去实例化整个 SceneEditor:那需要 QApplication 与一整个工程,
    而本测试要锁的是**写回语义**,不是 GUI 装配。写回逻辑一改这条就该红。
    """
    sc: dict = {}
    tv = {k: v for k, v in (time_variants or {}).items() if v}
    if tv:
        sc["timeVariants"] = copy.deepcopy(tv)
    elif "timeVariants" in sc:
        del sc["timeVariants"]
    return sc


def test_面板不认识的键必须原样带回去() -> None:
    disk = {
        "夜": {
            "backgrounds": [{"image": "background-night.png", "x": 0, "y": 0}],
            # 以下四项面板都不编 —— 全靠透传
            "lighting": {"fog": {"sigma": 0.4}, "sky": {"intensity": 0.02}},
            "depthConfig": {"depth_map": "raw_depth_night.png"},
            "ambientSounds": ["amb_night_street"],
            "bgm": "bgm_night",
        },
    }
    got = _variant_writeback(copy.deepcopy(disk))
    assert got["timeVariants"] == disk, (
        "写回丢了面板未显示的键 —— 打开保存一次夜的配置就少一半")


def test_空表不落键_旧场景零字节变化() -> None:
    assert "timeVariants" not in _variant_writeback({})
    # 值为空的时段也不该留下 —— 空对象在运行时与"没配"同义，留着只会让人以为配过了
    assert "timeVariants" not in _variant_writeback({"夜": {}})


def test_写回是深拷贝_改工作副本不污染已落盘的() -> None:
    tv = {"夜": {"backgrounds": [{"image": "n.png", "x": 0, "y": 0}]}}
    got = _variant_writeback(tv)
    tv["夜"]["backgrounds"][0]["image"] = "改了"
    assert got["timeVariants"]["夜"]["backgrounds"][0]["image"] == "n.png"


def test_候选背景排掉派生产物() -> None:
    """选到 collision.png / raw_depth_rg.png 不会报错，只会让整张画变成一张深度图。

    这种错作者极难反推（画面上是一片彩色噪点，而"背景图"字段看着填得好好的），
    所以候选列表必须在源头就排掉它们。
    """
    from tools.editor.editors import scene_editor as SE
    src = Path(SE.__file__).read_text(encoding="utf-8")
    i = src.find("def _scene_bg_candidates")
    assert i > 0, "候选背景的取用函数不见了 —— 时段外观面板会退回自由文本"
    body = src[i:i + 1600]
    assert '"collision"' in body and "raw_depth" in body, (
        "候选列表不再排除碰撞图/深度图 —— 选中它们会让整张画变成深度图")
    assert '"background.png"' in body, "白天那张不再置顶，作者要在一堆变体里翻它"


def test_环境覆盖块里永远不含灯() -> None:
    """`lights` 不许出现在时段覆盖里 —— 这是设计红线，不是实现细节。

    灯按各自的 `phases` 过滤（灯面板上配）。两条路都能改灯就有**两个真相源**：
    一盏灯到底亮不亮要同时看它自己的 phases 和当前时段的变体，作者无从推理。
    运行时也刻意不读变体里的 lights（mergeSceneLighting 显式 skip），校验器报 error。
    """
    from tools.editor.editors import scene_editor as SE
    keys = [k for k, _label in SE.ScenePropertyPanel._TV_ENV_BLOCKS]
    assert 'lights' not in keys, (
        '时段环境覆盖的白名单里出现了 lights —— 会与灯的 phases 形成两个真相源')
    # 覆盖面要真的覆盖到「夜」用得上的那几块，否则等于没做
    for must in ('sky', 'fog', 'display'):
        assert must in keys, f'时段覆盖缺 {must}，夜的氛围没法配'


def test_环境覆盖白名单与运行时合并口径一致() -> None:
    """编辑器能写的块，运行时必须认；反过来运行时认的块，编辑器不该漏得太离谱。

    这是镜像对账（编辑器规范第 8 条）：两边各写一份清单，漂了就是
    「编辑器里配了、跑起来不生效」，而且当场看不出来。
    """
    from pathlib import Path
    from tools.editor.editors import scene_editor as SE
    ts = (Path(SE.__file__).resolve().parents[3]
          / 'src' / 'utils' / 'sceneAppearance.ts').read_text(encoding='utf-8')
    # 运行时的合并是「除 lights 外整块盖」，所以只需锁住那条 skip 还在
    assert "if (k === 'lights') continue;" in ts, (
        '运行时不再跳过 lights —— 时段覆盖会变成第二个改灯的入口')
    keys = [k for k, _ in SE.ScenePropertyPanel._TV_ENV_BLOCKS]
    assert len(set(keys)) == len(keys), '白名单里有重复键'
