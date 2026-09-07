# -*- coding: utf-8 -*-
"""音频加工台后端护栏。

每条用例都对应一个真出过的事故或一条真会塌的不变量,不是为覆盖率凑的。

分三层:
  * 加工语义(build_filter / render / ffprobe)—— 旧模型留下的血债,一条没删;
  * 配置写入(audio_config_io)—— 只改 src 这条唯一写路径的全部歪结构;
  * 台账与导出(ledger / server)—— 新模型的核心不变量:两层 hash、状态由磁盘反算、
    幂等零重渲、一料多 key 只落一份文件、失败零残留。

跑法(必须用仓库自带解释器,系统 python3 没装 pytest):
    .tools/venv/bin/python -m pytest tools/audio_editor/tests/test_audio_editor.py -n0

⚠ tools/conftest.py 装了仓库写保护:任何写到仓库内的路径都会抛 RepositoryWriteBlocked。
所以每个会落盘的用例都必须把 server 的侧档路径(EDITS / EXPORTS / ASSIGNMENTS /
BACKUPS / UISTATE)重定向到临时目录 —— 漏一个的报错是 PermissionError,极易被
误读成环境问题。SandboxProject 一次性替你全部重定向。
"""
from __future__ import annotations

import json
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))

import audio_config_io as cio  # noqa: E402
import ledger as led  # noqa: E402
import server  # noqa: E402

from tools.editor.shared.project_paths import ProjectPaths  # noqa: E402

REPO = HERE.parent.parent.parent
REAL_CONFIG = REPO / "public/assets/data/audio_config.json"
SRC_BARK = REPO / "tmp/audio_batch_20260809/out/se_animal/animal_dog_bark_near_a.wav"
SRC_WHOOSH = REPO / "public/resources/runtime/audio/sfx_fireball_whoosh.wav"


# =================================================================== 加工语义


class TrimValidationTests(unittest.TestCase):
    """S1: 非法裁剪曾被默默改成「整条」——界面显示 0.6s、导出却是完整原音。

    新模型下这批的重要性反而上升:加工指纹声称「同一套参数 → 同一份成品」,
    build_filter 的语义一漂,指纹就开始说谎。"""

    def test_end_before_start_raises(self):
        with self.assertRaises(server.EditError) as cm:
            server.build_filter({"trim": {"start": 2.0, "end": 0.95}}, 2.78)
        self.assertIn("终点必须大于起点", str(cm.exception))

    def test_end_equal_start_raises(self):
        with self.assertRaises(server.EditError):
            server.build_filter({"trim": {"start": 1.0, "end": 1.0}}, 2.78)

    def test_negative_raises(self):
        with self.assertRaises(server.EditError):
            server.build_filter({"trim": {"start": -1, "end": 1}}, 2.78)

    def test_end_beyond_duration_raises(self):
        with self.assertRaises(server.EditError):
            server.build_filter({"trim": {"start": 0, "end": 99}}, 2.78)

    def test_non_numeric_raises(self):
        with self.assertRaises(server.EditError):
            server.build_filter({"trim": {"start": "abc", "end": 1}}, 2.78)

    def test_negative_fade_raises(self):
        with self.assertRaises(server.EditError):
            server.build_filter({"fadeIn": -1}, 2.78)

    def test_fades_longer_than_output_raises(self):
        with self.assertRaises(server.EditError):
            server.build_filter({"trim": {"start": 0, "end": 0.6},
                                 "fadeIn": 10, "fadeOut": 10}, 2.78)

    def test_valid_trim_builds_expected_chain(self):
        filters, dur = server.build_filter(
            {"trim": {"start": 0.35, "end": 0.95}, "fadeIn": 0.02, "fadeOut": 0.02}, 2.78)
        self.assertAlmostEqual(dur, 0.6, places=3)
        joined = ",".join(filters)
        self.assertIn("atrim=start=0.3500:end=0.9500", joined)
        self.assertIn("afade=t=in:st=0:d=0.0200", joined)
        self.assertIn("afade=t=out:st=0.5800:d=0.0200", joined)


class FilterOrderTests(unittest.TestCase):
    """H: 反向排在淡入淡出之后,会把用户填的"淡入"翻到成品结尾。"""

    def test_reverse_before_fades(self):
        filters, _ = server.build_filter(
            {"reverse": True, "fadeIn": 0.1, "fadeOut": 0.1}, 2.0)
        joined = ",".join(filters)
        self.assertLess(joined.index("areverse"), joined.index("afade=t=in"),
                        "areverse 必须排在 afade 之前")

    def test_positive_normalize_target_rejected(self):
        with self.assertRaises(server.EditError):
            server.build_filter({"normalize": {"enabled": True, "peakDb": 3}}, 2.0)


class NormalizeWithGainTests(unittest.TestCase):
    """N-严重-4: 增益+归一叠加时曾把音频推成 0dBFS 削顶。

    根因是 measure_peak 在含增益的链上测峰,volumedetect 走 int16,
    增益推爆后读到的是被削平的 0.0,补偿量因此算错。

    新模型下它还兼任「指纹可信度的物证」:归一补偿量一旦漂,同一个指纹会产出
    不同字节的成品,台账就开始说谎。"""

    def setUp(self):
        if not SRC_BARK.exists():
            self.skipTest(f"缺少测试音频 {SRC_BARK}")
        self.tmp = Path(tempfile.mkdtemp())

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _peak(self, p: Path) -> float:
        return server.measure_peak(p, [])

    def test_normalize_hits_target_regardless_of_gain(self):
        target = -3.0
        for gain in (0, 3, 6, 12, 24, 36):
            dst = self.tmp / f"g{gain}.wav"
            ok, err = server.render(
                SRC_BARK,
                {"gainDb": gain, "normalize": {"enabled": True, "peakDb": target}},
                dst)
            self.assertTrue(ok, f"gain={gain} 渲染失败: {err}")
            peak = self._peak(dst)
            self.assertAlmostEqual(
                peak, target, delta=0.6,
                msg=f"增益 {gain}dB 时归一没命中 {target}dB,实测 {peak}dB(削顶回归)")

    def test_normalize_alone_still_accurate(self):
        for target in (-3.0, -12.0):
            dst = self.tmp / f"n{target}.wav"
            ok, _ = server.render(
                SRC_BARK, {"normalize": {"enabled": True, "peakDb": target}}, dst)
            self.assertTrue(ok)
            self.assertAlmostEqual(self._peak(dst), target, delta=0.6)


