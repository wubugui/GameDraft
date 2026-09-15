# -*- coding: utf-8 -*-
"""地形工作台：数据面与路由的护栏。

跑：``sh scripts/py.sh -m pytest tools/terrain_workbench/tests -q``

**不碰真工程的作者层**：写盘类一律在 tmp 目录里假造一个场景树（合成器的场景根 / 预览根 / 草稿根都指过去）。
两条跨语言契约（Python ↔ TS 的槽路径 / 预览目录 / 文件名单；JS 合成器 ↔ Python 合成器逐格相同）在这里钉死。
"""
from __future__ import annotations

import json
import re
import shutil
import subprocess
import sys
import threading
import unittest
import urllib.request
from http.server import ThreadingHTTPServer
from pathlib import Path
from tempfile import TemporaryDirectory

import numpy as np

ROOT = Path(__file__).resolve().parents[3]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from tools.character_lighting_lab import terrain_compose as tc   # noqa: E402
from tools.terrain_workbench import authoring, serve             # noqa: E402

_TS_SYNC = ROOT / "src/dev/runtimeTerrainSync.ts"
_JS_MATH = ROOT / "tools/terrain_workbench/viewer/terrain_math.js"


def _dvc_ignored(rel: str) -> bool:
    from pathspec import PathSpec
    lines = (ROOT / ".dvcignore").read_text(encoding="utf-8").splitlines()
    return PathSpec.from_lines("gitwildmatch", lines).match_file(rel)


class _TmpScene:
    """tmp 里的一个场景：4×3 自动网格（中间一列阻挡）+ 空作者层 + 深度 / 行走面 / 照明 json（够合成器与 reach 跑）。"""

    def __init__(self, sid: str = "x"):
        self.tmp = TemporaryDirectory()
        base = Path(self.tmp.name)
        self.sid = sid
        self.rt = base / "rt"
        self.assets = base / "assets"
        (self.assets).mkdir()
        (self.rt / sid).mkdir(parents=True)
        self._saved = (tc.SCENES_RT, tc.SCENES_JSON, authoring.PREVIEW_ROOT, authoring.DRAFT_ROOT)
        tc.SCENES_RT = self.rt
        tc.SCENES_JSON = self.assets
        authoring.PREVIEW_ROOT = base / "preview"
        authoring.DRAFT_ROOT = base / "drafts"
        (self.assets / f"{sid}.json").write_text(json.dumps({
            "id": sid, "worldWidth": 400, "worldHeight": 200, "spawnPoint": {"x": 20, "y": 100},
            "backgrounds": [{"image": "background.png"}],
            "depthConfig": {"depth_map": "raw_depth_rg.png", "collision_map": "collision.png",
                            "M": {"R": [[1, 0, 0], [0, 1, 0], [0, 0, 1]], "ppu": 100.0, "cx": 200.0, "cy": 100.0}}}),
            encoding="utf-8")
        self.grid = tc.GridMeta(-2.0, 0.0, 1.0, 4, 3)
        blocked = np.zeros((3, 4), bool)
        blocked[:, 1] = True
        tc.record_auto(sid, blocked, self.grid)

    def close(self) -> None:
        tc.SCENES_RT, tc.SCENES_JSON, authoring.PREVIEW_ROOT, authoring.DRAFT_ROOT = self._saved
        self.tmp.cleanup()

    def state(self, **over) -> dict:
        doc = tc.load_terrain(self.sid)
        st = {"doc": doc, "brush": None, "height": None}
        st.update(over)
        return st


