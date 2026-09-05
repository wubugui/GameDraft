# -*- coding: utf-8 -*-
"""世界空间帧 → 画面空间帧的投影：与 TS 侧共用同一份金标（``src/utils/trajectoryProjection.golden.json``）。

金标是**读进来**的，不是抄一份数字——抄一份等于把契约劈成两半。
两侧表达式逐项同序，所以这里断的是**逐位相等**（TS 侧 1e-9 容差是 vitest 的 toBeCloseTo 习惯）。
"""
from __future__ import annotations

import json
import math
import sys
from pathlib import Path

import pytest

_ROOT = Path(__file__).resolve().parents[3]
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

from tools.trajectory_workbench.projection import (  # noqa: E402
    basis_rows_from_R,
    flip_keyframes,
    project_world_keyframes,
    project_world_offset,
)

_GOLDEN = _ROOT / "src" / "utils" / "trajectoryProjection.golden.json"


def _cases() -> list[dict]:
    return json.loads(_GOLDEN.read_text(encoding="utf-8"))


def test_golden_present_and_not_hollow() -> None:
    cases = _cases()
    assert len(cases) >= 3
    for c in cases:
        assert len(c["expect"]) == len(c["frames"])


@pytest.mark.parametrize("case", _cases(), ids=lambda c: c["name"])
def test_python_projection_matches_golden_bitwise(case: dict) -> None:
    rows = basis_rows_from_R(case["R"])
    assert rows is not None
    got = project_world_keyframes(case["frames"], rows)
    assert len(got) == len(case["expect"])
    for g, e in zip(got, case["expect"]):
        assert set(g.keys()) == set(e.keys()), (g, e)
        for k, v in e.items():
            assert g[k] == v, (k, g[k], v)


def test_basis_rejects_lab_matrix_and_bad_shapes() -> None:
    c = math.sqrt(0.5)
    assert basis_rows_from_R(None) is None
    assert basis_rows_from_R([[1, 0], [0, 1]]) is None
    assert basis_rows_from_R([[1, 0, 0], [0, 1, 0], [0, 0, "x"]]) is None
    assert basis_rows_from_R([[1, 0, 0], [0, c, -c], [0, -c, -c]]) is None      # det = −1（实验室那份）
    assert basis_rows_from_R([[1, 0, 0], [0, c, -c], [0, c, c]]) == [1, 0, 0, 0, c, -c, 0, c, c]


def test_projection_is_linear_and_orientation_sane() -> None:
    rows = [1, 0, 0, 0, 0.8, -0.6, 0, 0.6, 0.8]
    a = project_world_offset(rows, 10, 20, 30)
    b = project_world_offset(rows, 10 + 999, 20 - 123, 30 + 5)
    base = project_world_offset(rows, 999, -123, 5)
    assert abs((b[0] - base[0]) - a[0]) < 1e-9 and abs((b[1] - base[1]) - a[1]) < 1e-9
    assert project_world_offset(rows, 0, 100, 0)[1] < 0     # 往上 → 画面 y 变小
    assert project_world_offset(rows, 0, 0, 100)[1] < 0     # 往远 → 画面 y 变小
    assert project_world_offset(rows, 100, 0, 0)[0] == 100


def test_flip_negates_x_and_rotation_only() -> None:
    out = flip_keyframes([{"atMs": 0, "x": 10, "y": 20, "rotation": 30, "scaleX": 2, "sortY": 25}, {"atMs": 1, "x": -3, "y": 4}])
    assert out == [{"atMs": 0, "x": -10, "y": 20, "rotation": -30, "scaleX": 2, "sortY": 25}, {"atMs": 1, "x": 3, "y": 4}]
