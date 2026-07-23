"""Dialogue editor tests: the checked-out repository is read-only."""

from pathlib import Path

from tools.testing.repo_write_guard import install_repository_write_guard


install_repository_write_guard(Path(__file__).resolve().parents[3])

