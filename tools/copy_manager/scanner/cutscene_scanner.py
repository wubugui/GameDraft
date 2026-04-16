"""Cutscene scanner: extracts text from cutscenes/index.json."""
from __future__ import annotations

from pathlib import Path
from typing import Any

from tools.copy_manager.scanner.base import BaseScanner, TextEntry, find_entry_id, make_uid
from tools.copy_manager.utils import read_json


# Human labels for cutscene field types
_FIELD_LABELS = {
    "text": "文本",
    "speaker": "说话人",
    "name": "名称",
}


class CutsceneScanner(BaseScanner):
    """Scans cutscenes/index.json for translatable text."""

    @property
    def name(self) -> str:
        return "Cutscene Scripts"

    def scan(self, project_root: Path) -> list[TextEntry]:
        entries = []
        cutscene_path = project_root / "public/assets/data/cutscenes/index.json"

        if not cutscene_path.exists():
            return entries

        data = read_json(cutscene_path)
        file_rel = "public/assets/data/cutscenes/index.json"

        if not isinstance(data, list):
            return entries

        for i, cutscene in enumerate(data):
            if not isinstance(cutscene, dict):
                continue
            cs_id = find_entry_id(cutscene, "id", i)
            cs_name = cutscene.get("name", cs_id)
            group_id = f"cutscenes[{cs_id}]"
            group_label = str(cs_name)
            steps = cutscene.get("steps", [])
            if not isinstance(steps, list):
                continue

            # Track text field counts per cutscene for numbered labels
            field_counter = 0

            for si, step in enumerate(steps):
                if not isinstance(step, dict):
                    continue
                kind = step.get("kind", "")
                step_type = step.get("type", "")

                # showTitle — has text
                if step_type == "showTitle" and "text" in step:
                    text = step["text"]
                    if isinstance(text, str) and text.strip():
                        field_path = f"cutscenes[{cs_id}].steps[{si}].text"
                        field_counter += 1
                        entries.append(TextEntry(
                            uid=make_uid("cutscenes_title", file_rel, field_path),
                            source_text=text,
                            file_path=file_rel,
                            field_path=field_path,
                            file_type="cutscenes_title",
                            category="cutscene",
                            group_id=group_id,
                            group_label=group_label,
                            field_label=f"标题 #{field_counter}",
                            tags=[f"cutscene_id:{cs_id}", f"step:{step_type}"],
                        ))

                # showDialogue — has speaker and text
                if step_type == "showDialogue":
                    text = step.get("text", "")
                    speaker = step.get("speaker", "")
                    if isinstance(text, str) and text.strip():
                        field_path = f"cutscenes[{cs_id}].steps[{si}].text"
                        field_counter += 1
                        entries.append(TextEntry(
                            uid=make_uid("cutscenes_dialogue", file_rel, field_path),
                            source_text=text,
                            file_path=file_rel,
                            field_path=field_path,
                            file_type="cutscenes_dialogue",
                            category="cutscene",
                            group_id=group_id,
                            group_label=group_label,
                            field_label=f"对话 #{field_counter}",
                            tags=[f"cutscene_id:{cs_id}", f"speaker:{speaker}", f"step:{step_type}"],
                        ))
                    # Also capture the speaker name as a separate entry
                    if isinstance(speaker, str) and speaker.strip():
                        field_path_speaker = f"cutscenes[{cs_id}].steps[{si}].speaker"
                        field_counter += 1
                        entries.append(TextEntry(
                            uid=make_uid("cutscenes_speaker", file_rel, field_path_speaker),
                            source_text=speaker,
                            file_path=file_rel,
                            field_path=field_path_speaker,
                            file_type="cutscenes_speaker",
                            category="cutscene",
                            group_id=group_id,
                            group_label=group_label,
                            field_label=f"说话人 #{field_counter}",
                            tags=[f"cutscene_id:{cs_id}", f"step:{step_type}"],
                        ))

                # cutsceneSpawnActor — has name param
                if step_type == "cutsceneSpawnActor":
                    params = step.get("params", {})
                    if isinstance(params, dict) and "name" in params:
                        name = params["name"]
                        if isinstance(name, str) and name.strip():
                            field_path = f"cutscenes[{cs_id}].steps[{si}].params.name"
                            field_counter += 1
                            entries.append(TextEntry(
                                uid=make_uid("cutscenes_actor_name", file_rel, field_path),
                                source_text=name,
                                file_path=file_rel,
                                field_path=field_path,
                                file_type="cutscenes_actor_name",
                                category="cutscene",
                                group_id=group_id,
                                group_label=group_label,
                                field_label=f"角色名 #{field_counter}",
                                tags=[f"cutscene_id:{cs_id}", f"step:{step_type}"],
                            ))

                # parallel steps — check tracks
                if kind == "parallel":
                    tracks = step.get("tracks", [])
                    if isinstance(tracks, list):
                        for ti, track in enumerate(tracks):
                            if not isinstance(track, dict):
                                continue
                            track_type = track.get("type", "")
                            if track_type == "showDialogue":
                                text = track.get("text", "")
                                speaker = track.get("speaker", "")
                                if isinstance(text, str) and text.strip():
                                    field_path = f"cutscenes[{cs_id}].steps[{si}].tracks[{ti}].text"
                                    field_counter += 1
                                    entries.append(TextEntry(
                                        uid=make_uid("cutscenes_dialogue", file_rel, field_path),
                                        source_text=text,
                                        file_path=file_rel,
                                        field_path=field_path,
                                        file_type="cutscenes_dialogue",
                                        category="cutscene",
                                        group_id=group_id,
                                        group_label=group_label,
                                        field_label=f"对话(并行) #{field_counter}",
                                        tags=[f"cutscene_id:{cs_id}", f"speaker:{speaker}", f"step:parallel"],
                                    ))

        return entries
