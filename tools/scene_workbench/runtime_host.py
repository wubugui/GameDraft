"""Owns just the private preview child process; never discovers/kills other PIDs."""
from __future__ import annotations

import json
import queue
import shutil
import subprocess
import threading
import uuid
from pathlib import Path

TOOL = Path(__file__).resolve().parent


class RuntimeHost:
    def __init__(self, work_dir: Path | None = None):
        self.work_dir = work_dir or TOOL / '.runtime' / uuid.uuid4().hex
        self.process = None
        self.url = ''
        self.lock = threading.Lock()

    def start(self) -> str:
        with self.lock:
            if self.process and self.process.poll() is None and self.url:
                return self.url
            node = shutil.which('node')
            if not node:
                raise RuntimeError('未找到工程 Node.js')
            self.work_dir.mkdir(parents=True, exist_ok=True)
            ready = queue.Queue()
            self.process = subprocess.Popen([node, str(TOOL / 'runtime-server.mjs'), str(self.work_dir)],
                cwd=TOOL, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                text=True, encoding='utf-8', errors='replace',
                creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
            child = self.process
            def consume():
                with (self.work_dir / 'server.log').open('w', encoding='utf-8') as log:
                    for line in child.stdout:
                        log.write(line)
                        log.flush()
                        try:
                            value = json.loads(line)
                            if isinstance(value, dict) and value.get('ready'):
                                ready.put(value['url'])
                        except (ValueError, KeyError):
                            pass
                ready.put(None)
            threading.Thread(target=consume, daemon=True).start()
            try:
                url = ready.get(timeout=40)
                if not url:
                    raise RuntimeError(f'独立预览启动失败，请查看 {self.work_dir / "server.log"}')
                self.url = url
                return url
            except queue.Empty:
                self.stop()
                raise RuntimeError(f'独立预览启动超时，请查看 {self.work_dir / "server.log"}') from None

    def stop(self):
        child, self.process = self.process, None
        self.url = ''
        if not child or child.poll() is not None:
            return
        try:
            child.stdin.write('stop\n')
            child.stdin.flush()
            child.wait(timeout=8)
        except (OSError, subprocess.TimeoutExpired):
            child.terminate()
            child.wait(timeout=5)
