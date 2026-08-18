"""产物记账与状态引擎的契约。

这一层存在的唯一理由是:**状态不许靠人记**。所以测试要钉的不是"函数返回了什么",
而是那几条会让人白干一整批活的判据:

- 打个标签/改个备注**不该**让产物变"已过时"(假警报比没警报更烦);
- 改切点/改响度目标**必须**变"已过时"(漏报 = 游戏里放着旧声音,没有任何提示);
- 源不在本机时说"不知道",**不许**猜成"最新"或"已过时";
- 换台机器 mtime 全变,**不许**因此判成"被改过"(判据只认 sha)。
"""
from __future__ import annotations

import os
import sys
import time
import unittest
from dataclasses import replace
from pathlib import Path
from tempfile import TemporaryDirectory

import numpy as np

REPO = Path(__file__).resolve().parents[3]
if str(REPO) not in sys.path:
    sys.path.insert(0, str(REPO))

from tools.voice_workbench import audio_io as aio              # noqa: E402
from tools.voice_workbench import ledger as ldg                # noqa: E402
from tools.voice_workbench import render as rnd                # noqa: E402
from tools.voice_workbench.library import SourceLibrary        # noqa: E402
from tools.voice_workbench.project import Project, Slice       # noqa: E402


def _tone(seconds: float = 2.0, rate: int = 48000, db: float = -23.0) -> np.ndarray:
    t = np.arange(int(rate * seconds)) / rate
    one = (10 ** (db / 20)) * np.sin(2 * np.pi * 440 * t)
    return np.column_stack([one, one])


class _Rig:
    """源库 + 一条切片 + 导出目录 + 记账,四件套。"""

    def __init__(self, td: Path):
        self.root = Path(td)
        self.lib = SourceLibrary(self.root / "sources")
        raw = self.root / "raw.wav"
        aio.write(raw, aio.Audio(_tone(), 48000, 16))
        entry, _ = self.lib.import_file(raw)
        self.project = Project()
        self.project.settings.denoise_reduction_db = 0.0     # 降噪慢且与本层无关
        self.project.settings.export_dir = str(self.root / "out")
        self.slice = self.project.add_slice(
            Slice(source=entry.rel, start=0.0, end=1.0, name="甲_1")
        )
        self.out = self.root / "out"
        self.ledger = ldg.Ledger()
        self.shas = ldg.SourceShaCache()

    def status(self, sl: Slice | None = None) -> ldg.SliceStatus:
        return ldg.compute_status(
            self.project, sl or self.slice, self.lib, self.ledger, self.out,
            repo_root=self.root, sha_cache=self.shas,
        )

    def export(self, targets=None) -> list:
        return rnd.export_project(
            self.project, self.lib, self.out,
            targets=targets if targets is not None else [self.slice],
            overwrite=True, ledger=self.ledger, sha_cache=self.shas,
        )