class ContractTests(unittest.TestCase):
    """Python ↔ TS 各写一份的字面量（漂了 = 推了没反应且零报错）。"""

    def test_槽路径两边一致(self):
        m = re.search(r"RUNTIME_TERRAIN_API = '([^']+)'", _TS_SYNC.read_text(encoding="utf-8"))
        self.assertIsNotNone(m)
        self.assertEqual(authoring.SLOT_PATH, m.group(1))

    def test_预览根目录两边一致_且不进仓库不进发行包(self):
        m = re.search(r"RUNTIME_TERRAIN_PREVIEW_DIR = '([^']+)'", _TS_SYNC.read_text(encoding="utf-8"))
        self.assertIsNotNone(m)
        self.assertEqual(authoring.PREVIEW_ROOT, ROOT / Path(m.group(1)))
        rel = authoring.PREVIEW_ROOT.relative_to(ROOT).as_posix()
        self.assertTrue(rel.startswith("local/"), rel)
        self.assertIn("local/", (ROOT / ".gitignore").read_text(encoding="utf-8").splitlines())

    def test_文件名单两边一致(self):
        block = _TS_SYNC.read_text(encoding="utf-8").split("TERRAIN_PREVIEW_FILES")[1].split("];")[0]
        self.assertEqual(set(re.findall(r"'([^']+)'", block)), set(authoring.PREVIEW_FILES))
        self.assertEqual(set(authoring.PREVIEW_FILES), {"collision.png", tc.SIDECAR_FILE, "ground_d.png", "ground_d.json"})

    def test_旁挂文件名与运行时一致(self):
        ts = (ROOT / "src/core/SceneDepthSystem.ts").read_text(encoding="utf-8")
        m = re.search(r"COLLISION_SIDECAR_FILE = '([^']+)'", ts)
        self.assertIsNotNone(m)
        self.assertEqual(tc.SIDECAR_FILE, m.group(1))

    def test_dvcignore_真的排掉了槽与历史_没排掉作者层(self):
        self.assertTrue(_dvc_ignored("resources/editor_projects/editor_data/runtime_terrain.json"))
        self.assertTrue(_dvc_ignored("public/resources/runtime/scenes/崖墓/terrain/history/20260914-120000/terrain.json"))
        for rel in ("public/resources/runtime/scenes/崖墓/terrain/terrain.json",
                    "public/resources/runtime/scenes/崖墓/terrain/walk_brush.png",
                    "public/resources/runtime/scenes/崖墓/terrain/collision_auto.png",
                    "public/resources/runtime/scenes/崖墓/collision.json"):
            self.assertFalse(_dvc_ignored(rel), rel)

    def test_打包规则_旁挂抽取_作者层不抽(self):
        rules = json.loads((ROOT / "tools/build/manifest_rules.json").read_text(encoding="utf-8"))
        txt = json.dumps(rules, ensure_ascii=False)
        self.assertIn("scenes/*/collision.json", txt)
        self.assertIn("terrain", txt)

    def test_入口都接上了(self):
        self.assertIn('"terrain-workbench": ("tools.terrain_workbench", [])', (ROOT / "tools/dev/launch.py").read_text(encoding="utf-8"))
        self.assertIn('"terrain-workbench"', (ROOT / "tools/dev_console/app.py").read_text(encoding="utf-8"))
        mw = (ROOT / "tools/editor/main_window.py").read_text(encoding="utf-8")
        self.assertIn("def open_terrain_workbench", mw)
        self.assertIn("地形工作台…", mw)
        self.assertIn("runtimeTerrainApi()", (ROOT / "vite.config.ts").read_text(encoding="utf-8"))


