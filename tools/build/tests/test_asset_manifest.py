"""抽取清单生成器的回归测试。

用临时工程跑，不碰真实仓库——顺带钉死"清单工具只读"这条：
测试结束会断言临时工程的文件树一个字节都没变。
"""
from __future__ import annotations

import fnmatch
import hashlib
import json
import re
import sys
import unittest
from pathlib import Path

_ROOT = Path(__file__).resolve().parents[3]
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

from tools.build.asset_manifest import (  # noqa: E402
    DEFAULT_PROBE_MODE,
    LIGHTING_GEOMETRY_FILES,
    LIGHTING_PAYLOAD_CORE,
    LIGHTING_PAYLOAD_DEBUG_ONLY,
    LIGHTING_PAYLOAD_OPTIONAL,
    PROBE_ATLAS_FILE_BY_MODE,
    _load_rules,
    build_manifest,
    probe_atlas_file_for_mode,
    probe_mode_of,
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

    def test_注册表登记即引用_overlay_与道具预设(self) -> None:
        """登记在 overlay_images / prop_presets 里、但暂时没有哪条动作引用的图也要进包：
        注册表是作者写的内容，dev 服能显示它（整个 public/ 都在），包里不能静默缺。"""
        img = self.root / "public" / "resources" / "runtime" / "images" / "illustrations" / "lamp.png"
        _write_png(img)
        _write_png(self.root / "public" / "resources" / "runtime" / "images" / "icons" / "sword.png")
        _write(self.root / "public" / "assets" / "data" / "overlay_images.json", json.dumps({
            "lamp": "/resources/runtime/images/illustrations/lamp.png",
            "ghost": "/resources/runtime/images/illustrations/not_there.png",
        }))
        _write(self.root / "public" / "assets" / "data" / "prop_presets.json", json.dumps({
            "sword": {"label": "剑", "image": "/resources/runtime/images/icons/sword.png"},
        }))
        rep = self.run_manifest()
        self.assertIn("resources/runtime/images/illustrations/lamp.png", rep.files)
        self.assertIn("resources/runtime/images/icons/sword.png", rep.files)
        self.assertNotIn("resources/runtime/images/illustrations/not_there.png", rep.files)
        self.assertTrue(rep.origin["resources/runtime/images/illustrations/lamp.png"].startswith("注册表"))

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

    def test_光照载荷规则必须匹配磁盘上的真实布局(self) -> None:
        """规则少写一层目录 = **整批载荷静默不进包**，而且构建全绿。

        2026-08-30 烘焙产物改成按背景图名分目录（`lighting/<背景基名>/…`）之后，
        规则还停在 `lighting/<文件名>`。fnmatch 的 `*` 虽然跨 `/`，但那几条结尾是
        字面文件名，接不上多出来的一层 —— 于是 **probe 载荷一个都没进过发行包**，
        直到 2026-08-31 收束目录时才被发现。构建、测试、验包当时全是绿的。

        这条护栏对着**真实磁盘**验，而不是对着规则字符串验：只要布局再变一次而
        规则没跟上，这里立刻红。
        """
        import fnmatch
        rules = json.loads(
            (_ROOT / "tools" / "build" / "manifest_rules.json").read_text(encoding="utf-8"),
        )
        rt = _ROOT / "public" / "resources" / "runtime" / "scenes"
        if not rt.is_dir():
            self.skipTest("场景运行时目录不在（DVC 没拉）")
        # ⚠ 不用写死层数的 glob("*/lighting/*/*")：布局再加一层时它取回空集,
        #   下面若跟着 skipTest 就成了"要防的变更一发生,闸自己解除"(2026-08-31 审计)。
        #   rglob 找 lighting.json 定位载荷目录,再枚举目录内文件——层数无关。
        payload_dirs = {p.parent for p in rt.rglob("lighting.json")
                        if "lighting" in p.parent.parts}
        real = [f for d in payload_dirs for f in d.iterdir() if f.is_file()]
        # 载荷目录一个都找不到 = DVC 真没拉(空 scenes 树);但 scenes 下有场景目录
        # 却没有载荷,那是布局漂了/收束回归——必须红,不许 skip。
        if not any(rt.iterdir()):
            self.skipTest("场景运行时目录是空的（DVC 没拉）")
        self.assertTrue(real, "scenes/ 下有场景目录却找不到任何 lighting 载荷 —— "
                              "布局又变了?规则和本护栏都要跟上")

        always = list(rules["always_extract"])
        never = list(rules["never_extract"])
        # 规则只登记两个**入口**文件；其余由展开器按载荷推导（见下面 LightingPayloadExpanderTests
        # 与 RealTreeLightingTests）。入口没被 glob 接上 = 展开器根本没机会跑。
        entries = {"lighting.json", "geometry.json"}
        # 刻意不进包的（统一角色路径已停用 / 派生标量 / 只作离线烘 albedo 的输入）
        must_not = {"skyvis_grid.bin", "gi_hitmap.bin", "skyvis.png"}

        seen: set[str] = set()
        for f in real:
            rel = f.relative_to(_ROOT / "public").as_posix()
            name = f.name
            seen.add(name)
            if name in entries:
                self.assertTrue(any(fnmatch.fnmatch(rel, p) for p in always),
                                f"载荷入口没被 always_extract 匹配（布局又变了？）：{rel}")
            if name in must_not:
                self.assertTrue(any(fnmatch.fnmatch(rel, p) for p in never),
                                f"该排除的载荷没被 never_extract 匹配：{rel}")
        self.assertTrue(entries <= seen,
                        f"磁盘上缺这些烘焙产物，护栏形同虚设：{sorted(entries - seen)}")

    def test_发行档不许把任何_probe_图集写进_never_extract(self) -> None:
        """2026-09-05 的事故形状：atlas_bin.bin 被当"只有 F2 才读"排除，而它是正式档。
        哪张图集是正式的由载荷说了算（展开器抽），规则里排除任何一张都是推翻展开器。"""
        rules = _load_rules()
        for pat in rules["targets"]["release"].get("never_extract", []):
            for atlas in PROBE_ATLAS_FILE_BY_MODE.values():
                self.assertFalse(
                    fnmatch.fnmatch(f"resources/runtime/scenes/x/lighting/bg/{atlas}", pat),
                    f"发行档 never_extract 会排掉 probe 图集 {atlas}：{pat}",
                )
        for pat in rules["never_extract"]:
            for atlas in PROBE_ATLAS_FILE_BY_MODE.values():
                self.assertFalse(
                    fnmatch.fnmatch(f"resources/runtime/scenes/x/lighting/bg/{atlas}", pat),
                    f"公共 never_extract 会排掉 probe 图集 {atlas}：{pat}",
                )


class RuntimeContractTests(unittest.TestCase):
    """Python 侧的文件名表是 ``src/core/lightingPayloadFiles.ts`` 的镜像——逐字比对。

    运行时改了 mode→图集的对应（或加了一个必读文件）而这里没跟上，就是发行包
    静默失效的那条老路。解析 TS 源码而不是 import 它：Python 跑不了 TS，而 grep 一份
    形状固定的常量声明足够稳，声明形状变了这里也会红（那就一起改）。
    """

    TS_PATH = _ROOT / "src" / "core" / "lightingPayloadFiles.ts"

    def _ts(self) -> str:
        return self.TS_PATH.read_text(encoding="utf-8")

    def _ts_array(self, name: str) -> tuple[str, ...]:
        m = re.search(r"export const " + name + r"[^=]*=\s*\[([^\]]*)\]", self._ts())
        self.assertIsNotNone(m, f"TS 里找不到 export const {name} = [...]")
        return tuple(re.findall(r"'([^']+)'", m.group(1)))

    def test_probe_图集表与缺省_mode_逐字相同(self) -> None:
        src = self._ts()
        m = re.search(r"export const PROBE_ATLAS_FILE_BY_MODE[^=]*=\s*\{([^}]*)\}", src)
        self.assertIsNotNone(m, "TS 里找不到 PROBE_ATLAS_FILE_BY_MODE")
        table = {int(k): v for k, v in re.findall(r"(\d+)\s*:\s*'([^']+)'", m.group(1))}
        self.assertEqual(table, PROBE_ATLAS_FILE_BY_MODE)
        d = re.search(r"export const DEFAULT_PROBE_MODE\s*=\s*(\d+)", src)
        self.assertIsNotNone(d)
        self.assertEqual(int(d.group(1)), DEFAULT_PROBE_MODE)

    def test_四组文件名单逐字相同(self) -> None:
        self.assertEqual(self._ts_array("LIGHTING_PAYLOAD_CORE"), tuple(LIGHTING_PAYLOAD_CORE))
        self.assertEqual(self._ts_array("LIGHTING_GEOMETRY_FILES"), tuple(LIGHTING_GEOMETRY_FILES))
        self.assertEqual(self._ts_array("LIGHTING_PAYLOAD_OPTIONAL"), tuple(LIGHTING_PAYLOAD_OPTIONAL))
        self.assertEqual(self._ts_array("LIGHTING_PAYLOAD_DEBUG_ONLY"), tuple(LIGHTING_PAYLOAD_DEBUG_ONLY))

    def test_mode_判定与运行时同一条规则(self) -> None:
        """TS：``shadingMode === 1 || shadingMode === 2 ? shadingMode : DEFAULT``。"""
        self.assertEqual(probe_mode_of(1), 1)
        self.assertEqual(probe_mode_of(2), 2)
        self.assertEqual(probe_mode_of(3), DEFAULT_PROBE_MODE)
        self.assertEqual(probe_mode_of(None), DEFAULT_PROBE_MODE)
        self.assertEqual(probe_mode_of("2"), DEFAULT_PROBE_MODE)
        self.assertEqual(probe_mode_of(True), DEFAULT_PROBE_MODE)   # bool 是 int 子类，不能误判成 1
        self.assertEqual(probe_mode_of(2.0), DEFAULT_PROBE_MODE)    # JS 里 2.0 === 2，但载荷里写的是整数
        self.assertEqual(probe_atlas_file_for_mode(None), "atlas_bin.bin")


class LightingPayloadExpanderTests(ManifestBaseTests):
    """展开器按每份载荷自己的 ``shading.mode`` 抽图集——对着**真实规则文件**验。"""

    def _payload(self, scene: str, bg: str, *, mode: object = 3, files: tuple[str, ...] = (), meta_json: str | None = None) -> str:
        d = self.root / "public" / "resources" / "runtime" / "scenes" / scene / "lighting" / bg
        d.mkdir(parents=True, exist_ok=True)
        if meta_json is not None:
            _write(d / "lighting.json", meta_json)
        else:
            body = {"version": 3, "background_sha1": "x"}
            if mode is not None:
                body["shading"] = {"mode": mode}
            _write(d / "lighting.json", json.dumps(body))
        for name in files:
            (d / name).write_bytes(b"0" * 8)
        return f"resources/runtime/scenes/{scene}/lighting/{bg}"

    def run_real(self, target: str = "release"):
        return build_manifest(self.root, _load_rules(), target=target)

    ALL_SIBLINGS = (
        "probes_valid.bin", "ground_d.png", "geometry.json", "normal.png", "albedo.png", "skyvis.png",
        "skyao_probe.bin",
        "atlas_l1.bin", "atlas_l2.bin", "atlas_bin.bin", "vol_rad.bin", "vol_emit.bin",
        "skyvis_grid.bin", "gi_hitmap.bin", "lighting.json.bak",
    )

    def test_发行档只抽当前_mode_那张图集(self) -> None:
        d3 = self._payload("s1", "background", mode=3, files=self.ALL_SIBLINGS)
        d2 = self._payload("s1", "background-night", mode=2, files=self.ALL_SIBLINGS)
        d1 = self._payload("s1", "bg3", mode=1, files=self.ALL_SIBLINGS)
        d0 = self._payload("s1", "bg4", mode=None, files=self.ALL_SIBLINGS)
        rep = self.run_real("release")
        self.assertEqual(rep.problems, [])
        for d, want in ((d3, "atlas_bin.bin"), (d2, "atlas_l2.bin"), (d1, "atlas_l1.bin"), (d0, "atlas_bin.bin")):
            self.assertIn(f"{d}/{want}", rep.files, d)
            for other in PROBE_ATLAS_FILE_BY_MODE.values():
                if other != want:
                    self.assertNotIn(f"{d}/{other}", rep.files, f"{d} 不该带 {other}")

    def test_核心_几何_可选旁挂都抽_调试专用与派生标量不抽(self) -> None:
        d = self._payload("s1", "background", mode=3, files=self.ALL_SIBLINGS)
        rep = self.run_real("release")
        for name in (*LIGHTING_PAYLOAD_CORE, *LIGHTING_GEOMETRY_FILES, *LIGHTING_PAYLOAD_OPTIONAL):
            self.assertIn(f"{d}/{name}", rep.files, name)
        for name in (*LIGHTING_PAYLOAD_DEBUG_ONLY, "skyvis_grid.bin", "gi_hitmap.bin", "lighting.json.bak"):
            self.assertNotIn(f"{d}/{name}", rep.files, name)

    def test_dev_档三张图集与体积档全带(self) -> None:
        d = self._payload("s1", "background", mode=3, files=self.ALL_SIBLINGS)
        rep = self.run_real("dev")
        for name in (*PROBE_ATLAS_FILE_BY_MODE.values(), *LIGHTING_PAYLOAD_DEBUG_ONLY):
            self.assertIn(f"{d}/{name}", rep.files, name)
        for name in ("skyvis_grid.bin", "gi_hitmap.bin"):
            self.assertNotIn(f"{d}/{name}", rep.files, name)

    def test_旁挂缺席不算问题_只抽有的(self) -> None:
        d = self._payload("s1", "background", mode=3, files=("probes_valid.bin", "ground_d.png", "atlas_bin.bin"))
        rep = self.run_real("release")
        self.assertEqual(rep.problems, [])
        self.assertIn(f"{d}/atlas_bin.bin", rep.files)
        self.assertNotIn(f"{d}/geometry.json", rep.files)

    def test_mode_要的图集不在磁盘上是硬伤(self) -> None:
        """带着这种状态打出去的包进场景必 404、角色照明整份作废——清单生成就得停。"""
        d = self._payload("s1", "background", mode=3, files=("probes_valid.bin", "ground_d.png", "atlas_l2.bin"))
        rep = self.run_real("release")
        self.assertEqual(len(rep.problems), 1, rep.problems)
        self.assertIn("atlas_bin.bin", rep.problems[0])
        self.assertIn(d, rep.problems[0])
        # 同一份载荷从 lighting.json / geometry.json 两个入口各展开一次，问题只记一条
        self._payload("s2", "background", mode=3, files=("probes_valid.bin", "ground_d.png", "geometry.json"))
        rep2 = self.run_real("release")
        self.assertEqual(len(rep2.problems), 2, rep2.problems)

    def test_lighting_json_坏了也是硬伤(self) -> None:
        self._payload("s1", "background", files=("atlas_bin.bin",), meta_json="{not json")
        rep = self.run_real("release")
        self.assertTrue(any("读不出来" in p for p in rep.problems), rep.problems)

    def test_只有几何场入口时也能带出法线与albedo(self) -> None:
        d = self.root / "public" / "resources" / "runtime" / "scenes" / "s1" / "lighting" / "bg"
        d.mkdir(parents=True)
        _write(d / "geometry.json", "{}")
        (d / "normal.png").write_bytes(b"0")
        (d / "albedo.png").write_bytes(b"0")
        # skyvis.png 在开发树里照旧存在（离线烘 albedo 的输入），但**不许进发行包**
        (d / "skyvis.png").write_bytes(b"0")
        rep = self.run_real("release")
        rel = "resources/runtime/scenes/s1/lighting/bg"
        self.assertIn(f"{rel}/geometry.json", rep.files)
        self.assertIn(f"{rel}/normal.png", rep.files)
        self.assertIn(f"{rel}/albedo.png", rep.files)
        self.assertNotIn(f"{rel}/skyvis.png", rep.files)
        self.assertEqual(rep.problems, [])


class RealTreeLightingTests(unittest.TestCase):
    """对着**真实开发树**跑一遍清单：每份载荷按自己的 mode 要读的文件必须全在发行清单里。

    这是"运行时会要什么 → 清单里有没有"那个反向；2026-09-05 之前只有正向比对，
    atlas_bin 就是从这个盲区漏出去的。跑真清单要十几秒，值。
    """

    @classmethod
    def setUpClass(cls) -> None:
        rt = _ROOT / "public" / "resources" / "runtime" / "scenes"
        payloads = list(rt.rglob("lighting.json")) if rt.is_dir() else []
        if not payloads:
            raise unittest.SkipTest("场景运行时目录里没有光照载荷（DVC 没拉）")
        cls.payloads = payloads
        cls.release = build_manifest(_ROOT, target="release")
        cls.dev = build_manifest(_ROOT, target="dev")

    def _dir_rel(self, p: Path) -> str:
        return p.parent.relative_to(_ROOT / "public").as_posix()

    def test_展开器对真实载荷零硬伤(self) -> None:
        self.assertEqual(self.release.problems, [])

    def test_每份真实载荷_发行清单含其_mode_的图集与必读旁挂(self) -> None:
        files = set(self.release.files)
        for meta_path in self.payloads:
            d = self._dir_rel(meta_path)
            meta = json.loads(meta_path.read_text(encoding="utf-8"))
            mode = (meta.get("shading") or {}).get("mode")
            atlas = probe_atlas_file_for_mode(mode)
            self.assertIn(f"{d}/{atlas}", files, f"{d}：shading.mode={mode!r} 要读 {atlas}，发行清单里没有")
            for name in (*LIGHTING_PAYLOAD_CORE, *LIGHTING_GEOMETRY_FILES, *LIGHTING_PAYLOAD_OPTIONAL):
                if (meta_path.parent / name).is_file():
                    self.assertIn(f"{d}/{name}", files, f"{d}/{name} 在磁盘上却没进发行清单")

    def test_发行清单不含体积档_dev_清单含全部图集与体积档(self) -> None:
        rel_files = set(self.release.files)
        dev_files = set(self.dev.files)
        for meta_path in self.payloads:
            d = self._dir_rel(meta_path)
            for name in LIGHTING_PAYLOAD_DEBUG_ONLY:
                self.assertNotIn(f"{d}/{name}", rel_files, f"发行清单不该带 {d}/{name}")
            for name in (*PROBE_ATLAS_FILE_BY_MODE.values(), *LIGHTING_PAYLOAD_DEBUG_ONLY):
                if (meta_path.parent / name).is_file():
                    self.assertIn(f"{d}/{name}", dev_files, f"dev 清单缺 {d}/{name}（F2 切档会静默失败）")


if __name__ == "__main__":
    unittest.main()
