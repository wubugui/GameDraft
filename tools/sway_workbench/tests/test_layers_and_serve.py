# -*- coding: utf-8 -*-
"""草木工作台:数据面与路由的护栏。

跑:``sh scripts/py.sh -m pytest tools/sway_workbench/tests -q``

**不碰真工程的烘焙产物**:除了只读路由,写盘类一律在 tmp 目录里假造一个烘焙目录。
"""
from __future__ import annotations

import base64
import io
import json
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]


if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from tools.character_lighting_lab import sway_field  # noqa: E402
from tools.sway_workbench import layers, serve       # noqa: E402


def _dvc_ignored(rel: str) -> bool:
    """这条仓库相对路径会不会被 `.dvcignore` 排掉 —— 用 DVC 自己那套 gitwildmatch 语义判。"""
    from pathspec import PathSpec

    lines = (ROOT / ".dvcignore").read_text(encoding="utf-8").splitlines()
    return PathSpec.from_lines("gitwildmatch", lines).match_file(rel)


def _gray_data_url(w: int, h: int, v: int) -> str:
    """四层收发一律**不透明灰度**(数据在亮度上,不在 alpha 上)。"""
    from PIL import Image
    im = Image.new("L", (w, h), v)
    buf = io.BytesIO()
    im.save(buf, format="PNG")
    return "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode("ascii")


class ChannelContractTests(unittest.TestCase):
    """涂层的三个通道是工作台与烘焙之间的**契约**,两边对不上就是静默失效。"""

    def test_通道次序与烘焙端一致(self):
        self.assertEqual(layers.CHANNELS, {"veg": 0, "freeze": 1, "rigid": 2, "unrigid": 3})

    def test_烘焙端按同样的次序取(self):
        src = (ROOT / "tools/character_lighting_lab/sway_field.py").read_text(encoding="utf-8")
        self.assertIn("'veg': a[..., 0]", src)
        self.assertIn("'freeze': a[..., 1]", src)
        self.assertIn("'rigid': a[..., 2]", src)
        self.assertIn("'unrigid': a[..., 3]", src)

    def test_刚体度不许塞进_matte_的_alpha(self):
        """canvas 按 alpha 预乘:alpha=0 会把整张 RGB 清零,运行时的 CPU 副本正是这么取的。"""
        src = (ROOT / "tools/character_lighting_lab/sway_field.py").read_text(encoding="utf-8")
        i = src.index("matte = np.stack([")
        block = src[i:src.index("], -1).astype(np.uint8)", i)]
        self.assertEqual(block.count("np.round"), 3, "matte 必须是三通道(RGB)")
        self.assertIn("'sway_rigid.png'", src)

    def test_补带与自由度外延的不等式(self):
        """自由度外延 ≥ 运行时网格一格 + 补带宽,否则轮廓外那圈网格顶点不跟本株走、梢部被钉住压扁。

        补带宽从 12 加到 48 时(原画没有风,草木要一直斜着)这两个数必须一起改——漏改一个不报错,
        症状只是树梢被拉扁。
        """
        ts = (ROOT / "src/rendering/backgroundSway.ts").read_text(encoding="utf-8")
        self.assertIn("const GRID_CELL = 24;", ts, "运行时网格一格改了,这条不等式要跟着核")
        self.assertGreaterEqual(sway_field.FREEDOM_EXTEND_PX, 24 + sway_field.PLATE_MARGIN)

    def test_补带兜得住风里持续的斜度(self):
        """原画没有风:跑马梁松树梢平均风下就要斜约 10 像素、阵风约 30。封顶 = 0.8 × 补带,
        补带太窄树会被压扁成"风再大也只斜一点点"。"""
        self.assertGreaterEqual(sway_field.PLATE_MARGIN * 0.8, 30)

    def test_刚体图登记进了运行时载荷清单(self):
        """四处镜像少一处 = 整批静默不进包(见 agent_docs scene-lighting 的四连发)。"""
        for rel, needle in (
            ("src/core/lightingPayloadFiles.ts", "'sway_rigid.png'"),
            ("scripts/lib/build_helpers.mjs", "'sway_rigid.png'"),
            ("tools/build/asset_manifest.py", '"sway_rigid.png"'),
            ("tools/build/tests/test_asset_manifest.py", '"sway_rigid.png"'),
            # 打光场景的三张补图:同样四处镜像,少一处 = 打光场景的草木在发行包里静默不接
            *((rel, q.format(name)) for name in ("sway_plate_normal.png", "sway_plate_albedo.png", "sway_plate_depth.png")
              for rel, q in (("src/core/lightingPayloadFiles.ts", "'{}'"), ("scripts/lib/build_helpers.mjs", "'{}'"),
                             ("tools/build/asset_manifest.py", '"{}"'), ("tools/build/tests/test_asset_manifest.py", '"{}"'))),
        ):
            self.assertIn(needle, (ROOT / rel).read_text(encoding="utf-8"), rel)


