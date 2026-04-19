from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


@dataclass
class ProviderProfile:
    kind: str = "stub"
    base_url: str = ""
    api_key: str = ""
    model: str = "stub"
    ollama_host: str = "http://127.0.0.1:11434"
    extra: dict[str, Any] = field(default_factory=dict)