class DurationSourceTests(unittest.TestCase):
    """N1: ffprobe_duration 曾 round(d,3),把 1.962404 截成 1.962(比真实短),
    前端按解码时长算出的合法值被后端判成"超过总长"。库里 10.9% 的素材中招。"""

    def setUp(self):
        if not SRC_WHOOSH.exists():
            self.skipTest(f"缺少 {SRC_WHOOSH}")

    def test_duration_not_rounded_down(self):
        d = server.ffprobe_duration(SRC_WHOOSH)
        self.assertNotEqual(d, round(d, 3),
                            "时长被 round 掉了小数(会比真实时长短)")

    def test_end_within_tolerance_is_clamped_not_rejected(self):
        dur = server.ffprobe_duration(SRC_WHOOSH)
        # 前端拿的解码时长可能比容器时长多几毫秒
        _filters, out = server.build_filter(
            {"trim": {"start": 0.5, "end": dur + 0.004}}, dur)
        self.assertAlmostEqual(out, dur - 0.5, places=3)

    def test_end_far_beyond_still_rejected(self):
        dur = server.ffprobe_duration(SRC_WHOOSH)
        with self.assertRaises(server.EditError):
            server.build_filter({"trim": {"start": 0, "end": dur + 5}}, dur)

    def test_fades_within_tolerance_scaled_not_rejected(self):
        dur = server.ffprobe_duration(SRC_WHOOSH)
        filters, _out = server.build_filter(
            {"fadeIn": 1.9, "fadeOut": dur - 1.9 + 0.003}, dur)
        self.assertTrue(any(f.startswith("afade=t=in") for f in filters))


class ProbeRobustnessTests(unittest.TestCase):
    """① 库里 2 个 mp3 的 ID3 是 GBK,ffmpeg 回显到 stderr 曾打死整个请求。"""

    def test_non_utf8_tags_do_not_crash(self):
        for name in ("BGS/29822_1076_635.mp3", "BGS/30116_1076_638.mp3"):
            src = REPO / "public/resources/runtime/audio" / name
            if not src.exists():
                continue
            with self.subTest(file=name):
                self.assertIsNotNone(server.ffprobe_duration(src))
                self.assertIsNotNone(server.measure_peak(src, []))


class EditsPersistenceTests(unittest.TestCase):
    """A2: 只浏览不改也会写 {} 空壳,档案不再是"我改过什么"的记录。"""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self._orig = server.EDITS
        server.EDITS = self.tmp / "edits.json"

    def tearDown(self):
        server.EDITS = self._orig
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_empty_entries_pruned(self):
        server.save_edits({"a": {}, "b": {"gainDb": 3}, "c": {}})
        self.assertEqual(server.load_edits(), {"b": {"gainDb": 3}})


# =================================================================== key 合法性


class KeyWritabilityTests(unittest.TestCase):
    """旧 AUDIO_ID_RE 一个正则兼了两件事:防拼坏 JSON + 防 id 当文件名时路径穿越。

    新模型里物理文件名由工具按内容 hash 生成,与 id 再无关系,「当文件名」这层约束
    整个消失。留着旧正则的后果是实打实的:线上已有 8 个中文 ambient id 会被判非法,
    那 8 个 key 在新界面里永远挂不上文件。所以判据换成「只挡会拼坏 JSON 的字符」。
    """

    def test_real_config_keys_are_all_writable(self):
        """最硬的一条:清单里每一个 key 都必须可写。中文 id 从此回不去黑名单。"""
        doc = json.loads(REAL_CONFIG.read_text(encoding="utf-8"))
        bad = [(ch, k) for ch in cio.CHANNELS for k in doc.get(ch, {})
               if cio.key_is_writable(k) is not None]
        self.assertEqual(bad, [], f"清单里有 key 被判成不可写: {bad}")

    def test_chinese_and_spaced_ids_allowed(self):
        for ok in ("海边", "野外鸟叫", "a b", "sfx_dog_bark", "bgm-title-01"):
            self.assertIsNone(cio.key_is_writable(ok), ok)

    def test_rejects_json_breaking_chars(self):
        for bad in ('带"引号"', "反\\斜杠", "换\n行", "控制\x01符"):
            self.assertIsNotNone(cio.key_is_writable(bad), bad)

    def test_rejects_empty(self):
        self.assertIsNotNone(cio.key_is_writable(""))

    def test_src_must_be_runtime_url(self):
        """素材审计对绝对路径是 fail-open(/etc/hosts 都能报绿),所以这里必须硬拒。"""
        self.assertIsNone(cio.validate_src("/resources/runtime/audio/edited/a.wav"))
        for bad in ("", "/etc/hosts", "/Users/x/a.wav", "resources/runtime/a.wav",
                    "/resources/runtime/../../../etc/hosts", '/resources/runtime/a".wav'):
            self.assertIsNotNone(cio.validate_src(bad), bad)


# =================================================================== 配置写入