class SavePaintTests(unittest.TestCase):
    def setUp(self):
        import tempfile
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)

        class FakeScene:
            native = (64, 32)
            bake_dir = self.dir
            bg_name = "background.png"
            rt_dir = self.dir

        self._orig = layers.Scene
        layers.Scene = lambda sid: FakeScene()

    def tearDown(self):
        layers.Scene = self._orig
        self.tmp.cleanup()

    def test_存下来的是原画分辨率的_RGBA(self):
        from PIL import Image
        out = layers.save_paint("x", {"rigid": _gray_data_url(64, 32, 255)})
        self.assertTrue(out["ok"])
        p = self.dir / sway_field.PAINT_FILE
        self.assertTrue(p.is_file())
        im = Image.open(p)
        self.assertEqual(im.size, (64, 32))
        self.assertEqual(im.mode, "RGBA")
        # 全蓝 = 全刚体
        self.assertAlmostEqual(out["coverage"]["rigid"], 1.0, places=3)
        self.assertAlmostEqual(out["coverage"]["veg"], 0.0, places=3)

    def test_尺寸不对会被拉回原画分辨率(self):
        from PIL import Image
        layers.save_paint("x", {"veg": _gray_data_url(16, 8, 255)})
        self.assertEqual(Image.open(self.dir / sway_field.PAINT_FILE).size, (64, 32))

    def test_报出拆层是什么时候烘的_好判断存了有没有生效(self):
        """存了 ≠ 生效:差一次重烘时游戏里还是上一版,页面要能说出这一档。"""
        import json

        L = layers.layers("x")
        self.assertEqual(L["bakedMtime"], 0.0, "还没烘过就该是 0")

        layers.save_paint("x", {"rigid": _gray_data_url(64, 32, 255)}, force=True)
        L = layers.layers("x")
        self.assertGreater(L["paintMtime"], L["bakedMtime"], "存过没烘 ⇒ 涂层比拆层新")

        (self.dir / "sway.json").write_text(json.dumps({"version": 3}), encoding="utf-8")
        L = layers.layers("x")
        self.assertGreater(L["bakedMtime"], 0.0)

    def test_写盘走原子替换(self):
        """``atomic-write-windows``:就位类调用必须经 retry_transient,裸 os.replace 会变成偶发保存失败。"""
        src = (ROOT / "tools/sway_workbench/layers.py").read_text(encoding="utf-8")
        self.assertIn("retry_transient(os.replace", src)