class RenderKeyTests(unittest.TestCase):
    def test_name_note_tags_do_not_change_the_key(self) -> None:
        """改名/打标签/写备注都不进指纹——它们一个字节都不影响产物内容。
        这条要是漏了,给一批切片打个标签就会让它们集体变"已过时",没人会再信这个状态。"""
        with TemporaryDirectory() as td:
            rig = _Rig(Path(td))
            sha = rig.shas.sha_of(rig.lib.root / rig.slice.source)
            base = ldg.render_key(rig.project.settings, rig.slice, sha)
            changed = replace(rig.slice, name="改了个名", note="写点备注", tags=["茶馆", "第一幕"])
            self.assertEqual(base, ldg.render_key(rig.project.settings, changed, sha))

    def test_cut_and_loudness_changes_do_change_the_key(self) -> None:
        with TemporaryDirectory() as td:
            rig = _Rig(Path(td))
            sha = rig.shas.sha_of(rig.lib.root / rig.slice.source)
            base = ldg.render_key(rig.project.settings, rig.slice, sha)
            moved = replace(rig.slice, end=1.5)
            self.assertNotEqual(base, ldg.render_key(rig.project.settings, moved, sha))
            louder = replace(rig.project.settings, target_lufs=-13.0)
            self.assertNotEqual(base, ldg.render_key(louder, rig.slice, sha))

    def test_denoise_amount_is_out_of_the_key_when_denoise_is_off(self) -> None:
        """关了降噪的条目,不该因为别人调了降噪量而假过时。"""
        with TemporaryDirectory() as td:
            rig = _Rig(Path(td))
            sha = rig.shas.sha_of(rig.lib.root / rig.slice.source)
            off = replace(rig.slice, denoise=False)
            a = ldg.render_key(rig.project.settings, off, sha)
            louder = replace(rig.project.settings, denoise_reduction_db=20.0)
            self.assertEqual(a, ldg.render_key(louder, off, sha))
            # 但开着降噪的条目必须跟着变
            on = replace(rig.slice, denoise=True)
            st12 = replace(rig.project.settings, denoise_reduction_db=12.0)
            st20 = replace(rig.project.settings, denoise_reduction_db=20.0)
            self.assertNotEqual(ldg.render_key(st12, on, sha), ldg.render_key(st20, on, sha))

    def test_pipeline_version_is_in_the_key(self) -> None:
        """管线升级 = 全部产物过时。不进指纹的话,改了算法却静默留着旧声音。"""
        with TemporaryDirectory() as td:
            rig = _Rig(Path(td))
            sha = rig.shas.sha_of(rig.lib.root / rig.slice.source)
            self.assertIn("pipeline", ldg.render_key(rig.project.settings, rig.slice, sha))

    def test_change_is_described_in_words(self) -> None:
        with TemporaryDirectory() as td:
            rig = _Rig(Path(td))
            sha = rig.shas.sha_of(rig.lib.root / rig.slice.source)
            old = ldg.render_key(rig.project.settings, rig.slice, sha)
            new = ldg.render_key(rig.project.settings, replace(rig.slice, end=1.5), sha)
            self.assertIn("切点", ldg.describe_key_change(old, new))


class StatusTests(unittest.TestCase):
    def test_never_then_current_after_export(self) -> None:
        with TemporaryDirectory() as td:
            rig = _Rig(Path(td))
            self.assertEqual(rig.status().state, ldg.STATE_NEVER)
            reports = rig.export()
            self.assertTrue(reports[0].ok, reports[0].message)
            self.assertEqual(rig.status().state, ldg.STATE_CURRENT)

    def test_moving_the_cut_makes_it_stale_with_a_reason(self) -> None:
        with TemporaryDirectory() as td:
            rig = _Rig(Path(td))
            rig.export()
            rig.project.update(rig.slice.id, end=1.5)
            rig.slice = rig.project.get(rig.slice.id)
            st = rig.status()
            self.assertEqual(st.state, ldg.STATE_STALE)
            self.assertIn("切点", st.reason)

    def test_renaming_only_is_not_stale_but_leaves_an_orphan(self) -> None:
        """改名不改内容:新名字下"没导过",旧产物成孤儿——两件事都要说出来。"""
        with TemporaryDirectory() as td:
            rig = _Rig(Path(td))
            rig.export()
            old_file = rig.out / "甲_1.wav"
            rig.project.update(rig.slice.id, name="乙_1")
            rig.slice = rig.project.get(rig.slice.id)
            st = rig.status()
            self.assertEqual(st.state, ldg.STATE_NEVER)
            self.assertIsNotNone(st.orphan)
            self.assertEqual(st.orphan, old_file)

    def test_deleted_artifact_is_missing_not_never(self) -> None:
        """"从没导过"和"导过但产物没了"是两回事,混成一个状态就查不出谁删了东西。"""
        with TemporaryDirectory() as td:
            rig = _Rig(Path(td))
            rig.export()
            (rig.out / "甲_1.wav").unlink()
            self.assertEqual(rig.status().state, ldg.STATE_MISSING)

    def test_unknown_file_is_foreign_not_current(self) -> None:
        with TemporaryDirectory() as td:
            rig = _Rig(Path(td))
            rig.out.mkdir(parents=True, exist_ok=True)
            aio.write(rig.out / "甲_1.wav", aio.Audio(_tone(0.5), 48000, 16))
            self.assertEqual(rig.status().state, ldg.STATE_FOREIGN)

    def test_externally_edited_artifact_is_reported(self) -> None:
        with TemporaryDirectory() as td:
            rig = _Rig(Path(td))
            rig.export()
            aio.write(rig.out / "甲_1.wav", aio.Audio(_tone(0.3), 48000, 16))
            self.assertEqual(rig.status().state, ldg.STATE_MODIFIED)

    def test_missing_source_says_it_does_not_know(self) -> None:
        """源库不进版本控制,换台机器源就不在。那时**不许**猜——
        判成"最新"会让人以为万事大吉,判成"过时"会让人白渲一整批。"""
        with TemporaryDirectory() as td:
            rig = _Rig(Path(td))
            rig.export()
            (rig.lib.root / rig.slice.source).unlink()
            rig.shas.clear()
            st = rig.status()
            self.assertEqual(st.state, ldg.STATE_NO_SOURCE)
            self.assertFalse(st.needs_export, "不知道的东西不该被塞进导出集")

    def test_touching_mtime_does_not_make_it_modified(self) -> None:
        """拷贝/还原/换机都会刷 mtime。判据只认 sha,mtime 只是缓存键。"""
        with TemporaryDirectory() as td:
            rig = _Rig(Path(td))
            rig.export()
            dest = rig.out / "甲_1.wav"
            future = time.time() + 10_000
            os.utime(dest, (future, future))
            self.assertEqual(rig.status().state, ldg.STATE_CURRENT)
            # 缓存键应当被就地刷新,免得每次扫描都重算 sha
            self.assertEqual(rig.ledger.get(rig.slice.id).out_mtime_ns, dest.stat().st_mtime_ns)

    def test_excluded_slice_is_not_in_the_export_set(self) -> None:
        with TemporaryDirectory() as td:
            rig = _Rig(Path(td))
            rig.project.update(rig.slice.id, enabled=False)
            rig.slice = rig.project.get(rig.slice.id)
            st = rig.status()
            self.assertEqual(st.state, ldg.STATE_EXCLUDED)
            self.assertFalse(st.needs_export)

    def test_bad_range_is_invalid_not_never(self) -> None:
        with TemporaryDirectory() as td:
            rig = _Rig(Path(td))
            rig.project.update(rig.slice.id, end=0.0)
            rig.slice = rig.project.get(rig.slice.id)
            self.assertEqual(rig.status().state, ldg.STATE_INVALID)


