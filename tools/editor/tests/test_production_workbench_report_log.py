from __future__ import annotations

from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import TestCase

from tools.production_workbench.report_log import save_workbench_report, workbench_reports_root


class ProductionWorkbenchReportLogTests(TestCase):
    def test_save_workbench_report_writes_human_readable_log(self) -> None:
        with TemporaryDirectory() as td:
            root = Path(td) / "p"
            path = save_workbench_report(root, "daily check/中文", "报告正文")

            self.assertTrue(path.is_file())
            self.assertEqual(path.parent, workbench_reports_root(root))
            self.assertIn("daily-check", path.name)
            self.assertEqual(path.read_text(encoding="utf-8"), "报告正文\n")

    def test_save_workbench_report_avoids_name_collision(self) -> None:
        with TemporaryDirectory() as td:
            root = Path(td) / "p"
            first = save_workbench_report(root, "same", "one")
            second = save_workbench_report(root, "same", "two")

            self.assertNotEqual(first, second)
            self.assertEqual(first.read_text(encoding="utf-8"), "one\n")
            self.assertEqual(second.read_text(encoding="utf-8"), "two\n")


if __name__ == "__main__":
    import unittest

    unittest.main()
