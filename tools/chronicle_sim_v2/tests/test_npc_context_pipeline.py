"""npc_context_pipeline 纯规则与落盘辅助。"""
from __future__ import annotations

from tools.chronicle_sim_v2.core.sim.npc_context_pipeline import (
    build_public_digest,
    location_id_for_agent,
)
from tools.chronicle_sim_v2.core.world.fs import write_json


def test_public_digest_skips_what_happened_only(tmp_path) -> None:
    ev = {
        "id": "e1",
        "truth_json": {"what_happened": "秘密", "who_knows_what": {}},
    }
    pub = build_public_digest(tmp_path, 1, [ev])
    assert pub["notices"] == []


def test_public_digest_uses_who_knows_public(tmp_path) -> None:
    ev = {
        "id": "e2",
        "truth_json": {"who_knows_what": {"公开": "街面上都在传"}},
    }
    pub = build_public_digest(tmp_path, 1, [ev])
    assert len(pub["notices"]) == 1


def test_location_id_for_agent_maps_name(tmp_path) -> None:
    (tmp_path / "world" / "locations").mkdir(parents=True, exist_ok=True)
    write_json(
        tmp_path,
        "world/locations/loc_x.json",
        {"id": "loc_x", "name": "茶馆", "description": ""},
    )
    ag = {"current_location": "茶馆"}
    assert location_id_for_agent(tmp_path, ag) == "loc_x"
