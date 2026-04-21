"""将 GameDraft 根目录加入 sys.path，使 `tools.chronicle_sim_v2.*` 可导入。"""
from __future__ import annotations

import sys
from pathlib import Path

_THIS = Path(__file__).resolve()
_GAMEDRAFT_ROOT = _THIS.parents[3]
if str(_GAMEDRAFT_ROOT) not in sys.path:
    sys.path.insert(0, str(_GAMEDRAFT_ROOT))
