"""配音工作台内核契约:响度测得准、源库不丢原件、导出不覆盖。

响度那几条拿 EBU/BS.1770 的合规信号钉——这是整条链唯一"有标准答案"的部分,
它错了后面全错,而且错得没有任何提示(所有产物一致地偏 X dB,听起来只是"有点小")。
"""
from __future__ import annotations

import math
import sys
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

import numpy as np

REPO = Path(__file__).resolve().parents[3]
if str(REPO) not in sys.path:
    sys.path.insert(0, str(REPO))

from tools.voice_workbench import audio_io as aio          # noqa: E402
from tools.voice_workbench import dsp, render as rnd       # noqa: E402
from tools.voice_workbench.library import SourceLibrary    # noqa: E402
from tools.voice_workbench.project import (                # noqa: E402
    Project, Settings, Slice, sanitize_name,
)


def sine(seconds: float, rate: int = 48000, db: float = -23.0, freq: float = 1000.0,
         channels: int = 2) -> np.ndarray:
    t = np.arange(int(rate * seconds)) / rate
    one = (10 ** (db / 20)) * np.sin(2 * np.pi * freq * t)
    return np.column_stack([one] * channels)


class PipelineVersionTests(unittest.TestCase):
    """``dsp.PIPELINE_VERSION`` 的钉子。

    这个版本号进渲染指纹:它一变,全部产物立刻显示"已过时"——那正是想要的,
    因为算法换了,盘上那些还是老算法渲的。但**光靠自觉记得 +1 是记不住的**,
    所以这里锁住"处理管线的源码"这件事本身。

    ### 这个测试红了怎么办

    1. 先问自己:**输出的字节会变吗?**
       - 会(动了算法、参数默认值、处理顺序)→ ``dsp.PIPELINE_VERSION`` **+1**,
         然后按下面的办法更新期望值。不 +1 的后果是:游戏里继续放着旧算法渲的声音,
         而界面上一片"最新",没有任何提示。
       - 不会(只改了注释/格式/文档字符串)→ 直接更新期望值即可。
    2. 更新期望值:把断言里报出来的实际值抄进 ``_EXPECTED``。

    (锁源码文本而不是锁"输出音频的 sha":后者依赖 numpy/scipy 的实现细节,
    换台机器、换个版本就红,那种红没有任何信息量。)
    """

    _EXPECTED = "0fa46e266efce53a"

    @staticmethod
    def _fingerprint() -> str:
        import hashlib
        import inspect

        src = (Path(dsp.__file__).read_text(encoding="utf-8")
               + inspect.getsource(rnd.render_slice))
        return hashlib.sha256(src.replace("\r", "").encode("utf-8")).hexdigest()[:16]

    def test_pipeline_source_is_unchanged(self) -> None:
        self.assertEqual(
            self._fingerprint(), self._EXPECTED,
            "处理管线的源码变了。输出字节会变吗？会 → dsp.PIPELINE_VERSION +1；"
            "不会（只改了注释/格式）→ 把上面这个实际值抄进 _EXPECTED。",
        )

    def test_version_is_part_of_the_render_key(self) -> None:
        from tools.voice_workbench import ledger as ldg

        key = ldg.render_key(Settings(), Slice(source="a.wav", start=0, end=1, name="x"), "sha")
        self.assertEqual(key["pipeline"], dsp.PIPELINE_VERSION)


class LoudnessTests(unittest.TestCase):
    def test_ebu_compliance_1khz_sine(self) -> None:
        """EBU Tech 3341:1kHz 正弦(双声道)的读数应等于它的 dBFS 电平,容差 ±0.1 LU。"""
        for rate in (48000, 44100):
            for level in (-23.0, -20.0, -40.0):
                with self.subTest(rate=rate, level=level):
                    got = dsp.loudness_lufs(sine(10, rate, level), rate)
                    self.assertAlmostEqual(got, level, delta=0.1)

    def test_mono_measured_as_dual_matches_stereo(self) -> None:
        """单声道按双声道计:同一内容单/双声道读数必须一致。

        不这么算的话,单声道产物会被归一化得比立体声产物响 3 dB——
        一批素材里混着两种格式就永远对不齐,而且听起来只是"有几条偏大"。
        """
        mono = sine(5, channels=1)
        self.assertAlmostEqual(
            dsp.loudness_lufs(mono, 48000),
            dsp.loudness_lufs(np.repeat(mono, 2, axis=1), 48000),
            delta=0.05,
        )
        self.assertAlmostEqual(
            dsp.loudness_lufs(mono, 48000, mono_as_dual=False),
            dsp.loudness_lufs(mono, 48000) - 3.0,
            delta=0.1,
        )

    def test_silence_is_negative_infinity(self) -> None:
        """静音返回 -inf,不是 0 也不是 -70:调用方必须显式处理"这条没声音"。"""
        self.assertEqual(dsp.loudness_lufs(np.zeros((48000, 2)), 48000), float("-inf"))

    def test_true_peak_can_exceed_sample_peak(self) -> None:
        """真峰会高过样本峰——只看样本峰值会在解码/重采样后削顶。"""
        x = sine(1, 48000, db=-0.5, freq=11997)
        self.assertGreater(dsp.true_peak_db(x, 48000), dsp.sample_peak_db(x))


