"""NodeKind 全局注册表（RFC v3-engine.md §6.3）。

`@register_node` 把节点类的 `spec.kind` 映射到 class，`Engine` / GUI / CLI 用此查找。
"""
from __future__ import annotations

from typing import TypeVar

from tools.chronicle_sim_v3.engine.errors import ValidationError
from tools.chronicle_sim_v3.engine.node import Node, NodeKindSpec


_REGISTRY: dict[str, type] = {}


T = TypeVar("T", bound=type)


def register_node(cls: T) -> T:
    """装饰器：要求 cls 有 class 属性 spec: NodeKindSpec。"""
    spec = getattr(cls, "spec", None)
    if not isinstance(spec, NodeKindSpec):
        raise ValidationError(
            f"{cls.__name__} 缺少 class-level NodeKindSpec spec 属性"
        )
    if spec.kind in _REGISTRY:
        existing = _REGISTRY[spec.kind]
        if existing is not cls:
            raise ValidationError(
                f"NodeKind {spec.kind!r} 已被 {existing.__name__} 注册"
            )
    _REGISTRY[spec.kind] = cls
    return cls


def get_node_class(kind: str) -> type:
    if kind not in _REGISTRY:
        raise ValidationError(f"未注册的 NodeKind: {kind!r}")
    return _REGISTRY[kind]


def list_kinds(category: str | None = None) -> list[str]:
    items = sorted(_REGISTRY.keys())
    if category:
        items = [k for k in items if _REGISTRY[k].spec.category == category]
    return items


def all_specs() -> list[NodeKindSpec]:
    return [c.spec for _, c in sorted(_REGISTRY.items())]


def reset_registry_for_tests() -> None:
    """仅供测试：清空注册表。生产代码不要调。"""
    _REGISTRY.clear()
