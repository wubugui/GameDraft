"""Local server for the character lighting lab viewer.

Static viewer + a tiny ASYNC bake job queue so ALL baking lives in the app:
  GET  /api/scenes                  -> [manifest...]
  GET  /api/rebuild?scene=X&...     -> {job} queue rebake of one scene
  GET  /api/rebuild_all             -> {job} queue rebake of every scene
  POST /api/build_new?name=X&...    -> {job} body = image bytes; new scene
  GET  /api/job?id=N                -> {status, log, queue}
Jobs run serially in a worker thread; logs stream into the job record.
"""
from __future__ import annotations

import json
import re
import subprocess
import sys
import threading
from http.server import SimpleHTTPRequestHandler
from pathlib import Path
from urllib.parse import urlparse, parse_qs

TOOL = Path(__file__).resolve().parent
PORT = 5311

REBUILD_KEYS = {'pitch_deg', 'ppu_ratio', 'ev', 'max_gain_ev', 'vol_nx', 'vol_nz',
                'probe_nx', 'probe_ny', 'probe_nz', 'probe_dirs', 'probe_band',
                'fold', 'relief', 'semantic_gate', 'occluder_tau', 'thickness_k',
                'bg_thickness_q', 'ground_up_dot', 'walk_res'}

# ---------------------------------------------------------------- job queue
_jobs: dict[int, dict] = {}
_queue: list[int] = []
_lock = threading.Lock()
_next_id = [1]
_worker_started = [False]


def _run_bake(job: dict) -> None:
    for scene, extra in job['builds']:
        src = TOOL / 'out' / scene / 'background.png'
        cmd = [sys.executable, str(TOOL / 'pipeline.py'), str(src), '--name', scene, *extra]
        job['log'] += f'\n=== {scene} ===\n'
        p = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                             text=True, bufsize=1)
        for line in p.stdout:
            job['log'] = (job['log'] + line)[-12000:]
        p.wait()
        if p.returncode != 0:
            job['status'] = 'failed'
            return
    job['status'] = 'done'


def _worker() -> None:
    while True:
        with _lock:
            jid = _queue.pop(0) if _queue else None
        if jid is None:
            threading.Event().wait(0.3)
            continue
        job = _jobs[jid]
        job['status'] = 'running'
        try:
            _run_bake(job)
        except Exception as e:                     # noqa: BLE001
            job['log'] += f'\nEXCEPTION: {e}'
            job['status'] = 'failed'


def _enqueue(builds: list[tuple[str, list[str]]], label: str) -> dict:
    with _lock:
        if not _worker_started[0]:
            threading.Thread(target=_worker, daemon=True).start()
            _worker_started[0] = True
        jid = _next_id[0]; _next_id[0] += 1
        _jobs[jid] = {'id': jid, 'label': label, 'status': 'queued',
                      'log': '', 'builds': builds}
        _queue.append(jid)
    return {'ok': True, 'job': jid}


def _extra_from_query(q: dict) -> list[str]:
    extra: list[str] = []
    for k, v in q.items():
        if k in REBUILD_KEYS:
            extra += [f'--{k}', v[0]]
    return extra


class H(SimpleHTTPRequestHandler):
    def __init__(self, *a, **k):
        super().__init__(*a, directory=str(TOOL), **k)

    def _json(self, obj, code=200):
        body = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        u = urlparse(self.path)
        q = parse_qs(u.query)
        if u.path == '/':
            self.path = '/viewer/index.html'
            return super().do_GET()
        if u.path == '/api/scenes':
            scenes = []
            for m in sorted((TOOL / 'out').glob('*/manifest.json')):
                try:
                    scenes.append(json.loads(m.read_text()))
                except Exception:
                    pass
            return self._json(scenes)
        if u.path == '/api/job':
            jid = int(q.get('id', ['0'])[0])
            job = _jobs.get(jid)
            if not job:
                return self._json({'ok': False, 'err': 'no such job'}, 404)
            with _lock:
                pos = _queue.index(jid) + 1 if jid in _queue else 0
            return self._json({'ok': True, 'status': job['status'],
                               'label': job['label'], 'queue_position': pos,
                               'log': job['log'][-3000:]})
        if u.path == '/api/export':
            name = q.get('scene', [''])[0]
            if not name or not (TOOL / 'out' / name / 'manifest.json').exists():
                return self._json({'ok': False, 'err': 'unknown scene'}, 400)
            if not (TOOL / 'out' / name / 'walk_depth.bin').exists():
                return self._json({'ok': False, 'err': '该场景需先重烘一次(缺 walk_depth.bin)'}, 400)
            try:
                sys.path.insert(0, str(TOOL.parents[1]))
                from tools.character_lighting_lab.pipeline import export_runtime
                dest = export_runtime(name)
                return self._json({'ok': True, 'dest': str(dest)})
            except Exception as e:                     # noqa: BLE001
                return self._json({'ok': False, 'err': str(e)}, 500)
        if u.path == '/api/rebuild':
            name = q.get('scene', [''])[0]
            if not name or not (TOOL / 'out' / name / 'background.png').exists():
                return self._json({'ok': False, 'err': 'unknown scene'}, 400)
            return self._json(_enqueue([(name, _extra_from_query(q))], f'重烘 {name}'))
        if u.path == '/api/rebuild_all':
            extra = _extra_from_query(q)
            builds = []
            for m in sorted((TOOL / 'out').glob('*/manifest.json')):
                try:
                    man = json.loads(m.read_text())
                except Exception:
                    continue
                per = list(extra)
                # keep each scene's own baked params for anything not overridden
                for k, v in man.get('params', {}).items():
                    if k in REBUILD_KEYS and f'--{k}' not in per:
                        per += [f'--{k}', str(v)]
                builds.append((man['name'], per))
            if not builds:
                return self._json({'ok': False, 'err': 'no scenes'}, 400)
            return self._json(_enqueue(builds, f'重烘全部 {len(builds)} 场景'))
        return super().do_GET()

    def do_POST(self):
        u = urlparse(self.path)
        q = parse_qs(u.query)
        if u.path == '/api/build_new':
            raw_name = q.get('name', ['scene'])[0]
            try:  # undo latin-1 mojibake when the client sent raw UTF-8 bytes
                raw_name = raw_name.encode('latin-1').decode('utf-8')
            except (UnicodeEncodeError, UnicodeDecodeError):
                pass
            name = re.sub(r'[^\w一-鿿-]+', '_', raw_name).strip('_') or 'scene'
            length = int(self.headers.get('Content-Length', 0))
            if length <= 0 or length > 64 * 1024 * 1024:
                return self._json({'ok': False, 'err': 'bad image size'}, 400)
            data = self.rfile.read(length)
            dest = TOOL / 'out' / name
            dest.mkdir(parents=True, exist_ok=True)
            (dest / 'background.png').write_bytes(data)
            return self._json({**_enqueue([(name, _extra_from_query(q))], f'新场景 {name}'),
                               'scene': name})
        return self._json({'ok': False, 'err': 'unknown endpoint'}, 404)

    def log_message(self, *a):
        pass


if __name__ == '__main__':
    from http.server import ThreadingHTTPServer
    port = int(sys.argv[1]) if len(sys.argv) > 1 else PORT
    print(f'character lighting lab: http://localhost:{port}/')
    ThreadingHTTPServer(('127.0.0.1', port), H).serve_forever()
