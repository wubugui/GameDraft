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
        entries = [ln for ln in block.splitlines()[1:] if ln.strip() and not ln.strip().startswith("#")]
        self.assertEqual(len(entries), 3, f"matte 必须是三通道(RGB):{entries}")
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
            sid = "x"
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
            sid = "x"
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
            sid = "x"
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


class JobStatusTests(unittest.TestCase):
    """后台活(推给游戏 / 导出到游戏)的状态字段。⚠ 里面**不许**有叫 `ok` 的键:响应信封外层已经有一个,
    同名会把它盖掉,前端的 `api()` 一律当成"请求失败"——症状是刚点按钮就报错(实测撞过)。"""

    def test_状态字段不与信封的_ok_撞名(self):
        st = layers.job_status()
        self.assertNotIn("ok", st)
        for k in ("running", "done", "succeeded", "log", "elapsed"):
            self.assertIn(k, st, k)

    def test_同一时刻只许一个活_推送与导出互斥(self):
        layers._JOB["running"] = True
        try:
            for out in (layers.export_start("x"), layers.push_start("x")):
                self.assertFalse(out["ok"])
                self.assertTrue(out["busy"])
        finally:
            layers._JOB["running"] = False


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

    def test_导出中途被杀留下的暂存文件真的被排掉(self):
        """导出先写 ``*.tmp``、整套烘完再一起换上;中途被杀留下的暂存文件不是资源,不许跟着 DVC 走。"""
        for name in ("sway_matte.png.tmp", "sway.json.tmp", "sway_plate_normal.png.tmp"):
            self.assertTrue(_dvc_ignored(f"public/resources/runtime/scenes/跑马梁/lighting/background/{name}"), name)

    def test_正经的拆层产物一个都不许被排掉(self):
        """反面:规则写宽了会把该进 DVC 的产物一起排掉,那是真丢数据。"""
        for rel in ("public/resources/runtime/scenes/跑马梁/lighting/background/sway_matte.png",
                    "public/resources/runtime/scenes/跑马梁/lighting/background/sway_rigid.png",
                    "public/resources/runtime/scenes/跑马梁/lighting/background/sway_paint.png",
                    "public/resources/runtime/scenes/跑马梁/lighting/background/sway.json"):
            self.assertFalse(_dvc_ignored(rel), f"{rel} 被 .dvcignore 排掉了 —— 这张图是要跟着仓库走的")


def _wait_job(test: unittest.TestCase) -> dict:
    import time

    for _ in range(400):
        st = layers.job_status()
        if st["done"]:
            return st
        time.sleep(0.02)
    test.fail("后台活没结束")


class JobPushIsolationTests(unittest.TestCase):
    """通知游戏出岔子不许把一次**已经烘好**的活报成失败。

    合在一个 try 里的后果:产物明明落盘了,页面上写着"失败",作者会再烘一遍
    (第一次要跑分割,几十秒)——而且会开始怀疑这工具到底有没有在干活。
    """

    def setUp(self):
        import tempfile
        self._bake = sway_field.bake_sway
        self._push = layers.push_to_game
        self._state = dict(layers._JOB)
        # 导出成功会删这个场景的本机预览:指到空的临时目录,绝不碰作者真的 local/sway_preview/
        self._tmp = tempfile.TemporaryDirectory()
        self._preview_root = layers.PREVIEW_ROOT
        layers.PREVIEW_ROOT = Path(self._tmp.name) / "sway_preview"

    def tearDown(self):
        layers.PREVIEW_ROOT = self._preview_root
        self._tmp.cleanup()
        sway_field.bake_sway = self._bake
        layers.push_to_game = self._push
        # ⚠ 整本换回去,别只 update 那几个字段:`scene` / `started` / `push` 会留在字典里,
        # 将来谁断言 `job_status()` 的完整形状就会撞上这几个幽灵键。
        layers._JOB.clear()
        layers._JOB.update(self._state)

    def test_通知游戏抛异常时烘焙仍然算成功(self):
        sway_field.bake_sway = lambda sid, status=print, **kw: status("烘好了") or [{"key": "background", "instances": 3, "dir": "x"}]

        def boom(sid, source="export"):
            raise RuntimeError("游戏那边炸了")

        layers.push_to_game = boom
        layers.export_start("x")
        st = _wait_job(self)
        self.assertTrue(st["succeeded"], "烘好了却被报成失败 —— 作者会白白再烘一遍")
        self.assertFalse(st["running"])
        self.assertTrue(any("没送到游戏" in l for l in st["log"]), st["log"])

    def test_烘焙自己失败时照旧算失败(self):
        """反面:别把上面那条写成"永远成功"。"""
        def boom(sid, status=print, **kw):
            raise ValueError("分割挂了")

        sway_field.bake_sway = boom
        layers.push_to_game = lambda sid, source="export": {"pushed": False, "why": "没开着"}
        layers.export_start("x")
        st = _wait_job(self)
        self.assertFalse(st["succeeded"])
        self.assertIn("分割挂了", st["err"])


    def test_一个时段目录都没写就算失败_不许报已写进资源(self):
        """``bake_sway`` 每个时段都跳过(没有照明载荷 / 尺寸不对)时返回空表、不抛——原来照样报「✔ 已写进资源」,
        作者以为导出了,其实资源里什么都没进(2026-09-14 日常流程审查)。"""
        sway_field.bake_sway = lambda sid, status=print, **kw: status("跳过 background.png:没有照明载荷") or []
        layers.push_to_game = lambda sid, source="export": {"pushed": True, "rev": 1}
        layers.export_start("x")
        st = _wait_job(self)
        self.assertFalse(st["succeeded"])
        self.assertIn("一个时段目录都没写", st["err"])


class PushNoteTests(unittest.TestCase):
    """推送结果那一行要分清"游戏页换上了""游戏在别的场景""dev server 收下了但没有游戏页"——
    原来只要 dev server 收下就说「✔ 游戏里已换上」,游戏页根本没开也这么说。"""

    def test_三档说法(self):
        g_here = {"sceneId": "跑马梁", "bootId": "b", "preview": 3, "ageMs": 500}
        g_other = {"sceneId": "义庄", "bootId": "b", "preview": 0, "ageMs": 500}
        g_stale = {"sceneId": "跑马梁", "bootId": "b", "preview": 0, "ageMs": 60_000}
        mk = lambda g: {"pushed": True, "rev": 5, "game": g, "pageAlive": layers.page_alive(g),
                        "inScene": layers.page_alive(g) and g.get("sceneId") == "跑马梁"}
        self.assertIn("正在原地换上", layers.push_note(mk(g_here), "跑马梁"))
        self.assertIn("义庄", layers.push_note(mk(g_other), "跑马梁"))
        self.assertIn("没有游戏页开着", layers.push_note(mk(g_stale), "跑马梁"))
        self.assertIn("没送到游戏", layers.push_note({"pushed": False, "why": "没开着"}, "跑马梁"))
        self.assertFalse(layers.page_alive(None))
        self.assertFalse(layers.page_alive({"sceneId": "x"}))


class DraftStoreTests(unittest.TestCase):
    """草稿存 ``local/sway_drafts/``(不是浏览器 localStorage:桌面壳纯内存 profile,关窗就没了)。"""

    def setUp(self):
        import tempfile
        self._root = layers.DRAFT_ROOT
        self.tmp = Path(tempfile.mkdtemp())
        layers.DRAFT_ROOT = self.tmp

    def tearDown(self):
        import shutil
        layers.DRAFT_ROOT = self._root
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _sid(self) -> str:
        from tools.character_lighting_lab.scene_geometry import SCENES_RT
        rows = [p.name for p in SCENES_RT.iterdir() if p.is_dir()] if SCENES_RT.is_dir() else []
        if not rows:
            self.skipTest("本机没有场景目录")
        return rows[0]

    def test_存取清_往返(self):
        sid = self._sid()
        self.assertIsNone(layers.draft_get(sid))
        layers.draft_put(sid, {"at": 1, "base": 2.5, "ch": {"rigid": "data:image/png;base64,AAA"}})
        self.assertEqual(layers.draft_get(sid)["ch"]["rigid"], "data:image/png;base64,AAA")
        self.assertTrue((self.tmp / f"{sid}.json").is_file())
        self.assertTrue(layers.draft_clear(sid)["cleared"])
        self.assertIsNone(layers.draft_get(sid))
        self.assertFalse(layers.draft_clear(sid)["cleared"])

    def test_先不管_收起来_自动草稿与存盘都不碰它_能取回能删(self):
        sid = self._sid()
        layers.draft_put(sid, {"at": 1700000000123, "base": 1.0, "ch": {"rigid": "data:image/png;base64,AAA"}, "ov": {"anchors": []}})
        r = layers.draft_stash(sid)
        self.assertEqual(r["stashed"], f"{sid}.stash-1700000000123.json")
        self.assertIsNone(layers.draft_get(sid), "收起来之后主草稿位置空出来")
        layers.draft_put(sid, {"at": 2, "ch": {"veg": "x"}})           # 之后的自动草稿
        layers.draft_clear(sid)                                           # 存盘清草稿
        rows = layers.draft_stashes(sid)
        self.assertEqual([x["name"] for x in rows], [f"{sid}.stash-1700000000123.json"])
        self.assertEqual(rows[0]["channels"], ["rigid"])
        self.assertTrue(rows[0]["ov"])
        self.assertEqual(layers.draft_stash_get(sid, rows[0]["name"])["ch"]["rigid"], "data:image/png;base64,AAA")
        self.assertTrue(layers.draft_stash_delete(sid, rows[0]["name"])["deleted"])
        self.assertEqual(layers.draft_stashes(sid), [])

    def test_收起来的草稿每场景只留几份_名字拼路径一律拒(self):
        sid = self._sid()
        for i in range(layers.DRAFT_STASH_KEEP + 3):
            layers.draft_put(sid, {"at": 1000 + i, "ch": {"veg": "x"}})
            layers.draft_stash(sid)
        rows = layers.draft_stashes(sid)
        self.assertEqual(len(rows), layers.DRAFT_STASH_KEEP)
        self.assertEqual(rows[0]["name"], f"{sid}.stash-{1000 + layers.DRAFT_STASH_KEEP + 2}.json", "新的在前、旧的被剪")
        for bad in ("../x.json", f"{sid}.json", f"{sid}.stash-1.json/../../a", "a.stash-1.json", f"{sid}.stash-x.json"):
            with self.assertRaises(ValueError, msg=bad):
                layers.draft_stash_get(sid, bad)
            with self.assertRaises(ValueError, msg=bad):
                layers.draft_stash_delete(sid, bad)

    def test_场景名拼路径_或者场景不存在_一律拒(self):
        for bad in ("../x", "a/b", "..", "", "__根本没有这个场景__"):
            with self.assertRaises(ValueError, msg=bad):
                layers.draft_put(bad, {"at": 1})
        self.assertFalse(any(self.tmp.iterdir()))


