from __future__ import annotations

"""Lightweight LSP placeholder for GameDraft authoring files.

The production extension can start this process and later wire diagnostics,
completion, hover, definition, and references to the same parser / indexer used
by tools.content_pipeline. The file is intentionally dependency-light: it exits
with an explanatory message when pygls is not installed instead of adding a hard
runtime dependency to the game project.
"""

import json
import sys
from pathlib import Path


def main() -> int:
    try:
        import pygls  # type: ignore  # noqa: F401
    except Exception:
        sys.stderr.write(
            "GameDraft authoring LSP requires pygls. "
            "Install it in the tooling Python env when enabling live VS Code diagnostics.\n"
        )
        return 0

    # Full server wiring is kept behind the optional dependency boundary. The
    # compiler / validator already work without pygls; VS Code can call the CLI
    # today and upgrade to a live LSP later without touching runtime code.
    sys.stdout.write(json.dumps({"status": "pygls available", "root": str(Path.cwd())}) + "\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
