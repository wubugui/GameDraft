"""抽取清单生成器的回归测试。

用临时工程跑，不碰真实仓库——顺带钉死"清单工具只读"这条：
测试结束会断言临时工程的文件树一个字节都没变。
"""
from __future__ import annotations

import hashlib
import json
import sys
import unittest
from pathlib import Path

_ROOT = Path(__file__).resolve().parents[3]
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

from tools.build.asset_manifest import (  # noqa: E402
    build_manifest,
    unpicked_summary,
)

import tempfile  # noqa: E402


def _write(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    # newline="\n"：Windows 上 write_text 默认把 \n 翻成 \r\n
    path.write_text(text, encoding="utf-8", newline="\n")


def _write_png(path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(b"\x89PNG\r\n\x1a\n" + b"0" * 16)


def _tree_fingerprint(root: Path) -> str:
    """整棵树的内容指纹，用来证明工具没动过任何文件。"""
    h = hashlib.sha256()
    for p in sorted(root.rglob("*")):
        rel = p.relative_to(root).as_posix()
        h.update(rel.encode("utf-8"))
        if p.is_file():
            h.update(p.read_bytes())
    return h.hexdigest()


BASE_RULES = {
    "always_extract": [],
    "never_extract": [],
    "targets": {"dev": {}, "release": {}},
}


class ManifestBaseTests(unittest.TestCase):
    """最小工程：一个场景、一个动画包、一张被引用的图。"""

    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(self._tmp.name)
        pub = self.root / "public"

        _write(pub / "assets" / "data" / "game_config.json", json.dumps({
            "initialScene": "s1", "fallbackScene": "s1",
        }))
        _write(pub / "assets" / "scenes" / "s1.json", json.dumps({
            "id": "s1",
            "backgrounds": [{"image": "background.png"}],
            "npcs": [{"id": "n1", "animFile": "/resources/runtime/animation/pkg_a/anim.json"}],
        }, ensure_ascii=False))

        _write_png(pub / "resources" / "runtime" / "scenes" / "s1" / "background.png")

        _write(pub / "resources" / "runtime" / "animation" / "pkg_a" / "anim.json", json.dumps({
            "spritesheet": "atlas.png", "cols": 1, "rows": 1, "states": {},
        }))
        _write_png(pub / "resources" / "runtime" / "animation" / "pkg_a" / "atlas.png")

        self.addCleanup(self._tmp.cleanup)

    def run_manifest(self, rules: dict | None = None, target: str = "release"):
        merged = json.loads(json.dumps(BASE_RULES))
        for k, v in (rules or {}).items():
            merged[k] = v
        return build_manifest(self.root, merged, target=target)

    # ---------------------------------------------------------------- 只读

    def test_生成清单不动工程里任何文件(self) -> None:
        before = _tree_fingerprint(self.root)
        rep = self.run_manifest()
        unpicked_summary(self.root, rep)
        self.assertEqual(before, _tree_fingerprint(self.root))

    # ------------------------------------------------------------ 四个来源

    def test_文本配置整棵树无条件进包(self) -> None:
        rep = self.run_manifest()
        self.assertIn("assets/data/game_config.json", rep.files)
        self.assertIn("assets/scenes/s1.json", rep.files)

    def test_JSON_引用闭包捞到场景背景(self) -> None:
        rep = self.run_manifest()
        self.assertIn("resources/runtime/scenes/s1/background.png", rep.files)

    def test_动画包传递闭包带出精灵图(self) -> None:
        rep = self.run_manifest()
        self.assertIn("resources/runtime/animation/pkg_a/anim.json", rep.files)
        self.assertIn("resources/runtime/animation/pkg_a/atlas.png", rep.files)

    def test_派生兄弟_法线图与挂点表(self) -> None:
        pkg = self.root / "public" / "resources" / "runtime" / "animation" / "pkg_a"
        _write_png(pkg / "atlas.normal.png")
        _write(pkg / "sockets.json", "{}")

        rep = self.run_manifest()
        self.assertIn("resources/runtime/animation/pkg_a/atlas.normal.png", rep.files)
        self.assertIn("resources/runtime/animation/pkg_a/sockets.json", rep.files)

    def test_派生兄弟不存在时不硬塞(self) -> None:
        rep = self.run_manifest()
        self.assertNotIn("resources/runtime/animation/pkg_a/atlas.normal.png", rep.files)
        self.assertNotIn("resources/runtime/animation/pkg_a/sockets.json", rep.files)

    def test_bundleId_约定拼出动画包(self) -> None:
        """数据里写的是标识符，路径由代码拼——审计抓不到，只能靠这条约定扫描。"""
        pkg = self.root / "public" / "resources" / "runtime" / "animation" / "pkg_b"
        _write(pkg / "anim.json", json.dumps({"spritesheet": "atlas.png"}))
        _write_png(pkg / "atlas.png")
        _write(
            self.root / "public" / "assets" / "data" / "quests.json",
            json.dumps({"q1": {"actions": [{"params": {"bundleId": "pkg_b"}}]}}),
        )

        rep = self.run_manifest()
        self.assertIn("resources/runtime/animation/pkg_b/anim.json", rep.files)
        # 拼出来的入口还要继续走传递闭包
        self.assertIn("resources/runtime/animation/pkg_b/atlas.png", rep.files)

    def test_没人引用的东西不进包(self) -> None:
        _write_png(self.root / "public" / "resources" / "runtime" / "images" / "orphan.png")
        rep = self.run_manifest()
        self.assertNotIn("resources/runtime/images/orphan.png", rep.files)

    # -------------------------------------------------------------- 规则

    def test_always_extract_捞进代码写死的资源(self) -> None:
        _write_png(self.root / "public" / "resources" / "runtime" / "images" / "ui" / "frame.png")
        rep = self.run_manifest({"always_extract": ["resources/runtime/images/ui/*"]})
        self.assertIn("resources/runtime/images/ui/frame.png", rep.files)

    def test_never_extract_是兜底且优先级最高(self) -> None:
        """被引用到、但明确不该进包的东西，never 要能挡住。"""
        rep = self.run_manifest({
            "always_extract": ["resources/runtime/scenes/s1/*"],
            "never_extract": ["resources/runtime/scenes/s1/background.png"],
        })
        self.assertNotIn("resources/runtime/scenes/s1/background.png", rep.files)
        self.assertIn("resources/runtime/scenes/s1/background.png", rep.excluded_by_rule)

    def test_档位叠加_dev_多带_release_排除(self) -> None:
        big = self.root / "public" / "resources" / "runtime" / "scenes" / "s1" / "vol_emit.bin"
        big.parent.mkdir(parents=True, exist_ok=True)
        big.write_bytes(b"0" * 32)
        rules = {
            "targets": {
                "dev": {"always_extract": ["resources/runtime/scenes/*/vol_emit.bin"]},
                "release": {"never_extract": ["resources/runtime/scenes/*/vol_emit.bin"]},
            },
        }
        dev = self.run_manifest(rules, target="dev")
        rel = self.run_manifest(rules, target="release")
        self.assertIn("resources/runtime/scenes/s1/vol_emit.bin", dev.files)
        self.assertNotIn("resources/runtime/scenes/s1/vol_emit.bin", rel.files)

    def test_未知档位直接报错而不是悄悄按缺省走(self) -> None:
        with self.assertRaises(ValueError):
            self.run_manifest(target="prod")

    # ------------------------------------------------------------ 报告

    def test_未抽取报告只统计不改动(self) -> None:
        _write_png(self.root / "public" / "resources" / "runtime" / "images" / "orphan.png")
        rep = self.run_manifest()
        rows = unpicked_summary(self.root, rep)
        self.assertTrue(any("orphan" in key or "images" in key for key, _, _ in rows))
        self.assertTrue((self.root / "public" / "resources" / "runtime" / "images" / "orphan.png").is_file())

    def test_引用指向不存在的文件会被审计记成_issue(self) -> None:
        """打包管线据此 --strict 停下：带着这种状态打出来的包必然 404。"""
        _write(self.root / "public" / "assets" / "scenes" / "s2.json", json.dumps({
            "id": "s2", "backgrounds": [{"image": "missing.png"}],
        }))
        rep = self.run_manifest()
        self.assertGreater(rep.audit_issue_count, 0)


class RealRulesTests(unittest.TestCase):
    """真实规则文件本身的形状（写坏了会让整条管线跑不起来）。"""

    def test_规则文件可解析且两个档位都在(self) -> None:
        rules = json.loads(
            (_ROOT / "tools" / "build" / "manifest_rules.json").read_text(encoding="utf-8"),
        )
        self.assertIn("always_extract", rules)
        self.assertIn("never_extract", rules)
        self.assertEqual({"dev", "release"}, set(rules["targets"]))

    def test_每条规则都是相对_public_的路径不带前导斜杠(self) -> None:
        rules = json.loads(
            (_ROOT / "tools" / "build" / "manifest_rules.json").read_text(encoding="utf-8"),
        )
        pats = list(rules["always_extract"]) + list(rules["never_extract"])
        for t in rules["targets"].values():
            pats += list(t.get("always_extract", [])) + list(t.get("never_extract", []))
        for p in pats:
            self.assertFalse(p.startswith("/"), f"规则不该带前导斜杠：{p}")
            self.assertFalse(p.startswith("public/"), f"规则是相对 public 的，别再写一层：{p}")


if __name__ == "__main__":
    unittest.main()