class PushVsExportTests(unittest.TestCase):
    """🔴 推给游戏 ≠ 导出到游戏(制作人 2026-09-14:"推给游戏是指立即推送给运行时的游戏!资源写游戏应该叫做导出到游戏")。

    原先的「推给游戏」只让游戏重装**盘上已经烘好的**拆层,涂了、存了、按多少次都看不到——
    这里钉死两条路各自读什么、写到哪、告诉游戏什么。
    """

    def setUp(self):
        import tempfile
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        self.res = root / "res" / "lighting" / "background"
        self.res.mkdir(parents=True)
        self.preview = root / "preview"

        test = self

        class FakeScene:
            sid = "x"
            native = (64, 32)
            bake_dir = test.res
            bg_name = "background.png"
            rt_dir = test.res.parent.parent

        self._orig = (layers.Scene, layers.PREVIEW_ROOT, sway_field.bake_sway, layers.push_to_game, dict(layers._JOB))
        layers.Scene = lambda sid: FakeScene()
        layers.PREVIEW_ROOT = self.preview
        self.calls: list = []
        self.pushes: list = []

        def fake_bake(sid, status=print, **kw):
            self.calls.append((sid, kw))
            return [{"key": "background", "instances": 3, "dir": "x"}]

        sway_field.bake_sway = fake_bake
        layers.push_to_game = lambda sid, source="export": (self.pushes.append((sid, source))
                                                            or {"pushed": True, "rev": 7})

    def tearDown(self):
        layers.Scene, layers.PREVIEW_ROOT, sway_field.bake_sway, layers.push_to_game, state = self._orig
        layers._JOB.clear()
        layers._JOB.update(state)
        self.tmp.cleanup()

    def test_推给游戏_用页面上此刻的四层_烘进预览目录_告诉游戏是预览(self):
        ch = {"veg": _gray_data_url(64, 32, 0), "freeze": _gray_data_url(64, 32, 0),
              "rigid": _gray_data_url(16, 8, 255), "unrigid": _gray_data_url(64, 32, 0)}
        layers.push_start("x", ch, {"anchors": [[10, 10], [999, 999]], "coherent": []})
        st = _wait_job(self)
        self.assertTrue(st["succeeded"], st)
        (sid, kw), = self.calls
        self.assertEqual(kw["out_root"], self.preview / "x", "预览必须落在预览目录,不许写资源")
        paint = kw["inputs"]["paint"]
        self.assertEqual(paint["rigid"].shape, (32, 64), "尺寸不对的层要拉回原画分辨率")
        self.assertEqual(int(paint["rigid"].min()), 255, "页面上涂的刚体没传进烘焙")
        self.assertEqual(kw["inputs"]["overrides"]["anchors"], [[10.0, 10.0]], "越界的锚点要丢掉")
        self.assertEqual(self.pushes, [("x", "preview")])

    def test_推给游戏_页面缺的层按空处理(self):
        layers.push_start("x", {"rigid": _gray_data_url(64, 32, 255)}, None)
        _wait_job(self)
        paint = self.calls[0][1]["inputs"]["paint"]
        self.assertEqual(set(paint), {"veg", "freeze", "rigid", "unrigid"})
        self.assertEqual(int(paint["veg"].max()), 0)

    def test_导出到游戏_读盘上的输入_写资源_告诉游戏换回资源(self):
        layers.export_start("x")
        st = _wait_job(self)
        self.assertTrue(st["succeeded"], st)
        (sid, kw), = self.calls
        self.assertEqual(kw, {}, "导出不许带 inputs / out_root:读的是盘上那份、写的是资源")
        self.assertEqual(self.pushes, [("x", "export")])

    def test_叠加层与检视跟着更新的那一份走(self):
        """推过预览、还没导出:工作台叠加层要显示游戏里正显示的那份;导出之后换回资源。"""
        import os
        import time

        from PIL import Image

        (self.res / "sway.json").write_text(json.dumps({"version": 3, "instances": [{"id": 1}]}), encoding="utf-8")
        Image.new("RGB", (64, 32), (0, 0, 0)).save(self.res / "sway_rigid.png")
        L = layers.layers("x")
        self.assertEqual(L["source"], "export")
        self.assertEqual(L["previewMtime"], 0.0)

        pv = self.preview / "x" / "background"
        pv.mkdir(parents=True)
        (pv / "sway.json").write_text(json.dumps({"version": 3, "instances": [{"id": 1}, {"id": 2}], "preview": True}),
                                      encoding="utf-8")
        Image.new("RGB", (64, 32), (255, 255, 255)).save(pv / "sway_rigid.png")
        later = time.time() + 5
        for p in (pv / "sway.json", pv / "sway_rigid.png"):
            os.utime(p, (later, later))
        L = layers.layers("x")
        self.assertEqual(L["source"], "preview")
        self.assertEqual(len(L["instances"]), 2)
        self.assertGreater(L["previewMtime"], L["bakedMtime"], "推过没导出 ⇒ 页面要能说出游戏里是预览")
        raw, _ = layers.image_bytes("x", "rigid")
        self.assertEqual(Image.open(io.BytesIO(raw)).getpixel((0, 0)), (255, 255, 255))

        even_later = later + 5
        os.utime(self.res / "sway.json", (even_later, even_later))       # 之后导出过
        self.assertEqual(layers.layers("x")["source"], "export")
        raw, _ = layers.image_bytes("x", "rigid")
        self.assertEqual(Image.open(io.BytesIO(raw)).getpixel((0, 0)), (0, 0, 0))

    def test_通知游戏的来源只认两种(self):
        layers.push_to_game = self._orig[3]
        with self.assertRaises(ValueError):
            layers.push_to_game("x", "乱写")


class PreviewContractTests(unittest.TestCase):
    """预览目录是 Python 写、vite 插件读——两边各写一份路径与文件名单,漂了就是"推了没反应"且零报错。"""

    def _ts(self) -> str:
        return (ROOT / "src/dev/runtimeSwaySync.ts").read_text(encoding="utf-8")

    def test_预览根目录两边一致(self):
        import re

        m = re.search(r"RUNTIME_SWAY_PREVIEW_DIR = '([^']+)'", self._ts())
        self.assertIsNotNone(m)
        self.assertEqual(layers.PREVIEW_ROOT, ROOT / Path(m.group(1)))

    def test_文件名单两边一致(self):
        import re

        block = self._ts().split("SWAY_PREVIEW_FILES")[1].split("];")[0]
        self.assertEqual(set(re.findall(r"'([^']+)'", block)), set(layers.DERIVED))
        # 烘焙可能写出的每一张都得在名单里(少一张 = 游戏去要时插件回 400,那张图静默缺席)
        for name in ("sway_matte.png", "sway_ids.png", "sway_rigid.png", "sway_plate.png", "sway.json",
                     *sway_field.LIT_PLATE_FILES.values()):
            self.assertIn(name, layers.DERIVED, name)

    def test_预览不进仓库_不进发行包(self):
        """在 local/ 下:gitignore 排掉、不在 public/ 下(打包按载荷入口从 public 抽,碰不到它)。"""
        rel = layers.PREVIEW_ROOT.relative_to(ROOT).as_posix()
        self.assertTrue(rel.startswith("local/"), rel)
        self.assertIn("local/", (ROOT / ".gitignore").read_text(encoding="utf-8").splitlines())