class LedgerFileTests(unittest.TestCase):
    def test_roundtrip(self) -> None:
        with TemporaryDirectory() as td:
            rig = _Rig(Path(td))
            rig.export()
            path = Path(td) / "p.export.json"
            rig.ledger.save(path)
            again = ldg.Ledger.load(path)
            rec_a, rec_b = rig.ledger.get(rig.slice.id), again.get(rig.slice.id)
            self.assertEqual(rec_a.key, rec_b.key)
            self.assertEqual(rec_a.out_sha256, rec_b.out_sha256)
            self.assertEqual(rec_a.out_mtime_ns, rec_b.out_mtime_ns)

    def test_broken_ledger_does_not_explode(self) -> None:
        """记账坏了最坏的后果是"全部显示来历不明",不该是打不开工具。"""
        with TemporaryDirectory() as td:
            path = Path(td) / "bad.export.json"
            path.write_text("{ 这不是 json", encoding="utf-8")
            self.assertEqual(len(ldg.Ledger.load(path)), 0)

    def test_ledger_path_sits_next_to_the_project(self) -> None:
        p = Path("/tmp/工程/说书.json")
        self.assertEqual(ldg.ledger_path_for(p).name, "说书.export.json")
        self.assertIsNone(ldg.ledger_path_for(None))


