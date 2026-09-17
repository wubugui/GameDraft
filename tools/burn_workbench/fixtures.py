# -*- coding: utf-8 -*-
"""临时样例工程（pytest 与 ``--selftest`` 共用）：三份可燃物模板、一个用它们的场景（热点 + NPC）、一个开了可燃的挂件预设、
一份轨迹 spawn 规格、一个薄片绑模板的粒子效果、玩家动画包与挂点、能点火的挂件预设。**只往给定目录里写**，真工程一个字节都不碰。

模板（真实尺寸与图的像素比例一致，``paper_pile`` / ``candle_red`` 的尺寸与旧样例热点的世界尺寸相同：120×80 / 20×80 wu）：

* ``paper_pile``：纸钱堆（面燃烧，立着），图 96×64 px；
* ``candle_red``：红蜡烛（消耗燃烧，可吹熄），图 24×96 px；
* ``zz_loose``：没有任何宿主引用的面燃烧模板（删除走得通）。

场景 ``zz_burn_room``（没有深度 = 平面空间；配了透视轴 near y=900 ×1 → far y=300 ×0.5）：

* ``hs_paper`` / ``hs_paper2``：两堆纸钱挨着放（跨可燃物蔓延看得到）；``hs_paper2`` 朝左、开了透视；
* ``hs_candle``：红蜡烛，``initial: burning``（第一次出现就在烧）；
* ``hs_plain``：不可燃的热点（场景视图里不画）；
* ``npc_paper``：抱着纸钱堆的 NPC（NPC 缺省吃透视）；``npc_plain``：不可燃的 NPC。

引用处：``paper_pile`` ← 场景 3 处 + 粒子 ``zz_paper_money`` 薄片；``candle_red`` ← 场景 1 处 + 挂件预设 ``zz_incense_prop`` + 数据文件
``zz_cutscene.json`` 里的 ``playTrajectory`` spawn 规格（那个文件故意用 ``ensure_ascii`` 转义 + CRLF 写，改名要逐字节保住它的风格）。
"""
from __future__ import annotations

import json
from pathlib import Path

SCENE = "zz_burn_room"
PAPER_IMG = "/resources/runtime/images/zz_burn/paper.png"
CANDLE_IMG = "/resources/runtime/images/zz_burn/candle.png"
TORCH_IMG = "/resources/runtime/images/zz_burn/torch.png"
ANIM_URL = "/resources/runtime/animation/zz_player/anim.json"
CUTSCENE_REL = "public/assets/data/zz_cutscene.json"


def _dump(p: Path, obj) -> None:
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_bytes((json.dumps(obj, ensure_ascii=False, indent=2) + "\n").encode("utf-8"))


def _png(p: Path, w: int, h: int, fill, box=None) -> None:
    from PIL import Image, ImageDraw
    p.parent.mkdir(parents=True, exist_ok=True)
    img = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    x0, y0, x1, y1 = box or (0, 0, w - 1, h - 1)
    d.rectangle([x0, y0, x1, y1], fill=fill)
    img.save(p)


def paper_doc() -> dict:
    return {
        "id": "paper_pile", "label": "纸钱堆", "image": PAPER_IMG, "widthCm": 136.36, "heightCm": 90.91,
        "mode": "spread", "orientation": "upright", "gridCells": 32,
        "ignitionPoints": [{"id": "p1", "u": 0.5, "v": 0.9}],
        "spread": {"speedOpposed": 10, "speedConcurrent": 40},
        "flameSeconds": 1.5, "emberSeconds": 1.0, "flameLength": 20, "ignitionDelay": 0.25,
        "look": {"glowKelvin": 1500, "ashAlpha": 0.0},
        "particles": [{"effect": "zz_burn_flame", "from": "flame", "refArea": 100}],
        "light": {"kelvin": 1700, "intensityPerM2": 12.0, "range": 420},
    }


