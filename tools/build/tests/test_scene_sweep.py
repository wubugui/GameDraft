"""全场景抓取扫描的纯逻辑：请求归一化、相对清单的归类、逐场景汇总。

驱动（QtWebEngine）不在这里测——它要真起 dev 服；归类逻辑错了会让扫描门
"永远绿"或"永远红"，所以这一层必须钉死。
"""
from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path

_ROOT = Path(__file__).resolve().parents[3]
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

from tools.build.scene_sweep import (  # noqa: E402
    classify_request,
    normalize_request_url,
    scenes_from_disk,
    summarize,
)


class NormalizeTests(unittest.TestCase):
    def test_游戏内容_URL_去掉_origin_与_query_并解码(self) -> None:
        self.assertEqual(
            normalize_request_url("http://127.0.0.1:5197/resources/runtime/scenes/s1/lighting/background/atlas_bin.bin?t=1"),
            "resources/runtime/scenes/s1/lighting/background/atlas_bin.bin",
        )
        self.assertEqual(
            normalize_request_url("http://127.0.0.1:5197/resources/runtime/audio/%E8%83%8C%E6%99%AF%E9%9F%B3/x.wav"),
            "resources/runtime/audio/背景音/x.wav",
        )
        self.assertEqual(normalize_request_url("http://h/assets/scenes/s1.json"), "assets/scenes/s1.json")

    def test_vite_模块_中间件_浏览器自动请求一律忽略(self) -> None:
        for u in (
            "http://h/", "http://h/index.html", "http://h/favicon.ico",
            "http://h/@vite/client", "http://h/@fs/E:/x.ts", "http://h/src/main.ts",
            "http://h/node_modules/.vite/deps/pixi.js", "http://h/__gamedraft-api/runtime-command",
            "http://h/__verify/404", "http://h/something/else.png",
        ):
            self.assertIsNone(normalize_request_url(u), u)


class ClassifyTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.pub = Path(self._tmp.name)
        self.addCleanup(self._tmp.cleanup)
        (self.pub / "resources" / "runtime" / "scenes" / "s1" / "lighting" / "bg").mkdir(parents=True)
        (self.pub / "resources" / "runtime" / "scenes" / "s1" / "lighting" / "bg" / "atlas_bin.bin").write_bytes(b"0")
        (self.pub / "resources" / "runtime" / "audio").mkdir(parents=True)
        (self.pub / "resources" / "runtime" / "audio" / "a.wav").write_bytes(b"0")
        self.manifest = {"resources/runtime/audio/a.wav", "assets/scenes/s1.json"}

    def test_清单里有就是_in_manifest(self) -> None:
        self.assertEqual(classify_request("assets/scenes/s1.json", self.manifest, self.pub), "in_manifest")

    def test_发行档音频转码_请求_ogg_认作清单里的_wav(self) -> None:
        self.assertEqual(classify_request("resources/runtime/audio/a.ogg", self.manifest, self.pub), "in_manifest")

    def test_开发树有_清单没有_就是漏抽(self) -> None:
        """这就是 2026-09-05 atlas_bin 的形状：运行时要、磁盘上有、清单里没有。"""
        self.assertEqual(
            classify_request("resources/runtime/scenes/s1/lighting/bg/atlas_bin.bin", self.manifest, self.pub),
            "gap",
        )

    def test_可选_sidecar_的探测按设计_404(self) -> None:
        self.assertEqual(classify_request("resources/runtime/animation/p/sockets.json", self.manifest, self.pub), "optional_probe")
        self.assertEqual(classify_request("resources/runtime/images/x.normal.png", self.manifest, self.pub), "optional_probe")
        # 没烘过的场景进场景会去问载荷入口（含迁移期的扁平布局）——烘焙可以缺省
        self.assertEqual(classify_request("resources/runtime/scenes/dev_room/lighting/background/lighting.json", self.manifest, self.pub), "optional_probe")
        self.assertEqual(classify_request("resources/runtime/scenes/dev_room/lighting/lighting.json", self.manifest, self.pub), "optional_probe")
        self.assertEqual(classify_request("resources/runtime/scenes/dev_room/lighting/background/geometry.json", self.manifest, self.pub), "optional_probe")
        # 但载荷**目录已存在**时旁挂文件缺席就不是"可选"：那是烘焙缺件（missing_in_dev）或漏抽（gap）
        self.assertEqual(classify_request("resources/runtime/scenes/s1/lighting/bg/probes_valid.bin", self.manifest, self.pub), "missing_in_dev")

    def test_开发树也没有的是数据缺件_不是漏抽(self) -> None:
        self.assertEqual(classify_request("resources/runtime/images/nope.png", self.manifest, self.pub), "missing_in_dev")

    def test_产物派生物不算(self) -> None:
        self.assertEqual(classify_request("assets/scene_index.json", self.manifest, self.pub), "derived")


class ScenesFromDiskTests(unittest.TestCase):
    def test_按文件名列场景_只有开了日夜且配了变体的才有时段(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            d = Path(tmp)
            (d / "a.json").write_text(json.dumps({"id": "a"}), encoding="utf-8")
            (d / "b.json").write_text(json.dumps({
                "id": "b_json_id", "dayNight": {"enabled": True},
                "timeVariants": {"夜": {"backgrounds": [{"image": "bg-night.png"}]}, "暮": {}},
            }), encoding="utf-8")
            # 配了变体但没开日夜：运行时不解析时段，扫描也不切
            (d / "c.json").write_text(json.dumps({"timeVariants": {"夜": {}}}), encoding="utf-8")
            (d / "broken.json").write_text("{not json", encoding="utf-8")
            scenes = {s.id: s for s in scenes_from_disk(d)}
        self.assertEqual(set(scenes), {"a", "b", "c", "broken"})
        self.assertEqual(scenes["a"].phases, [])
        self.assertEqual(scenes["b"].phases, ["夜", "暮"])
        self.assertEqual(scenes["b"].json_id, "b_json_id")
        self.assertEqual(scenes["c"].phases, [])
        self.assertEqual(scenes["broken"].json_id, "broken")


class SummarizeTests(unittest.TestCase):
    def test_有漏抽或有场景没跑起来就是_FAIL(self) -> None:
        ok = summarize([{"id": "a", "requests": 3, "gaps": [], "missingInDev": []}])
        self.assertEqual(ok["verdict"], "PASS")
        gap = summarize([{"id": "a", "requests": 3, "gaps": ["x.bin"], "missingInDev": []},
                         {"id": "b", "requests": 1, "gaps": ["x.bin"], "missingInDev": ["y.png"]}])
        self.assertEqual(gap["verdict"], "FAIL")
        self.assertEqual(gap["gaps"], [{"path": "x.bin", "scenes": ["a", "b"]}])
        self.assertEqual(gap["missingInDev"], [{"path": "y.png", "scenes": ["b"]}])
        self.assertEqual(gap["summary"]["requests"], 4)
        err = summarize([{"id": "a", "requests": 0, "gaps": [], "missingInDev": [], "error": "boom"}])
        self.assertEqual(err["verdict"], "FAIL")
        self.assertEqual(err["summary"]["scenesFailed"], 1)

    def test_开发树也没有的不影响判定(self) -> None:
        r = summarize([{"id": "a", "requests": 1, "gaps": [], "missingInDev": ["y.png"]}])
        self.assertEqual(r["verdict"], "PASS")


if __name__ == "__main__":
    unittest.main()
