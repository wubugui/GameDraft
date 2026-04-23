"""canonical_json / canonical_hash 稳定性。"""
from __future__ import annotations

import math

import pytest

from tools.chronicle_sim_v3.engine.canonical import (
    canonical_hash,
    canonical_json,
    sha256_hex,
)


def test_dict_key_order_irrelevant() -> None:
    a = {"x": 1, "y": 2, "z": 3}
    b = {"z": 3, "y": 2, "x": 1}
    assert canonical_json(a) == canonical_json(b)
    assert canonical_hash(a) == canonical_hash(b)


def test_nested_dict_stable() -> None:
    a = {"a": {"b": {"c": 1, "d": 2}}}
    b = {"a": {"b": {"d": 2, "c": 1}}}
    assert canonical_hash(a) == canonical_hash(b)


def test_list_order_matters() -> None:
    a = [1, 2, 3]
    b = [3, 2, 1]
    assert canonical_hash(a) != canonical_hash(b)


def test_chinese_not_escaped() -> None:
    s = canonical_json({"name": "中文"})
    assert "中文" in s
    assert "\\u" not in s


def test_compact_separators() -> None:
    s = canonical_json({"a": 1, "b": 2})
    assert " " not in s
    assert s == '{"a":1,"b":2}'


def test_floats_stable() -> None:
    a = {"v": 0.1 + 0.2}
    b = {"v": 0.30000000000000004}
    assert canonical_hash(a) == canonical_hash(b)


def test_nan_inf_rejected() -> None:
    with pytest.raises(ValueError):
        canonical_json({"v": math.nan})
    with pytest.raises(ValueError):
        canonical_json({"v": math.inf})


def test_set_normalized_to_sorted_list() -> None:
    a = canonical_json({"x": {3, 1, 2}})
    b = canonical_json({"x": [1, 2, 3]})
    assert a == b


def test_tuple_treated_as_list() -> None:
    assert canonical_json((1, 2, 3)) == canonical_json([1, 2, 3])


def test_bytes_hashed_into_marker() -> None:
    s = canonical_json({"b": b"abc"})
    assert "bytes:sha256:" in s


def test_unsupported_type_raises() -> None:
    class X: ...
    with pytest.raises(TypeError):
        canonical_json({"v": X()})


def test_sha256_hex_known_value() -> None:
    assert sha256_hex("abc") == (
        "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    )


def test_canonical_hash_full_length() -> None:
    h = canonical_hash({"a": 1})
    assert len(h) == 64
    assert all(c in "0123456789abcdef" for c in h)