class ClearAndReloadTests(unittest.TestCase):
    """🔴 制作人 2026-09-13 撞上的那条:清空一层 → 保存(显示成功)→ 刷新 → **擦掉的全回来了**。

    根因是"一份内容两个来源":旧的 ``sway_lock.png`` 仍在盘上,装场景时又被并回「锁死」层。
    保存本身没丢——丢的是"删掉"这个动作。这几条钉的就是"删得掉、且刷新之后还是删掉的"。
    """

    def setUp(self):
        import tempfile
        from PIL import Image
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)
        # 盘上先有一张旧锁定图(白 = 锁死)
        Image.new("RGBA", (64, 32), (255, 255, 255, 255)).save(self.dir / sway_field.LOCK_FILE)

        class FakeScene:
            native = (64, 32)
            bake_dir = self.dir
            bg_name = "background.png"
            rt_dir = self.dir

        self._orig = layers.Scene
        layers.Scene = lambda sid: FakeScene()

    def tearDown(self):
        layers.Scene = self._orig
        self.tmp.cleanup()

    @staticmethod
    def _gray(w: int, h: int, v: int) -> str:
        from PIL import Image
        im = Image.new("L", (w, h), v)
        buf = io.BytesIO()
        im.save(buf, format="PNG")
        return "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode("ascii")

    def _load(self, name: str):
        import numpy as np
        from PIL import Image
        raw, _ = layers.channel_bytes("x", name)
        return np.asarray(Image.open(io.BytesIO(raw)).convert("L"))

    def test_旧锁定图会并进锁死层给出去(self):
        """看不见它 = 明明锁着却以为没锁。"""
        self.assertGreater(int(self._load("freeze").mean()), 200)

    def test_清空锁死层保存后_旧锁定图被迁移掉_刷新不再回来(self):
        blank = self._gray(64, 32, 0)
        out = layers.save_paint("x", {"veg": blank, "freeze": blank, "rigid": blank, "unrigid": blank})
        self.assertTrue(out["ok"])
        self.assertTrue(out["lockMigrated"], "旧的 sway_lock.png 必须在保存时迁移掉,否则它会把删掉的内容读回来")
        self.assertFalse((self.dir / sway_field.LOCK_FILE).is_file())
        self.assertEqual(int(self._load("freeze").max()), 0, "刷新后锁死层必须还是空的")

    def test_四层各存各的_互不串道(self):
        full, blank = self._gray(64, 32, 255), self._gray(64, 32, 0)
        layers.save_paint("x", {"veg": blank, "freeze": blank, "rigid": full, "unrigid": blank})
        self.assertEqual(int(self._load("rigid").min()), 255)
        for other in ("veg", "freeze", "unrigid"):
            self.assertEqual(int(self._load(other).max()), 0, other)

    def test_收发一律不透明_数据不放在_alpha(self):
        """canvas 按 alpha 预乘:alpha=0 的像素 RGB 会被清零,把数据放 alpha 里就是"存了等于没存"。"""
        from PIL import Image
        full = self._gray(64, 32, 255)
        layers.save_paint("x", {"veg": full, "freeze": full, "rigid": full, "unrigid": full})
        raw, _ = layers.channel_bytes("x", "unrigid")
        self.assertEqual(Image.open(io.BytesIO(raw)).mode, "L", "回给页面的必须是灰度不透明图")


class SaveSafetyTests(unittest.TestCase):
    """三道数据安全闸。作者的涂层是**手工劳动**,一次误存可能是半小时的活——这几条不许删。"""

    def setUp(self):
        import tempfile
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)

        class FakeScene:
            native = (64, 32)
            bake_dir = self.dir
            bg_name = "background.png"
            rt_dir = self.dir

        self._orig = layers.Scene
        layers.Scene = lambda sid: FakeScene()
        # 先铺一份"已有劳动成果":整张都涂了刚体
        layers.save_paint("x", {"rigid": _gray_data_url(64, 32, 255)})

    def tearDown(self):
        layers.Scene = self._orig
        self.tmp.cleanup()

    def test_大面积删除要先点头(self):
        blank = _gray_data_url(64, 32, 0)
        out = layers.save_paint("x", {"veg": blank, "freeze": blank, "rigid": blank, "unrigid": blank})
        self.assertFalse(out["ok"])
        self.assertTrue(out["needConfirm"])
        self.assertEqual(out["before"]["rigid"], 64 * 32)
        self.assertEqual(out["after"]["rigid"], 0)
        # 盘上那份没被动
        self.assertEqual(layers.paint_state("x")["counts"]["rigid"], 64 * 32)

    def test_点了头才真删(self):
        blank = _gray_data_url(64, 32, 0)
        out = layers.save_paint("x", {"rigid": blank}, force=True)
        self.assertTrue(out["ok"])
        self.assertEqual(layers.paint_state("x")["counts"]["rigid"], 0)

    def test_盘上更新了就拒绝保存(self):
        """两个窗口同时开着,后存的那个不许无声盖掉先存的。"""
        stale = layers.paint_state("x")["mtime"] - 10
        out = layers.save_paint("x", {"rigid": _gray_data_url(64, 32, 255)}, base_mtime=stale)
        self.assertFalse(out["ok"])
        self.assertTrue(out["conflict"])

    def test_历史不许落在_DVC_跟踪的资源树里(self):
        """历史是本机的撤销记录,不该跟着仓库走:每场景 20 份会进 DVC 推送体积。"""
        layers.save_paint("x", {"rigid": _gray_data_url(64, 32, 0)}, force=True)
        items = layers.history("x")
        self.assertTrue(items)
        d = layers.history_dir(layers.Scene("x"))
        self.assertEqual(d.name, "sway_paint_history")
        # ⚠ 别用 `assertIn("sway_paint_history", rules)` 了事:pattern 少写一级 `*` 时
        # 那种断言照样绿,而 DVC 那边其实没排掉。这里拿 DVC 自己用的匹配器(pathspec 的
        # gitwildmatch)对**真实路径**匹一遍。
        # (这个夹具的场景在 tmp 里,不在仓库树内 —— 拿真实形状的路径去匹,见 DvcIgnoreTests)
        self.assertTrue(_dvc_ignored(
            f"public/resources/runtime/scenes/某场景/lighting/background/{d.name}/20260913-020304-1.png"),
            "历史目录没真被 .dvcignore 排掉(pattern 写错一级?),否则每场景 20 份都进 DVC 推送体积")

    def test_每次保存留一份历史_且能恢复回来(self):
        blank = _gray_data_url(64, 32, 0)
        layers.save_paint("x", {"rigid": blank}, force=True)          # 把活抹了
        items = layers.history("x")
        self.assertTrue(items, "保存必须留历史")
        r = layers.restore("x", items[0]["name"])                      # 最新那份历史 = 抹之前的
        self.assertTrue(r["ok"])
        self.assertEqual(layers.paint_state("x")["counts"]["rigid"], 64 * 32, "恢复要把活捡回来")

    def test_历史名必须是纯文件名_不许拼出路径(self):
        """`restore` 的动作是"拿这个文件盖掉作者的涂层"。名字带上路径 = 拿无关文件覆盖半小时的活。"""
        import hashlib

        paint = self.dir / sway_field.PAINT_FILE
        before = hashlib.sha256(paint.read_bytes()).hexdigest()
        for bad in ("../../../../etc/passwd", "a/b", "..", "", "sub\\evil"):
            out = layers.restore("x", bad)
            self.assertFalse(out["ok"], f"{bad!r} 居然被当成合法历史名")
        self.assertEqual(hashlib.sha256(paint.read_bytes()).hexdigest(), before,
                         "被拒的恢复不许动到涂层一个字节")

    def test_恢复本身也进历史_可以再撤(self):
        before = len(layers.history("x"))
        layers.save_paint("x", {"rigid": _gray_data_url(64, 32, 0)}, force=True)
        layers.restore("x", layers.history("x")[0]["name"])
        self.assertGreater(len(layers.history("x")), before)