def candle_doc() -> dict:
    return {
        "id": "candle_red", "label": "红蜡烛", "image": CANDLE_IMG, "widthCm": 22.73, "heightCm": 90.91,
        "grip": {"u": 0.5, "v": 0.8},
        "mode": "consume", "orientation": "upright", "gridCells": 24,
        "consume": {"seconds": 60, "from": "top", "flameU": 0.5, "flameWidth": 0.4},
        "flameSeconds": 2, "emberSeconds": 1, "flameLength": 6,
        "blowout": {"windSpeed": 3, "drainSeconds": 1.5, "recoverSeconds": 2},
    }


def loose_doc() -> dict:
    return {"id": "zz_loose", "label": "没人用的", "image": PAPER_IMG, "widthCm": 30, "heightCm": 20, "mode": "spread", "orientation": "ground"}


def scene_doc() -> dict:
    def hs(hid, x, y, template=None, rng=120, **extra):
        d = {"id": hid, "type": "inspect", "label": hid, "x": x, "y": y, "interactionRange": rng}
        if template:
            d["burnable"] = {"template": template}
        d.update(extra)
        return d
    paper = hs("hs_paper", 600, 600, "paper_pile")
    paper["burnable"]["signals"] = {"ignited": "zz_paper_lit"}
    paper2 = hs("hs_paper2", 680, 600, "paper_pile", perspectiveScaleEnabled=True,
                displayImage={"image": PAPER_IMG, "worldWidth": 120, "worldHeight": 80, "facing": "left"})
    candle = hs("hs_candle", 1000, 600, "candle_red", rng=90)
    candle["burnable"]["initial"] = "burning"
    return {
        "id": SCENE, "name": "燃烧自检房间", "worldWidth": 1600, "worldHeight": 900,
        "backgrounds": [{"image": "background.png"}],
        "spawnPoint": {"x": 400, "y": 700},
        "wind": {"direction": [1, 0, 0], "speed": 44},
        "perspectiveScale": {"near": {"x": 800, "y": 900, "scale": 1}, "far": {"x": 800, "y": 300, "scale": 0.5}},
        "hotspots": [
            paper, paper2, candle,
            {"id": "hs_plain", "type": "inspect", "x": 300, "y": 300, "interactionRange": 60},
        ],
        "npcs": [
            {"id": "npc_paper", "name": "抱纸的人", "x": 300, "y": 750, "interactionRange": 80, "initialFacing": "left",
             "animFile": "/resources/runtime/animation/zz_player/anim.json", "burnable": {"template": "paper_pile", "playerIgnite": False}},
            {"id": "npc_plain", "name": "路人", "x": 1300, "y": 700, "interactionRange": 80},
        ],
    }


