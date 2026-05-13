#!/usr/bin/env python3
"""
Heuristic scan: PowerShell double-quoted strings treat (word ...) as subexpressions.
Flag throw/Write-Host lines where " ... (Letter ..." appears without $( before '('.
Run: python3 scripts/scan_ps_doublequote_subexpr.py
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent


def string_has_risky_paren(s: str) -> bool:
    i = 0
    while True:
        j = s.find("(", i)
        if j < 0:
            return False
        if j > 0 and s[j - 1] == "$":
            i = j + 1
            continue
        if j + 1 < len(s) and s[j + 1].isalpha():
            return True
        i = j + 1


def scan_file(path: Path) -> list[tuple[int, str]]:
    hits: list[tuple[int, str]] = []
    text = path.read_text(encoding="utf-8")
    for lineno, line in enumerate(text.splitlines(), 1):
        raw = line
        if "#" in line:
            line = line.split("#", 1)[0]
        stripped = line.rstrip()
        if "throw" not in stripped and "Write-Host" not in stripped:
            continue
        if '`""' in stripped:
            continue
        m = re.search(r'(?:throw|Write-Host)\s+"([^"]*)"', stripped, re.IGNORECASE)
        if not m:
            continue
        inner = m.group(1)
        if string_has_risky_paren(inner):
            hits.append((lineno, raw.strip()))
    return hits


def main() -> int:
    bad = False
    for path in sorted(ROOT.glob("*.ps1")):
        if path.name == "scan_ps_doublequote_subexpr.py":
            continue
        hits = scan_file(path)
        if hits:
            bad = True
            print(f"{path.name}:")
            for ln, content in hits:
                print(f"  L{ln}: {content[:200]}")
    if bad:
        print(
            "\nFix: use single-quoted strings, concatenation, or -f with a single-quoted format string.",
            file=sys.stderr,
        )
        return 1
    print("OK: no risky throw/Write-Host double-quoted ( bare (Word patterns in scripts/*.ps1")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