class NormalizeTests(unittest.TestCase):
    def test_normalize_hits_target(self) -> None:
        r = dsp.normalize_lufs(sine(5, db=-35.0), 48000, target_lufs=-20.0)
        self.assertAlmostEqual(r.out_lufs, -20.0, delta=0.1)
        self.assertTrue(r.hit_target)

    def test_true_peak_ceiling_wins_over_target(self) -> None:
        """够不着目标时宁可差一点也不削顶,并如实报出让掉了多少。

        场景是真会遇到的:一条整体很轻的录音里混进一下碰麦/桌子响——
        整段响度只有 -40 LUFS,单个瞬态却快满刻度。照响度目标推 +20 dB 必然削顶,
        这时**必须让真峰上限赢**,并把"差了多少"报出来给人看(那条八成该重录或剪掉)。
        """
        x = sine(3, db=-40.0)
        x[10000:10096] = 0.9                      # 一下碰麦:极短、极响
        r = dsp.normalize_lufs(x, 48000, target_lufs=-20.0, true_peak_ceiling_db=-1.5)
        self.assertLessEqual(r.out_true_peak_db, -1.4)
        self.assertGreater(r.peak_limited_db, 1.0)
        self.assertFalse(r.hit_target)

    def test_silence_normalizes_to_nothing(self) -> None:
        """全静音的一段:不许拉 +24dB 把底噪轰出来,增益必须是 0。"""
        r = dsp.normalize_lufs(np.zeros((48000, 2)), 48000)
        self.assertEqual(r.applied_gain_db, 0.0)


class DenoiseTests(unittest.TestCase):
    def test_denoise_lowers_noise_floor(self) -> None:
        rng = np.random.default_rng(0)
        sig = np.zeros(48000 * 3)
        sig[48000:96000] = 0.3 * np.sin(2 * np.pi * 200 * np.arange(48000) / 48000)
        noisy = (sig + rng.normal(0, 0.01, sig.size))[:, None]
        out = dsp.denoise(noisy, 48000, noise_sample=noisy[:40000], reduction_db=12.0)
        rms = lambda a: 20 * math.log10(math.sqrt(float((a[:40000] ** 2).mean())))
        self.assertLess(rms(out[:, 0]), rms(noisy[:, 0]) - 6.0)
        self.assertEqual(out.shape, noisy.shape)


class AudioIOTests(unittest.TestCase):
    def test_roundtrip_wav(self) -> None:
        with TemporaryDirectory() as td:
            p = Path(td) / "a.wav"
            src = aio.Audio(sine(1), 48000, 16)
            aio.write(p, src)
            back = aio.read(p)
            self.assertEqual(back.rate, 48000)
            self.assertEqual(back.channels, 2)
            self.assertLess(float(np.max(np.abs(back.samples - src.samples))), 1e-4)

    def test_write_accepts_tmp_suffix(self) -> None:
        """写盘走"临时文件 + 就位",临时名是 xxx.wav.tmp——
        让 libsndfile 从扩展名猜格式会直接抛 TypeError(踩过)。"""
        with TemporaryDirectory() as td:
            aio.write(Path(td) / "a.wav.tmp", aio.Audio(sine(0.2), 48000, 16))

    def test_undecodable_format_error_gives_a_way_out(self) -> None:
        """m4a 是真解不开(libsndfile 无 AAC)——但报错必须给可执行的出路,
        不能只说"请重录":人手上那条录音可能是唯一的一条。"""
        with TemporaryDirectory() as td:
            p = Path(td) / "x.m4a"
            p.write_bytes(b"not really audio")
            with self.assertRaises(aio.AudioIOError) as ctx:
                aio.read(p)
            msg = str(ctx.exception)
            self.assertIn("ffmpeg", msg, "报错要给出转换办法")
            self.assertIn("wav", msg.lower())

    def test_mp3_is_accepted_not_rejected(self) -> None:
        """libsndfile 1.2+ 支持 MP3:按"有损"一刀切拒掉是错的——
        损失在录音那刻就发生了,拒收挽回不了任何东西,只会把人挡在工具外面。"""
        self.assertIn(".mp3", aio.SUPPORTED_EXT)
        with TemporaryDirectory() as td:
            p = Path(td) / "a.mp3"
            import soundfile as sf
            sf.write(str(p), sine(1, channels=1)[:, 0], 48000, format="MP3")
            back = aio.read(p)
            self.assertEqual(back.rate, 48000)
            self.assertTrue(aio.is_lossy(p), "有损来源必须被标记出来")
            self.assertFalse(aio.is_lossy(Path("a.wav")))

    def test_clipping_is_clamped_not_wrapped(self) -> None:
        """超幅样本必须夹到满刻度:绕回会变成反相大负值,听感是"咔"的爆音。"""
        with TemporaryDirectory() as td:
            p = Path(td) / "loud.wav"
            aio.write(p, aio.Audio(np.full((100, 1), 1.8), 48000, 16))
            self.assertLessEqual(float(np.max(np.abs(aio.read(p).samples))), 1.0)


