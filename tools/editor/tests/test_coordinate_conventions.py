"""坐标约定的机械契约 —— 逐场景复算,不许靠人记得。

权威表在 `agent_docs/runtime/mechanisms/coordinate-spaces.md`;那张卡是**说明**,
这份是**判据**。本项目六个坐标空间混用**一律不报错**——只是光偏、影子错位、
碰撞漂、参数调了不生效,所以每一条能机械复算的约定都锁在这里。

已经真踩过的(每一条都不报错):
· 造了「米」这个单位(`1.7 / char_wu`)——游戏里没有米
· 把**伪世界 q 单位**叫成 wu,以为"同一个 wu 在不同场景差 5.7 倍"(实则是相机 ppu 在变)
· `meta.cal` 是 **work** 分辨率的标定,拿去配 `native.w` 差 4 倍
· 「native/work 反正是 4 倍」——只有 19/28 个场景成立
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

_ROOT = Path(__file__).resolve().parents[3]
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

_SCENES = _ROOT / "public" / "assets" / "scenes"
_RUNTIME = _ROOT / "public" / "resources" / "runtime" / "scenes"

#: 角色身高(**wu**)。这是全项目的尺度锚,28 个场景恒定。
CHARACTER_HEIGHT_WU = 150


def _load(p: Path) -> dict:
    return json.loads(p.read_text(encoding="utf-8"))


def _scene_files() -> list[Path]:
    return sorted(_SCENES.glob("*.json"))


def _det3(m: list[list[float]]) -> float:
    (a, b, c), (d, e, f), (g, h, i) = m
    return a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g)


# ---------------------------------------------------------------- 两个 M

def test_游戏约定的_R_行列式恒为正一() -> None:
    """`depthConfig.M.R` 是 **det=+1** 的游戏约定矩阵(q → M-world)。

    与 `lighting.json world.M`(det=−1,实验室 GL 右手)喂错对方的消费者 =
    Z 轴整体翻号,影子前后颠倒,而且不报错。
    """
    seen = 0
    for f in _scene_files():
        R = ((_load(f).get("depthConfig") or {}).get("M") or {}).get("R")
        if not R:
            continue
        seen += 1
        assert abs(_det3(R) - 1.0) < 1e-6, f"{f.name}: det(R) = {_det3(R)}"
    assert seen >= 20, f"只找到 {seen} 个场景,数据面可能没拉全"


def test_实验室_M_行列式恒为负一() -> None:
    seen = 0
    for f in _scene_files():
        p = _RUNTIME / f.stem / "lighting" / "lighting.json"
        if not p.is_file():
            continue
        M = (_load(p).get("world") or {}).get("M")
        if not M:
            continue
        seen += 1
        assert abs(_det3(M) + 1.0) < 1e-6, f"{f.stem}: det(M) = {_det3(M)}"
    assert seen >= 20, f"只找到 {seen} 个 probe 载荷"


def test_R_是正交阵() -> None:
    """正交是「着色在 M-world、march 在 q 两边距离夹角逐位相同」的前提。

    R 若不再正交,`wrQToWorld` 就会拉伸空间,N·L 与 1/r² 一起错。
    """
    for f in _scene_files():
        R = ((_load(f).get("depthConfig") or {}).get("M") or {}).get("R")
        if not R:
            continue
        for i in range(3):
            for j in range(3):
                dot = sum(R[i][k] * R[j][k] for k in range(3))
                want = 1.0 if i == j else 0.0
                assert abs(dot - want) < 1e-9, f"{f.name}: RᵀR[{i}][{j}] = {dot}"


# ---------------------------------------------------------------- 两套像素栅格

def test_两套像素栅格各自自洽() -> None:
    """native 配 `depthConfig.M`,work 配 `meta.cal`。

    判据:**尺寸比必须等于 ppu 比**。不等就是有人把一套的 ppu 配了另一套的尺寸
    ——`backgroundWu` 就这么错过一次(报 16000 而不是 4000)。
    """
    seen = 0
    for f in _scene_files():
        meta = _RUNTIME / f.stem / "lighting2" / "meta.json"
        if not meta.is_file():
            continue
        cfg = ((_load(f).get("depthConfig") or {}).get("M") or {})
        if not cfg.get("ppu"):
            continue
        m = _load(meta)
        seen += 1
        size_ratio = m["native"]["w"] / m["work"]["w"]
        ppu_ratio = float(cfg["ppu"]) / m["cal"]["ppu"]
        assert size_ratio == pytest.approx(ppu_ratio, rel=1e-9), (
            f"{f.stem}: 尺寸比 {size_ratio} ≠ ppu 比 {ppu_ratio}")
    assert seen >= 20, seen


def test_native_work_比例不是恒定的四倍() -> None:
    """防的是「反正是 4 倍」这个假设 —— 实测只有一部分场景成立。

    这条**故意断言"存在不是 4 的场景"**:哪天所有场景都变成 4 了,
    这条会红,提醒把上面那句警告从文档里撤掉。
    """
    ratios = []
    for f in _scene_files():
        meta = _RUNTIME / f.stem / "lighting2" / "meta.json"
        if not meta.is_file():
            continue
        m = _load(meta)
        ratios.append(m["native"]["w"] / m["work"]["w"])
    assert ratios, "没有 lighting2 载荷"
    assert any(abs(r - 4.0) > 0.01 for r in ratios), (
        "所有场景的 native/work 都变成 4 了 —— 撤掉 coordinate-spaces 卡里那条警告")


# ---------------------------------------------------------------- 尺度锚

def test_角色身高在所有场景都是_150_wu() -> None:
    """**wu 一致的判据**。

    `char_wu` 是角色在**伪世界 q** 里占多少(0.17–0.97,随相机标定变);
    `scene_per_wu` 是 1 个 q 单位等于多少 wu。两者相乘 = 角色的**世界身高**,
    必须恒定 —— 曾经拿 `char_wu` 当尺度参照,得出"同一个 wu 差 5.7 倍"的错误结论。
    """
    seen = 0
    for meta in sorted(_RUNTIME.glob("*/lighting2/meta.json")):
        sc = _load(meta).get("scale") or {}
        if not (sc.get("char_wu") and sc.get("scene_per_wu")):
            continue
        seen += 1
        h = sc["char_wu"] * sc["scene_per_wu"]
        assert h == pytest.approx(CHARACTER_HEIGHT_WU, abs=0.5), f"{meta.parts[-3]}: {h}"
    assert seen >= 20, seen


def test_烘焙产物里没有造出来的单位() -> None:
    """防回退:`meters_per_wu = 1.7 / char_wu` 那一层已经删了,别再加回来。"""
    for meta in sorted(_RUNTIME.glob("*/lighting2/meta.json")):
        sc = _load(meta).get("scale") or {}
        assert "meters_per_wu" not in sc, f"{meta.parts[-3]} 又出现了造出来的单位"


def test_背景世界宽度等于_worldWidth() -> None:
    """`work.w / cal.ppu × scene_per_wu` 必须**恰好等于**场景的 `worldWidth`。

    这是「两套标定有没有配对」最直接的判据 —— 拿 `native.w` 配 `cal.ppu`
    会差整整一个 native/work 比。
    """
    seen = 0
    for f in _scene_files():
        meta = _RUNTIME / f.stem / "lighting2" / "meta.json"
        if not meta.is_file():
            continue
        d = _load(f)
        m = _load(meta)
        ww = d.get("worldWidth")
        sc = m.get("scale") or {}
        if not (ww and sc.get("scene_per_wu") and m.get("cal", {}).get("ppu")):
            continue
        seen += 1
        got = m["work"]["w"] / m["cal"]["ppu"] * sc["scene_per_wu"]
        assert got == pytest.approx(ww, rel=1e-6), f"{f.stem}: {got} ≠ worldWidth {ww}"
    assert seen >= 20, seen


# ---------------------------------------------------------------- 各向同性

def test_地面法线在_M_world_里朝上() -> None:
    """**q 各向同性的判据**:深度 `d` 得与 `(px−cx)/ppu` 同尺。

    若不同尺,对 q 施加正交的 R 就没有意义,距离与夹角一起错 —— 而这不报错,
    只会让 1/r² 与 N·L 悄悄偏。判据:地面在 M-world 里应当朝上(0,1,0)。

    法线是在 `pos = q @ R.T` 里烘的(`geometry.py`),所以它**已经是 M-world 的**。
    """
    np = pytest.importorskip("numpy")
    Image = pytest.importorskip("PIL.Image", reason="需要 Pillow")

    p = _RUNTIME / "雾津街头" / "lighting2" / "normal.png"
    if not p.is_file():
        pytest.skip("雾津街头 没烘 lighting2/(DVC 没拉)")

    nrm = np.asarray(Image.open(p).convert("RGB"), np.float32) / 255.0
    # 与两个 shader 同一套解码:rg 做 *2−1,b 是 |z| 直存
    n = np.stack([nrm[..., 0] * 2 - 1, nrm[..., 1] * 2 - 1,
                  -np.maximum(nrm[..., 2], 0.05)], -1)
    n /= np.maximum(np.linalg.norm(n, axis=-1, keepdims=True), 1e-9)

    h, w = n.shape[:2]
    band = n[int(h * 0.80):int(h * 0.95), int(w * 0.35):int(w * 0.65)].reshape(-1, 3)
    med = np.median(band, axis=0)
    med /= np.linalg.norm(med)
    ang = np.degrees(np.arccos(np.clip(float(med @ np.array([0.0, 1.0, 0.0])), -1, 1)))
    # 实测 6.4°。放宽到 20° —— 超过就说明标定链或深度尺度出了问题
    assert ang < 20.0, f"街面法线离世界上 {ang:.1f}°,q 可能不再各向同性"


# ---------------------------------------------------------------- 卡与代码不许分家

def test_坐标总表存在且被路径触发覆盖() -> None:
    """卡是被动的,靠 `audit.py --paths` 把它推到改这些文件的人面前。

    这条锁的是**触发面**:动了下面任何一个路径,必读清单里都得有这张卡。
    """
    card = _ROOT / "agent_docs" / "runtime" / "mechanisms" / "coordinate-spaces.md"
    assert card.is_file(), "坐标总表卡不见了"

    triggers = _load(_ROOT / "agent_docs" / "paths-triggers.json")
    flat = json.dumps(triggers, ensure_ascii=False)
    assert "coordinate-spaces" in flat, "坐标总表没有进路径触发索引"
    for must in ("src/utils/worldReconstruct.ts", "src/rendering/lighting/",
                 "tools/scene_relight/"):
        assert must in flat, f"{must} 不在任何触发面里"