class PreviewBakeIntegrationTests(unittest.TestCase):
    """真场景(跑马梁)真烘:推给游戏的预览**资源一个字节不动**;页面上涂的刚体进了预览;缓存命中与不走缓存逐位相同。

    需要本机的分割缓存(系统临时目录 gamedraft_sway_seg,烘过一次就有);没有就跳过(不去下载模型)。约 40 秒。
    """

    SID = "跑马梁"

    @classmethod
    def setUpClass(cls):
        import tempfile

        from tools.character_lighting_lab.scene_geometry import Scene

        bg = Scene(cls.SID).rt_dir / sway_field.scene_paths(cls.SID)["bg_name"]
        key = __import__("hashlib").sha1(bg.read_bytes() + sway_field.SAM_MODEL.encode()
                                         + str(sway_field.SCORE_THRESHOLD).encode()).hexdigest()[:16]
        seg_dir = Path(tempfile.gettempdir()) / "gamedraft_sway_seg"
        if not any(seg_dir.glob(f"{key}_*.npz")):
            raise unittest.SkipTest("本机没有跑马梁的分割缓存")

    def _fingerprint(self) -> dict:
        import hashlib

        d = ROOT / "public/resources/runtime/scenes" / self.SID / "lighting"
        return {p.relative_to(d).as_posix(): hashlib.sha256(p.read_bytes()).hexdigest()
                for p in sorted(d.rglob("*")) if p.is_file()}

    def _clear_caches(self):
        for c in (sway_field._SEG_MEM, sway_field._PLAN_MEM, sway_field._FILL_MEM, sway_field._STAGE_MEM,
                  sway_field._INST_MEM, sway_field._PNG_MEM):
            c.clear()

    def test_预览不碰资源_刚体进预览_缓存与不缓存逐位相同(self):
        import tempfile

        import numpy as np
        from PIL import Image

        from tools.character_lighting_lab.scene_geometry import Scene

        bd = Scene(self.SID).bake_dir
        before = self._fingerprint()
        paint = sway_field.read_paint(bd, (2048, 1152), lambda _m: None) or {
            k: np.zeros((1152, 2048), np.uint8) for k in ("veg", "freeze", "rigid", "unrigid")}
        ov = sway_field.read_overrides(bd)
        ids = np.asarray(Image.open(bd / "sway_ids.png")).astype(np.int64)
        veg = (ids[..., 0] + 256 * ids[..., 1]) > 0
        rig0 = np.asarray(Image.open(bd / "sway_rigid.png"))[..., 0]
        # 找一块全是植被、原来没有刚体的 40×12,在"页面上"涂成刚体
        spot = next((y, x) for y in range(0, 1100, 16) for x in range(0, 2030, 16)
                    if veg[y:y + 40, x:x + 12].all() and rig0[y:y + 40, x:x + 12].max() == 0
                    and paint["rigid"][y:y + 40, x:x + 12].max() == 0)
        y, x = spot
        painted = {k: v.copy() for k, v in paint.items()}
        painted["rigid"][y:y + 40, x:x + 12] = 255

        with tempfile.TemporaryDirectory() as td:
            out = Path(td)
            self._clear_caches()
            sway_field.bake_sway(self.SID, lambda _m: None, inputs={"paint": paint, "overrides": ov}, out_root=out)
            sway_field.bake_sway(self.SID, lambda _m: None, inputs={"paint": painted, "overrides": ov}, out_root=out)
            warm = {p.relative_to(out).as_posix(): np.asarray(Image.open(p)) if p.suffix == ".png"
                    else json.loads(p.read_text(encoding="utf-8")) for p in sorted(out.rglob("sway*"))}
            self._clear_caches()
            sway_field.bake_sway(self.SID, lambda _m: None, inputs={"paint": painted, "overrides": ov}, out_root=out)
            cold = {p.relative_to(out).as_posix(): np.asarray(Image.open(p)) if p.suffix == ".png"
                    else json.loads(p.read_text(encoding="utf-8")) for p in sorted(out.rglob("sway*"))}

        self.assertEqual(self._fingerprint(), before, "推给游戏的预览动到了资源")
        self.assertEqual(set(warm), set(cold))
        self.assertIn("background/sway_rigid.png", warm)
        for name, a in warm.items():
            if isinstance(a, dict):
                self.assertEqual(a, cold[name], name)
            else:
                self.assertTrue(a.shape == cold[name].shape and (a == cold[name]).all(), f"{name}:走缓存与不走缓存不一样")
        for key in [k for k in warm if k.endswith("/sway_rigid.png")]:
            self.assertGreaterEqual(int(warm[key][y:y + 40, x:x + 12, 0].mean()), 250,
                                    f"{key}:页面上涂的刚体没进预览")
        self.assertTrue(all(v.get("preview") for k, v in warm.items() if k.endswith("sway.json")))

    def test_补植被改了植被归属_走缓存的底板与叠加层照样逐位相同(self):
        """上一条只走"植被没变"那条缓存路;这条补一块新植被,逼着按植被记的那几段(补带、距离变换、底板)重算。"""
        import tempfile

        import numpy as np
        from PIL import Image
        from scipy import ndimage as ndi

        from tools.character_lighting_lab.scene_geometry import Scene

        bd = Scene(self.SID).bake_dir
        before = self._fingerprint()
        paint = sway_field.read_paint(bd, (2048, 1152), lambda _m: None) or {
            k: np.zeros((1152, 2048), np.uint8) for k in ("veg", "freeze", "rigid", "unrigid")}
        ov = sway_field.read_overrides(bd)
        read = lambda out: {p.relative_to(out).as_posix(): np.asarray(Image.open(p)) if p.suffix == ".png"  # noqa: E731
                            else json.loads(p.read_text(encoding="utf-8")) for p in sorted(out.rglob("sway*"))}
        with tempfile.TemporaryDirectory() as td:
            out = Path(td)
            self._clear_caches()
            sway_field.bake_sway(self.SID, lambda _m: None, inputs={"paint": paint, "overrides": ov}, out_root=out)
            base = next(v for v in sway_field._STAGE_MEM.values() if isinstance(v, dict) and "rock" in v)
            ids = np.asarray(Image.open(out / "background" / "sway_ids.png")).astype(np.int64)
            veg = (ids[..., 0] + 256 * ids[..., 1]) > 0
            far = ndi.distance_transform_edt(~veg) > 40
            free = far & ~base["rock"] & (paint["freeze"] < 128)
            y, x = next((y, x) for y in range(40, 1100, 20) for x in range(40, 2000, 20) if free[y:y + 30, x:x + 30].all())
            painted = {k: v.copy() for k, v in paint.items()}
            painted["veg"][y:y + 30, x:x + 30] = 255
            sway_field.bake_sway(self.SID, lambda _m: None, inputs={"paint": painted, "overrides": ov}, out_root=out)
            warm = read(out)
            self._clear_caches()
            sway_field.bake_sway(self.SID, lambda _m: None, inputs={"paint": painted, "overrides": ov}, out_root=out)
            cold = read(out)
        self.assertEqual(self._fingerprint(), before, "推给游戏的预览动到了资源")
        # 先确认这条真走到了"植被变了"(按不走缓存的那份判),再比走缓存的
        self.assertGreater(int((cold["background/sway_ids.png"][y:y + 30, x:x + 30, :2].astype(int).sum(-1) > 0).sum()), 800,
                           "补的植被没成株,这条就没测到植被变了的那条路")
        self.assertEqual(set(warm), set(cold))
        for name, a in warm.items():
            if isinstance(a, dict):
                self.assertEqual(a, cold[name], name)
            else:
                self.assertTrue(a.shape == cold[name].shape and (a == cold[name]).all(), f"{name}:走缓存与不走缓存不一样")


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
            sid = "x"
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
        self.assertEqual(out["overrides"], {"anchors": 1, "coherent": 1, "changed": True})
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
        for route in ("/api/scenes", "/api/layers", "/api/img", "/api/ch", "/api/paint", "/api/export",
                      "/api/job/status", "/api/warm", "/api/history", "/api/restore", "/api/push",
                      "/api/push/notify", "/api/link/open"):
            self.assertIn(f'"{route}"', src, route)
        # 旧的"重烘"口子不许留着:它写资源,却挂着像是"只看看"的名字
        self.assertNotIn('"/api/bake"', src)

    def test_页面上两个按钮打的是对的口子(self):
        js = (ROOT / "tools/sway_workbench/viewer/app.js").read_text(encoding="utf-8")
        html = (ROOT / "tools/sway_workbench/viewer/index.html").read_text(encoding="utf-8")
        self.assertIn('id="push"', html)
        self.assertIn('id="export"', html)
        self.assertIn("推给游戏", html)
        self.assertIn("导出到游戏", html)
        self.assertNotIn("重烘", html + js, "按钮 / 提示里不许再出现「重烘」:它没说清是推给游戏还是写资源")
        push = js.split("async function pushToGame")[1].split("\nasync function ")[0]
        self.assertIn("'/api/push'", push)
        self.assertIn("channels", push, "推给游戏要带页面上此刻的四层(存没存都算)")
        self.assertNotIn("save(", push, "推给游戏不写资源,不许先存盘")
        # 导出可能拆成「exportToGame(独占 / 关窗保护要等的那个 promise)+ async exportOnce(真干活)」两段:两段连起来看
        i = js.index("function exportToGame")
        j = js.find("async function exportOnce", i)
        exp = js[i:js.index("\n}\n", j if j >= 0 else i)]
        self.assertIn("'/api/export'", exp)
        self.assertIn("save()", exp, "导出读的是盘上那份,没存就导出 = 导出的是上一版")
        self.assertLess(exp.index("save()"), exp.index("'/api/export'"), "先存盘再导出")

    def test_页内下拉列表经白名单转发_排在页面脚本前面(self):
        """第六轮复核 #5:场景下拉框不许弹 QtWebEngine 原生弹窗(150% 缩放下越开越大、不吃暗色)。"""
        import threading
        import urllib.error
        import urllib.request
        from http.server import ThreadingHTTPServer

        srv = ThreadingHTTPServer(("127.0.0.1", 0), serve.H)
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        base = f"http://127.0.0.1:{srv.server_address[1]}"
        try:
            with urllib.request.urlopen(base + "/vendor/dropdown.js", timeout=5) as r:     # noqa: S310
                body, ctype = r.read(), r.headers.get("Content-Type", "")
            self.assertEqual(body, (ROOT / "tools/trajectory_workbench/viewer/dropdown.js").read_bytes(), "原样转发,不 fork")
            self.assertTrue(ctype.startswith("text/javascript"), ctype)
            for bad in ("/vendor/common.js", "/vendor/..%2Fserve.py", "/vendor/"):
                with self.assertRaises(urllib.error.HTTPError, msg=bad) as cm:
                    urllib.request.urlopen(base + bad, timeout=5)                        # noqa: S310
                self.assertEqual(cm.exception.code, 404, bad)
                cm.exception.close()
        finally:
            srv.shutdown()
            srv.server_close()
        html = (ROOT / "tools/sway_workbench/viewer/index.html").read_text(encoding="utf-8")
        self.assertIn('<script src="/vendor/dropdown.js"></script>', html)
        self.assertLess(html.index("/vendor/dropdown.js"), html.index('src="./app.js"'),
                        "要排在 app.js 前面:它的 Esc 挂 window 捕获,得先于页面对话框的 Esc")

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


class _FakeSceneMixin:
    """tmp 目录里假造一个 64×32 的烘焙目录(不碰真工程)。"""

    def setUp(self):
        import tempfile
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)
        test = self

        class FakeScene:
            sid = "x"
            native = (64, 32)
            bake_dir = test.dir
            bg_name = "background.png"
            rt_dir = test.dir

        self._orig_scene = layers.Scene
        layers.Scene = lambda sid: FakeScene()

    def tearDown(self):
        layers.Scene = self._orig_scene
        self.tmp.cleanup()

    def _rigid_value(self, raw: bytes) -> int:
        from PIL import Image
        return int(Image.open(io.BytesIO(raw)).convert("RGBA").getpixel((0, 0))[2])