class StateCodecTests(unittest.TestCase):
    def setUp(self):
        self.sc = _TmpScene()

    def tearDown(self):
        self.sc.close()

    def test_场景id护栏(self):
        for bad in ("", "..", "a/b", "a\\b", "x:y", "没有这个场景"):
            with self.assertRaises(ValueError):
                authoring.safe_sid(bad)
        self.assertEqual(authoring.safe_sid("x"), "x")

    def test_盘上作者层到工作态再回来_逐格相同(self):
        st = authoring.layer_state("x")
        self.assertIsNone(st["brush"])
        self.assertEqual(st["auto"]["grid"]["grid_width"], 4)
        brush = np.zeros((3, 4), np.uint8)
        brush[0, 1] = tc.BRUSH_WALK
        height = np.zeros((3, 4), np.float32)
        height[2, 3] = 0.25
        state = self.sc.state(brush=authoring._b64(brush), height=authoring._b64(height.astype("<f4")))
        r = authoring.save("x", state)
        self.assertTrue(r["ok"], r)
        st2 = authoring.layer_state("x")
        np.testing.assert_array_equal(authoring._unb64(st2["brush"], np.uint8, (3, 4)), brush)
        h2 = authoring._unb64(st2["height"], "<f4", (3, 4))
        self.assertAlmostEqual(float(h2[2, 3]), 0.25, places=4)
        self.assertTrue(st2["doc"]["brush"]["sha1"] and st2["doc"]["height"]["range"] >= 1.0)

    def test_形状闸门在保存_合成_推送三处同一道(self):
        bad = self.sc.state()
        bad["doc"]["regions"] = [{"id": "r", "kind": "nope", "points": [[0, 0], [1, 0], [1, 1]]}]
        for fn in (authoring.compose, authoring.save, authoring.push_start):
            with self.assertRaises(ValueError):
                fn("x", bad)
        v = authoring.validate("x", bad)
        self.assertTrue(v["problems"])
        with self.assertRaises(ValueError):
            authoring.decode_state("x", self.sc.state(brush=authoring._b64(np.full((3, 4), 7, np.uint8))))

    def test_合成与阻挡压过可走(self):
        st = self.sc.state()
        # 多边形边别压在格心上（射线法在边上不稳定，作者面用格心采样，这里也避开）
        st["doc"]["regions"] = [{"id": "w", "kind": "walk", "points": [[-1.6, -0.5], [0.4, -0.5], [0.4, 3.5], [-1.6, 3.5]]},
                                {"id": "b", "kind": "block", "points": [[-2.5, 1.6], [2.5, 1.6], [2.5, 3.5], [-2.5, 3.5]]}]
        c = authoring.compose("x", st)
        blocked = authoring._unb64(c["blocked"], np.uint8, (3, 4))
        self.assertEqual(blocked[0].tolist(), [0, 0, 0, 0])      # 可走多边形盖掉自动阻挡的那一列
        self.assertEqual(blocked[1].tolist(), [0, 0, 0, 0])
        self.assertEqual(blocked[2].tolist(), [1, 1, 1, 1])      # 阻挡多边形压过一切
        self.assertAlmostEqual(c["blockedPct"], 100 * 4 / 12)

    def test_保存留历史_乐观并发_恢复(self):
        st = self.sc.state()
        st["doc"]["regions"] = [{"id": "r1", "kind": "block", "points": [[0, 0], [1, 0], [1, 1]]}]
        r1 = authoring.save("x", st)
        self.assertTrue(r1["ok"])
        st2 = authoring.layer_state("x")
        st2["doc"]["regions"] = []
        r2 = authoring.save("x", {"doc": st2["doc"], "brush": None, "height": None}, base_updated=r1["updated"])
        self.assertTrue(r2["ok"])
        stale = authoring.save("x", {"doc": st2["doc"], "brush": None, "height": None}, base_updated="1999-01-01 00:00:00")
        self.assertFalse(stale["ok"]) and self.assertTrue(stale["conflict"])
        hist = authoring.history("x")
        self.assertGreaterEqual(len(hist), 2)
        older = next(h for h in hist if h["regions"] == 1)
        back = authoring.restore("x", older["name"])
        self.assertTrue(back["ok"])
        self.assertEqual(len(tc.load_terrain("x")["regions"]), 1)
        self.assertFalse(authoring.restore("x", "../etc")["ok"])

    def test_待导出判据(self):
        self.assertTrue(authoring.needs_export("x"))            # 还没导出过
        tc.export_terrain("x")
        self.assertFalse(authoring.needs_export("x"))
        st = self.sc.state()
        st["doc"]["regions"] = [{"id": "r1", "kind": "walk", "points": [[0, 0], [1, 0], [1, 1]]}]
        authoring.save("x", st)
        self.assertTrue(authoring.needs_export("x"))

    def test_草稿(self):
        self.assertIsNone(authoring.draft_get("x"))
        authoring.draft_put("x", {"state": {"doc": {}}, "savedAt": "t"})
        self.assertEqual(authoring.draft_get("x")["savedAt"], "t")
        self.assertTrue(authoring.draft_clear("x")["cleared"])
        with self.assertRaises(ValueError):
            authoring.draft_put("x", "不是对象")