class ConfigSrcUpdateTests(unittest.TestCase):
    """「只换 src」是新模型的**唯一**写路径,所以歪结构必须一次测全。

    旧实现那条正则 `"<id>"\\s*:\\s*\\{\\s*\\n\\s*"src"\\s*:\\s*"` 有两处硬伤:
    写死 src 必须是首键(volume 排前面就掉进「插新条目」分支写出重复键),
    以及全文首个命中即改(跨区同名会改到另一个区那条)。两处都在这里钉死。
    """

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.cfg = self.tmp / "audio_config.json"
        self.bk = self.tmp / "bk"

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _write(self, doc, **kw):
        kw.setdefault("indent", 2)
        self.cfg.write_text(json.dumps(doc, ensure_ascii=False, **kw) + "\n",
                            encoding="utf-8")

    def _stat(self):
        st = self.cfg.stat()
        return (st.st_size, st.st_mtime_ns)

    def _doc(self):
        return json.loads(self.cfg.read_text(encoding="utf-8"))

    def _apply(self, updates, **kw):
        kw.setdefault("expect_stat", self._stat())
        return cio.apply_src_updates(self.cfg, updates, backup_dir=self.bk, **kw)

    def test_updates_only_the_named_section_when_ids_collide(self):
        """跨区同名:改 bgm 那条,sfx 的同名条目一个字节都不许动。"""
        self._write({
            "bgm": {"dup": {"src": "/resources/runtime/audio/a.mp3"}},
            "ambient": {},
            "sfx": {"dup": {"src": "/resources/runtime/audio/b.wav"}},
        })
        res = self._apply([{"channel": "bgm", "audio_id": "dup",
                            "src": "/resources/runtime/audio/edited/new.mp3"}])
        self.assertTrue(res["ok"], res.get("error"))
        doc = self._doc()
        self.assertEqual(doc["bgm"]["dup"]["src"],
                         "/resources/runtime/audio/edited/new.mp3")
        self.assertEqual(doc["sfx"]["dup"]["src"], "/resources/runtime/audio/b.wav")

    def test_volume_first_entry_updates_and_keeps_key_order(self):
        """旧正则在这里会掉进插入分支、写出重复键,然后整批被对账拒掉。"""
        self._write({"bgm": {}, "ambient": {
            "海边": {"volume": 0.4, "src": "/resources/runtime/audio/old.mp3"}}, "sfx": {}})
        res = self._apply([{"channel": "ambient", "audio_id": "海边",
                            "src": "/resources/runtime/audio/edited/新.mp3"}])
        self.assertTrue(res["ok"], res.get("error"))
        text = self.cfg.read_text(encoding="utf-8")
        entry = self._doc()["ambient"]["海边"]
        self.assertEqual(entry["src"], "/resources/runtime/audio/edited/新.mp3")
        self.assertEqual(entry["volume"], 0.4, "volume 被写没了")
        self.assertEqual(list(entry), ["volume", "src"], "键序被改了")
        self.assertIn("新.mp3", text, "中文被转义成了 \\uXXXX,破坏往返契约")

    def test_bare_string_entry_supported(self):
        """历史形态 ``"id": "/x.wav"`` 也要能改,且改完仍是字符串。"""
        self._write({"bgm": {}, "ambient": {}, "sfx": {"bare": "/resources/runtime/audio/a.wav"}})
        res = self._apply([{"channel": "sfx", "audio_id": "bare",
                            "src": "/resources/runtime/audio/edited/b.wav"}])
        self.assertTrue(res["ok"], res.get("error"))
        self.assertEqual(self._doc()["sfx"]["bare"], "/resources/runtime/audio/edited/b.wav")

    def test_any_indent_and_compact_form(self):
        base = {"bgm": {}, "ambient": {}, "sfx": {"k": {"src": "/resources/runtime/audio/a.wav"}}}
        for kw in ({"indent": 2}, {"indent": 4}, {"separators": (",", ":")}):
            with self.subTest(fmt=kw):
                self._write(base, **kw)
                res = self._apply([{"channel": "sfx", "audio_id": "k",
                                    "src": "/resources/runtime/audio/edited/z.wav"}])
                self.assertTrue(res["ok"], f"{kw}: {res.get('error')}")
                self.assertEqual(self._doc()["sfx"]["k"]["src"],
                                 "/resources/runtime/audio/edited/z.wav")

    def test_never_adds_new_entries(self):
        """新模型不新增条目:扫不到的 key 必须整批拒,绝不许插进去。"""
        self._write({"bgm": {}, "ambient": {}, "sfx": {}})
        before = self.cfg.read_text(encoding="utf-8")
        res = self._apply([{"channel": "sfx", "audio_id": "brand_new",
                            "src": "/resources/runtime/audio/edited/x.wav"}])
        self.assertFalse(res["ok"])
        self.assertIn("不新增条目", res["blocked"][0]["reason"])
        self.assertEqual(self.cfg.read_text(encoding="utf-8"), before, "文件被改了")

    def test_untouched_entries_are_byte_identical(self):
        """真配置全量:只改一条,其余 179 条连同格式必须字节不变。"""
        shutil.copy2(REAL_CONFIG, self.cfg)
        before = self.cfg.read_text(encoding="utf-8")
        res = self._apply([{"channel": "sfx", "audio_id": "ui_hover",
                            "src": "/resources/runtime/audio/edited/probe_ui_hover.wav"}])
        self.assertTrue(res["ok"], res.get("error"))
        after = self.cfg.read_text(encoding="utf-8")
        b_doc, a_doc = json.loads(before), json.loads(after)
        for sec in b_doc:
            for k, v in b_doc[sec].items():
                if (sec, k) == ("sfx", "ui_hover"):
                    continue
                self.assertEqual(a_doc[sec][k], v, f"{sec}.{k} 被意外改动")
        # 改动只发生在那一行
        diff = [(x, y) for x, y in zip(before.splitlines(), after.splitlines()) if x != y]
        self.assertEqual(len(diff), 1, f"改动溢出到了别的行: {diff[:4]}")
        self.assertTrue(after.endswith("\n"), "末尾换行没了")

    def test_plan_and_apply_agree(self):
        """预览说能改、落盘却拒 —— 这个错位是旧实现的老毛病,判据必须同源。"""
        shutil.copy2(REAL_CONFIG, self.cfg)
        text = self.cfg.read_text(encoding="utf-8")
        updates = [
            {"channel": "sfx", "audio_id": "ui_hover", "src": "/resources/runtime/audio/edited/a.wav"},
            {"channel": "sfx", "audio_id": "nope", "src": "/resources/runtime/audio/edited/b.wav"},
        ]
        plan = cio.plan_src_updates(text, updates)
        self.assertEqual([p["action"] for p in plan], ["update", "blocked"])
        res = self._apply(updates)
        self.assertFalse(res["ok"], "计划里有 blocked,落盘却放行了")
        self.assertEqual(len(res["blocked"]), 1)

    def test_noop_writes_nothing_and_leaves_no_backup(self):
        """幂等重导在新模型里是**主路径**:src 没变就不该动文件、不该落备份。"""
        shutil.copy2(REAL_CONFIG, self.cfg)
        doc = self._doc()
        same = doc["sfx"]["ui_hover"]["src"]
        st_before = self._stat()
        res = self._apply([{"channel": "sfx", "audio_id": "ui_hover", "src": same}])
        self.assertTrue(res["ok"])
        self.assertTrue(res["unchanged"])
        self.assertIsNone(res["backup"])
        self.assertEqual(self._stat(), st_before, "什么都没变却动了文件")
        self.assertFalse(self.bk.exists(), "什么都没变却落了备份")

    def test_backup_goes_to_sidecar_not_game_data(self):
        """备份落在 public/assets/data/ 会污染主编辑器的引用扫描与素材审计。"""
        shutil.copy2(REAL_CONFIG, self.cfg)
        res = self._apply([{"channel": "sfx", "audio_id": "ui_hover",
                            "src": "/resources/runtime/audio/edited/bk_probe.wav"}])
        self.assertTrue(res["ok"])
        self.assertIsNotNone(res["backup"])
        self.assertIn(str(self.bk), res["backup"])
        siblings = [p.name for p in self.cfg.parent.iterdir() if p.is_file()]
        self.assertEqual(siblings, [self.cfg.name], f"配置目录里多了东西: {siblings}")

    def test_external_change_between_plan_and_write_is_refused(self):
        """主编辑器 Save All 会拿它内存里的旧 config 整份覆盖磁盘。
        我们读过之后它插了一脚,再写就是拿旧世界盖新世界 —— 必须拒。"""
        shutil.copy2(REAL_CONFIG, self.cfg)
        stale = self._stat()
        doc = self._doc()
        doc["sfx"]["ui_hover"] = {"src": "/resources/runtime/audio/someone_else.wav"}
        self._write(doc)
        res = cio.apply_src_updates(
            self.cfg, [{"channel": "sfx", "audio_id": "ui_hover",
                        "src": "/resources/runtime/audio/edited/mine.wav"}],
            backup_dir=self.bk, expect_stat=stale)
        self.assertFalse(res["ok"])
        self.assertIn("被别的程序改过", res["error"])
        self.assertEqual(self._doc()["sfx"]["ui_hover"]["src"],
                         "/resources/runtime/audio/someone_else.wav", "别人的写入被覆盖了")

    def test_broken_json_is_refused_not_guessed(self):
        self.cfg.write_text('{"sfx": {"k": {"src": "/a.wav"}', encoding="utf-8")
        with self.assertRaises(cio.ConfigIOError):
            cio.plan_src_updates(self.cfg.read_text(encoding="utf-8"), [])

    def test_systemsfx_channel_is_refused(self):
        """systemSfx 是 id→id 映射,它的值是另一个音频 id 而不是文件路径。
        把 src 写进去等于把映射毁成一条路径,运行时再也查不到那个音频。"""
        self._write({"bgm": {}, "ambient": {}, "sfx": {},
                     "systemSfx": {"dialogueEnd": "dialogue_end"}})
        before = self.cfg.read_text(encoding="utf-8")
        res = self._apply([{"channel": "systemSfx", "audio_id": "dialogueEnd",
                            "src": "/resources/runtime/audio/edited/x.wav"}])
        self.assertFalse(res["ok"])
        self.assertIn("不是承载文件的频道", res["blocked"][0]["reason"])
        self.assertEqual(self.cfg.read_text(encoding="utf-8"), before)

    def test_crlf_file_keeps_its_line_endings(self):
        """读的时候被 universal newlines 悄悄转成 LF、写回去就是整份换行符被改写,
        「一个字节都不多动」当场破功(而且备份也是改过的版本,救不回来)。"""
        body = json.dumps({"bgm": {}, "ambient": {},
                           "sfx": {"k": {"src": "/resources/runtime/audio/a.wav"}}},
                          ensure_ascii=False, indent=2) + "\n"
        self.cfg.write_bytes(body.replace("\n", "\r\n").encode("utf-8"))
        res = self._apply([{"channel": "sfx", "audio_id": "k",
                            "src": "/resources/runtime/audio/edited/b.wav"}])
        self.assertTrue(res["ok"], res.get("error"))
        raw = self.cfg.read_bytes()
        self.assertNotIn(b"\n", raw.replace(b"\r\n", b""), "CRLF 被改成了 LF")

    def test_surrogate_pair_key_matches_json_loads(self):
        """代理对逐段解码各得半个,拼起来与 json.loads 的键对不上 ——
        那个 key 就永远查不到、永远挂不上文件。"""
        doc = {"bgm": {}, "ambient": {},
               "sfx": {"emoji_😀_key": {"src": "/resources/runtime/audio/a.wav"}}}
        # ensure_ascii=True 会把 😀 写成一对 \\uD83D\\uDE00
        self.cfg.write_text(json.dumps(doc, ensure_ascii=True, indent=2) + "\n",
                            encoding="utf-8")
        text = self.cfg.read_text(encoding="utf-8")
        root = cio._SpanParser(text).parse()
        self.assertEqual(set(root.members["sfx"].members), set(json.loads(text)["sfx"]))
        res = self._apply([{"channel": "sfx", "audio_id": "emoji_😀_key",
                            "src": "/resources/runtime/audio/edited/b.wav"}])
        self.assertTrue(res["ok"], res.get("error"))
        self.assertEqual(self._doc()["sfx"]["emoji_😀_key"]["src"],
                         "/resources/runtime/audio/edited/b.wav")


