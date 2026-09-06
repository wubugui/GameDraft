"""Use pytest so repository filesystem, QSettings and Qt guards remain active."""
import subprocess
import sys
from pathlib import Path

subprocess.run([
    sys.executable, '-m', 'pytest', '-q', '-o', 'addopts=',
    'tools/editor/tests/test_open_world_forms_roundtrip.py',
    'tools/dialogue_graph_editor/tests/test_inspector_roundtrip.py',
], cwd=Path(__file__).resolve().parents[2], check=True)