class HistoryRestoreTests(_FakeSceneMixin, unittest.TestCase):
    """「历史…」这一套:恢复最旧那份、时间戳是内容自己的存盘时刻、没改涂层的保存不挤历史(2026-09-14 复核)。"""

    def test_历史满_20_份时恢复最旧那一份_照样恢复且那一份还在(self):
        """原来恢复先留历史(剪掉最旧的——正是要恢复的那份)再读:恢复失败,那一版永久丢了。"""
        for i in range(layers.HISTORY_KEEP + 2):
            out = layers.save_paint("x", {"rigid": _gray_data_url(64, 32, 10 + i * 11)}, force=True)
            self.assertTrue(out["ok"], out)
        items = layers.history("x")
        self.assertEqual(len(items), layers.HISTORY_KEEP)
        hist = layers.history_dir(layers.Scene("x"))
        oldest = items[-1]["name"]
        want = self._rigid_value((hist / f"{oldest}.png").read_bytes())
        current = self._rigid_value((self.dir / sway_field.PAINT_FILE).read_bytes())

        r = layers.restore("x", oldest)
        self.assertTrue(r.get("ok"), r)
        self.assertEqual(self._rigid_value((self.dir / sway_field.PAINT_FILE).read_bytes()), want, "恢复的不是那一份")
        self.assertTrue((hist / f"{oldest}.png").is_file(), "要恢复的那份被这次恢复自己剪掉了")
        names = [it["name"] for it in layers.history("x")]
        self.assertEqual(len(names), layers.HISTORY_KEEP)
        self.assertIn(current, [self._rigid_value((hist / f"{n}.png").read_bytes()) for n in names],
                      "恢复前的当前这份没进历史,恢复就撤不回来了")

    def test_历史文件名是那份内容自己的存盘时刻_不是被替换的时刻(self):
        """原来按"现在"命名:15:30 那一行装的是 15:00 存的内容,作者点"15:00"拿到的是更早的一版。"""
        import os
        import time

        layers.save_paint("x", {"rigid": _gray_data_url(64, 32, 255)})
        p = self.dir / sway_field.PAINT_FILE
        t = time.mktime((2026, 1, 2, 3, 4, 5, 0, 0, -1)) + 0.678
        os.utime(p, (t, t))
        content = p.read_bytes()
        layers.save_paint("x", {"rigid": _gray_data_url(64, 32, 0)}, force=True)
        newest = layers.history("x")[0]
        self.assertTrue(newest["name"].startswith("20260102-030405-678"), newest)
        self.assertEqual((layers.history_dir(layers.Scene("x")) / f"{newest['name']}.png").read_bytes(), content)
        self.assertAlmostEqual(newest["mtime"], t, places=2)

    def test_同一份内容不重复进历史(self):
        """同一时刻存下的同一份再调一次 keep_history(命令行 seed_lock 与工作台前后脚)不许多出一份去挤真历史。"""
        layers.save_paint("x", {"rigid": _gray_data_url(64, 32, 255)})
        sc = layers.Scene("x")
        layers.keep_history(sc)
        layers.keep_history(sc)
        self.assertEqual(len(layers.history("x")), 1)

    def test_只改锚点的保存_不留涂层历史_不重写涂层_照样存逐株设置(self):
        """调二十轮锚点(含「导出到游戏」前自动的那次保存),「历史…」里原来就是二十份一模一样的涂层。"""
        full = _gray_data_url(64, 32, 255)
        layers.save_paint("x", {"rigid": full})
        layers.save_paint("x", {"rigid": _gray_data_url(64, 32, 0)}, force=True)
        layers.save_paint("x", {"rigid": full}, force=True)
        p = self.dir / sway_field.PAINT_FILE
        n_hist = len(layers.history("x"))
        raw, st = p.read_bytes(), p.stat().st_mtime_ns
        disk_mtime = layers.paint_state("x")["mtime"]

        for i in range(3):
            out = layers.save_paint("x", {"rigid": full}, base_mtime=disk_mtime,
                                    overrides={"anchors": [[5 + i, 5]], "coherent": []})
            self.assertTrue(out["ok"], out)
            self.assertTrue(out["paintUnchanged"])
            self.assertEqual(out["mtime"], disk_mtime, "没重写就回盘上原来的 mtime,页面的 baseMtime 才对得上")
        self.assertEqual(len(layers.history("x")), n_hist, "涂层没变却又留了历史")
        self.assertEqual((p.read_bytes(), p.stat().st_mtime_ns), (raw, st), "涂层没变却重写了")
        self.assertEqual(sway_field.read_overrides(self.dir)["anchors"], [[7.0, 5.0]], "逐株设置照样要存")

        out = layers.save_paint("x", {"rigid": full, "veg": full}, base_mtime=disk_mtime)
        self.assertFalse(out["paintUnchanged"])
        # 被替换的这份(只有刚体满)前面已经留过一份一模一样的:不再留副本(第四轮复核 #7)
        self.assertEqual(len(layers.history("x")), n_hist, "同样字节的已经在历史里,又留了一份副本")
        out = layers.save_paint("x", {"veg": full}, base_mtime=out["mtime"], force=True)
        self.assertFalse(out["paintUnchanged"])
        self.assertEqual(len(layers.history("x")), n_hist + 1, "真改了涂层、被替换的是新内容,就照常留历史")


class NeedsExportTests(_FakeSceneMixin, unittest.TestCase):
    """「● 待导出」按资源 sway.json 里导出时盖的**输入指纹**判,不按写盘时刻(2026-09-14 复核 #29)。"""

    def _meta(self, **extra) -> None:
        (self.dir / "sway.json").write_text(json.dumps({"version": sway_field.SWAY_VERSION, "instances": [], **extra}),
                                            encoding="utf-8")

    def test_layers_带_needsExport_且按指纹判(self):
        L = layers.layers("x")
        self.assertIs(L["needsExport"], False, "什么都没有")
        layers.save_paint("x", {"rigid": _gray_data_url(64, 32, 255)}, overrides={"anchors": [[1, 1]], "coherent": []})
        self.assertIs(layers.layers("x")["needsExport"], True, "存过、从没导出过")

        self._meta(inputs=sway_field.input_fingerprint(self.dir))
        self.assertIs(layers.layers("x")["needsExport"], False, "资源就是拿盘上这份烘的")

        disk = layers.paint_state("x")["mtime"]
        layers.save_paint("x", {"rigid": _gray_data_url(64, 32, 255)}, base_mtime=disk,
                          overrides={"anchors": [[2, 2]], "coherent": []})
        self.assertIs(layers.layers("x")["needsExport"], True, "只改了逐株设置也是没进资源")

    def test_导出烘的途中又存了一次_sway_json_写得更晚也照样待导出(self):
        import os
        import time

        layers.save_paint("x", {"rigid": _gray_data_url(64, 32, 255)})
        fp = sway_field.input_fingerprint(self.dir)                     # 烘焙开头读输入
        layers.save_paint("x", {"rigid": _gray_data_url(64, 32, 255), "veg": _gray_data_url(64, 32, 255)},
                          base_mtime=layers.paint_state("x")["mtime"])  # 烘的途中作者又存了一次
        self._meta(inputs=fp)                                            # 烘完 sway.json 最后写
        later = time.time() + 5
        os.utime(self.dir / "sway.json", (later, later))
        L = layers.layers("x")
        self.assertLess(L["paintMtime"], L["bakedMtime"], "前提:按时刻比会说已导出")
        self.assertIs(L["needsExport"], True, "资源里没有途中存的那几笔,「待导出」不许熄")

    def test_老的_sway_json_没有指纹_退回时刻比较(self):
        import os
        import time

        layers.save_paint("x", {"rigid": _gray_data_url(64, 32, 255)})
        self._meta()
        later = time.time() + 5
        os.utime(self.dir / "sway.json", (later, later))
        self.assertIs(layers.layers("x")["needsExport"], False)
        earlier = time.time() - 3600
        os.utime(self.dir / "sway.json", (earlier, earlier))
        self.assertIs(layers.layers("x")["needsExport"], True)