class JobTests(unittest.TestCase):
    def setUp(self):
        self.sc = _TmpScene()
        self._push = authoring.push_to_game

    def tearDown(self):
        authoring.push_to_game = self._push
        self.sc.close()

    def _wait(self) -> dict:
        import time
        for _ in range(400):
            st = authoring.job_status()
            if st["done"]:
                return st
            time.sleep(0.02)
        self.fail("后台活没结束")

    def test_推给游戏_只写预览目录_资源不动_通知失败不算失败(self):
        authoring.push_to_game = lambda sid, source: (_ for _ in ()).throw(RuntimeError("游戏炸了"))
        st = self.sc.state()
        st["doc"]["regions"] = [{"id": "r1", "kind": "walk", "points": [[-2.5, -0.5], [2.5, -0.5], [2.5, 3.5], [-2.5, 3.5]]}]
        r = authoring.push_start("x", st)
        self.assertTrue(r["ok"], r)
        done = self._wait()
        self.assertTrue(done["succeeded"], done)
        self.assertFalse(done["push"]["pushed"])
        pv = authoring.preview_root("x")
        self.assertTrue((pv / "collision.png").exists() and (pv / tc.SIDECAR_FILE).exists())
        self.assertFalse((self.sc.rt / "x" / "collision.png").exists(), "推给游戏不许写资源")
        png = tc.read_u8_png(pv / "collision.png")
        self.assertEqual(int((png > 127).sum()), 0, "可走多边形盖满 ⇒ 预览里没有阻挡格")
        self.assertEqual(json.loads((pv / tc.SIDECAR_FILE).read_text(encoding="utf-8"))["grid_width"], 4)

    def test_导出到游戏_写资源_删预览_报连通性(self):
        authoring.push_to_game = lambda sid, source: {"pushed": False, "why": "测试里没有游戏"}
        authoring.preview_root("x").mkdir(parents=True, exist_ok=True)
        (authoring.preview_root("x") / "collision.png").write_bytes(b"x")
        r = authoring.export_start("x")
        self.assertTrue(r["ok"], r)
        done = self._wait()
        self.assertTrue(done["succeeded"], done)
        self.assertTrue((self.sc.rt / "x" / "collision.png").exists() and (self.sc.rt / "x" / tc.SIDECAR_FILE).exists())
        self.assertFalse(authoring.preview_root("x").exists(), "导出之后预览目录就是多余的")
        self.assertIn("reach", done["result"])

    def test_同一时刻只许一个活(self):
        authoring.push_to_game = lambda sid, source: {"pushed": False, "why": "-"}
        authoring._JOB.update({"running": True, "kind": "push", "scene": "x"})
        try:
            r = authoring.export_start("x")
            self.assertFalse(r["ok"]) and self.assertTrue(r["busy"])
        finally:
            authoring._JOB.update({"running": False, "done": True})

    def test_状态字段不与信封的_ok_撞名(self):
        self.assertNotIn("ok", authoring.job_status())

    def test_推送说法三档(self):
        self.assertIn("没送到", authoring.push_note({"pushed": False, "why": "x"}, "s"))
        self.assertIn("原地换上", authoring.push_note({"pushed": True, "rev": 3, "inScene": True, "game": {}}, "s"))
        self.assertIn("没有游戏页", authoring.push_note({"pushed": True, "rev": 3, "pageAlive": False, "game": None}, "s"))


