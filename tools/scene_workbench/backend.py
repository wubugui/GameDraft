"""Thin adapters. No JSON serializer, trajectory baker or acoustics normalizer here.

All business writes go through their existing owners. Version tokens guard stale
UI documents; they do not replace the original owners' validation/transactions.
"""
from __future__ import annotations

import copy
import hashlib
import json
import threading
import time
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from tools.trajectory_workbench import assets
from tools.trajectory_workbench import serve as trajectory
from tools.acoustic_workbench import spaces
from tools.editor.editors import scene_lights

TOOL = Path(__file__).resolve().parent
ROOT = TOOL.parents[1]


class Conflict(ValueError):
    pass


def revision(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest() if path.exists() else 'absent'


class Backend:
    def __init__(self, root: Path = ROOT, game_url: str = ''):
        self.root = root
        self.lock = threading.RLock()
        # Owned transport: never changes the old editor's global endpoint/client.
        self.game_url = lambda: game_url.rstrip('/')
        class UnconnectedTransport(scene_lights.LightingSyncTransport):
            def candidates(self):
                return []
        self.transport = UnconnectedTransport(self.game_url)
        self.external_game_url = game_url
        self.runtime_phases = {}
        from .runtime_host import RuntimeHost
        self.runtime = RuntimeHost()

    def start_runtime(self):
        url = self.external_game_url or self.runtime.start()
        class FixedTransport(scene_lights.LightingSyncTransport):
            def candidates(self):
                return [url]
        self.transport = FixedTransport(lambda: url)
        self.game_url = lambda: url
        return {'url': url, 'available': True, 'isolated': not bool(self.external_game_url)}

    def close(self):
        self.runtime.stop()

    def path(self, kind: str, ident: str) -> Path:
        if not assets.valid_id(ident):
            raise ValueError('非法资产标识')
        if kind == 'scene':
            return self.root / 'public/assets/scenes' / f'{ident}.json'
        if kind == 'trajectory':
            return assets.asset_path(ident)
        if kind == 'acoustic':
            return self.root / 'public/assets/data/acoustic_spaces.json'
        raise ValueError('未知文档类型')

    def read(self, kind: str, ident: str) -> dict:
        with self.lock:
            path = self.path(kind, ident)
            before = revision(path)
            if kind == 'scene':
                # ProjectModel is also the reader: no second scene-loading policy.
                from tools.editor.project_model import ProjectModel
                model = ProjectModel()
                model.load_project(self.root)
                doc = copy.deepcopy(model.scenes.get(ident))
            elif kind == 'trajectory':
                doc = assets.load_asset(ident)
            else:
                doc = spaces.get_space(ident, path)
            if before != revision(path):
                raise Conflict('文件正在被其他工具修改，请重新打开')
            if doc is None:
                raise FileNotFoundError(ident)
            return {'doc': doc, 'revision': before}

    def save(self, kind: str, ident: str, doc: dict, expected: str, create: bool = False) -> dict:
        with self.lock:
            path = self.path(kind, ident)
            if revision(path) != expected:
                raise Conflict('磁盘文件已被其他工具修改；当前编辑仍保留，请先处理外部变更')
            if not isinstance(doc, dict):
                raise ValueError('文档必须是对象')
            if kind == 'scene':
                from tools.editor.project_model import ProjectModel
                model = ProjectModel()
                model.load_project(self.root)
                # Recheck after loading, before installing the UI snapshot.
                if revision(path) != expected:
                    raise Conflict('读取期间文件已变化，请重新打开')
                if ident not in model.scenes or doc.get('id') != model.scenes[ident].get('id'):
                    raise ValueError('此界面不创建或改名场景')
                if model.scenes[ident] != doc:
                    model.scenes[ident] = copy.deepcopy(doc)
                    model.mark_dirty('scene', ident)
                    changed = model.detect_external_changes()
                    if changed:
                        raise Conflict('场景发生外部修改，保存已停止')
                    model.save_all()
                saved = copy.deepcopy(model.scenes[ident])
                result = {'doc': saved}
            elif kind == 'trajectory':
                if doc.get('id') != ident:
                    raise ValueError('轨迹标识不匹配')
                result = trajectory.save_document(doc)
            else:
                if create and spaces.get_space(ident, path) is not None:
                    raise Conflict('同名声学空间已经存在，请换一个名称')
                _, saved = spaces.save_space(ident, doc, path)
                result = {'doc': saved}
            return {**result, 'revision': revision(path)}

    def catalog(self) -> dict:
        return {'scenes': trajectory.list_scenes(), 'trajectories': assets.list_assets(),
                'spaces': spaces.list_spaces(self.root / 'public/assets/data/acoustic_spaces.json')}


def handler_for(backend: Backend):
    class Handler(SimpleHTTPRequestHandler):
        def __init__(self, *args, **kwargs):
            super().__init__(*args, directory=str(TOOL / 'dist'), **kwargs)

        def log_message(self, *args):
            pass

        def end_headers(self):
            self.send_header('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0')
            self.send_header('Pragma', 'no-cache')
            self.send_header('Expires', '0')
            self.send_header('X-Content-Type-Options', 'nosniff')
            super().end_headers()

        def send(self, body, content_type='application/json; charset=utf-8', status=200):
            if not isinstance(body, bytes):
                body = json.dumps({'ok': True, **body}, ensure_ascii=False, allow_nan=False).encode('utf-8')
            self.send_response(status)
            self.send_header('Content-Type', content_type)
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def error(self, exc):
            code = 409 if isinstance(exc, Conflict) else 400
            self.send(json.dumps({'ok': False, 'err': str(exc)}, ensure_ascii=False).encode('utf-8'), status=code)

        def do_GET(self):
            u = urlparse(self.path)
            q = parse_qs(u.query)
            arg = lambda key, default='': q.get(key, [default])[0]
            try:
                if u.path == '/api/catalog':
                    return self.send(backend.catalog())
                if u.path == '/api/acoustic-revision':
                    return self.send({'revision': revision(backend.root / 'public/assets/data/acoustic_spaces.json')})
                if u.path == '/api/document':
                    return self.send(backend.read(arg('kind'), arg('id')))
                if u.path == '/api/scene':
                    with backend.lock:
                        g = trajectory.get_geometry(arg('id'), arg('bg') or None)
                        return self.send({'scene': g.summary()})
                if u.path == '/api/background':
                    sid = arg('id')
                    p = trajectory.scene_paths(sid)
                    bg = arg('bg') or p['bg_name']
                    from tools.trajectory_workbench.geometry import scene_backgrounds
                    if bg not in scene_backgrounds(sid):
                        raise ValueError('背景不属于所选场景')
                    return self.send(trajectory.scaled_background(sid, bg, 2048), 'image/png')
                if u.path in ('/api/ground', '/api/heightfield', '/api/mesh'):
                    with backend.lock:
                        g = trajectory.get_geometry(arg('id'), arg('bg') or None)
                        if not g.has_depth:
                            raise ValueError('场景没有深度数据')
                        data = {'/api/ground': g.ground_bytes, '/api/heightfield': g.heightfield_bytes,
                                '/api/mesh': lambda: g.mesh_bytes(stride=3)}[u.path]()
                        return self.send(data, 'application/octet-stream')
                if u.path == '/api/default-light':
                    return self.send({'light': scene_lights.default_light(int(arg('index', '0')), arg('kind', 'point')),
                                      'lighting': scene_lights.default_lighting_block()})
                if u.path == '/api/runtime':
                    base = backend.game_url()
                    _, _, error = backend.transport.fetch(time.time() * 1000, timeout=3.0)
                    return self.send({'url': backend.transport.candidates()[0] if not error else base,
                                      'available': not error, 'err': error})
                if u.path == '/reuse/exports.js':
                    return self.send(b'window.Legacy = {SceneCal, Edit, History, sampleScreen, sampleWorld};', 'text/javascript')
                if u.path == '/reuse/acoustic.js':
                    source = (ROOT / 'tools/acoustic_workbench/viewer/mathx.js').read_bytes()
                    return self.send(b'(function(){\n' + source + b'\nwindow.Legacy.AcousticGeo = Geo;})();', 'text/javascript')
                if u.path.startswith('/reuse/'):
                    name = u.path.rsplit('/', 1)[-1]
                    if name not in {'common.js', 'edit.js', 'history.js'}:
                        raise FileNotFoundError(name)
                    return self.send((ROOT / 'tools/trajectory_workbench/viewer' / name).read_bytes(), 'text/javascript')
                if u.path == '/':
                    self.path = '/index.html'
                return super().do_GET()
            except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
                return
            except Exception as exc:
                return self.error(exc)

        def do_POST(self):
            try:
                # Local application requests only; do not let unrelated web pages write.
                origin = self.headers.get('Origin')
                if origin and urlparse(origin).netloc != self.headers.get('Host'):
                    raise ValueError('请求来源与工作台不匹配')
                if 'application/json' not in self.headers.get('Content-Type', ''):
                    raise ValueError('需要 JSON 请求')
                n = int(self.headers.get('Content-Length', '0'))
                if not 0 < n <= 16 * 1024 * 1024:
                    raise ValueError('请求长度不合法')
                body = json.loads(self.rfile.read(n))
                route = urlparse(self.path).path
                if route == '/api/runtime/start':
                    return self.send(backend.start_runtime())
                if route == '/api/save':
                    return self.send(backend.save(body['kind'], body['id'], body['doc'], body['revision'], bool(body.get('create'))))
                if route == '/api/bake':
                    with backend.lock:
                        return self.send(trajectory.bake_document(body['doc']))
                if route == '/api/new-space':
                    return self.send({'doc': spaces.new_space_def(body['sceneId'], body.get('background', ''))})
                if route == '/api/light/retype':
                    return self.send({'light': scene_lights.retype(body['light'], body['kind'])})
                if route == '/api/lighting/publish':
                    current, age, err = backend.transport.fetch(time.time() * 1000, timeout=5.0)
                    if err:
                        raise ValueError(err)
                    _, err = scene_lights.validate_pulled_lighting(current, body['sceneId'])
                    if err or scene_lights.is_sync_doc_stale(age):
                        raise ValueError(err or '运行时灯光数据已过期，请重新进入场景')
                    if 'phase' in current and current.get('writer') != 'editor:scene-workbench':
                        backend.runtime_phases[body['sceneId']] = scene_lights.pulled_phase(current)
                    phase = backend.runtime_phases.get(body['sceneId'], '')
                    variant = (body.get('variants') or {}).get(phase, {}).get('lighting')
                    body['lighting'] = scene_lights.merge_lighting_for_phase(body['lighting'], variant)
                    errors = scene_lights.validate_lights(body['lighting'].get('lights', []))
                    if errors:
                        raise ValueError('；'.join(errors))
                    doc, err = backend.transport.publish(body['sceneId'], 'editor:scene-workbench', body['lighting'],
                                                        time.time() * 1000, timeout=5.0, selected_id=body.get('selectedId'))
                    if err:
                        raise ValueError(err)
                    return self.send({'doc': doc})
                if route == '/api/lighting/pull':
                    doc, age, err = backend.transport.fetch(time.time() * 1000, timeout=5.0)
                    if err:
                        raise ValueError(err)
                    if scene_lights.is_sync_doc_stale(age):
                        raise ValueError('运行时灯光数据已过期')
                    lighting, err = scene_lights.validate_pulled_lighting(doc, body['sceneId'])
                    if err:
                        raise ValueError(err)
                    if 'phase' in doc and doc.get('writer') != 'editor:scene-workbench':
                        backend.runtime_phases[body['sceneId']] = scene_lights.pulled_phase(doc)
                    phase = backend.runtime_phases.get(body['sceneId'], '')
                    if phase:
                        variant_before = (body.get('variants') or {}).get(phase, {}).get('lighting')
                        base, variant = scene_lights.split_phase_pull(lighting, body.get('base'), variant_before)
                    else:
                        base, variant = lighting, None
                    return self.send({'lighting': base, 'variant': variant, 'phase': phase,
                                      'selectedId': scene_lights.doc_selected_id(doc)})
                raise ValueError('未知操作')
            except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
                return
            except Exception as exc:
                return self.error(exc)

    return Handler


def start_server(backend: Backend, port=0):
    server = ThreadingHTTPServer(('127.0.0.1', port), handler_for(backend))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server