class ExportStagingTests(unittest.TestCase):
    """导出写资源必须**成套**就位:烘到一半被打断(关窗 / 进程被杀 / 抛异常)资源里还是上一整套(复核 #3 / #8)。

    烘焙本体(分割 / 拆层 / 补底板)一律换成桩,只跑 `bake_sway` 的暂存与就位;全在 tmp 目录里。
    """

    BGS = ("background.png", "night.png")

    def setUp(self):
        import tempfile
        from unittest import mock

        import numpy as np
        from PIL import Image

        self.tmp = tempfile.TemporaryDirectory()
        rt = self.rt = Path(self.tmp.name)
        (rt / "background.png").write_bytes(b"bg")
        self.dirs = {}
        self.old = {}
        for bg in self.BGS:
            d = rt / "lighting" / Path(bg).stem
            d.mkdir(parents=True)
            (d / "geometry.json").write_text("{}", encoding="utf-8")
            for name, raw in (("sway_matte.png", b"old-matte"), ("sway_ids.png", b"old-ids"),
                              ("sway_rigid.png", b"old-rigid"), ("sway_plate.png", b"old-plate"),
                              ("sway.json", json.dumps({"version": "old", "instances": [{"id": 9}]}).encode())):
                (d / name).write_bytes(raw)
            self.dirs[bg] = d
            self.old[bg] = {p.name: p.read_bytes() for p in d.iterdir()}
        self.main = self.dirs["background.png"]
        buf = io.BytesIO()
        Image.new("RGBA", (8, 4), (0, 0, 255, 0)).save(buf, format="PNG")
        (self.main / sway_field.PAINT_FILE).write_bytes(buf.getvalue())

        class Ref:
            def __init__(self, sid, background=None):
                self.sid, self.bg_name, self.rt_dir, self.native = sid, background or "background.png", rt, (8, 4)

            @property
            def bake_dir(self):
                return rt / "lighting" / Path(self.bg_name).stem

        self.during_build = None
        self.plate_fail_on = None
        self.plates = []

        def fake_build(scene, data, seg, status=print, lock=None, paint=None, overrides=None):
            if self.during_build:
                self.during_build()
            maps = {n: np.full((4, 8, 3), 200, np.uint8) for n in ("sway_matte.png", "sway_ids.png", "sway_rigid.png")}
            return maps, {"_veg": np.zeros((4, 8), bool), "margin": 1, "lock": None, "paint": None,
                          "rigid_coverage": 0, "overrides": None, "depthScale": None, "veg_coverage": 0,
                          "rock_coverage": 0, "instances": [{"id": 1}, {"id": 2}]}

        def fake_plate(src, veg, read, encode, fast):
            self.plates.append(src.name)
            if src.name == self.plate_fail_on:
                raise KeyboardInterrupt("作者关窗了")          # 模拟"烘到一半进程没了"(不是 Exception,别被谁顺手接住)
            return b"new-plate-" + src.name.encode()

        self.lit_slots = []

        def fake_lit_plates(s, veg, depth_rel, status=print, fast=False):
            self.lit_slots.append(s.bake_dir.name)
            return {name: b"lit-" + name.encode() for name in sway_field.LIT_PLATE_FILES.values()}

        self.patches = [
            mock.patch.object(sway_field, "scene_paths", lambda sid: {"bg_name": "background.png", "data": {}}),
            mock.patch.object(sway_field, "_SceneRef", Ref),
            mock.patch.object(sway_field, "CachedSegmenter", lambda raw, status: None),
            mock.patch.object(sway_field, "build_layers", fake_build),
            mock.patch.object(sway_field, "scene_backgrounds", lambda sid: list(self.BGS)),
            mock.patch.object(sway_field, "_plate_png", fake_plate),
            mock.patch.object(sway_field, "lit_plates", fake_lit_plates),
        ]
        for p in self.patches:
            p.start()

    def tearDown(self):
        for p in self.patches:
            p.stop()
        self.tmp.cleanup()

    def _snapshot(self, bg):
        return {p.name: p.read_bytes() for p in self.dirs[bg].iterdir() if p.name != sway_field.PAINT_FILE}

    def test_烘到第二个时段被打断_两个时段都还是上一整套_不留临时文件(self):
        self.plate_fail_on = "night.png"
        with self.assertRaises(KeyboardInterrupt):
            sway_field.bake_sway("x", lambda _m: None)
        self.assertEqual(self.plates, list(self.BGS), "前提:第一个时段的图都已经算好暂存了")
        for bg in self.BGS:
            self.assertEqual(self._snapshot(bg), {k: v for k, v in self.old[bg].items()},
                             f"{bg}:被打断后资源里混进了新的一半(新 id 图配旧实例表)")
        self.assertEqual(list(self.rt.rglob("*.tmp")), [], "暂存的半套要删掉")

    def test_烘完整套就位_sway_json_盖上读输入之前的指纹(self):
        fp = sway_field.input_fingerprint(self.main)
        (self.main / "sway.png").write_bytes(b"v1")
        rows = sway_field.bake_sway("x", lambda _m: None)
        self.assertEqual([r["key"] for r in rows], ["background", "night"])
        for bg in self.BGS:
            d = self.dirs[bg]
            self.assertEqual((d / "sway_plate.png").read_bytes(), b"new-plate-" + bg.encode())
            self.assertNotEqual((d / "sway_matte.png").read_bytes(), b"old-matte")
            meta = json.loads((d / "sway.json").read_text(encoding="utf-8"))
            self.assertEqual(len(meta["instances"]), 2)
            self.assertEqual(meta["inputs"], fp)
            self.assertNotIn("preview", meta)
        self.assertFalse((self.main / "sway.png").exists(), "v1 的旧图整套就位之后要删")
        self.assertEqual(list(self.rt.rglob("*.tmp")), [])

    def test_打不打光按时段有没有几何场判_不看场景写没写_lighting_块(self):
        """运行时对没写 lighting 块、但烘了几何场的时段照样打光;烘焙这边要是还按块判,
        就烘不出漏出处补图,进游戏"打光场景缺补图,草木不接"。场景数据此处恰好没有 lighting 块。"""
        (self.dirs["night.png"] / "geometry.json").unlink()
        (self.dirs["night.png"] / "lighting.json").write_text("{}", encoding="utf-8")  # 只有 probe、没几何场
        sway_field.bake_sway("x", lambda _m: None)
        self.assertEqual(self.lit_slots, ["background"])
        main_meta = json.loads((self.main / "sway.json").read_text(encoding="utf-8"))
        self.assertEqual(main_meta["litPlate"], sway_field.LIT_PLATE_FILES)
        self.assertEqual((self.main / "sway_plate_normal.png").read_bytes(), b"lit-sway_plate_normal.png")
        night_meta = json.loads((self.dirs["night.png"] / "sway.json").read_text(encoding="utf-8"))
        self.assertIsNone(night_meta["litPlate"])

    def test_烘的途中存了一次_指纹是烘之前那份_工作台照样报待导出(self):
        from PIL import Image

        def save_mid_bake():
            buf = io.BytesIO()
            Image.new("RGBA", (8, 4), (255, 0, 255, 0)).save(buf, format="PNG")
            (self.main / sway_field.PAINT_FILE).write_bytes(buf.getvalue())

        before = sway_field.input_fingerprint(self.main)
        self.during_build = save_mid_bake
        sway_field.bake_sway("x", lambda _m: None)
        meta = json.loads((self.main / "sway.json").read_text(encoding="utf-8"))
        self.assertEqual(meta["inputs"], before)
        paint_mtime = round((self.main / sway_field.PAINT_FILE).stat().st_mtime, 3)
        self.assertTrue(layers.needs_export(self.main, meta, paint_mtime))

    def test_预热一个字节都不写(self):
        sway_field.bake_sway("x", lambda _m: None, dry=True)
        for bg in self.BGS:
            self.assertEqual(self._snapshot(bg), self.old[bg])
        self.assertEqual(list(self.rt.rglob("*.tmp")), [])

    def test_导出与预览盖同一个口径的输入内容指纹(self):
        """第四轮复核 #12:工作台按它判推过的预览与资源 / 盘上是不是同一份(不再按写盘时刻猜)。"""
        disk = sway_field.disk_content_fingerprint(self.main, (8, 4))
        sway_field.bake_sway("x", lambda _m: None)
        meta = json.loads((self.main / "sway.json").read_text(encoding="utf-8"))
        self.assertEqual(meta["inputsContentSha1"], disk)

        out = self.rt / "pv"
        paint = sway_field.read_paint(self.main, (8, 4), lambda _m: None)
        none = {"anchors": [], "coherent": []}
        sway_field.bake_sway("x", lambda _m: None, inputs={"paint": paint, "overrides": none}, out_root=out)
        pmeta = json.loads((out / "background" / "sway.json").read_text(encoding="utf-8"))
        self.assertEqual(pmeta["inputsContentSha1"], disk, "页面上的就是盘上这份,两边指纹要一样")
        changed = {k: v.copy() for k, v in paint.items()}
        changed["veg"][0, 0] = 255
        sway_field.bake_sway("x", lambda _m: None, inputs={"paint": changed, "overrides": none}, out_root=out)
        pmeta = json.loads((out / "background" / "sway.json").read_text(encoding="utf-8"))
        self.assertNotEqual(pmeta["inputsContentSha1"], disk)

    def test_非涂层输入指纹_每个时段同一个值_预览与导出同口径_原画法线时段变了才变(self):
        """第六轮复核 #6:涂层没动、原画 / 照明烘焙 / 时段变了,烘出来的是另一份——工作台靠这个指纹认出来。"""
        from PIL import Image

        sway_field._FILE_SHA1.clear()
        fp0 = sway_field.bake_inputs_fingerprint("x")
        sway_field.bake_sway("x", lambda _m: None)
        metas = [json.loads((self.dirs[bg] / "sway.json").read_text(encoding="utf-8")) for bg in self.BGS]
        self.assertEqual([m["bakeInputsSha1"] for m in metas], [fp0, fp0], "同一次烘焙每个时段同一个值")
        self.assertEqual(sway_field.bake_inputs_fingerprint("x"), fp0, "烘焙自己的产物不许算进输入")

        out = self.rt / "pv"
        paint = sway_field.read_paint(self.main, (8, 4), lambda _m: None)
        sway_field.bake_sway("x", lambda _m: None, inputs={"paint": paint, "overrides": {"anchors": [], "coherent": []}},
                             out_root=out)
        self.assertEqual(json.loads((out / "background" / "sway.json").read_text(encoding="utf-8"))["bakeInputsSha1"], fp0,
                         "推给游戏的预览与导出同一个口径")

        buf = io.BytesIO()
        Image.new("RGBA", (8, 4), (255, 0, 0, 0)).save(buf, format="PNG")
        (self.main / sway_field.PAINT_FILE).write_bytes(buf.getvalue())
        self.assertEqual(sway_field.bake_inputs_fingerprint("x"), fp0, "只改涂层不动它(涂层归 inputsContentSha1 管)")

        (self.dirs["night.png"] / "normal.png").write_bytes(b"normal-rebaked")
        fp1 = sway_field.bake_inputs_fingerprint("x")
        self.assertNotEqual(fp1, fp0, "夜景时段的法线重烘了")
        (self.rt / "background.png").write_bytes(b"bg-repainted-in-place")
        fp2 = sway_field.bake_inputs_fingerprint("x")
        self.assertNotEqual(fp2, fp1, "主背景就地重画(文件名不变)")
        (self.dirs["night.png"] / "geometry.json").unlink()
        self.assertNotEqual(sway_field.bake_inputs_fingerprint("x"), fp2, "少了一个要写的时段")


class WarmQueueTests(unittest.TestCase):
    """预热:忙的时候记下最近想热的场景,手上那一轮跑完接着热它;日志别许诺别的场景的预热帮得上(复核 #12)。"""

    def setUp(self):
        import tempfile
        import threading
        self._state = (dict(layers._WARM), dict(layers._JOB), sway_field.bake_sway, layers.push_to_game)
        # 导出成功会删这个场景的本机预览:指到空的临时目录,绝不碰作者真的 local/sway_preview/
        self._tmp = tempfile.TemporaryDirectory()
        self._preview_root = layers.PREVIEW_ROOT
        layers.PREVIEW_ROOT = Path(self._tmp.name) / "sway_preview"
        self.addCleanup(self._tmp.cleanup)
        self.addCleanup(setattr, layers, "PREVIEW_ROOT", self._preview_root)
        layers._WARM.clear()
        layers._WARM.update({"running": False, "scene": "", "done": "", "err": "", "want": ""})
        self.calls: list = []
        self.gates: dict = {}
        self.threading = threading

        def fake(sid, status=print, **kw):
            self.calls.append((sid, "warm" if kw.get("dry") else "job"))
            g = self.gates.get(sid)
            if g is not None:
                g.wait(5)
            return [{"key": "background", "instances": 1, "dir": "x"}]

        sway_field.bake_sway = fake
        layers.push_to_game = lambda sid, source="export": {"pushed": False, "why": "测试"}

    def tearDown(self):
        for g in self.gates.values():
            g.set()
        self._idle()
        warm, job, sway_field.bake_sway, layers.push_to_game = self._state
        layers._WARM.clear()
        layers._WARM.update(warm)
        layers._JOB.clear()
        layers._JOB.update(job)

    def _idle(self):
        import time
        for _ in range(250):
            if not layers._WARM["running"] and not layers._JOB["running"]:
                time.sleep(0.05)                               # 刚跑完的那一轮可能正在接着开下一轮
                if not layers._WARM["running"] and not layers._JOB["running"]:
                    return
            time.sleep(0.02)
        self.fail("后台活没停")

    def test_预热期间切了两次场景_跑完接着热最后那个(self):
        self.gates["A"] = self.threading.Event()
        self.assertTrue(layers.warm_start("A")["started"])
        self.assertFalse(layers.warm_start("B")["started"])
        self.assertFalse(layers.warm_start("C")["started"])
        self.gates["A"].set()
        self._idle()
        self.assertEqual(self.calls, [("A", "warm"), ("C", "warm")], "中间路过的 B 不热,最后停下的 C 要热")
        self.assertEqual(layers._WARM["done"], "C")
        self.assertFalse(layers.warm_start("C")["started"], "热过的不再热")

    def test_推送导出跑完_接着热期间切去的场景_推过的场景不白热(self):
        self.gates["E"] = self.threading.Event()
        self.assertTrue(layers.export_start("E")["ok"])
        self.assertFalse(layers.warm_start("D")["started"], "有活在跑不叠预热")
        self.gates["E"].set()
        self._idle()
        self.assertEqual(self.calls, [("E", "job"), ("D", "warm")])

        self.calls.clear()
        self.gates["P"] = self.threading.Event()
        layers.push_start("P")
        layers.warm_start("P")
        self.gates["P"].set()
        self._idle()
        self.assertEqual(self.calls, [("P", "job")], "推送就是按预热的口径算的,推完别再热一遍")

    def test_等别的场景的预热_日志不许说缓存用得上(self):
        layers._WARM.update({"running": True, "scene": "A"})
        layers.export_start("C")
        st = _wait_job(self)
        text = "\n".join(st["log"])
        self.assertIn("那是别的场景", text)
        self.assertNotIn("这一次就用得上", text)

        layers._WARM.update({"running": True, "scene": "C"})
        layers.export_start("C")
        st = _wait_job(self)
        self.assertIn("这一次就用得上", "\n".join(st["log"]))
        layers._WARM["running"] = False