class LibraryTests(unittest.TestCase):
    def _make_src(self, td: Path, name: str = "raw.wav", db: float = -23.0) -> Path:
        p = td / name
        aio.write(p, aio.Audio(sine(1, db=db), 48000, 16))
        return p

    def test_import_copies_and_leaves_original(self) -> None:
        with TemporaryDirectory() as td:
            root = Path(td)
            src = self._make_src(root)
            lib = SourceLibrary(root / "lib")
            entry, is_new = lib.import_file(src)
            self.assertTrue(is_new)
            self.assertTrue(src.exists(), "原始文件必须原地不动（拷贝，不是移动）")
            self.assertTrue((lib.root / entry.rel).is_file())

    def test_same_content_imported_twice_makes_no_copy(self) -> None:
        with TemporaryDirectory() as td:
            root = Path(td)
            src = self._make_src(root)
            lib = SourceLibrary(root / "lib")
            e1, new1 = lib.import_file(src)
            e2, new2 = lib.import_file(src)
            self.assertTrue(new1)
            self.assertFalse(new2, "同内容重复导入不该产生副本")
            self.assertEqual(e1.rel, e2.rel)
            self.assertEqual(len(lib.scan()), 1)

    def test_same_name_different_content_never_overwrites(self) -> None:
        """源库是不可再生资源:同名不同内容必须另起名字,绝不覆盖。"""
        with TemporaryDirectory() as td:
            root = Path(td)
            lib = SourceLibrary(root / "lib")
            a = self._make_src(root / "a", "raw.wav", db=-23.0)
            b = self._make_src(root / "b", "raw.wav", db=-12.0)
            e1, _ = lib.import_file(a)
            e2, _ = lib.import_file(b)
            self.assertNotEqual(e1.rel, e2.rel)
            self.assertEqual(len(lib.scan()), 2)

    def test_verify_reports_externally_modified_source(self) -> None:
        """库内文件被外部改写必须报出来——默默用新内容 = "原始素材"这个前提没了。"""
        with TemporaryDirectory() as td:
            root = Path(td)
            lib = SourceLibrary(root / "lib")
            entry, _ = lib.import_file(self._make_src(root))
            self.assertEqual(lib.verify(), [])
            aio.write(lib.root / entry.rel, aio.Audio(sine(1, db=-6.0), 48000, 16))
            self.assertTrue(any("覆盖" in p for p in lib.verify()))

    def test_undecodable_source_rejected_with_way_out(self) -> None:
        with TemporaryDirectory() as td:
            root = Path(td)
            p = root / "voice.m4a"
            p.write_bytes(b"x")
            lib = SourceLibrary(root / "lib")
            with self.assertRaises(aio.AudioIOError) as ctx:
                lib.import_file(p)
            self.assertIn("ffmpeg", str(ctx.exception))

    def test_lossy_source_is_imported_but_flagged(self) -> None:
        """有损来源照收,但库里必须标出来——降噪/归一化会把编码噪声一起放大。"""
        with TemporaryDirectory() as td:
            root = Path(td)
            import soundfile as sf
            src = root / "voice.mp3"
            sf.write(str(src), sine(1, channels=1)[:, 0], 48000, format="MP3")
            lib = SourceLibrary(root / "lib")
            entry, is_new = lib.import_file(src)
            self.assertTrue(is_new)
            self.assertTrue(entry.lossy)