def build_project(root: Path) -> Path:
    root = Path(root)
    pub = root / "public"
    # ---- 图
    _png(pub / PAPER_IMG.lstrip("/"), 96, 64, (230, 210, 150, 255), box=(8, 4, 87, 59))
    _png(pub / CANDLE_IMG.lstrip("/"), 24, 96, (200, 30, 30, 255), box=(6, 8, 17, 95))
    _png(pub / TORCH_IMG.lstrip("/"), 60, 240, (120, 80, 40, 255))
    from PIL import Image
    bg = pub / "resources" / "runtime" / "scenes" / SCENE / "background.png"
    bg.parent.mkdir(parents=True, exist_ok=True)
    Image.new("RGB", (800, 450), (60, 64, 72)).save(bg)
    atlas = pub / "resources" / "runtime" / "animation" / "zz_player" / "atlas.png"
    atlas.parent.mkdir(parents=True, exist_ok=True)
    Image.new("RGBA", (96, 48), (200, 200, 200, 255)).save(atlas)
    # ---- 场景 / 模板
    _dump(pub / "assets" / "scenes" / f"{SCENE}.json", scene_doc())
    _dump(pub / "assets" / "data" / "burnables" / "paper_pile.json", paper_doc())
    _dump(pub / "assets" / "data" / "burnables" / "candle_red.json", candle_doc())
    _dump(pub / "assets" / "data" / "burnables" / "zz_loose.json", loose_doc())
    # ---- 玩家动画 + 挂点（与 igniteStance.test.ts 同一组数）
    _dump(pub / ANIM_URL.lstrip("/"), {
        "spritesheet": "atlas.png", "cols": 3, "rows": 1, "cellWidth": 32, "cellHeight": 48,
        "worldWidth": 148, "worldHeight": 150,
        "atlasFrames": [{"x": 0, "y": 0}, {"x": 32, "y": 0}, {"x": 64, "y": 0}],
        "states": {"idle": {"frames": [0, 1], "frameRate": 8, "loop": True},
                   "light": {"frames": [0, 2, 1], "frameRate": 8, "loop": False}},
    })
    _dump(pub / "resources" / "runtime" / "animation" / "zz_player" / "sockets.json", {
        "schemaVersion": 1, "atlas": {"cols": 3, "rows": 1, "slotCount": 3},
        "sockets": {"right_hand": {"poses": {"0": {"x": 0.6, "y": 0.5, "angle": 80},
                                             "1": {"x": 0.62, "y": 0.52, "angle": 85},
                                             "2": {"x": 0.8, "y": 0.45, "angle": 30}}}},
        "contactSlots": [], "igniteSlots": [2],
    })
    _dump(pub / "assets" / "data" / "game_config.json", {
        "playerAvatar": {"animManifest": ANIM_URL, "stateMap": {"idle": "idle", "ignite": "light"}},
        "playerActs": {"ignite": {"enabled": True, "animation": "ignite"}},
    })
    _dump(pub / "assets" / "data" / "prop_presets.json", {
        "zz_torch": {"label": "自检火把", "image": TORCH_IMG, "anchorX": 0.5, "anchorY": 0.85, "rotation": -35, "scale": 0.26,
                     "firePoint": [0.455, 0.04], "light": {"intensity": 1}, "igniter": {"flameLength": 20},
                     "states": {"lit": {}, "out": {"light": None, "igniter": None}}, "defaultState": "lit"},
        "zz_sword": {"label": "不能点火", "image": TORCH_IMG},
        "zz_incense_prop": {"label": "手上的蜡烛", "scale": 0.5, "burnable": {"template": "candle_red", "initial": "burning"}},
    })
    _dump(pub / "assets" / "data" / "vfx" / "zz_burn_flame.json", {
        "id": "zz_burn_flame", "label": "火苗",
        "emitters": [{"id": "main", "spawn": {"max": 10, "rate": 5, "shape": {"kind": "external"}}}],
    })
    _dump(pub / "assets" / "data" / "vfx" / "zz_paper_money.json", {
        "id": "zz_paper_money", "label": "纸钱",
        "emitters": [{"id": "main", "spawn": {"max": 10, "rate": 5, "shape": {"kind": "point"}},
                      "plate": {"size": [16, 16], "burnable": {"template": "paper_pile"}}}],
    })
    # 轨迹 spawn 规格：故意 ensure_ascii + CRLF（改名只许动那一个值的字节）
    cut = {"id": "zz_cutscene", "label": "演出（自检）", "steps": [
        {"type": "playTrajectory", "params": {"trajectory": "zz_throw", "spawn": {"id": "zz_thrown_candle", "burnable": {"template": "candle_red"}}}},
        {"type": "wait", "params": {"seconds": 1.0}},
    ]}
    text = json.dumps(cut, ensure_ascii=True, indent=2).replace("\n", "\r\n") + "\r\n"
    cp = root / CUTSCENE_REL
    cp.parent.mkdir(parents=True, exist_ok=True)
    cp.write_bytes(text.encode("utf-8"))
    return root