class ClaimTests(unittest.TestCase):
    def test_claim_turns_foreign_into_current(self) -> None:
        """迁移路径:这套记账上线之前导出去的那一批,认一次账就归位。"""
        with TemporaryDirectory() as td:
            rig = _Rig(Path(td))
            rig.out.mkdir(parents=True, exist_ok=True)
            aio.write(rig.out / "甲_1.wav", aio.Audio(_tone(0.5), 48000, 16))
            self.assertEqual(rig.status().state, ldg.STATE_FOREIGN)
            claimed = ldg.claim_existing(
                rig.project, rig.lib, rig.ledger, rig.out,
                repo_root=rig.root, sha_cache=rig.shas,
            )
            self.assertEqual(claimed, ["甲_1"])
            self.assertEqual(rig.status().state, ldg.STATE_CURRENT)

    def test_claim_does_not_touch_audio(self) -> None:
        with TemporaryDirectory() as td:
            rig = _Rig(Path(td))
            rig.out.mkdir(parents=True, exist_ok=True)
            dest = rig.out / "甲_1.wav"
            aio.write(dest, aio.Audio(_tone(0.5), 48000, 16))
            before = dest.read_bytes()
            ldg.claim_existing(
                rig.project, rig.lib, rig.ledger, rig.out,
                repo_root=rig.root, sha_cache=rig.shas,
            )
            self.assertEqual(before, dest.read_bytes(), "认账只动记账，绝不碰音频")

    def test_claim_skips_genuinely_stale_entries(self) -> None:
        """已过时的不认——那是参数真的变了,认账等于把变更抹掉。"""
        with TemporaryDirectory() as td:
            rig = _Rig(Path(td))
            rig.export()
            rig.project.update(rig.slice.id, end=1.5)
            claimed = ldg.claim_existing(
                rig.project, rig.lib, rig.ledger, rig.out,
                repo_root=rig.root, sha_cache=rig.shas,
            )
            self.assertEqual(claimed, [])
            rig.slice = rig.project.get(rig.slice.id)
            self.assertEqual(rig.status().state, ldg.STATE_STALE)


class ExportSetTests(unittest.TestCase):
    def test_second_batch_needs_no_re_checking(self) -> None:
        """这就是"隔段时间导第二批"的场景:第一批导完之后,
        「需要更新的」只剩新加的那条——不用把上一批的钩子取消掉。"""
        with TemporaryDirectory() as td:
            rig = _Rig(Path(td))
            rig.export()
            second = rig.project.add_slice(
                Slice(source=rig.slice.source, start=1.0, end=1.8, name="甲_2")
            )
            need = [
                s for s in rig.project.slices
                if ldg.compute_status(
                    rig.project, s, rig.lib, rig.ledger, rig.out,
                    repo_root=rig.root, sha_cache=rig.shas,
                ).needs_export
            ]
            self.assertEqual([s.name for s in need], ["甲_2"])
            rig.export(targets=need)
            self.assertEqual(rig.status(second).state, ldg.STATE_CURRENT)

    def test_cancel_stops_and_says_so(self) -> None:
        """取消按钮不许是画上去的:剩下的要如实记成"已取消",不是"跳过"。"""
        with TemporaryDirectory() as td:
            rig = _Rig(Path(td))
            for i in range(2, 5):
                rig.project.add_slice(
                    Slice(source=rig.slice.source, start=0.0, end=0.5, name=f"甲_{i}")
                )
            seen: list[str] = []

            def progress(i, total, name):
                seen.append(name)
                return i < 2                       # 放过头两条，第三条上按取消

            reports = rnd.export_project(
                rig.project, rig.lib, rig.out, overwrite=True, progress=progress,
                ledger=rig.ledger,
            )
            self.assertEqual(sum(1 for r in reports if r.ok), 2)
            self.assertTrue(any(r.cancelled for r in reports))
            self.assertEqual(len(list(rig.out.glob("*.wav"))), 2, "取消之前导出的那些要留着")


class RenameArtifactTests(unittest.TestCase):
    def test_rename_moves_the_file_and_keeps_the_record(self) -> None:
        with TemporaryDirectory() as td:
            rig = _Rig(Path(td))
            rig.export()
            rec = rig.ledger.get(rig.slice.id)
            old, new = rig.out / "甲_1.wav", rig.out / "乙_1.wav"
            ldg.rename_artifact(rig.ledger, rec, old, new)
            rig.project.update(rig.slice.id, name="乙_1")
            rig.slice = rig.project.get(rig.slice.id)
            self.assertFalse(old.exists())
            self.assertTrue(new.is_file())
            self.assertEqual(rig.status().state, ldg.STATE_CURRENT, "连带改名之后不该变成未导出")


if __name__ == "__main__":
    unittest.main()
