"""场景重打光工作台本地服务。

  GET  /                       viewer
  GET  /api/scenes             工程场景清单(带深度/mask/已导出变体状态)
  GET  /api/presets            全局预设(完整参数)+ DEFAULTS
  GET  /api/params?scene=      该场景已保存的逐预设参数
  GET  /api/rig?t=13.5         任意时刻 → 光照参数补丁(rig_from_time)
  GET  /api/bg?scene=&w=       原背景图(可缩放,给 A/B 对比与刷 mask 的底)
  GET  /api/mask?scene=        当前发光 mask PNG(404=还没有)
  POST /api/preview?scene=&w=  body=参数 JSON → 重打光 PNG(头带 X-Render-Ms)
  POST /api/mask?scene=        body=PNG(原生分辨率)存发光 mask;body=CLEAR 删除
  POST /api/save_params?scene=&preset=   body=参数 JSON,只存不导出
  POST /api/export?scene=&preset=        body=参数 JSON,全分辨率导出变体+存参数
  POST /api/bake?scene=                烘几何场(法线/天穹可见性/3D 网格/GI 命中图)
  POST /api/migrate?scene=[&force=1]   恒等迁移:接进统一光影且**画面零变化**
  POST /api/dump?name=                 运行时取证:游戏页 POST 像素过来落盘

预览是**同一份** relight() 在低分辨率跑——看到的就是导出的(无 GLSL/Python 两套数学)。
"""
from __future__ import annotations

import io
import json
import os
import re
import sys
import time
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

TOOL = Path(__file__).resolve().parent
ROOT = TOOL.parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from PIL import Image                                            # noqa: E402

from tools.atomic_io import retry_transient                      # noqa: E402
from tools.scene_relight import store                            # noqa: E402
from tools.scene_relight.geometry import OUT, Scene, list_scenes  # noqa: E402
from tools.scene_relight.presets import PRESETS                  # noqa: E402
from tools.scene_relight.relight import DEFAULTS, merge_params, rig_from_time  # noqa: E402

PORT = 5317
_scenes: dict[str, tuple[float, Scene]] = {}
_SCENE_CACHE_MAX = 4                                 # 原生几何一场景可到几十 MB,别全囤内存


def _get_scene(sid: str) -> Scene:
    """按背景图 mtime 缓存 Scene(LRU 上限 4);游戏里重画背景后自动重载。"""
    from tools.scene_relight.geometry import scene_paths
    bg = scene_paths(sid)['bg']
    mt = bg.stat().st_mtime
    hit = _scenes.get(sid)
    if hit and hit[0] == mt:
        _scenes[sid] = _scenes.pop(sid)              # 触活到队尾
        return hit[1]
    s = Scene(sid)
    _scenes.pop(sid, None)
    _scenes[sid] = (mt, s)
    while len(_scenes) > _SCENE_CACHE_MAX:
        _scenes.pop(next(iter(_scenes)))
    return s