class BakeStatusTests(unittest.TestCase):
    """后台烘焙的状态字段。⚠ 里面**不许**有叫 `ok` 的键:响应信封外层已经有一个,
    同名会把它盖掉,前端的 `api()` 一律当成"请求失败"——症状是刚点重烘就报错(实测撞过)。"""

    def test_状态字段不与信封的_ok_撞名(self):
        st = layers.bake_status()
        self.assertNotIn("ok", st)
        for k in ("running", "done", "succeeded", "log", "elapsed"):
            self.assertIn(k, st, k)

    def test_同一时刻只许烘一个(self):
        layers._BAKE["running"] = True
        try:
            out = layers.bake_start("x")
            self.assertFalse(out["ok"])
            self.assertTrue(out["busy"])
        finally:
            layers._BAKE["running"] = False


class DvcIgnoreTests(unittest.TestCase):
    """两条排除规则都要**真能匹上**,不是"字符串里出现过"。

    弱守卫的代价:pattern 写错一级没人红,等到 DVC 推送时才发现每场景 20 份历史 / 每推一次
    联动槽都跟着仓库走。
    """

    def test_历史目录真的被排掉(self):
        self.assertTrue(_dvc_ignored(
            "public/resources/runtime/scenes/跑马梁/lighting/background/sway_paint_history/20260913-020304-1.png"))

    def test_联动槽真的被排掉(self):
        self.assertTrue(_dvc_ignored("resources/editor_projects/editor_data/runtime_sway.json"))

    def test_正经的拆层产物一个都不许被排掉(self):
        """反面:规则写宽了会把该进 DVC 的产物一起排掉,那是真丢数据。"""
        for rel in ("public/resources/runtime/scenes/跑马梁/lighting/background/sway_matte.png",
                    "public/resources/runtime/scenes/跑马梁/lighting/background/sway_rigid.png",
                    "public/resources/runtime/scenes/跑马梁/lighting/background/sway_paint.png",
                    "public/resources/runtime/scenes/跑马梁/lighting/background/sway.json"):
            self.assertFalse(_dvc_ignored(rel), f"{rel} 被 .dvcignore 排掉了 —— 这张图是要跟着仓库走的")