class BootReopenTests(unittest.TestCase):
    """F5 / Ctrl+R(含「保存并刷新」)之后回到正在干活的场景,不是清单里第一个烘过的(复核 #43)。"""

    def setUp(self):
        import threading
        from http.server import ThreadingHTTPServer
        from unittest import mock

        self._boot, self._last = list(serve.BOOT_OPEN), list(serve.LAST_OPEN)
        serve.BOOT_OPEN.clear()
        serve.LAST_OPEN.clear()

        def fake_layers(sid):
            if sid == "装不上":
                raise FileNotFoundError("没有背景图")
            return {"id": sid, "native": [8, 4]}

        self.patches = [mock.patch.object(serve.layers, "layers", fake_layers),
                        mock.patch.object(serve.game_link, "discover_game_url", lambda root: "")]
        for p in self.patches:
            p.start()
        self.srv = ThreadingHTTPServer(("127.0.0.1", 0), serve.H)
        threading.Thread(target=self.srv.serve_forever, daemon=True).start()
        self.base = f"http://127.0.0.1:{self.srv.server_address[1]}"

    def tearDown(self):
        self.srv.shutdown()
        self.srv.server_close()
        for p in self.patches:
            p.stop()
        serve.BOOT_OPEN[:] = self._boot
        serve.LAST_OPEN[:] = self._last

    def _get(self, path: str) -> dict:
        import urllib.error
        import urllib.parse
        import urllib.request
        try:
            with urllib.request.urlopen(self.base + urllib.parse.quote(path, safe="/?=&"), timeout=5) as r:  # noqa: S310
                return json.loads(r.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            return json.loads(e.read().decode("utf-8"))

    def test_刷新后回到最近装上的场景(self):
        self.assertEqual(self._get("/api/boot")["open"], "", "什么都没装过")
        serve.BOOT_OPEN.append("雾津街头")                         # --open 带进来的
        self.assertEqual(self._get("/api/boot")["open"], "雾津街头")
        self.assertTrue(self._get("/api/layers?scene=雾津街头")["ok"])
        self.assertEqual(self._get("/api/boot")["open"], "雾津街头", "刷新一次 --open 的场景就丢了")
        self.assertTrue(self._get("/api/layers?scene=跑马梁")["ok"])   # 下拉框切过去
        self.assertEqual(self._get("/api/boot")["open"], "跑马梁")
        self.assertEqual(self._get("/api/boot")["open"], "跑马梁", "刷新多少次都回这个")
        self.assertFalse(self._get("/api/layers?scene=装不上")["ok"])
        self.assertEqual(self._get("/api/boot")["open"], "跑马梁", "装不上的场景不记")


class OverridesHistoryTests(_FakeSceneMixin, unittest.TestCase):
    """逐株设置的备份:内容没变不重写不备份、备份名是被替换那份的存盘时刻、空的不凭空建文件(第三轮复核之后 #15 / #18 / #2)。"""

    def _ov(self) -> Path:
        return self.dir / sway_field.OVERRIDES_FILE

    def _backups(self) -> list[Path]:
        return sorted(layers.history_dir(layers.Scene("x")).glob("overrides-*.json"))

    def test_只改涂层的保存_不重写逐株设置_不留备份(self):
        full = _gray_data_url(64, 32, 255)
        ov = {"anchors": [[3, 4], [10, 10]], "coherent": [[20, 20]]}
        first = layers.save_paint("x", {"rigid": full}, overrides=ov)
        self.assertTrue(first["overrides"]["changed"])
        raw, st = self._ov().read_bytes(), self._ov().stat().st_mtime_ns
        for i in range(5):                                          # 只改涂层、页面照样带着同一份 overrides
            out = layers.save_paint("x", {"rigid": _gray_data_url(64, 32, 20 + i * 40)}, force=True,
                                    overrides=json.loads(json.dumps(ov)))
            self.assertTrue(out["ok"], out)
            self.assertFalse(out["overrides"]["changed"])
        self.assertEqual(self._backups(), [], "内容没变却留了备份:二十次就把误删锚点之前那版挤掉了")
        self.assertEqual((self._ov().read_bytes(), self._ov().stat().st_mtime_ns), (raw, st), "内容没变却重写了")

    def test_误删锚点之后又存了二十几次涂层_删之前那版还在备份里(self):
        before = {"anchors": [[1, 1], [2, 2], [3, 3]], "coherent": []}
        layers.save_paint("x", {"rigid": _gray_data_url(64, 32, 255)}, overrides=before)
        want = self._ov().read_bytes()
        broken = {"anchors": [[1, 1]], "coherent": []}                  # 右键误删了两个
        for i in range(layers.HISTORY_KEEP + 5):
            layers.save_paint("x", {"rigid": _gray_data_url(64, 32, (i * 37) % 250 + 3)}, force=True, overrides=broken)
        got = [p.read_bytes() for p in self._backups()]
        self.assertEqual(got, [want], "误删之前那一版应该恰好留一份,不被重复的备份挤掉")

    def test_备份名是被替换那份内容的存盘时刻_同一份不重复留(self):
        import os
        import time

        layers.save_overrides(layers.Scene("x"), {"anchors": [[5, 5]], "coherent": []})
        t = time.mktime((2026, 1, 2, 3, 4, 5, 0, 0, -1)) + 0.678
        os.utime(self._ov(), (t, t))
        content = self._ov().read_bytes()
        layers.save_overrides(layers.Scene("x"), {"anchors": [[6, 6]], "coherent": []})
        names = [p.name for p in self._backups()]
        self.assertEqual(names, ["overrides-20260102-030405-678.json"], "名字该是那份内容自己的存盘时刻,不是现在")
        self.assertEqual(self._backups()[0].read_bytes(), content)
        # 盘上那份被还原成同一时刻的同一份(比如外部工具回滚)再被替换:不重复进历史
        self._ov().write_bytes(content)
        os.utime(self._ov(), (t, t))
        layers.save_overrides(layers.Scene("x"), {"anchors": [[7, 7]], "coherent": []})
        self.assertEqual([p.name for p in self._backups()], names)

    def test_备份只留最近二十份(self):
        import os

        for i in range(layers.HISTORY_KEEP + 4):
            layers.save_overrides(layers.Scene("x"), {"anchors": [[i, 1]], "coherent": []})
            t = 1_700_000_000 + i                                   # 每份内容一个不同的存盘时刻
            os.utime(self._ov(), (t, t))
        self.assertEqual(len(self._backups()), layers.HISTORY_KEEP)

    def test_没有文件又是空的_不凭空建一个空文件(self):
        out = layers.save_overrides(layers.Scene("x"), {"anchors": [], "coherent": []})
        self.assertFalse(out["changed"])
        self.assertFalse(self._ov().exists(), "凭空多一个空文件:输入指纹从 '' 变成空文件的 sha1,「待导出」白亮一次")


class PaintNeedsExportTests(_FakeSceneMixin, unittest.TestCase):
    """/api/paint 回 needsExport(写完之后按输入指纹算):页面不再存完一律亮「● 待导出」(#2)。"""

    def _meta(self) -> None:
        (self.dir / "sway.json").write_text(json.dumps({"version": sway_field.SWAY_VERSION, "instances": [],
                                                        "inputs": sway_field.input_fingerprint(self.dir)}),
                                            encoding="utf-8")

    def test_存下的与导出时一样_不待导出_真改了才待导出(self):
        full = _gray_data_url(64, 32, 255)
        out = layers.save_paint("x", {"rigid": full}, overrides={"anchors": [], "coherent": []})
        self.assertIs(out["needsExport"], True, "存过、从没导出过")
        self.assertFalse((self.dir / sway_field.OVERRIDES_FILE).exists())
        self._meta()                                                 # 导出了
        disk = layers.paint_state("x")["mtime"]
        out = layers.save_paint("x", {"rigid": full}, base_mtime=disk, overrides={"anchors": [], "coherent": []})
        self.assertTrue(out["paintUnchanged"])
        self.assertIs(out["needsExport"], False, "撤销回原样再存:盘上字节没变,不许亮「待导出」")
        self.assertIs(out["needsExport"], layers.layers("x")["needsExport"], "与装场景时的判据一致")
        out = layers.save_paint("x", {"rigid": full}, base_mtime=disk, overrides={"anchors": [[1, 1]], "coherent": []})
        self.assertIs(out["needsExport"], True, "只改了锚点也是没进资源")


class WindCheckTests(unittest.TestCase):
    """layers() 的 hasWind 与运行时 resolveSceneWind 同一个判据(#13):没配风的场景推了 / 导出了草木也不会动。"""

    def test_判据逐条照抄运行时(self):
        ok = layers.wind_def_usable
        self.assertTrue(ok({"direction": [-1, 0, -0.25], "speed": 400}))
        self.assertTrue(ok({"direction": [0, 5, 1e-3], "speed": 1}))
        self.assertFalse(ok(None))
        self.assertFalse(ok({}))
        self.assertFalse(ok({"direction": "x", "speed": 400}), "direction 不是数组")
        self.assertFalse(ok({"direction": [1, 0, 0]}), "没写 speed")
        self.assertFalse(ok({"direction": [1, 0, 0], "speed": 0}))
        self.assertFalse(ok({"direction": [1, 0, 0], "speed": True}), "布尔在 JS 里不是数")
        self.assertFalse(ok({"direction": [0, 1, 0], "speed": 400}), "只有竖直分量")
        self.assertFalse(ok({"direction": ["1", 0, 0], "speed": 400}), "字符串按 0")
        self.assertTrue(ok({"direction": [1], "speed": 400}), "缺的 z 按 0,x 够长就算")

    def test_真工程_跑马梁有风_义庄没风_假场景说不清(self):
        self.assertIs(layers.scene_has_wind("跑马梁"), True)
        self.assertIs(layers.scene_has_wind("义庄"), False)
        self.assertIsNone(layers.scene_has_wind("__没有这个场景__"))


class LinkOpenWithoutConsoleTests(unittest.TestCase):
    """控制台没开时 /api/link/open:有 dev server 就经它的 POST 排(盖 enqueuedAt、会过期),没有就不排、回 via:'none'(#16)。"""

    def setUp(self):
        import threading
        from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
        from unittest import mock

        test = self
        self.queue: list = [{"id": "别人的", "type": "debugSwitchScene", "sceneId": "别的场景", "enqueuedAt": 1}]
        self.posts: list = []

        class Dev(BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def _send(self, obj):
                raw = json.dumps(obj).encode("utf-8")
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(raw)))
                self.end_headers()
                self.wfile.write(raw)

            def do_GET(self):                                        # noqa: N802
                self._send({"ok": True, "commands": test.queue})

            def do_POST(self):                                       # noqa: N802
                body = json.loads(self.rfile.read(int(self.headers.get("Content-Length") or 0)).decode("utf-8"))
                test.posts.append(body)
                test.queue = body["commands"]
                self._send({"ok": True, "count": len(body["commands"])})

        self.dev = ThreadingHTTPServer(("127.0.0.1", 0), Dev)
        threading.Thread(target=self.dev.serve_forever, daemon=True).start()
        self.dev_base = f"http://127.0.0.1:{self.dev.server_address[1]}"
        self.file_writes: list = []
        self.game = self.dev_base
        self.patches = [
            mock.patch.object(serve.game_link, "console_open_dev_entry", lambda sid: (False, "控制台没开:目标计算机积极拒绝")),
            mock.patch.object(serve.game_link, "enqueue_switch_scene",
                              lambda *a, **k: self.file_writes.append(a) or {"ok": True}),
            mock.patch.object(serve.layers, "find_game", lambda: self.game),
        ]
        for p in self.patches:
            p.start()
        self.srv = ThreadingHTTPServer(("127.0.0.1", 0), serve.H)
        threading.Thread(target=self.srv.serve_forever, daemon=True).start()
        self.base = f"http://127.0.0.1:{self.srv.server_address[1]}"

    def tearDown(self):
        for s in (self.srv, self.dev):
            s.shutdown()
            s.server_close()
        for p in self.patches:
            p.stop()

    def _open(self, sid: str) -> dict:
        import urllib.request
        req = urllib.request.Request(self.base + "/api/link/open", data=json.dumps({"scene": sid}).encode("utf-8"),
                                     headers={"Content-Type": "application/json"}, method="POST")
        with urllib.request.urlopen(req, timeout=10) as r:                                  # noqa: S310
            return json.loads(r.read().decode("utf-8"))

    def test_有_dev_server_经它的_POST_排_不直接写队列文件_别人的命令留着(self):
        got = self._open("跑马梁")
        self.assertEqual(got["via"], "queue", got)
        self.assertIn("积极拒绝", got["console"], "控制台为什么没开要带回页面")
        self.assertEqual(self.file_writes, [], "直接写队列文件的命令没有 enqueuedAt、永不过期")
        self.assertEqual(len(self.posts), 1)
        cmds = self.posts[0]["commands"]
        self.assertEqual(cmds[0]["id"], "别人的", "POST 是整队替换:别人排着的命令不许冲掉")
        self.assertEqual((cmds[-1]["type"], cmds[-1]["sceneId"]), ("debugSwitchScene", "跑马梁"))
        self.assertNotIn("enqueuedAt", cmds[-1], "时间戳由 dev server 盖(服务器时间),这里不伪造")

    def test_dev_server_也没有_不排任何命令_回_none_带控制台原因(self):
        self.game = ""
        got = self._open("跑马梁")
        self.assertEqual(got["via"], "none", got)
        self.assertIn("积极拒绝", got["console"])
        self.assertEqual((self.file_writes, self.posts), ([], []), "没人会来取的命令一条都不许排")

    def test_dev_server_不收_照样回_none(self):
        self.game = "http://127.0.0.1:9"                              # 探到过、这会儿已经关了
        got = self._open("跑马梁")
        self.assertEqual(got["via"], "none", got)
        self.assertIn("排不进", got["detail"])
        self.assertEqual(self.file_writes, [])