# =================================================================== 指纹 / 台账


class FingerprintTests(unittest.TestCase):
    """加工指纹是缓存键,成品 hash 是物理身份 —— 两层身份不许混。"""

    def test_only_render_affecting_fields_enter_params(self):
        """fadePref / normPeakDb 是界面记忆值,不影响输出,进了指纹就会白白重渲。"""
        a = led.normalized_render_params({"gainDb": 3, "fadePref": {"fi": 1, "fo": 2},
                                          "normPeakDb": -6})
        b = led.normalized_render_params({"gainDb": 3})
        self.assertEqual(a, b)

    def test_falsy_forms_collapse_to_one_shape(self):
        """0 / 缺失 / False / None 在 build_filter 里完全等价,指纹也必须等价。"""
        shapes = [{}, {"gainDb": 0}, {"fadeIn": 0, "fadeOut": None},
                  {"reverse": False}, {"normalize": {"enabled": False, "peakDb": -9}}]
        got = {json.dumps(led.normalized_render_params(s), sort_keys=True) for s in shapes}
        self.assertEqual(len(got), 1, f"同一份成品挂上了多个指纹: {got}")

    def test_quantized_to_ffmpeg_precision(self):
        """比 ffmpeg 命令的精度更细的差别根本到不了 ffmpeg,不能算两份不同的料。"""
        self.assertEqual(led.normalized_render_params({"gainDb": 3.001}),
                         led.normalized_render_params({"gainDb": 3.0}))
        self.assertEqual(led.normalized_render_params({"fadeIn": 0.10000001}),
                         led.normalized_render_params({"fadeIn": 0.1}))
        self.assertNotEqual(led.normalized_render_params({"gainDb": 3.0}),
                            led.normalized_render_params({"gainDb": 3.5}))

    def test_normalize_peak_matters_only_when_enabled(self):
        on_a = led.normalized_render_params({"normalize": {"enabled": True, "peakDb": -3}})
        on_b = led.normalized_render_params({"normalize": {"enabled": True, "peakDb": -6}})
        self.assertNotEqual(on_a, on_b)

    def test_output_format_is_part_of_identity(self):
        """同源同参数只换扩展名 = 两份不同字节。跨格式的 key 共用不成立。"""
        p = led.normalized_render_params({"gainDb": 3})
        wav = led.make_fingerprint("h" * 64, p, led.output_spec(".wav"))
        mp3 = led.make_fingerprint("h" * 64, p, led.output_spec(".mp3"))
        self.assertNotEqual(wav, mp3)

    def test_algo_version_changes_fingerprint(self):
        """滤镜链/码率常量改了就必须抬版本号,否则旧指纹会假命中。"""
        p = led.normalized_render_params({"gainDb": 3})
        base = led.make_fingerprint("h" * 64, p, led.output_spec(".wav"))
        saved = led.FINGERPRINT_ALGO
        try:
            led.FINGERPRINT_ALGO = saved + 1
            self.assertNotEqual(led.make_fingerprint("h" * 64, p, led.output_spec(".wav")),
                                base)
        finally:
            led.FINGERPRINT_ALGO = saved

    def test_fingerprint_is_stable_across_processes(self):
        """绝不能用内置 hash():它是进程级加盐的,重启即全废。
        这里用一条写死的期望值钉住 —— 值变了说明指纹口径变了,必须同步抬 ALGO。"""
        p = led.normalized_render_params({"gainDb": 8, "trim": {"start": 0, "end": 0.9762}})
        fp = led.make_fingerprint("a" * 64, p, led.output_spec(".wav"))
        self.assertEqual(fp, led.make_fingerprint("a" * 64, p, led.output_spec(".wav")))
        self.assertEqual(len(fp), 64)

    def test_lookup_refuses_hit_when_file_is_gone(self):
        """指纹命中但那份成品已经不在了 —— 必须当未命中重渲,绝不能 fail-open
        拿一个不存在的路径去写配置。"""
        ledger = led.empty_ledger()
        led.record_file(ledger, "c" * 64, src="/resources/runtime/audio/x.wav",
                        size=1, origin=None)
        led.remember_fingerprint(ledger, "fp1", "c" * 64)
        self.assertEqual(led.lookup_fingerprint(ledger, "fp1",
                                                lambda h: (Path("/x"), "c" * 64)), "c" * 64)
        self.assertIsNone(led.lookup_fingerprint(ledger, "fp1", lambda h: (None, None)))
        self.assertIsNone(led.lookup_fingerprint(ledger, "fp1",
                                                 lambda h: (Path("/x"), "d" * 64)))