class H(SimpleHTTPRequestHandler):
    def __init__(self, *a, **k):
        super().__init__(*a, directory=str(TOOL), **k)

    def end_headers(self):
        self.send_header('Cache-Control', 'no-store, must-revalidate')
        super().end_headers()

    def _json(self, obj, code=200):
        body = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _png(self, data: bytes, extra: dict | None = None):
        self.send_response(200)
        self.send_header('Content-Type', 'image/png')
        self.send_header('Content-Length', str(len(data)))
        for k, v in (extra or {}).items():
            self.send_header(k, str(v))
        self.end_headers()
        self.wfile.write(data)

    def do_OPTIONS(self):
        # /api/dump 要被**游戏页**(另一个端口)调用,得放行跨源预检
        self.send_response(204)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        self.end_headers()

    def _body_json(self) -> dict:
        n = int(self.headers.get('Content-Length', 0))
        return json.loads(self.rfile.read(n) or b'{}')

    # ------------------------------------------------------------------ GET
    def do_GET(self):
        u = urlparse(self.path)
        q = parse_qs(u.query)
        try:
            if u.path == '/':
                self.path = '/viewer/index.html'
                return super().do_GET()
            if u.path == '/api/scenes':
                return self._json(list_scenes())
            if u.path == '/api/presets':
                return self._json({
                    'defaults': DEFAULTS,
                    'presets': {k: merge_params(v) for k, v in PRESETS.items()},
                })
            if u.path == '/api/params':
                sid = q.get('scene', [''])[0]
                return self._json({p: store.load_params(sid, p)
                                   for p in store.saved_presets(sid)})
            if u.path == '/api/rig':
                t = float(q.get('t', ['12'])[0])
                return self._json(merge_params(rig_from_time(t)))
            if u.path == '/api/bg':
                sid = q.get('scene', [''])[0]
                w = int(q.get('w', ['0'])[0])
                s = _get_scene(sid)
                img = Image.fromarray((s.bg_srgb * 255).astype('uint8'))
                if w and w < img.width:
                    img = img.resize((w, max(1, round(img.height * w / img.width))),
                                     Image.BILINEAR)
                buf = io.BytesIO()
                img.save(buf, format='PNG')
                return self._png(buf.getvalue(),
                                 {'X-Native-W': s.native[0], 'X-Native-H': s.native[1]})
            if u.path == '/api/mask':
                sid = q.get('scene', [''])[0]
                f = OUT / sid / 'emissive_mask.png'
                if not f.exists():
                    return self._json({'ok': False, 'err': 'no mask'}, 404)
                return self._png(f.read_bytes())
            if u.path == '/api/field':
                # 烘出来的几何场(skyvis / normal),给作者看"光照结构从哪来"
                sid = q.get('scene', [''])[0]
                kind = q.get('kind', ['skyvis'])[0]
                fname = {'skyvis': 'skyvis.png', 'normal': 'normal.png'}.get(kind)
                if not fname:
                    return self._json({'ok': False, 'err': 'bad kind'}, 400)
                f = _get_scene(sid).rt_dir / 'lighting2' / fname
                if not f.exists():
                    return self._json({'ok': False, 'err': '该场景还没烘几何场(--bake)'}, 404)
                return self._png(f.read_bytes())
            if u.path == '/api/bake_meta':
                sid = q.get('scene', [''])[0]
                f = _get_scene(sid).rt_dir / 'lighting2' / 'meta.json'
                if not f.exists():
                    return self._json({'ok': True, 'meta': None})
                return self._json({'ok': True, 'meta': json.loads(f.read_text(encoding='utf-8'))})
            return super().do_GET()
        except Exception as e:                       # noqa: BLE001 — 工具服务:报错给前端而不是断连
            return self._json({'ok': False, 'err': f'{type(e).__name__}: {e}'}, 500)

    # ----------------------------------------------------------------- POST
    def do_POST(self):
        u = urlparse(self.path)
        q = parse_qs(u.query)
        try:
            if u.path == '/api/preview':
                sid = q.get('scene', [''])[0]
                w = int(q.get('w', ['640'])[0])
                params = self._body_json()
                s = _get_scene(sid)
                t0 = time.time()
                data = store.render_png_bytes(s, params, width=w)
                return self._png(data, {'X-Render-Ms': round((time.time() - t0) * 1000)})
            if u.path == '/api/mask':
                sid = q.get('scene', [''])[0]
                n = int(self.headers.get('Content-Length', 0))
                if n <= 0 or n > 32 * 1024 * 1024:
                    return self._json({'ok': False, 'err': 'bad size'}, 400)
                data = self.rfile.read(n)
                f = OUT / sid / 'emissive_mask.png'
                if n <= 8 and data[:5] == b'CLEAR':
                    f.unlink(missing_ok=True)
                else:
                    Image.open(io.BytesIO(data)).verify()      # 只收合法 PNG
                    f.parent.mkdir(parents=True, exist_ok=True)
                    tmp = f.with_suffix('.png.tmp')
                    tmp.write_bytes(data)
                    retry_transient(os.replace, tmp, f)
                return self._json({'ok': True})
            if u.path == '/api/dump':
                # 运行时取证通道:游戏页把 extract 出来的像素 POST 过来落盘,供 agent 目视。
                # 存在的理由:本环境的浏览器面板不显示 ⇒ 截图工具用不了;而 Pixi 坑⑧ 说
                # `extract.pixels` 不过 filter、**但过 mesh 自定义 shader** —— 统一光影的
                # 背景正是 mesh,所以这条路拿到的是真着色像素。
                name = re.sub(r'[^\w.\-]', '_', q.get('name', ['dump'])[0])[:80]
                n = int(self.headers.get('Content-Length', 0))
                if n <= 0 or n > 64 * 1024 * 1024:
                    return self._json({'ok': False, 'err': 'bad size'}, 400)
                data = self.rfile.read(n)
                dest = TOOL / 'out' / '_dump' / f'{name}.png'
                dest.parent.mkdir(parents=True, exist_ok=True)
                tmp = dest.with_suffix('.png.tmp')
                tmp.write_bytes(data)
                retry_transient(os.replace, tmp, dest)
                self.send_response(200)
                self.send_header('Access-Control-Allow-Origin', '*')
                self.send_header('Content-Type', 'application/json')
                body = json.dumps({'ok': True, 'dest': str(dest), 'bytes': n}).encode()
                self.send_header('Content-Length', str(len(body)))
                self.end_headers()
                self.wfile.write(body)
                return
            if u.path == '/api/bake':
                # 烘几何场（法线 / 天穹可见性 / 3D 网格 / GI 命中图）。
                # ⚠ 同步跑，单场景约 2'40"–3'25"：这个服务是**本机单用户**的桌面壳后端，
                #   开线程只会让"跑到哪了"更难看清，而且并发烘同一个场景会互相覆盖产物。
                from .bake import bake as _bake
                sid = q.get('scene', [''])[0]
                _get_scene(sid)                      # 场景不存在时在这里就报，别烘一半才发现
                r = _bake(sid)
                return self._json({'ok': True, 'result': {
                    k: v for k, v in r.items() if k != 'dest'}})
            if u.path == '/api/migrate':
                # 恒等迁移：把场景接进统一光影且**画面零变化**。
                # 不覆盖手调过的场景（migrate 自己判 already-configured）。
                from .migrate import migrate as _migrate, verify_identity as _verify
                sid = q.get('scene', [''])[0]
                force = q.get('force', ['0'])[0] == '1'
                status = _migrate(sid, force=force)
                return self._json({'ok': status in ('migrated', 'already-configured'),
                                   'status': status,
                                   'verify': _verify(sid) if status == 'migrated' else None})
            if u.path == '/api/save_params':
                sid = q.get('scene', [''])[0]
                preset = q.get('preset', [''])[0]
                if not preset:
                    return self._json({'ok': False, 'err': 'missing preset'}, 400)
                f = store.save_params(sid, preset, self._body_json())
                return self._json({'ok': True, 'file': str(f)})
            if u.path == '/api/export':
                sid = q.get('scene', [''])[0]
                preset = q.get('preset', [''])[0]
                if not preset:
                    return self._json({'ok': False, 'err': 'missing preset'}, 400)
                s = _get_scene(sid)
                t0 = time.time()
                res = store.export_variant(s, preset, self._body_json())
                res.update(ok=True, ms=round((time.time() - t0) * 1000))
                return self._json(res)
            return self._json({'ok': False, 'err': 'unknown endpoint'}, 404)
        except Exception as e:                       # noqa: BLE001
            return self._json({'ok': False, 'err': f'{type(e).__name__}: {e}'}, 500)

    def log_message(self, *a):
        pass


def main(port: int = PORT):
    print(f'scene relight lab: http://localhost:{port}/')
    ThreadingHTTPServer(('127.0.0.1', port), H).serve_forever()


if __name__ == '__main__':
    main(int(sys.argv[1]) if len(sys.argv) > 1 else PORT)