class ServeTests(unittest.TestCase):
    """进程内起真服务，路由与信封（一切 ok:false 而不是断连）。"""

    @classmethod
    def setUpClass(cls):
        cls.sc = _TmpScene()
        cls.httpd = ThreadingHTTPServer(("127.0.0.1", 0), serve.H)
        threading.Thread(target=cls.httpd.serve_forever, daemon=True).start()
        cls.base = f"http://127.0.0.1:{cls.httpd.server_address[1]}"

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        cls.sc.close()

    def _get(self, path: str):
        with urllib.request.urlopen(self.base + path, timeout=5) as r:
            return r.status, json.loads(r.read().decode("utf-8"))

    def _post(self, path: str, body: dict):
        req = urllib.request.Request(self.base + path, data=json.dumps(body).encode("utf-8"),
                                     headers={"Content-Type": "application/json"}, method="POST")
        try:
            with urllib.request.urlopen(req, timeout=5) as r:
                return r.status, json.loads(r.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            return e.code, json.loads(e.read().decode("utf-8") or "{}")

    def test_boot_取一次即清_然后回最近装上的(self):
        serve.BOOT_OPEN.append("x")
        self.assertEqual(self._get("/api/boot")[1]["open"], "x")
        self.assertEqual(self._get("/api/boot")[1]["open"], "")

    def test_scenes_terrain_compose_validate_save(self):
        _s, j = self._get("/api/scenes")
        self.assertTrue(j["ok"] and any(r["id"] == "x" for r in j["scenes"]))
        _s, t = self._get("/api/terrain?id=x")
        self.assertTrue(t["ok"] and t["doc"]["grid"]["grid_width"] == 4)
        st = {"doc": t["doc"], "brush": None, "height": None}
        _s, c = self._post("/api/compose", {"id": "x", "state": st})
        self.assertTrue(c["ok"] and c["cells"] == 12)
        _s, v = self._post("/api/validate", {"id": "x", "state": st})
        self.assertTrue(v["ok"] and v["problems"] == [])
        _s, sv = self._post("/api/save", {"id": "x", "state": st})
        self.assertTrue(sv["ok"] and sv["updated"])
        _s, h = self._get("/api/history?id=x")
        self.assertTrue(h["ok"])
        code, bad = self._post("/api/compose", {"id": "../x", "state": st})
        self.assertEqual(code, 500) and self.assertFalse(bad["ok"])
        self.assertEqual(self._post("/api/nope", {})[0], 404)

    def test_vendor_白名单(self):
        with urllib.request.urlopen(self.base + "/vendor/common.js", timeout=5) as r:
            self.assertEqual(r.status, 200)
            self.assertIn("javascript", r.headers.get("Content-Type", ""))
        with self.assertRaises(urllib.error.HTTPError):
            self._get("/vendor/nope.js")

    def test_check_与_link_status_不断连(self):
        _s, c = self._get("/api/check?id=x")
        self.assertTrue(c["ok"])
        _s, ls = self._get("/api/link/status")
        self.assertTrue(ls["ok"] and "alive" in ls)


@unittest.skipIf(shutil.which("node") is None, "没有 node")
class JsParityTests(unittest.TestCase):
    """页面即时反馈用的 JS 合成器必须与 Python 合成器**逐格相同**（否则作者看到的与游戏读的不是一回事）。"""

    def test_随机作者层_合成逐格相同(self):
        rng = np.random.default_rng(7)
        grid = tc.GridMeta(-2.3, 0.7, 0.37, 23, 17)
        auto_grid = tc.GridMeta(-2.0, 1.0, 0.5, 15, 12)
        auto = rng.random((12, 15)) < 0.4
        brush = rng.integers(0, 3, (17, 23)).astype(np.uint8)
        regions = []
        for i in range(4):
            cx, cz = rng.uniform(-2, 6), rng.uniform(0, 7)
            n = int(rng.integers(3, 7))
            ang = np.sort(rng.uniform(0, 2 * np.pi, n))
            rad = rng.uniform(0.4, 2.0, n)
            regions.append({"id": f"r{i}", "kind": "walk" if i % 2 else "block",
                            "points": [[float(cx + np.cos(a) * r), float(cz + np.sin(a) * r)] for a, r in zip(ang, rad)]})
        with TemporaryDirectory() as td:
            base = Path(td)
            saved = (tc.SCENES_RT, tc.SCENES_JSON)
            tc.SCENES_RT, tc.SCENES_JSON = base / "rt", base / "assets"
            try:
                (base / "assets").mkdir()
                (base / "assets" / "p.json").write_text(json.dumps({"id": "p", "depthConfig": {}}), encoding="utf-8")
                (base / "rt" / "p").mkdir(parents=True)
                doc = tc.record_auto("p", auto, auto_grid)
                doc["grid"] = grid.to_dict()
                doc["regions"] = regions
                blocked, src, _g = tc.compose_collision("p", doc, {"brush": brush, "height": None})
            finally:
                tc.SCENES_RT, tc.SCENES_JSON = saved
            payload = json.dumps({"grid": grid.to_dict(), "auto": {"grid": auto_grid.to_dict(), "data": auto.astype(int).ravel().tolist()},
                                  "brush": brush.ravel().tolist(), "regions": regions})
            (base / "in.json").write_text(payload, encoding="utf-8")
            # 仓库 package.json 是 "type":"module"，浏览器脚本不能直接 require：走 vm 装载（与轨迹台的样条金标同法）
            js = f"""
const fs = require('fs'), vm = require('vm');
const ctx = {{ console, module: {{ exports: {{}} }}, atob: (s) => Buffer.from(s, 'base64').toString('binary'), btoa: (s) => Buffer.from(s, 'binary').toString('base64') }};
vm.createContext(ctx);
vm.runInContext(fs.readFileSync({json.dumps(str(_JS_MATH))}, 'utf8'), ctx, {{ filename: 'terrain_math.js' }});
const m = ctx.module.exports;
const inp = JSON.parse(require('fs').readFileSync({json.dumps(str(base / 'in.json'))}, 'utf-8'));
const g = new m.Grid(inp.grid), ag = new m.Grid(inp.auto.grid);
const r = m.composeCollision(g, {{ grid: ag, data: Uint8Array.from(inp.auto.data) }}, Uint8Array.from(inp.brush), inp.regions);
process.stdout.write(JSON.stringify({{ blocked: Array.from(r.blocked), src: Array.from(r.src) }}));
"""
            from tools.dev.paths import env_with_node_path
            out = subprocess.run(["node", "-e", js], capture_output=True, text=True, encoding="utf-8", timeout=60, env=env_with_node_path())
            self.assertEqual(out.returncode, 0, out.stderr)
            got = json.loads(out.stdout)
            self.assertEqual(got["blocked"], np.where(blocked, 1, 0).ravel().tolist())
            self.assertEqual(got["src"], src.ravel().tolist())


if __name__ == "__main__":
    unittest.main()