class ProjectTests(unittest.TestCase):
    def test_roundtrip_json(self) -> None:
        with TemporaryDirectory() as td:
            pj = Project(name="p", settings=Settings(target_lufs=-18.0))
            pj.add_slice(Slice(source="a.wav", start=0.5, end=1.5, name="第一句"))
            path = Path(td) / "p.json"
            pj.save(path)
            back = Project.load(path)
            self.assertEqual(back.name, "p")
            self.assertEqual(back.settings.target_lufs, -18.0)
            self.assertEqual(len(back.slices), 1)
            self.assertEqual(back.slices[0].name, "第一句")

    def test_duplicate_names_are_a_problem(self) -> None:
        """两条切片同名 = 后导出的盖掉先导出的,必须在导出前拦。"""
        pj = Project()
        pj.add_slice(Slice(source="a.wav", start=0, end=1, name="同名"))
        pj.add_slice(Slice(source="a.wav", start=1, end=2, name="同名"))
        self.assertTrue(any("重名" in p for p in pj.problems()))

    def test_sanitize_name_keeps_chinese_drops_separators(self) -> None:
        self.assertEqual(sanitize_name("说书/9"), "说书_9")
        self.assertEqual(sanitize_name("  "), "未命名")


class ExportTests(unittest.TestCase):
    def _rig(self, td: Path):
        raw = td / "raw.wav"
        # 三段电平各不相同的正弦,中间留静音——模拟"一次录了好几句"
        parts = [sine(1.0, db=-30), np.zeros((24000, 2)), sine(1.0, db=-18)]
        aio.write(raw, aio.Audio(np.concatenate(parts), 48000, 16))
        lib = SourceLibrary(td / "lib")
        entry, _ = lib.import_file(raw)
        pj = Project(settings=Settings(target_lufs=-20.0, denoise_reduction_db=0.0))
        pj.add_slice(Slice(source=entry.rel, start=0.0, end=1.0, name="s1"))
        pj.add_slice(Slice(source=entry.rel, start=1.5, end=2.5, name="s2"))
        return lib, pj

    def test_export_aligns_loudness(self) -> None:
        """两条差 12 dB 的素材导出后必须落在同一响度上(这就是整个工具的价值)。"""
        with TemporaryDirectory() as td:
            lib, pj = self._rig(Path(td))
            out = Path(td) / "out"
            reports = rnd.export_project(pj, lib, out)
            self.assertTrue(all(r.ok for r in reports), [r.message for r in reports])
            values = [r.out_lufs for r in reports]
            self.assertLess(max(values) - min(values), 0.3)
            for r in reports:
                self.assertAlmostEqual(r.out_lufs, -20.0, delta=0.3)

    def test_export_does_not_overwrite_by_default(self) -> None:
        """导出目录里可能有正在用的资产:默认不覆盖,并如实报告跳过了什么。"""
        with TemporaryDirectory() as td:
            lib, pj = self._rig(Path(td))
            out = Path(td) / "out"
            rnd.export_project(pj, lib, out)
            again = rnd.export_project(pj, lib, out)
            self.assertTrue(all(r.skipped for r in again))
            forced = rnd.export_project(pj, lib, out, overwrite=True)
            self.assertTrue(all(r.ok for r in forced))

    def test_disabled_slices_are_not_exported(self) -> None:
        with TemporaryDirectory() as td:
            lib, pj = self._rig(Path(td))
            pj.update(pj.slices[0].id, enabled=False)
            reports = rnd.export_project(pj, lib, Path(td) / "out")
            self.assertEqual([r.name for r in reports], ["s2"])

    def test_dual_mono_is_downmixed(self) -> None:
        """双份同内容的立体声转单声道:省一半体积且零损失。"""
        with TemporaryDirectory() as td:
            lib, pj = self._rig(Path(td))
            out = Path(td) / "out"
            rnd.export_project(pj, lib, out)
            info = aio.probe(out / "s1.wav")
            self.assertEqual(info["channels"], 1)
            self.assertEqual(info["bits"], 16)

    def test_true_stereo_is_not_downmixed(self) -> None:
        """两声道内容不同时**不许**转单声道:求平均会梳状滤波,人声发闷发空。
        本项目那批说书配音实测相关系数只有 0.66~0.86,照"手机立体声都是双份同内容"
        的直觉转下去就废了。"""
        with TemporaryDirectory() as td:
            root = Path(td)
            rng = np.random.default_rng(1)
            left = sine(2, db=-20)[:, 0]
            right = left * 0.7 + rng.normal(0, 0.02, left.size)     # 两路真的不同
            raw = root / "stereo.wav"
            aio.write(raw, aio.Audio(np.column_stack([left, right]), 48000, 16))
            lib = SourceLibrary(root / "lib")
            entry, _ = lib.import_file(raw)
            pj = Project(settings=Settings(denoise_reduction_db=0.0, export_mono=True))
            pj.add_slice(Slice(source=entry.rel, start=0.0, end=2.0, name="st"))
            out = root / "out"
            reports = rnd.export_project(pj, lib, out)
            self.assertEqual(aio.probe(out / "st.wav")["channels"], 2)
            self.assertIn("梳状滤波", reports[0].message)

    def test_bad_range_reports_instead_of_crashing(self) -> None:
        with TemporaryDirectory() as td:
            lib, pj = self._rig(Path(td))
            pj.update(pj.slices[0].id, start=5.0, end=6.0)      # 越过文件末尾
            reports = rnd.export_project(pj, lib, Path(td) / "out")
            self.assertFalse(reports[0].ok)
            self.assertTrue(reports[0].message)


