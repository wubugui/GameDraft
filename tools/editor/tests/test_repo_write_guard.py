from __future__ import annotations

import json
import os
from pathlib import Path

import pytest

from tools.dialogue_graph_editor.flow_layout_store import save_layout_map
from tools.editor.shared.project_paths import ProjectPaths
from tools.testing.repo_write_guard import (
    RepositoryWriteBlocked,
    RepositoryWriteGuard,
    repository_write_guard_installed,
)


_REPOSITORY_ROOT = Path(__file__).resolve().parents[3]


def test_pytest_installs_real_repository_write_guard() -> None:
    assert repository_write_guard_installed(_REPOSITORY_ROOT)


def test_guard_rejects_write_and_rename_before_disk_mutation(tmp_path: Path) -> None:
    fake_repository = tmp_path / "repo"
    fake_repository.mkdir()
    guard = RepositoryWriteGuard(fake_repository)
    protected = fake_repository / "public" / "assets" / "data.json"

    with pytest.raises(RepositoryWriteBlocked, match="real GameDraft working tree"):
        guard(
            "open",
            (str(protected), "w", os.O_WRONLY | os.O_CREAT | os.O_TRUNC),
        )
    with pytest.raises(RepositoryWriteBlocked, match="real GameDraft working tree"):
        guard("os.rename", (str(protected), str(protected.with_suffix(".bak"))))

    assert not protected.exists()


def test_guard_blocks_lexical_repository_path_through_symlink(tmp_path: Path) -> None:
    fake_repository = tmp_path / "repo"
    outside = tmp_path / "outside"
    fake_repository.mkdir()
    outside.mkdir()
    (fake_repository / "linked").symlink_to(outside, target_is_directory=True)
    guard = RepositoryWriteGuard(fake_repository)

    with pytest.raises(RepositoryWriteBlocked, match="real GameDraft working tree"):
        guard(
            "open",
            (
                str(fake_repository / "linked" / "escaped.json"),
                "w",
                os.O_WRONLY | os.O_CREAT | os.O_TRUNC,
            ),
        )


def test_real_project_dialogue_layout_write_is_redirected(
    isolated_dialogue_layout_store: Path,
) -> None:
    real_layout = (
        ProjectPaths(_REPOSITORY_ROOT).editor_data_root / "dialogue_flow_layout.json"
    )
    before = real_layout.read_bytes() if real_layout.is_file() else None
    payload = {"test-only.json": {"nodes": {"n1": [10.0, 20.0]}}}

    save_layout_map(_REPOSITORY_ROOT, payload)

    assert json.loads(isolated_dialogue_layout_store.read_text(encoding="utf-8")) == payload
    after = real_layout.read_bytes() if real_layout.is_file() else None
    assert after == before


def test_qsettings_are_redirected_outside_the_user_profile(
    isolated_qsettings: Path,
) -> None:
    from PySide6.QtCore import QSettings

    settings = QSettings("GameDraftTest", "RepositoryWriteGuard")
    settings.setValue("probe", True)
    settings.sync()

    assert Path(settings.fileName()).resolve().is_relative_to(isolated_qsettings.resolve())
