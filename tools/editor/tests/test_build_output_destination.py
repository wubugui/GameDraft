"""手动构建的缺省位置必须在项目外，旧工作树路径不得继续复用。"""
from pathlib import Path

from tools.editor.main_window import _build_output_is_in_git_checkout, _default_build_output_dir


def test_default_build_output_is_outside_checkout(tmp_path: Path) -> None:
    project = tmp_path / "GameDraft"
    project.mkdir()
    (project / ".git").write_text("gitdir: elsewhere\n", encoding="utf-8")

    output = _default_build_output_dir("release")
    assert output.name == "release"
    assert not _build_output_is_in_git_checkout(output)


def test_old_repo_output_is_rejected_even_when_folder_missing(tmp_path: Path) -> None:
    project = tmp_path / "GameDraft"
    project.mkdir()
    (project / ".git").write_text("gitdir: elsewhere\n", encoding="utf-8")

    assert _build_output_is_in_git_checkout(project / "release" / "ship" / "release")
    assert _build_output_is_in_git_checkout(tmp_path, project)
    assert not _build_output_is_in_git_checkout(tmp_path / "GameDraft-builds" / "release")
