"""Context schema 注册表。

目标：
- key/path/listing/text/yaml 判定统一走 schema，而不是写死在 keymap.py
- 新增内容只需改 data/context_schema.yaml，不必改 Context 核心代码
- 保持现有 v3 key 兼容
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from functools import lru_cache
from pathlib import Path
from typing import Any

from tools.chronicle_sim_v3.engine.errors import ValidationError
from tools.chronicle_sim_v3.engine.io import read_yaml

_PLACEHOLDER_RE = re.compile(r"\{([a-zA-Z_][a-zA-Z0-9_]*)(?::[^}]+)?\}")
_DIGITS_RE = re.compile(r"^-?\d+$")


def _coerce_value(value: Any) -> Any:
    if isinstance(value, str) and _DIGITS_RE.match(value):
        try:
            return int(value)
        except ValueError:
            return value
    return value


def _compile_template_regex(template: str) -> re.Pattern[str]:
    parts: list[str] = []
    last = 0
    for m in _PLACEHOLDER_RE.finditer(template):
        parts.append(re.escape(template[last : m.start()]))
        name = m.group(1)
        parts.append(f"(?P<{name}>[^/]+)")
        last = m.end()
    parts.append(re.escape(template[last:]))
    return re.compile("^" + "".join(parts) + "$")


def _render_template(template: str, params: dict[str, str], placeholders: tuple[str, ...]) -> str:
    values: dict[str, Any] = {k: _coerce_value(v) for k, v in params.items()}
    if "_" in values and len(placeholders) == 1:
        values.setdefault(placeholders[0], values["_"])
    missing = [name for name in placeholders if name not in values]
    if missing:
        raise ValidationError(f"模板 {template!r} 缺少参数: {missing}")
    try:
        return template.format(**values)
    except Exception as e:
        raise ValidationError(f"模板渲染失败 {template!r}: {e}") from e


@dataclass(frozen=True)
class SchemaRecord:
    base: str
    path_template: str
    storage: str = "json"
    key_template: str = ""
    placeholders: tuple[str, ...] = field(default_factory=tuple)
    path_regex: re.Pattern[str] | None = None

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "SchemaRecord":
        path_template = str(data.get("path") or "")
        if not path_template:
            raise ValidationError(f"record {data.get('base')!r} 缺少 path")
        placeholders = tuple(m.group(1) for m in _PLACEHOLDER_RE.finditer(path_template))
        return cls(
            base=str(data["base"]),
            path_template=path_template,
            storage=str(data.get("storage", "json")),
            key_template=str(data.get("key_template") or ""),
            placeholders=placeholders,
            path_regex=_compile_template_regex(path_template),
        )

    def render_path(self, params: dict[str, str]) -> Path:
        return Path(_render_template(self.path_template, params, self.placeholders))

    def key_from_path(self, rel_path: str) -> str | None:
        if self.path_regex is None:
            return None
        m = self.path_regex.match(rel_path)
        if not m:
            return None
        captures = {k: v for k, v in m.groupdict().items() if v is not None}
        if not captures:
            return self.base
        if self.key_template:
            try:
                rendered = self.key_template.format(
                    **{k: _coerce_value(v) for k, v in captures.items()}
                )
                if rendered.startswith(self.base):
                    return rendered
                return f"{self.base}:{rendered}"
            except Exception as e:
                raise ValidationError(
                    f"record {self.base!r} key_template 渲染失败: {e}"
                ) from e
        ordered = ",".join(f"{k}={captures[k]}" for k in sorted(captures.keys()))
        return f"{self.base}:{ordered}"


@dataclass(frozen=True)
class SchemaCollection:
    base: str
    path_template: str
    scan_glob: str
    scan_regex: re.Pattern[str]
    item_key_template: str
    placeholders: tuple[str, ...] = field(default_factory=tuple)

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "SchemaCollection":
        path_template = str(data.get("path") or "")
        scan_glob = str(data.get("scan_glob") or "")
        scan_regex = str(data.get("scan_regex") or "")
        item_key_template = str(data.get("item_key_template") or "")
        if not path_template or not scan_glob or not scan_regex or not item_key_template:
            raise ValidationError(f"collection {data.get('base')!r} 配置不完整")
        placeholders = tuple(m.group(1) for m in _PLACEHOLDER_RE.finditer(path_template))
        return cls(
            base=str(data["base"]),
            path_template=path_template,
            scan_glob=scan_glob,
            scan_regex=re.compile(scan_regex),
            item_key_template=item_key_template,
            placeholders=placeholders,
        )

    def render_dir(self, params: dict[str, str]) -> Path:
        return Path(_render_template(self.path_template, params, self.placeholders))

    def iter_keys(self, run_dir: Path, params: dict[str, str]) -> list[str]:
        base_dir = (Path(run_dir) / self.render_dir(params)).resolve()
        if not base_dir.exists():
            return []
        out: list[str] = []
        for path in sorted(base_dir.glob(self.scan_glob)):
            rel = path.relative_to(base_dir).as_posix()
            m = self.scan_regex.match(rel)
            if not m:
                continue
            values = {**params, **{k: v for k, v in m.groupdict().items() if v is not None}}
            try:
                out.append(self.item_key_template.format(**{k: _coerce_value(v) for k, v in values.items()}))
            except Exception as e:
                raise ValidationError(
                    f"collection {self.base!r} 构造 item key 失败: {self.item_key_template!r}: {e}"
                ) from e
        return out


class ContextSchemaRegistry:
    def __init__(self, *, records: dict[str, SchemaRecord], collections: dict[str, SchemaCollection]) -> None:
        self.records = records
        self.collections = collections
        self._records_by_storage: dict[str, set[str]] = {}
        self._path_records = list(records.values())
        self._parent_listings: dict[str, tuple[str, ...]] = self._build_parent_listings()
        for base, entry in records.items():
            self._records_by_storage.setdefault(entry.storage, set()).add(base)

    def _build_parent_listings(self) -> dict[str, tuple[str, ...]]:
        mapping: dict[str, list[str]] = {}
        for listing_base, entry in self.collections.items():
            item_base = entry.item_key_template.split(":", 1)[0]
            if "." not in item_base:
                continue
            mapping.setdefault(item_base, []).append(listing_base)
        return {k: tuple(sorted(v)) for k, v in mapping.items()}

    def record_for(self, base: str) -> SchemaRecord | None:
        return self.records.get(base)

    def collection_for(self, base: str) -> SchemaCollection | None:
        return self.collections.get(base)

    def is_listing_base(self, base: str) -> bool:
        return base in self.collections

    def storage_for(self, base: str) -> str | None:
        rec = self.records.get(base)
        return rec.storage if rec else None

    def parent_listings_for(self, base: str) -> tuple[str, ...]:
        return self._parent_listings.get(base, ())

    def key_to_path(self, base: str, params: dict[str, str]) -> Path:
        if base in self.collections:
            return self.collections[base].render_dir(params)
        rec = self.records.get(base)
        if rec is None:
            raise ValidationError(f"未知 key base: {base!r}")
        return rec.render_path(params)

    def scan_keys(self, base: str, params: dict[str, str], run_dir: Path) -> list[str]:
        collection = self.collections.get(base)
        if collection is None:
            raise ValidationError(f"scan_keys 不支持: {base!r}")
        return collection.iter_keys(run_dir, params)

    def path_to_key(self, rel_path: str) -> str:
        for rec in self._path_records:
            key = rec.key_from_path(rel_path)
            if key is not None:
                return key
        raise ValidationError(f"path 无对应 key: {rel_path}")


@lru_cache(maxsize=1)
def load_context_schema_registry() -> ContextSchemaRegistry:
    schema_path = Path(__file__).resolve().parents[1] / "data" / "context_schema.yaml"
    raw = read_yaml(schema_path)
    if not isinstance(raw, dict):
        raise ValidationError("context_schema.yaml 顶层必须是 mapping")
    records_raw = raw.get("records") or []
    collections_raw = raw.get("collections") or []
    if not isinstance(records_raw, list) or not isinstance(collections_raw, list):
        raise ValidationError("context_schema.yaml 中 records/collections 必须是 list")
    records = {
        str(item["base"]): SchemaRecord.from_dict(item)
        for item in records_raw
    }
    collections = {
        str(item["base"]): SchemaCollection.from_dict(item)
        for item in collections_raw
    }
    return ContextSchemaRegistry(records=records, collections=collections)
