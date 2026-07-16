#!/usr/bin/env python3
"""Thin wrapper for the skill/workflow governance CLI."""

from __future__ import annotations

import sys
from pathlib import Path


HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

from skill_workflow_governance.cli import main  # noqa: E402


if __name__ == "__main__":
    raise SystemExit(main())