class BakePushIsolationTests(unittest.TestCase):
    """推送出岔子不许把一次**已经烘好**的重烘报成失败。

    合在一个 try 里的后果:产物明明落盘了,页面上写着"烘焙失败",作者会再烘一遍
    (第一次要跑分割,几十秒)——而且会开始怀疑这工具到底有没有在干活。
    """

    def setUp(self):
        self._bake = sway_field.bake_sway
        self._push = layers.push_to_game
        self._state = dict(layers._BAKE)

    def tearDown(self):
        sway_field.bake_sway = self._bake
        layers.push_to_game = self._push
        # ⚠ 整本换回去,别只 update 那几个字段:`scene` / `started` / `push` 会留在字典里,
        # 将来谁断言 `bake_status()` 的完整形状就会撞上这几个幽灵键。
        layers._BAKE.clear()
        layers._BAKE.update(self._state)

    def _run_and_wait(self):
        import time

        layers.bake_start("x")
        for _ in range(200):
            st = layers.bake_status()
            if st["done"]:
                return st
            time.sleep(0.02)
        self.fail("烘焙线程没结束")

    def test_推送抛异常时烘焙仍然算成功(self):
        sway_field.bake_sway = lambda sid, status=print: status("烘好了") or []

        def boom(sid):
            raise RuntimeError("游戏那边炸了")

        layers.push_to_game = boom
        st = self._run_and_wait()
        self.assertTrue(st["succeeded"], "烘好了却被报成失败 —— 作者会白白再烘一遍")
        self.assertFalse(st["running"])
        self.assertTrue(any("没推给游戏" in l for l in st["log"]), st["log"])

    def test_烘焙自己失败时照旧算失败(self):
        """反面:别把上面那条写成"永远成功"。"""
        def boom(sid, status=print):
            raise ValueError("分割挂了")

        sway_field.bake_sway = boom
        layers.push_to_game = lambda sid: {"pushed": False, "why": "没开着"}
        st = self._run_and_wait()
        self.assertFalse(st["succeeded"])
        self.assertIn("分割挂了", st["err"])


class PlateFillTests(unittest.TestCase):
    """补底板:同一份"去哪取"的计划,要能填原画、夜景原画、法线、albedo、深度。

    运行时植物挪开露出来的地方,不打光读的是补过的原画,打光读的是补过的法线 / albedo / 深度
    算出来的光照——几张必须补在**同一批像素**上,且原画以外的几张分辨率可能不同(法线是 1/4)。
    """

    def _scene(self, w=64, h=40):
        import numpy as np
        veg = np.zeros((h, w), bool)
        veg[10:30, 20:44] = True                     # 中间一块植物
        return veg

    def test_补带里换成外面的背景_补带外原样(self):
        import numpy as np
        veg = self._scene()
        img = np.zeros((40, 64, 3), np.uint8)
        img[...] = (30, 120, 200)                    # 背景
        img[veg] = (0, 255, 0)                       # 植物是纯绿
        out = sway_field.fill_plate(img, sway_field.plate_plan(veg, margin=48))
        self.assertFalse(((out[veg] == (0, 255, 0)).all(axis=1)).any(), "补带里还留着植物的颜色")
        far = np.zeros_like(veg)
        far[0:5, 0:10] = True                        # 离植物很远的背景
        self.assertTrue((out[far] == (30, 120, 200)).all(), "补带外的背景被动了")

    def test_16位深度也能补_类型不变(self):
        import numpy as np
        veg = self._scene()
        d = np.full((40, 64), 20000, np.uint16)
        d[veg] = 5000                                # 植物离相机近
        out = sway_field.fill_plate(d, sway_field.plate_plan(veg, margin=48))
        self.assertEqual(out.dtype, np.uint16)
        self.assertGreater(int(out[veg].min()), 15000, "补过的深度应该是背后地面的,不是植物的")

    def test_掩码缩到低分辨率时宁可多补不许漏补(self):
        import numpy as np
        veg = np.zeros((40, 64), bool)
        veg[5, 5] = True                             # 只有一个像素是植物
        small = sway_field.veg_at(veg, (16, 10))
        self.assertTrue(small[1, 1], "块里有一个植物像素就得算植物,漏了就是露出处拿植物的法线去照")

    def test_打光场景三张补图都出_法线分辨率不同也行(self):
        import tempfile
        import numpy as np
        from PIL import Image

        veg = self._scene()
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            bake = root / "lighting" / "background"
            bake.mkdir(parents=True)
            Image.new("RGB", (16, 10), (128, 128, 255)).save(bake / "normal.png")    # 1/4 分辨率
            Image.new("RGB", (64, 40), (90, 80, 70)).save(bake / "albedo.png")
            rg = np.zeros((40, 64, 3), np.uint8)
            rg[..., 0], rg[..., 1] = 0x4E, 0x20
            Image.fromarray(rg).save(root / "raw_depth_rg.png")

            class S:
                bake_dir = bake
                rt_dir = root

            out = sway_field.lit_plates(S, veg, "raw_depth_rg.png", status=lambda _m: None)
        self.assertEqual(set(out), {"sway_plate_normal.png", "sway_plate_albedo.png", "sway_plate_depth.png"})
        n = Image.open(io.BytesIO(out["sway_plate_normal.png"]))
        self.assertEqual(n.size, (16, 10), "法线补图要保持法线原来的分辨率")


