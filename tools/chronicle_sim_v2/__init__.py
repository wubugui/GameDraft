"""ChronicleSim v2 — 编年史模拟器（完全重构版）。"""

from __future__ import annotations

import logging
import os

# 任意 `import tools.chronicle_sim_v2...` 时尽早生效（须在 import pydantic/litellm 之前）。
os.environ.setdefault("CREWAI_TRACING_ENABLED", "false")
os.environ.setdefault("PYDANTIC_DISABLE_PLUGINS", "1")
logging.getLogger("LiteLLM").setLevel(logging.ERROR)
