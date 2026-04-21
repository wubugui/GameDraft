"""CI 冒烟：核心依赖可导入；可选检测 Cline CLI。"""
from __future__ import annotations

import shutil

import mcp  # noqa: F401
import pydantic  # noqa: F401

print("pydantic", pydantic.__version__)
print("mcp", mcp.__version__)

exe = shutil.which("cline")
if exe:
    print("cline", exe)
else:
    print("cline", "not found in PATH (install: npm i -g cline)")