class OverridesTests(unittest.TestCase):
    """作者逐株设置(锚点 / 整体摆):存**位置**不存 id,烘焙时按位置落到这一次分割出来的株上。

    制作人 2026-09-13:"有的植物很大就应该整体一起扭""刚体要可以我自己定锚点,不然有的你就是乱在旋转"。
    """

    def _owner(self):
        import numpy as np
        owner = np.zeros((100, 160), np.int32)
        owner[5:20, 5:20] = 1
        owner[5:35, 100:130] = 2
        return owner, [owner == 1, owner == 2]

    def test_锚点按位置落到所在那一株_贴边往外找_太远就报(self):
        owner, masks = self._owner()
        rows = [{'id': 1, 'reach': 10.0}, {'id': 2, 'reach': 10.0}]
        notes = []
        stat = sway_field.apply_overrides(
            rows, owner, masks,
            {'anchors': [[10, 10], [110, 37], [60, 90]], 'coherent': [[110, 20]]},
            world=(160.0, 100.0), status=notes.append)
        self.assertEqual(rows[0]['anchors'], [[10.0, 10.0]])
        self.assertEqual(rows[1]['anchors'], [[110.0, 37.0]], "点在竿底轮廓外一点点也要落到那一株")
        self.assertTrue(rows[1].get('coherent'))
        self.assertNotIn('coherent', rows[0])
        self.assertEqual(stat, {'anchors': 2, 'coherent': 1, 'lost': 1})
        self.assertTrue(any('没有任何一株' in n for n in notes), "落不到任何一株的点要说出来")

    def test_有锚点的株按到锚点的最远距离重算梢长(self):
        owner, masks = self._owner()
        rows = [{'id': 1, 'reach': 1.0}, {'id': 2, 'reach': 1.0}]
        sway_field.apply_overrides(rows, owner, masks, {'anchors': [[100, 5]], 'coherent': []}, world=(160.0, 100.0),
                                   status=lambda _m: None)
        self.assertGreater(rows[1]['reach'], 25.0, "刚体转角封顶按梢长压,支点换了梢长必须跟着换")
        self.assertEqual(rows[0]['reach'], 1.0)

    def test_坏文件与坏条目当作没设(self):
        import tempfile
        with tempfile.TemporaryDirectory() as tmp:
            d = Path(tmp)
            (d / sway_field.OVERRIDES_FILE).write_text('{不是 json', encoding='utf-8')
            self.assertEqual(sway_field.read_overrides(d), {'anchors': [], 'coherent': []})
            (d / sway_field.OVERRIDES_FILE).write_text(
                json.dumps({'anchors': [[1, 2], 'x', [1], [3, 4]], 'coherent': None}), encoding='utf-8')
            self.assertEqual(sway_field.read_overrides(d), {'anchors': [[1.0, 2.0], [3.0, 4.0]], 'coherent': []})