class SplitTests(unittest.TestCase):
    def test_split_finds_segments_across_silence(self) -> None:
        parts = [sine(0.8, db=-20), np.zeros((48000, 2)), sine(0.8, db=-20)]
        x = np.concatenate(parts)
        segs = dsp.split_on_silence(x, 48000)
        self.assertEqual(len(segs), 2)
        self.assertLess(segs[0][1], segs[1][0])

    def test_split_threshold_default_is_above_room_floor(self) -> None:
        """默认门限必须高于常见家庭录音的房间本底(-43~-45 dBFS),
        否则"全程都不算静音",一整条录音会切成一段(本项目实测踩过)。"""
        self.assertGreater(dsp.DEFAULT_SPLIT_THRESHOLD_DB, -45.0)


if __name__ == "__main__":
    unittest.main()


class NoAutoEditTests(unittest.TestCase):
    """用户明令:工具**绝不自动剪片段**。这几条把它钉死在代码里。"""

    def test_default_slice_has_no_fade(self) -> None:
        """默认不加淡入淡出:用户手工剪好的片段,连头尾几十毫秒都不该被动。"""
        s = Slice(source="a.wav", start=0.0, end=1.0, name="x")
        self.assertEqual(s.fade_in_s, 0.0)
        self.assertEqual(s.fade_out_s, 0.0)

    def test_render_preserves_duration_exactly(self) -> None:
        """整条导入 = 整条出来:渲染管线只改电平与噪声,**一帧都不剪**。"""
        with TemporaryDirectory() as td:
            root = Path(td)
            raw = root / "raw.wav"
            # 头尾都有静音——正是"自动去静音"最容易下手的形状
            body = np.concatenate([np.zeros((24000, 2)), sine(2.0, db=-20), np.zeros((24000, 2))])
            aio.write(raw, aio.Audio(body, 48000, 16))
            lib = SourceLibrary(root / "lib")
            entry, _ = lib.import_file(raw)
            dur = aio.probe(lib.root / entry.rel)["seconds"]
            # 关掉转单声道:本条测的是"一帧不剪",声道合并另有专门的两条测试
            pj = Project(settings=Settings(denoise_reduction_db=10.0, export_mono=False))
            pj.add_slice(Slice(source=entry.rel, start=0.0, end=dur, name="whole"))
            out = root / "out"
            rnd.export_project(pj, lib, out)
            before = aio.probe(lib.root / entry.rel)
            after = aio.probe(out / "whole.wav")
            self.assertEqual(after["frames"], before["frames"], "帧数必须一模一样")
            self.assertEqual(after["rate"], before["rate"])
            self.assertEqual(after["channels"], before["channels"])

    def test_no_trimming_helper_is_wired_into_the_pipeline(self) -> None:
        """静音检测只是给'建议切点'看的分析函数,**不许**出现在渲染管线里。
        护栏用源码扫:哪天有人图省事在 render 里加一句 trim,这条会当场红。"""
        src = (Path(__file__).resolve().parents[1] / "render.py").read_text(encoding="utf-8")
        for banned in ("detect_speech_bounds", "split_on_silence", "trim_silence"):
            self.assertNotIn(banned, src, f"渲染管线里不许出现 {banned}（那是自动剪）")
