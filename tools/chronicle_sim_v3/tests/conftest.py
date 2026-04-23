"""v3 测试的 pytest 配置。

刻意与 v2 conftest 完全独立：v2 的 conftest 在 tools/chronicle_sim_v2/tests/，
本文件只在 v3 测试根加载，不会与 v2 产生交叉 fixture。

仅做一件事：把仓库根注入 sys.path，让 `import tools.chronicle_sim_v3.*` 成立。
"""
from __future__ import annotations

import sys
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parents[3]
if str(_REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(_REPO_ROOT))