class HistoryDedupTests(_FakeSceneMixin, unittest.TestCase):
    """历史里同样字节的不再留第二份(第四轮复核 #7):恢复把历史字节写回涂层、mtime 变成现在,原来下一次恢复 / 保存
    按新时刻再留一份同样的,裁剪接着删掉一版独一无二的最旧历史——逐个点「恢复」找旧版,每点一下少一版真历史。"""

    @staticmethod
    def _sha(p: Path) -> str:
        import hashlib
        return hashlib.sha1(p.read_bytes()).hexdigest()

    def _hist(self) -> list[Path]:
        return sorted(layers.history_dir(layers.Scene("x")).glob("*.png"))

    def test_满历史里连着试恢复两份再存_不留副本_只挤掉一版(self):
        for i in range(layers.HISTORY_KEEP + 1):                      # 20 份不同的历史 + 当前一份
            out = layers.save_paint("x", {"rigid": _gray_data_url(64, 32, 10 + i * 11)}, force=True)
            self.assertTrue(out["ok"], out)
        hist = self._hist()
        self.assertEqual(len(hist), layers.HISTORY_KEEP)
        paint = self.dir / sway_field.PAINT_FILE
        before = {self._sha(p) for p in hist} | {self._sha(paint)}
        self.assertEqual(len(before), layers.HISTORY_KEEP + 1, "前提:21 份各不相同")
        oldest = self._sha(hist[0])

        for pick in (9, 11):                                        # 作者逐个点恢复找旧版(h10、h12)
            name = self._hist()[pick].stem
            r = layers.restore("x", name)
            self.assertTrue(r.get("ok"), r)
        out = layers.save_paint("x", {"rigid": _gray_data_url(64, 32, 3)}, force=True)   # 然后接着改、存
        self.assertTrue(out["ok"], out)

        hist = self._hist()
        shas = [self._sha(p) for p in hist]
        self.assertEqual(len(shas), len(set(shas)), "历史里出现了同样字节的副本")
        after = set(shas) | {self._sha(paint)}
        self.assertEqual(before - after, {oldest}, "只该挤掉第一次恢复新留那份顶出去的最旧一版")

    def test_撤销回原样再存_不留副本(self):
        a, b = _gray_data_url(64, 32, 255), _gray_data_url(64, 32, 0)
        layers.save_paint("x", {"rigid": a})
        layers.save_paint("x", {"rigid": b}, force=True)             # 历史:a
        layers.save_paint("x", {"rigid": a}, force=True)             # 历史:a, b
        layers.save_paint("x", {"rigid": b}, force=True)             # 当前 a 已在历史里:不再留
        shas = [self._sha(p) for p in self._hist()]
        self.assertEqual(len(shas), 2)
        self.assertEqual(len(set(shas)), 2)

    def test_逐株设置备份_同样字节不论名字都不再留(self):
        sc = layers.Scene("x")
        A = {"anchors": [[1, 1]], "coherent": []}
        B = {"anchors": [[2, 2]], "coherent": []}
        for ov in (A, B, A, B, A):
            layers.save_overrides(sc, ov)
        backups = sorted(layers.history_dir(sc).glob("overrides-*.json"))
        shas = [self._sha(p) for p in backups]
        self.assertEqual(len(shas), 2, [p.name for p in backups])
        self.assertEqual(len(set(shas)), 2)