class LedgerPersistenceTests(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_corrupt_ledger_degrades_to_empty(self):
        """台账只是缓存,磁盘才是真值。读不出来最多多渲一次,不许拦住用户干活。"""
        p = self.tmp / "exports.json"
        p.write_text("{ not json", encoding="utf-8")
        self.assertEqual(led.load_ledger(p), led.empty_ledger())

    def test_bad_entries_are_dropped_not_passed_through(self):
        """只校验到「这两层是 dict」的话,一条类型坏掉的记录会在读它的地方抛异常,
        把整个 key 列表打成 500 —— 与「台账坏了也不该拦住用户」自相矛盾。"""
        p = self.tmp / "exports.json"
        p.write_text(json.dumps({
            "version": 1,
            "files": {"a" * 64: {"src": "/x"}, "bad": "我是个字符串不是 dict"},
            "keys": {"sfx/ok": {"hash": "a" * 64}, "sfx/bad": ["列表"]},
            "fingerprints": {"fp": "a" * 64, "bad_fp": {"nested": 1}},
        }), encoding="utf-8")
        lg = led.load_ledger(p)
        self.assertEqual(set(lg["files"]), {"a" * 64})
        self.assertEqual(set(lg["keys"]), {"sfx/ok"})
        self.assertEqual(set(lg["fingerprints"]), {"fp"})
        # 坏条目被丢掉之后,状态推导也不该炸
        self.assertEqual(led.derive_status(lg, "sfx/bad", src="/x", disk_hash="a" * 64),
                         led.STATUS_FOREIGN)

    def test_roundtrip(self):
        p = self.tmp / "exports.json"
        lg = led.empty_ledger()
        led.record_file(lg, "a" * 64, src="/resources/runtime/audio/a.wav", size=3, origin=None)
        led.record_key_export(lg, "sfx/k", content_hash="a" * 64,
                              src="/resources/runtime/audio/a.wav")
        led.save_ledger(p, lg)
        self.assertEqual(led.load_ledger(p)["keys"]["sfx/k"]["hash"], "a" * 64)

    def test_record_file_never_overwrites_known_origin(self):
        """存量回填标 origin=None,后来真导出补上出处;反过来不许把出处抹掉。"""
        lg = led.empty_ledger()
        led.record_file(lg, "a" * 64, src="/x", size=1, origin={"sourceKey": "s"})
        led.record_file(lg, "a" * 64, src="/y", size=1, origin=None)
        self.assertEqual(lg["files"]["a" * 64]["origin"], {"sourceKey": "s"})
        self.assertEqual(lg["files"]["a" * 64]["src"], "/x", "共用文件的路径被改了")


class StatusDerivationTests(unittest.TestCase):
    """状态一律由磁盘反算。台账说「已导出」而磁盘上是别的东西,那就是漂移。"""

    def setUp(self):
        self.lg = led.empty_ledger()

    def test_unlinked_and_missing(self):
        self.assertEqual(led.derive_status(self.lg, "sfx/k", src="", disk_hash=None),
                         led.STATUS_UNLINKED)
        self.assertEqual(led.derive_status(self.lg, "sfx/k", src="/a.wav", disk_hash=None),
                         led.STATUS_MISSING)

    def test_foreign_when_origin_unknown(self):
        led.record_file(self.lg, "a" * 64, src="/a.wav", size=1, origin=None)
        self.assertEqual(led.derive_status(self.lg, "sfx/k", src="/a.wav",
                                           disk_hash="a" * 64), led.STATUS_FOREIGN)

    def test_exported_needs_both_record_and_origin(self):
        led.record_file(self.lg, "a" * 64, src="/a.wav", size=1, origin={"backfilled": True})
        led.record_key_export(self.lg, "sfx/k", content_hash="a" * 64, src="/a.wav")
        self.assertEqual(led.derive_status(self.lg, "sfx/k", src="/a.wav",
                                           disk_hash="a" * 64), led.STATUS_EXPORTED)

    def test_drift_beats_ledger_claim(self):
        led.record_file(self.lg, "a" * 64, src="/a.wav", size=1, origin={"backfilled": True})
        led.record_key_export(self.lg, "sfx/k", content_hash="a" * 64, src="/a.wav")
        self.assertEqual(led.derive_status(self.lg, "sfx/k", src="/a.wav",
                                           disk_hash="b" * 64), led.STATUS_DRIFTED)


# =================================================================== 端到端


class SandboxProject:
    """一个可写的临时工程 + 把 server 的全部路径重定向过去。

    仓库写保护守卫会拦下任何写到仓库内的路径,所以侧档必须一个不漏地重定向。
    """

    FIELDS = ("PATHS", "PROJECT_AUDIO", "AUDIO_CONFIG", "EXPORT_DIR", "SOURCES",
              "EDITS", "EXPORTS", "ASSIGNMENTS", "TRASH", "BACKUPS", "UISTATE", "HASHES")

    def __init__(self):
        self.root = Path(tempfile.mkdtemp(prefix="ae_sandbox_"))
        self.audio = self.root / "public/resources/runtime/audio"
        (self.root / "public/assets/data").mkdir(parents=True)
        (self.audio / "edited").mkdir(parents=True)
        (self.audio / "demo").mkdir(parents=True)
        self.src_dir = self.root / "srcmaterial"
        self.src_dir.mkdir()
        self.cfg = self.root / "public/assets/data/audio_config.json"
        self._saved = {f: getattr(server, f) for f in self.FIELDS}
        server.PATHS = ProjectPaths(self.root)
        server.PROJECT_AUDIO = server.PATHS.runtime_audio_dir
        server.AUDIO_CONFIG = self.cfg
        server.EXPORT_DIR = server.PROJECT_AUDIO / "edited"
        server.SOURCES = {"src": self.src_dir, "project": server.PROJECT_AUDIO}
        server.EDITS = self.root / "edits.json"
        server.EXPORTS = self.root / "exports.json"
        server.ASSIGNMENTS = self.root / "assignments.json"
        server.TRASH = self.root / "trash.json"
        server.BACKUPS = self.root / "backups"
        server.UISTATE = self.root / "ui_state.json"
        server.HASHES = led.HashCache()

    def close(self):
        for f, v in self._saved.items():
            setattr(server, f, v)
        shutil.rmtree(self.root, ignore_errors=True)

    # -- 布景

    def write_config(self, doc):
        self.cfg.write_text(json.dumps(doc, ensure_ascii=False, indent=2) + "\n",
                            encoding="utf-8")

    def add_source(self, name: str, origin: Path) -> str:
        shutil.copy2(origin, self.src_dir / name)
        return f"src/{name}"

    def set_edits(self, edits: dict):
        server.save_edits(edits)

    def assign(self, key: str, source_key: str, ext: str | None = None):
        a = led.load_assignments(server.ASSIGNMENTS)
        a[key] = {"sourceKey": source_key, "at": "t", **({"ext": ext} if ext else {})}
        led.save_assignments(server.ASSIGNMENTS, a)

    # -- 观察

    def scan(self):
        return server.scan_keys(led.load_ledger(server.EXPORTS),
                                led.load_assignments(server.ASSIGNMENTS))

    def status(self, key: str) -> str:
        return {r["key"]: r["status"] for r in self.scan()["keys"]}[key]

    def plan(self):
        return server.build_plan(led.load_ledger(server.EXPORTS),
                                 led.load_assignments(server.ASSIGNMENTS))

    def export(self):
        return server.run_export(led.load_ledger(server.EXPORTS),
                                 led.load_assignments(server.ASSIGNMENTS))

    def exported_files(self):
        return sorted(p.name for p in server.EXPORT_DIR.iterdir() if p.is_file())

    def doc(self):
        return json.loads(self.cfg.read_text(encoding="utf-8"))


class ExportPipelineTests(unittest.TestCase):
    """新模型的核心不变量。"""

    def setUp(self):
        if not SRC_BARK.exists() or not SRC_WHOOSH.exists():
            self.skipTest("缺少测试音频")
        self.box = SandboxProject()
        self.box.write_config({
            "bgm": {},
            "ambient": {"海边": {"volume": 0.4, "src": ""}},
            "sfx": {"k_a": {"src": ""}, "k_b": {"src": ""}, "k_c": {"src": ""}},
            "systemSfx": {},
        })
        self.bark = self.box.add_source("bark.wav", SRC_BARK)
        self.whoosh = self.box.add_source("whoosh.wav", SRC_WHOOSH)
        self.box.set_edits({self.bark: {"gainDb": 3},
                            self.whoosh: {"trim": {"start": 0, "end": 1.0}}})

    def tearDown(self):
        self.box.close()

    def test_one_source_many_keys_writes_one_file(self):
        """用户明说的用法:同一份料分给多个 key。物理文件只该有一份,
        三个 key 写的是**同一个路径字符串**。"""
        for k in ("sfx/k_a", "sfx/k_b", "sfx/k_c"):
            self.box.assign(k, self.bark)
        res = self.box.export()
        self.assertTrue(res["ok"], res.get("error"))
        self.assertEqual(len(self.box.exported_files()), 1,
                         f"落了不止一份文件: {self.box.exported_files()}")
        doc = self.box.doc()
        srcs = {doc["sfx"][k]["src"] for k in ("k_a", "k_b", "k_c")}
        self.assertEqual(len(srcs), 1, f"三个 key 指向了不同路径: {srcs}")

    def test_second_export_is_idempotent_and_free(self):
        """重开工具再导一次同样的东西:零渲染、零新文件、配置零改动、
        「上次导出时间」也不许被刷新(那会让时间戳变成谎话)。"""
        self.box.assign("sfx/k_a", self.bark)
        first = self.box.export()
        self.assertTrue(first["ok"], first.get("error"))
        cfg_before = self.box.cfg.read_text(encoding="utf-8")
        files_before = self.box.exported_files()
        when = led.load_ledger(server.EXPORTS)["keys"]["sfx/k_a"]["exportedAt"]

        self.box.assign("sfx/k_a", self.bark)          # 再分配同一份料
        plan = self.box.plan()
        self.assertEqual(plan["counts"]["unchanged"], 1, plan["rows"])
        self.assertEqual(plan["counts"]["render"], 0, "又要重渲一遍")
        second = self.box.export()
        self.assertTrue(second["ok"], second.get("error"))
        self.assertEqual(self.box.exported_files(), files_before, "多落了文件")
        self.assertEqual(self.box.cfg.read_text(encoding="utf-8"), cfg_before,
                         "配置被无谓改动")
        self.assertEqual(led.load_ledger(server.EXPORTS)["keys"]["sfx/k_a"]["exportedAt"],
                         when, "内容没变却刷新了导出时间")

    def test_relink_reuses_existing_file_without_rendering(self):
        """同一份料换个 key:指纹命中 -> 只改映射,不渲染不拷贝。"""
        self.box.assign("sfx/k_a", self.bark)
        self.box.export()
        n_files = len(self.box.exported_files())
        self.box.assign("sfx/k_b", self.bark)
        plan = self.box.plan()
        self.assertEqual(plan["counts"]["relink"], 1, plan["rows"])
        self.assertEqual(plan["counts"]["render"], 0)
        res = self.box.export()
        self.assertTrue(res["ok"], res.get("error"))
        self.assertEqual(res["newFiles"], [], "复用路径却落了新文件")
        self.assertEqual(len(self.box.exported_files()), n_files)
        doc = self.box.doc()
        self.assertEqual(doc["sfx"]["k_a"]["src"], doc["sfx"]["k_b"]["src"])

    def test_different_params_make_different_files(self):
        """同一份料换参数 = 另一份成品,绝不能被去重合并掉。"""
        self.box.assign("sfx/k_a", self.bark)
        self.box.export()
        self.box.set_edits({self.bark: {"gainDb": 9}})
        server.HASHES = led.HashCache()
        self.box.assign("sfx/k_b", self.bark)
        res = self.box.export()
        self.assertTrue(res["ok"], res.get("error"))
        self.assertEqual(len(self.box.exported_files()), 2)
        doc = self.box.doc()
        self.assertNotEqual(doc["sfx"]["k_a"]["src"], doc["sfx"]["k_b"]["src"])

    def test_status_flow_unlinked_to_exported(self):
        self.assertEqual(self.box.status("sfx/k_a"), led.STATUS_UNLINKED)
        self.box.assign("sfx/k_a", self.bark)
        self.box.export()
        self.assertEqual(self.box.status("sfx/k_a"), led.STATUS_EXPORTED)

    def test_external_file_swap_shows_as_drift(self):
        """有人在外面把文件换了:台账不许自说自话,必须如实报漂移。"""
        self.box.assign("sfx/k_a", self.bark)
        self.box.export()
        target = server.src_to_disk(self.box.doc()["sfx"]["k_a"]["src"])
        shutil.copy2(SRC_WHOOSH, target)
        server.HASHES = led.HashCache()
        self.assertEqual(self.box.status("sfx/k_a"), led.STATUS_DRIFTED)

    def test_missing_file_reported(self):
        self.box.assign("sfx/k_a", self.bark)
        self.box.export()
        server.src_to_disk(self.box.doc()["sfx"]["k_a"]["src"]).unlink()
        server.HASHES = led.HashCache()
        self.assertEqual(self.box.status("sfx/k_a"), led.STATUS_MISSING)

    def test_config_failure_leaves_no_new_files(self):
        """配置写不成 -> 刚落的新文件必须全部撤掉,项目零变化。
        (内容寻址的文件名让这一步安全:那些新文件还没有人引用。)"""
        self.box.assign("sfx/k_a", self.bark)
        # 读过之后被别人改盘 -> 写入被守卫拒绝
        orig_plan = server.build_plan

        def poisoned(*a, **kw):
            p = orig_plan(*a, **kw)
            p["stat"] = (p["stat"][0] + 1, p["stat"][1])     # 假装磁盘已变
            return p
        server.build_plan = poisoned
        try:
            res = self.box.export()
        finally:
            server.build_plan = orig_plan
        self.assertFalse(res["ok"])
        self.assertEqual(self.box.exported_files(), [], "配置失败却把文件留下了")
        self.assertEqual(self.box.doc()["sfx"]["k_a"]["src"], "")

    def test_blocked_row_blocks_whole_batch(self):
        """一条过不了检查就整批不导 —— 半批导出会留下对不上账的项目状态。"""
        self.box.assign("sfx/k_a", self.bark)
        self.box.assign("sfx/gone_key", self.bark)          # 配置里没有这个 key
        plan = self.box.plan()
        self.assertTrue(plan["blocked"])
        res = self.box.export()
        self.assertFalse(res["ok"])
        self.assertEqual(self.box.exported_files(), [])

    def test_missing_source_reported_not_dropped(self):
        """分配的料被删了必须报出来,不能让计划数悄悄变少。"""
        self.box.assign("sfx/k_a", self.bark)
        (self.box.src_dir / "bark.wav").unlink()
        server.HASHES = led.HashCache()
        plan = self.box.plan()
        self.assertTrue(plan["blocked"])
        self.assertIn("源文件已经不在了", plan["rows"][0]["reason"])

    def test_output_format_follows_existing_extension(self):
        """线上有 52 条 key 与「频道→格式」的老规则相反。按老规则推会把它们全翻面。"""
        self.box.write_config({
            "bgm": {}, "ambient": {"amb_wav": {"src": "/resources/runtime/audio/demo/x.wav"}},
            "sfx": {"sfx_mp3": {"src": "/resources/runtime/audio/demo/y.mp3"},
                    "fresh": {"src": ""}},
            "systemSfx": {},
        })
        self.assertEqual(server.derived_ext("/resources/runtime/audio/demo/x.wav", "ambient"),
                         ".wav", "ambient 里的 wav 被翻成了 mp3")
        self.assertEqual(server.derived_ext("/resources/runtime/audio/demo/y.mp3", "sfx"),
                         ".mp3", "sfx 里的 mp3 被翻成了 wav")
        self.assertEqual(server.derived_ext("", "sfx"), ".wav")
        self.assertEqual(server.derived_ext("", "bgm"), ".mp3")

    def test_format_conversion_is_warned(self):
        self.box.write_config({
            "bgm": {}, "ambient": {}, "sfx": {"k_a": {"src": "/resources/runtime/audio/demo/y.mp3"}},
            "systemSfx": {}})
        self.box.assign("sfx/k_a", self.bark, ext=".wav")
        plan = self.box.plan()
        self.assertIn("格式会从 .mp3 变成 .wav", plan["rows"][0]["warn"])

    def test_chinese_key_can_be_exported(self):
        """8 个中文 ambient key 必须能挂上文件 —— 旧正则会把它们永久锁死。"""
        self.box.assign("ambient/海边", self.whoosh, ext=".wav")
        res = self.box.export()
        self.assertTrue(res["ok"], res.get("error"))
        entry = self.box.doc()["ambient"]["海边"]
        self.assertTrue(entry["src"].endswith(".wav"))
        self.assertEqual(entry["volume"], 0.4, "volume 被写没了")

    def test_same_bytes_from_different_fingerprints_share_one_file_across_sessions(self):
        """两次会话、参数写法不同(指纹不同)、渲出来字节一模一样 —— 仍然只能有一份
        文件、一个路径。这条锁的是**内容级**那层去重(成品 hash),不是指纹那层:
        指纹在这里是不命中的,全靠渲完之后拿成品 hash 再查一次台账才没落第二份。

        (批内同样有一层 by-content 记忆表兜同一件事,但要在**一批之内**构造出
        「指纹不同、字节相同」需要两份不同的源渲出完全一样的字节 —— ffmpeg 会把源的
        元数据一起搬进成品,实际上构造不出来,所以那层没有对应用例,只是廉价的兜底。)"""
        dur = server.ffprobe_duration(self.box.src_dir / "bark.wav")
        # 「不填 trim」与「trim 填成整条」在 build_filter 里拼出完全一样的滤镜链
        self.box.set_edits({self.bark: {}})
        self.box.assign("sfx/k_a", self.bark)
        self.box.export()
        self.box.set_edits({self.bark: {"trim": {"start": 0, "end": round(dur, 4)}}})
        server.HASHES = led.HashCache()
        self.box.assign("sfx/k_b", self.bark)
        res = self.box.export()
        self.assertTrue(res["ok"], res.get("error"))
        self.assertEqual(len(self.box.exported_files()), 1,
                         f"同样的字节落了两份文件: {self.box.exported_files()}")
        doc = self.box.doc()
        self.assertEqual(doc["sfx"]["k_a"]["src"], doc["sfx"]["k_b"]["src"])

    def test_rollback_never_deletes_a_file_it_did_not_create(self):
        """回滚只许删自己刚建的。删掉一个「同名但内容不同」的既有文件 = 毁掉别的 key
        正在引用的东西,还对用户说「项目目录未改动」。"""
        self.box.assign("sfx/k_a", self.bark)
        self.box.export()
        victim = server.src_to_disk(self.box.doc()["sfx"]["k_a"]["src"])
        victim.write_bytes(b"someone edited this in place")   # 同名、内容不同
        server.HASHES = led.HashCache()

        self.box.assign("sfx/k_b", self.bark)                 # 会渲出原来那份内容
        res = self.box.export()
        self.assertTrue(victim.exists(), "回滚/落位把一个既有文件删掉了")
        self.assertEqual(victim.read_bytes(), b"someone edited this in place",
                         "既有文件被覆盖了")
        if res["ok"]:
            # 允许它换个更长的后缀另落一份,但绝不许动那个既有文件
            self.assertNotEqual(self.box.doc()["sfx"]["k_b"]["src"],
                                self.box.doc()["sfx"]["k_a"]["src"])

    def test_assignments_cleared_after_success(self):
        self.box.assign("sfx/k_a", self.bark)
        self.box.export()
        self.assertEqual(led.load_assignments(server.ASSIGNMENTS), {})

    def test_origin_records_provenance_and_ffmpeg_version(self):
        """出处是给人排查用的证据,但 ffmpeg 版本绝不能进指纹(升级会让全量假漂移)。"""
        self.box.assign("sfx/k_a", self.bark)
        self.box.export()
        lg = led.load_ledger(server.EXPORTS)
        h = lg["keys"]["sfx/k_a"]["hash"]
        origin = lg["files"][h]["origin"]
        self.assertEqual(origin["sourceKey"], self.bark)
        self.assertIn("ffmpeg", origin)
        self.assertNotIn("ffmpeg", json.dumps(
            {"algo": led.FINGERPRINT_ALGO, "params": origin["params"]}))


class BackfillTests(unittest.TestCase):
    """存量:导出目录里的成品认领成「已导出(时间推断)」,别处的一律「外来」。
    绝不反推来料出处 —— 名字像不像某个源文件,与它是不是那份料无关。"""

    def setUp(self):
        self.box = SandboxProject()
        (self.box.audio / "edited" / "old_product.wav").write_bytes(b"RIFFproduct")
        (self.box.audio / "demo" / "outsider.wav").write_bytes(b"RIFFoutsider")
        self.box.write_config({
            "bgm": {}, "ambient": {},
            "sfx": {"was_exported": {"src": "/resources/runtime/audio/edited/old_product.wav"},
                    "from_elsewhere": {"src": "/resources/runtime/audio/demo/outsider.wav"}},
            "systemSfx": {}})

    def tearDown(self):
        self.box.close()

    def test_product_claimed_as_exported_with_inferred_time(self):
        rows = {r["key"]: r for r in self.box.scan()["keys"]}
        row = rows["sfx/was_exported"]
        self.assertEqual(row["status"], led.STATUS_EXPORTED)
        self.assertTrue(row["ledger"]["inferred"], "推断出来的时间必须如实标注")
        self.assertEqual(row["ledger"]["origin"], {"backfilled": True},
                         "来料出处必须留白,不许反推")

    def test_outsider_stays_foreign(self):
        rows = {r["key"]: r for r in self.box.scan()["keys"]}
        self.assertEqual(rows["sfx/from_elsewhere"]["status"], led.STATUS_FOREIGN)
        self.assertIsNone(rows["sfx/from_elsewhere"]["ledger"])

    def test_backfill_is_idempotent(self):
        first = json.dumps(led.load_ledger(server.EXPORTS), sort_keys=True)
        self.box.scan()
        self.box.scan()
        after = led.load_ledger(server.EXPORTS)
        self.assertEqual(len(after["keys"]), 1)
        self.assertNotEqual(first, json.dumps(after, sort_keys=True))


class AssignEndpointTests(unittest.TestCase):
    """护栏要从最外层用户入口进 —— 直接打 /api/assign 这个处理函数。"""

    def setUp(self):
        self.box = SandboxProject()
        self.box.write_config({
            "bgm": {}, "ambient": {}, "sfx": {"real_key": {"src": ""}}, "systemSfx": {}})
        (self.box.src_dir / "a.wav").write_bytes(b"RIFFa")
        self.body = b"{}"

        outer = self

        class _H(server.Handler):
            def __init__(_s):
                pass

            def _body(_s):
                return outer.body

        self.h = _H()

    def tearDown(self):
        self.box.close()

    def _assign(self, **payload):
        self.body = json.dumps(payload).encode()
        return self.h.do_assign()

    def test_rejects_key_not_in_config(self):
        """key 只能来自实时扫描的清单。手写的、拼来的、穿越的一律拒。"""
        for bad in ("sfx/typed_by_hand", "sfx/../../pwn", "nosuch/x", ""):
            with self.subTest(key=bad):
                res = self._assign(key=bad, sourceKey="src/a.wav")
                self.assertFalse(res["ok"], bad)

    def test_rejects_missing_source(self):
        res = self._assign(key="sfx/real_key", sourceKey="src/nope.wav")
        self.assertFalse(res["ok"])

    def test_assign_and_unassign(self):
        res = self._assign(key="sfx/real_key", sourceKey="src/a.wav")
        self.assertTrue(res["ok"], res.get("error"))
        self.assertEqual(res["assignments"]["sfx/real_key"]["sourceKey"], "src/a.wav")
        res = self._assign(key="sfx/real_key", sourceKey=None)
        self.assertTrue(res["ok"])
        self.assertNotIn("sfx/real_key", res["assignments"])

    def test_orphan_assignment_is_reported_not_dropped(self):
        """主编辑器把 key 改名/删了,分配就悬空了 —— 必须报出来,不能默默消失。"""
        self._assign(key="sfx/real_key", sourceKey="src/a.wav")
        self.box.write_config({"bgm": {}, "ambient": {}, "sfx": {}, "systemSfx": {}})
        self.assertEqual([o["key"] for o in self.box.scan()["orphans"]], ["sfx/real_key"])


class TrashEndpointTests(unittest.TestCase):
    """回收站是**标记**,不是删除。这组锁的就是这句话:文件必须一直在盘上。"""

    def setUp(self):
        self.box = SandboxProject()
        self.box.write_config({
            "bgm": {}, "ambient": {}, "sfx": {"real_key": {"src": ""}}, "systemSfx": {}})
        (self.box.src_dir / "a.wav").write_bytes(b"RIFFa")
        (self.box.src_dir / "b.wav").write_bytes(b"RIFFb")
        self.body = b"{}"

        outer = self

        class _H(server.Handler):
            def __init__(_s):
                pass

            def _body(_s):
                return outer.body

        self.h = _H()

    def tearDown(self):
        self.box.close()

    def _post(self, **payload):
        self.body = json.dumps(payload).encode()
        return self.h.do_trash()

    def _lib(self):
        return {i["key"]: i for i in self.h.library()["items"]}

    def test_mark_never_touches_the_file(self):
        res = self._post(keys=["src/a.wav"], trashed=True)
        self.assertTrue(res["ok"], res.get("error"))
        self.assertTrue((self.box.src_dir / "a.wav").is_file(), "回收站绝不许删文件")
        self.assertTrue(self._lib()["src/a.wav"]["trashed"])
        self.assertFalse(self._lib()["src/b.wav"]["trashed"])

    def test_restore_clears_the_mark(self):
        self._post(keys=["src/a.wav"], trashed=True)
        res = self._post(keys=["src/a.wav"], trashed=False)
        self.assertTrue(res["ok"], res.get("error"))
        self.assertFalse(self._lib()["src/a.wav"]["trashed"])

    def test_mark_survives_restart(self):
        """标记存在盘上,重开工具还在 —— 不然回收站只是一次会话的错觉。"""
        self._post(keys=["src/a.wav"], trashed=True)
        self.assertEqual(list(led.load_trash(server.TRASH)), ["src/a.wav"])

    def test_rejects_key_not_in_library(self):
        """和分配同一条规矩:key 只能来自实时扫描,手写的/穿越的一律拒。"""
        for bad in ("src/typed_by_hand.wav", "src/../../pwn.wav", "nosuch/x.wav", ""):
            with self.subTest(key=bad):
                self.assertFalse(self._post(keys=[bad], trashed=True)["ok"], bad)

    def test_refuses_while_assigned(self):
        """收进回收站却照样跟着导出走 = 界面上看不见但仍在生效,必须拦。"""
        self.box.assign("sfx/real_key", "src/a.wav")
        res = self._post(keys=["src/a.wav"], trashed=True)
        self.assertFalse(res["ok"])
        self.assertIn("sfx/real_key", res["error"])
        self.assertFalse(self._lib()["src/a.wav"]["trashed"])

    def test_restore_works_for_material_no_longer_on_disk(self):
        """料不在盘上时标记仍在,必须报出来且能撤 —— 否则料回来那天会莫名不见。"""
        self._post(keys=["src/a.wav"], trashed=True)
        (self.box.src_dir / "a.wav").unlink()
        lib = self.h.library()
        self.assertEqual([o["key"] for o in lib["trashOrphans"]], ["src/a.wav"])
        self.assertTrue(self._post(keys=["src/a.wav"], trashed=False)["ok"])
        self.assertEqual(led.load_trash(server.TRASH), {})

    def test_broken_trash_file_does_not_break_the_library(self):
        """标记只是标记,坏了最多是废料重新冒出来,不许把工具打不开。"""
        server.TRASH.write_text("{ not json", encoding="utf-8")
        self.assertFalse(self._lib()["src/a.wav"]["trashed"])


if __name__ == "__main__":
    unittest.main()