class OverridesSaveTests(unittest.TestCase):
    """逐株设置与涂层一起保存:越界点丢掉、覆盖前留历史、装场景读得回来。"""

    def setUp(self):
        import tempfile
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)

        class FakeScene:
            native = (64, 32)
            bake_dir = self.dir
            bg_name = "background.png"
            rt_dir = self.dir

        self._orig = layers.Scene
        layers.Scene = lambda sid: FakeScene()

    def tearDown(self):
        layers.Scene = self._orig
        self.tmp.cleanup()

    def test_随涂层保存_越界点丢掉_覆盖前留历史(self):
        blank = _gray_data_url(64, 32, 0)
        out = layers.save_paint("x", {"veg": blank}, force=True,
                                overrides={"anchors": [[10, 10], [999, 5]], "coherent": [[20, 20]]})
        self.assertTrue(out["ok"])
        self.assertEqual(out["overrides"], {"anchors": 1, "coherent": 1})
        self.assertEqual(sway_field.read_overrides(self.dir), {"anchors": [[10.0, 10.0]], "coherent": [[20.0, 20.0]]})

        layers.save_paint("x", {"veg": blank}, force=True, overrides={"anchors": [], "coherent": []})
        hist = list(layers.history_dir(layers.Scene("x")).glob("overrides-*.json"))
        self.assertEqual(len(hist), 1, "覆盖作者的逐株设置前要留一份历史")

    def test_不带_overrides_的保存不动已有的逐株设置(self):
        blank = _gray_data_url(64, 32, 0)
        layers.save_paint("x", {"veg": blank}, force=True, overrides={"anchors": [[1, 1]], "coherent": []})
        layers.save_paint("x", {"veg": blank}, force=True)
        self.assertEqual(sway_field.read_overrides(self.dir)["anchors"], [[1.0, 1.0]],
                         "老页面(不认识逐株设置)存一次就把作者的锚点清掉,那是丢数据")


class GameLinkTests(unittest.TestCase):
    """找在跑的游戏:**别只信 devstate**。它缺省回 5173,而作者常跑在别的端口
    (本仓 launch.json 并列着 5173/5174/5178/5180/5188)。推错端口的症状是"推了没反应"、不报错。"""

    def setUp(self):
        layers._GAME_BASE.clear()
        self._alive = layers._slot_alive

    def tearDown(self):
        layers._slot_alive = self._alive
        layers._GAME_BASE.clear()

    def test_devstate_那个不应答时_会往下探其它端口(self):
        seen = []

        def fake(base, timeout=0.4):
            seen.append(base)
            return base.endswith(":5178")

        layers._slot_alive = fake
        self.assertEqual(layers.find_game(), "http://127.0.0.1:5178")
        self.assertIn("http://127.0.0.1:5178", seen)

    def test_一个都不应答就说找不到_而不是瞎推(self):
        layers._slot_alive = lambda base, timeout=0.4: False
        self.assertEqual(layers.find_game(), "")

    def test_探到过的记住_下次不再逐个试(self):
        calls = []

        def fake(base, timeout=0.4):
            calls.append(base)
            return base.endswith(":5178")

        layers._slot_alive = fake
        layers.find_game()
        n = len(calls)
        layers.find_game()
        self.assertEqual(len(calls), n + 1, "第二次只确认记住的那个")

    def test_游戏没开着不算错(self):
        layers._slot_alive = lambda base, timeout=0.4: False
        out = layers.push_to_game("跑马梁")
        self.assertFalse(out["pushed"])
        self.assertIn("没找到", out["why"])


class ServeTests(unittest.TestCase):
    def test_js_的_MIME_自己钉死(self):
        """Windows 注册表常把 .js 映射成 text/plain,浏览器按规范拒绝这种 MIME 的模块脚本(页面白屏)。"""
        self.assertEqual(serve.H.extensions_map[".js"], "text/javascript")

    def test_路由表齐全(self):
        src = (ROOT / "tools/sway_workbench/serve.py").read_text(encoding="utf-8")
        for route in ("/api/scenes", "/api/layers", "/api/img", "/api/ch", "/api/paint", "/api/bake",
                      "/api/history", "/api/restore", "/api/push", "/api/link/open"):
            self.assertIn(f'"{route}"', src, route)

    def test_场景清单不逐个打开原画(self):
        """36 个场景逐个 new Scene() 要解 36 张 PNG,页面要等十秒——清单只许拼路径。"""
        src = (ROOT / "tools/sway_workbench/layers.py").read_text(encoding="utf-8")
        head = src[src.index("def scenes("):src.index("def _read_json(")]
        self.assertNotIn("Scene(sid)", head)

    def test_场景清单能跑且带拆层状态(self):
        rows = layers.scenes()
        self.assertGreater(len(rows), 0)
        self.assertTrue(all("id" in r and "depth" in r for r in rows))

    def test_没有背景图的场景在清单里标出来(self):
        """制作人 2026-09-13"切了场景没反应":dev_room 没有背景图,装载 500,页面悄悄停在原场景。
        清单得报出来,页面才能把它标成装不了、不让选。"""
        import tempfile
        from unittest import mock
        with tempfile.TemporaryDirectory() as td:
            rt = Path(td)
            (rt / "有图").mkdir()
            (rt / "有图" / "background.png").write_bytes(b"x")
            (rt / "没图").mkdir()
            fake = lambda sid: {"bg_name": "background.png", "bg": rt / sid / "background.png"}  # noqa: E731
            with mock.patch.object(layers, "list_scenes", lambda: [{"id": "有图", "depth": True}, {"id": "没图", "depth": True}]),                     mock.patch.object(layers, "scene_paths", fake), mock.patch.object(layers, "SCENES_RT", rt):
                rows = {r["id"]: r for r in layers.scenes()}
        self.assertIs(rows["有图"]["hasBackground"], True)
        self.assertIs(rows["没图"]["hasBackground"], False)

    def test_真工程里每个场景都报了有没有背景图(self):
        rows = layers.scenes()
        self.assertTrue(all(isinstance(r.get("hasBackground"), bool) for r in rows))