class PreviewContentTests(unittest.TestCase):
    """推给游戏的预览按**内容**判(第四轮复核 #12):预览烘的是哪份输入盖在 sway.json 的 inputsContentSha1 里,
    与资源 / 盘上那份同一个口径比——不再是"预览时刻更新就算游戏里是预览"。"""

    def setUp(self):
        import tempfile
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        self.res = root / "res" / "lighting" / "background"
        self.res.mkdir(parents=True)
        self.preview = root / "preview"
        test = self

        class FakeScene:
            sid = "x"
            native = (64, 32)
            bake_dir = test.res
            bg_name = "background.png"
            rt_dir = test.res.parent.parent

        self._orig = (layers.Scene, layers.PREVIEW_ROOT, layers.push_to_game, dict(layers._JOB))
        layers.Scene = lambda sid: FakeScene()
        layers.PREVIEW_ROOT = self.preview
        layers._DISK_FP.clear()
        self.pushes: list = []
        layers.push_to_game = lambda sid, source="export": self.pushes.append((sid, source)) or {"pushed": False}

    def tearDown(self):
        layers.Scene, layers.PREVIEW_ROOT, layers.push_to_game, job = self._orig
        layers._JOB.clear()
        layers._JOB.update(job)
        layers._DISK_FP.clear()
        self.tmp.cleanup()

    def _page_sha(self, rigid: int, anchors=()) -> str:
        """页面上此刻那份(推给游戏用的输入)的内容指纹——与烘焙盖进预览的是同一个算法。"""
        inp = layers.decode_inputs("x", {"rigid": _gray_data_url(64, 32, rigid)}, {"anchors": list(anchors), "coherent": []})
        return sway_field.content_fingerprint(inp["paint"], inp["overrides"], None, (64, 32))

    def _write(self, d: Path, **meta) -> Path:
        d.mkdir(parents=True, exist_ok=True)
        p = d / "sway.json"
        p.write_text(json.dumps({"version": sway_field.SWAY_VERSION, "instances": [], **meta}), encoding="utf-8")
        return p

    def _later(self, p: Path, dt: float = 5) -> None:
        import os
        import time
        t = time.time() + dt
        os.utime(p, (t, t))

    def _export_disk(self) -> None:
        """模拟一次导出:资源 sway.json 盖上盘上这份的两个指纹。"""
        self._write(self.res, inputs=sway_field.input_fingerprint(self.res),
                    inputsContentSha1=sway_field.disk_content_fingerprint(self.res, (64, 32)))

    def test_同一份输入_页面解码与盘上读回的内容指纹相同(self):
        layers.save_paint("x", {"rigid": _gray_data_url(64, 32, 255)}, overrides={"anchors": [[3, 4]], "coherent": []})
        self.assertEqual(sway_field.disk_content_fingerprint(self.res, (64, 32)), self._page_sha(255, [[3, 4]]))
        self.assertNotEqual(self._page_sha(255, [[3, 4]]), self._page_sha(255, [[3, 5]]))
        self.assertNotEqual(self._page_sha(255), self._page_sha(254))

    def test_推了一版试验又丢掉_预览时刻更新也不算资源还没导出_叠加层读资源(self):
        layers.save_paint("x", {"rigid": _gray_data_url(64, 32, 255)})
        self._export_disk()
        pv = self._write(self.preview / "x" / "background", preview=True, inputsContentSha1=self._page_sha(0))
        self._later(pv)
        L = layers.layers("x")
        self.assertIs(L["previewDiffersFromExport"], True, "预览烘的是另一份:游戏里 / 叠加层是预览")
        self.assertIs(L["previewMatchesDisk"], False)
        self.assertEqual(L["source"], "preview")

        # 撤销回导出的样子再推一次:内容与资源一模一样,时刻照样最新
        self._write(self.preview / "x" / "background", preview=True, inputsContentSha1=self._page_sha(255))
        self._later(self.preview / "x" / "background" / "sway.json")
        L = layers.layers("x")
        self.assertIs(L["previewDiffersFromExport"], False, "内容与资源相同却说「资源还没导出」")
        self.assertIs(L["previewMatchesDisk"], True)
        self.assertEqual(L["source"], "export")
        self.assertEqual(layers.derived_dir(layers.Scene("x"))[1], "export")

    def test_老导出没盖内容指纹_文件指纹对得上就按盘上这份比(self):
        layers.save_paint("x", {"rigid": _gray_data_url(64, 32, 255)})
        self._write(self.res, inputs=sway_field.input_fingerprint(self.res))
        pv = self._write(self.preview / "x" / "background", preview=True, inputsContentSha1=self._page_sha(255))
        self._later(pv)                                  # 推在导出之后(资源不比预览旧的话预览一律算已被导出取代)
        self.assertIs(layers.layers("x")["previewDiffersFromExport"], False)
        # 之后又存了别的、没导出:资源说不清是拿什么烘的 ⇒ 按不同算(宁可多说一句)
        layers.save_paint("x", {"rigid": _gray_data_url(64, 32, 0)}, force=True)
        self.assertIs(layers.layers("x")["previewDiffersFromExport"], True)

    def test_推了A又涂几笔_导出B_本机预览删掉_叠加层回资源_不说资源没导出(self):
        """第六轮复核 #3/#4:推 A → 再涂几笔 → B(先存再导出)。游戏收到导出那行就忘了预览;
        本机预览不删的话,工作台一直说"游戏里是预览、资源还没导出",叠加层 / Alt+点读被取代的 A。"""
        layers.save_paint("x", {"rigid": _gray_data_url(64, 32, 255)})                      # 盘上 = B
        pvd = self.preview / "x" / "background"
        pv = self._write(pvd, preview=True, inputsContentSha1=self._page_sha(0))           # 推过 A
        (pvd / "sway_ids.png").write_bytes(b"ids-A")
        self.assertIs(layers.layers("x")["previewDiffersFromExport"], True, "前提:导出之前游戏里确实是预览 A")

        def bake(status):
            import time
            time.sleep(0.02)
            self._export_disk()                                                             # 资源盖上 B 的指纹
            status("烘好了")
            return [{"key": "background", "instances": 0, "dir": str(self.res)}]

        layers._start_job("export", "x", bake, "export")
        st = _wait_job(self)
        self.assertTrue(st["succeeded"], st)
        self.assertFalse((self.preview / "x").exists(), "导出取代了预览:本机预览要删掉")
        self.assertTrue(any("被这次导出取代" in l for l in st["log"]), st["log"])
        self.assertEqual(self.pushes, [("x", "export")], "不单独撤预览:导出那一行就让游戏换回资源")
        L = layers.layers("x")
        self.assertEqual(L["source"], "export")
        self.assertIs(L["previewDiffersFromExport"], False)
        self.assertEqual(L["previewMtime"], 0.0)
        self.assertIs(L["needsExport"], False)
        self.assertEqual(layers.derived_dir(layers.Scene("x"))[1], "export")

    def test_导出之后删预览失败_不算导出失败_预览比资源旧也不算不同(self):
        """删不掉(Windows 上 dev server 正读着那几张图)只记一行;`preview_state` 按"资源不比预览旧"兜着。"""
        from unittest import mock

        layers.save_paint("x", {"rigid": _gray_data_url(64, 32, 255)})
        pvd = self.preview / "x" / "background"
        pv = self._write(pvd, preview=True, inputsContentSha1=self._page_sha(0))
        self._later(pv, -60)                                                                # 预览是一分钟前推的

        def boom(*a, **kw):
            raise PermissionError("文件被占用")

        with mock.patch("shutil.rmtree", boom):
            layers._start_job("export", "x", lambda status: self._export_disk() or [{"key": "background"}], "export")
            st = _wait_job(self)
        self.assertTrue(st["succeeded"], st)
        self.assertTrue(any("没删掉" in l for l in st["log"]), st["log"])
        self.assertTrue(pvd.is_dir(), "前提:预览还在")
        L = layers.layers("x")
        self.assertIs(L["previewDiffersFromExport"], False, "资源比预览新:预览已被导出取代")
        self.assertEqual(L["source"], "export")
        self.assertIs(L["previewMatchesDisk"], False, "撤预览的判据照旧只看涂层")

        # 之后又推了一版(比资源新):照常按内容比
        self._write(pvd, preview=True, inputsContentSha1=self._page_sha(0))
        self._later(pvd / "sway.json")
        self.assertIs(layers.layers("x")["previewDiffersFromExport"], True)

    def test_涂层一样_原画或照明烘焙变了_预览照样算另一份(self):
        """第六轮复核 #6:原画就地重画 / scene_fields 重烘 / 加了时段,涂层一笔没动 —— 推的预览是另一份拆层。"""
        layers.save_paint("x", {"rigid": _gray_data_url(64, 32, 255)})
        self._write(self.res, inputs=sway_field.input_fingerprint(self.res),
                    inputsContentSha1=sway_field.disk_content_fingerprint(self.res, (64, 32)), bakeInputsSha1="old-art")
        pvd = self.preview / "x" / "background"

        def push(**meta):
            p = self._write(pvd, preview=True, inputsContentSha1=self._page_sha(255), **meta)
            self._later(p)

        push(bakeInputsSha1="old-art")
        L = layers.layers("x")
        self.assertIs(L["previewDiffersFromExport"], False, "涂层与非涂层输入都一样:就是资源那份")
        self.assertEqual(L["source"], "export")

        push(bakeInputsSha1="new-art")
        L = layers.layers("x")
        self.assertIs(L["previewDiffersFromExport"], True, "原画变了:游戏里 / 叠加层是新拆的预览")
        self.assertEqual(L["source"], "preview")
        self.assertEqual(layers.derived_dir(layers.Scene("x"))[1], "preview")
        self.assertIs(L["previewMatchesDisk"], True, "涂层还是盘上这份:丢弃改动时不许撤它")

        # 资源是今天之前导出的(没盖非涂层指纹)而预览盖了:说不清 ⇒ 按不同算
        self._write(self.res, inputs=sway_field.input_fingerprint(self.res),
                    inputsContentSha1=sway_field.disk_content_fingerprint(self.res, (64, 32)))
        push(bakeInputsSha1="old-art")
        self.assertIs(layers.layers("x")["previewDiffersFromExport"], True)

    def test_原画或照明烘焙在导出之后变过_待导出亮_老导出没盖指纹不亮(self):
        from unittest import mock

        layers.save_paint("x", {"rigid": _gray_data_url(64, 32, 255)})
        base = dict(inputs=sway_field.input_fingerprint(self.res),
                    inputsContentSha1=sway_field.disk_content_fingerprint(self.res, (64, 32)))
        now = {"fp": "art-1"}

        def fp(sid):
            if now["fp"] is None:
                raise FileNotFoundError("场景 JSON 读不到")
            return now["fp"]

        with mock.patch.object(sway_field, "bake_inputs_fingerprint", fp):
            self._write(self.res, bakeInputsSha1="art-1", **base)
            L = layers.layers("x")
            self.assertIs(L["needsExport"], False)
            self.assertIs(L["bakeInputsChanged"], False)
            now["fp"] = "art-2"                                          # 原画重画了,涂层没动
            L = layers.layers("x")
            self.assertIs(L["needsExport"], True, "资源里的底板 / matte 是按旧原画烘的,要提醒导出")
            self.assertIs(L["bakeInputsChanged"], True)
            disk = layers.paint_state("x")["mtime"]
            out = layers.save_paint("x", {"rigid": _gray_data_url(64, 32, 255)}, base_mtime=disk)
            self.assertIs(out["needsExport"], True, "存完的判据与装场景一致")
            now["fp"] = None                                             # 算不出来:不报
            self.assertIs(layers.layers("x")["needsExport"], False)
            now["fp"] = "art-2"
            self._write(self.res, **base)                                # 老导出没盖:说不清,不为老场景一律亮
            self.assertIs(layers.layers("x")["needsExport"], False)

    def test_撤预览_与盘上不同才删本机预览_通知游戏换回资源_资源不动(self):
        layers.save_paint("x", {"rigid": _gray_data_url(64, 32, 255)})
        self._export_disk()
        res_before = {p.name: p.read_bytes() for p in self.res.iterdir() if p.is_file()}
        self.assertEqual(layers.revoke_preview("x"), {"ok": True, "revoked": False, "why": "没有推过的预览"})

        pvd = self.preview / "x" / "background"
        self._write(pvd, preview=True, inputsContentSha1=self._page_sha(255))      # 推之前存过:就是盘上这份
        (pvd / "sway_ids.png").write_bytes(b"ids")
        out = layers.revoke_preview("x")
        self.assertFalse(out["revoked"], out)
        self.assertTrue(pvd.is_dir(), "预览就是盘上这份,不该撤")

        self._write(pvd, preview=True, inputsContentSha1=self._page_sha(0))        # 没保存的试验
        layers._JOB.update({"running": True, "kind": "push", "scene": "x"})
        self.assertFalse(layers.revoke_preview("x")["revoked"], "正在推这个场景:别删它正要写的目录")
        layers._JOB.update({"running": False})
        out = layers.revoke_preview("x")
        self.assertTrue(out["revoked"], out)
        for t in layers._REVOKE_NOTIFY:
            t.join(5)
        self.assertFalse((self.preview / "x").exists(), "本机预览目录没删")
        self.assertEqual(self.pushes, [("x", "export")], "要让游戏换回资源那份")
        self.assertEqual({p.name: p.read_bytes() for p in self.res.iterdir() if p.is_file()}, res_before, "资源一个字节都不许动")

    def test_撤预览_场景名拼路径一律拒(self):
        for bad in ("", "..", "a/b", "a\\b", "../x"):
            with self.assertRaises(ValueError, msg=bad):
                layers.revoke_preview(bad)

    def test_撤预览_游戏没开_死端口也不抛(self):
        from unittest import mock

        layers.push_to_game = self._orig[2]
        layers.save_paint("x", {"rigid": _gray_data_url(64, 32, 255)})
        self._write(self.preview / "x" / "background", preview=True, inputsContentSha1=self._page_sha(0))
        with mock.patch.object(layers, "find_game", lambda: "http://127.0.0.1:9"):
            out = layers.revoke_preview("x")
            for t in layers._REVOKE_NOTIFY:
                t.join(10)
        self.assertTrue(out["revoked"], out)
        self.assertFalse((self.preview / "x").exists())

    def test_服务路由认_revoke(self):
        src = (ROOT / "tools/sway_workbench/serve.py").read_text(encoding="utf-8")
        self.assertIn('"/api/push/revoke"', src)
        js = (ROOT / "tools/sway_workbench/viewer/app.js").read_text(encoding="utf-8")
        self.assertIn("'/api/push/revoke'", js)


class GameBusyTests(unittest.TestCase):
    """游戏页在装场景(心跳 loading)也算开着,但要分得出来(第四轮复核 #13):前端据 pageBusy 不去拉第二个游戏。"""

    def test_page_busy_判据(self):
        self.assertTrue(layers.page_busy({"ageMs": 10, "loading": True, "sceneId": ""}))
        self.assertFalse(layers.page_busy({"ageMs": 10, "loading": False, "sceneId": "x"}))
        self.assertFalse(layers.page_busy({"ageMs": 10, "sceneId": "x"}), "老插件没有 loading:照旧")
        self.assertFalse(layers.page_busy({"ageMs": layers.GAME_PAGE_FRESH_MS + 1, "loading": True}), "心跳不新鲜不算")
        self.assertFalse(layers.page_busy(None))

    def test_推送回_pageBusy_说法也分得清(self):
        from unittest import mock

        class Resp(io.BytesIO):
            status = 200

            def __enter__(self):
                return self

            def __exit__(self, *a):
                return False

        body = json.dumps({"rev": 5, "game": {"sceneId": "", "bootId": "b", "ageMs": 12, "loading": True}}).encode()
        with mock.patch.object(layers, "find_game", lambda: "http://127.0.0.1:9"), \
                mock.patch("urllib.request.urlopen", lambda *a, **kw: Resp(body)):
            out = layers.push_to_game("跑马梁", "preview")
        self.assertTrue(out["pushed"], out)
        self.assertTrue(out["pageAlive"])
        self.assertTrue(out["pageBusy"])
        self.assertFalse(out["inScene"])
        self.assertIn("正在装场景", layers.push_note(out, "跑马梁"))


if __name__ == "__main__":
    unittest.main()
