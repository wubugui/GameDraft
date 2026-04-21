"""ChronicleSim v2 — 编年史模拟器（完全重构版）。"""

from __future__ import annotations

import os

# 任意 `import tools.chronicle_sim_v2...` 时尽早生效。
os.environ.setdefault("PYDANTIC_DISABLE_PLUGINS", "1")