class SeedLockTests(unittest.TestCase):
    """``--lock-ids`` 这条命令行:必须写作者涂层的「锁死」通道,不许另起一张图。

    这是把制作人的活吃掉过的那个 bug 的**另一半**:工作台那边已经收敛成"涂层是唯一来源"了,
    可命令行还在造 ``sway_lock.png``。只要还有第二个写入者,那个"擦掉 → 保存 → 刷新 → 全回来"
    就随时能复发一次。
    """

    def _src(self) -> str:
        return (ROOT / 'tools/character_lighting_lab/sway_field.py').read_text(encoding='utf-8')

    def test_并进锁死通道时别的三层一根汗毛都不动(self):
        import numpy as np

        paint = {
            'veg': np.full((4, 6), 200, np.uint8),
            'freeze': np.zeros((4, 6), np.uint8),
            'rigid': np.full((4, 6), 111, np.uint8),
            'unrigid': np.full((4, 6), 7, np.uint8),
        }
        paint['freeze'][0, 0] = 255                      # 作者手涂的一块
        mask = np.zeros((4, 6), bool)
        mask[2, 3] = True                                # 命令行圈的一株

        out = sway_field.freeze_into_paint(paint, mask)
        self.assertEqual(out.shape, (4, 6, 4))
        self.assertTrue((out[..., 0] == 200).all(), '补植被被动了')
        self.assertTrue((out[..., 2] == 111).all(), '加刚体被动了')
        self.assertTrue((out[..., 3] == 7).all(), '减刚体被动了')
        self.assertEqual(out[0, 0, 1], 255, '手涂的锁死块被覆盖掉了(应该取并集)')
        self.assertEqual(out[2, 3, 1], 255, '命令行圈的那株没锁上')
        self.assertEqual(out[1, 1, 1], 0, '没圈到的地方不该被锁')

    def test_还没有涂层时也写得出四通道(self):
        import numpy as np

        mask = np.zeros((3, 3), bool)
        mask[1, 1] = True
        out = sway_field.freeze_into_paint(None, mask)
        self.assertEqual(out.shape, (3, 3, 4))
        self.assertEqual(out[1, 1, 1], 255)
        self.assertEqual(int(out[..., 0].max()), 0)
        self.assertEqual(int(out[..., 2].max()), 0)

    def test_没有任何人再写_sway_lock_png(self):
        import re

        writes = re.findall(r'_atomic_bytes\([^)]*LOCK_FILE[^)]*\)', self._src())
        self.assertEqual(writes, [], f'又有人写 sway_lock.png 了:{writes}')

    def test_命令行覆盖前留的历史与工作台是同一套(self):
        """两条路各留一套历史 = 作者在工作台的「历史…」里找不到命令行覆盖前那一份。"""
        self.assertTrue(callable(layers.keep_history), 'keep_history 得是公开的,命令行那条路要用')
        body = self._src().split('def seed_lock')[1].split('def main')[0]
        self.assertIn('PAINT_FILE', body, 'seed_lock 应该写涂层(sway_paint.png)')
        self.assertIn('keep_history', body, 'seed_lock 覆盖涂层前没留历史')
        self.assertNotIn('_keep_history', body, '别用私有名,那是会被改掉的')


if __name__ == "__main__":
    unittest.main()
