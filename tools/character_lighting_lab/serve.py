"""Local server for the character lighting lab viewer.

Static viewer + a tiny ASYNC bake job queue so ALL baking lives in the app:
  GET  /api/scenes                  -> [manifest...]
  GET  /api/rebuild?scene=X&...     -> {job} queue rebake of one scene
  GET  /api/rebuild_all             -> {job} queue rebake of every scene
  POST /api/build_new?name=X&...    -> {job} body = image bytes; new scene
  GET  /api/job?id=N                -> {status, log, queue}
  GET  /api/terrain?scene=X         -> {stats} 秒级地形预览+站位体检(不重烘)
Jobs run serially in a worker thread; logs stream into the job record.
"""
from __future__ import annotations

import hashlib
import json
import re
import shutil
import subprocess
import sys
import threading
import time
from http.server import SimpleHTTPRequestHandler
from pathlib import Path
from urllib.parse import urlparse, parse_qs

TOOL = Path(__file__).resolve().parent
ROOT = TOOL.parents[1]
SCENES_JSON = ROOT / 'public' / 'assets' / 'scenes'
SCENES_RT = ROOT / 'public' / 'resources' / 'runtime' / 'scenes'
PORT = 5311

REBUILD_KEYS = {'pitch_deg', 'azimuth_deg', 'ppu_ratio', 'ev', 'max_gain_ev',
                'hdr_method', 'hdr_pa',
                'depth_model', 'depth_scale_adj', 'depth_offset_adj',
                'col_h_lo', 'col_h_hi', 'vol_nx', 'vol_nz',
                'probe_nx', 'probe_ny', 'probe_nz', 'probe_dirs', 'probe_band',
                'fold', 'relief', 'semantic_gate', 'occluder_tau', 'thickness_k',
                'bg_thickness_q', 'ground_up_dot', 'walk_res',
                'object_score_min', 'object_groups', 'object_prompts_extra'}

# ------------------------------------------------------------- 游戏场景清单
# 这个工具深度绑定工程:场景身份**只认游戏场景 id**(= public/assets/scenes/<id>.json 的
# 文件名)。由 id 一路推出四个落点,不再从"上传的文件名"猜:
#   背景图      public/resources/runtime/scenes/<id>/<backgrounds[0].image>
#   烘焙工作目录 tools/character_lighting_lab/out/<id>/
#   导出照明    public/resources/runtime/scenes/<id>/lighting/
#   导出深度    public/assets/scenes/<id>.json (+ 同场景运行时目录)
_hash_cache: dict[str, tuple[float, int, str]] = {}


def _file_hash(p: Path) -> str | None:
    """文件字节 sha1(12 位),与 pipeline.img_hash / validator 同口径;按 mtime+size 缓存。"""
    try:
        st = p.stat()
    except OSError:
        return None
    key = str(p)
    hit = _hash_cache.get(key)
    if hit and hit[0] == st.st_mtime and hit[1] == st.st_size:
        return hit[2]
    h = hashlib.sha1(p.read_bytes()).hexdigest()[:12]
    _hash_cache[key] = (st.st_mtime, st.st_size, h)
    return h


def _scene_bg(sid: str, data: dict) -> tuple[str | None, Path | None]:
    """场景声明的背景图 → (相对名, 磁盘路径)。缺 backgrounds 时退回 background.png。"""
    bgs = data.get('backgrounds') or []
    ref = None
    if bgs and isinstance(bgs[0], dict):
        ref = bgs[0].get('image')
    ref = ref or 'background.png'
    return ref, SCENES_RT / sid / ref


_stale_cache: dict[str, tuple[tuple, bool]] = {}


def _bg_stale(game_bg: Path, lab_bg: Path) -> bool:
    """烘焙输入是否已过期(游戏背景重画了)。

    字节相同 → 直接不过期(新流程按字节拷贝,走这条快路)。字节不同**不代表**过期:
    历史场景的实验室副本是 PIL 重编码,像素一样字节必不同——那种情况才解码比像素,
    结果按两个文件的 (mtime,size) 缓存,避免每次列清单都解 PNG。"""
    try:
        gs, ls = game_bg.stat(), lab_bg.stat()
    except OSError:
        return False
    if _file_hash(game_bg) == _file_hash(lab_bg):
        return False
    key = str(lab_bg)
    sig = (gs.st_mtime, gs.st_size, ls.st_mtime, ls.st_size)
    hit = _stale_cache.get(key)
    if hit and hit[0] == sig:
        return hit[1]
    try:
        from PIL import Image
        import numpy as np
        a = np.asarray(Image.open(game_bg).convert('RGB'))
        b = np.asarray(Image.open(lab_bg).convert('RGB'))
        stale = a.shape != b.shape or not np.array_equal(a, b)
    except Exception:                              # noqa: BLE001 — 判不了就别乱报警
        stale = False
    _stale_cache[key] = (sig, stale)
    return stale


def _scene_index() -> list[dict]:
    """扫工程里**所有**场景,带上实验室侧状态(烘没烘 / 背景变没变 / 导没导)。"""
    out = []
    seen = set()
    for j in sorted(SCENES_JSON.glob('*.json')):
        try:
            data = json.loads(j.read_text())
        except Exception:                          # noqa: BLE001 — 坏 JSON 不该让清单挂掉
            continue
        sid = j.stem
        seen.add(sid)
        ref, bg = _scene_bg(sid, data)
        bg_hash = _file_hash(bg) if bg else None
        man_p = TOOL / 'out' / sid / 'manifest.json'
        lab_bg = TOOL / 'out' / sid / 'background.png'
        out.append({
            'id': sid,
            'name': data.get('name') or sid,
            'bg': ref,
            'bg_ok': bg_hash is not None,
            'baked': man_p.exists(),
            # 背景重画过 → 烘焙输入过期,得重烘(游戏侧 validator 也会拦导出的载荷)
            'bg_stale': bool(man_p.exists() and bg and bg.exists()
                             and lab_bg.exists() and _bg_stale(bg, lab_bg)),
            'lighting': (SCENES_RT / sid / 'lighting' / 'lighting.json').exists(),
            'depth': 'depthConfig' in data,
        })
    # 实验室里有、游戏里没有的:多半是历史错位命名,列出来别让它藏着
    for m in sorted((TOOL / 'out').glob('*/manifest.json')):
        sid = m.parent.name
        if sid not in seen:
            out.append({'id': sid, 'name': sid, 'bg': None, 'bg_ok': False,
                        'baked': True, 'bg_stale': False, 'lighting': False,
                        'depth': False, 'orphan': True})
    return out


def _stage_scene_bg(sid: str) -> Path:
    """把游戏背景**按字节**拷进 out/<id>/background.png(已一致则不动)。

    字节级拷贝很关键:manifest.hash 因此 == 游戏文件哈希,导出时的像素比对与
    validator 的 background_sha1 门天然对齐,不再有"实验室副本是重编码"那套麻烦。"""
    j = SCENES_JSON / f'{sid}.json'
    if not j.exists():
        raise FileNotFoundError(f'游戏里没有场景 {sid}(先在主编辑器建场景)')
    ref, bg = _scene_bg(sid, json.loads(j.read_text()))
    if not bg or not bg.exists():
        raise FileNotFoundError(f'场景 {sid} 的背景图不在盘上: {bg}')
    dest_dir = TOOL / 'out' / sid
    dest_dir.mkdir(parents=True, exist_ok=True)
    dest = dest_dir / 'background.png'
    if not dest.exists() or _file_hash(dest) != _file_hash(bg):
        shutil.copyfile(bg, dest)
        _hash_cache.pop(str(dest), None)
    return dest


# ---------------------------------------------------------------- job queue
_jobs: dict[int, dict] = {}
_queue: list[int] = []
_lock = threading.Lock()
_next_id = [1]
_worker_started = [False]


# B-2:烘焙阶段清单。pipeline 本来就在吐 `[tag] ...` 结构化阶段标签,这里顺手解析成
# 结构化进度 —— 查看器据此画一个**静态**勾选清单(打勾/当前/未到 + 已耗时秒数)。
# 刻意不做 spinner/进度条动画:变化的只有数据本身(铁律 1「零动效」)。
# 顺序取自 pipeline.build() 的真实调用序列;`objects`/`edit` 等可能被跳过,
# 查看器把"已越过但没出现"的显示为跳过,不会卡在那里假装还没跑。
BAKE_STAGE_ORDER = ['depth', 'objects', 'calib', 'hdr', 'edit', 'voxel', 'bounds',
                    'lights', 'ambient', 'probes', 'walk', 'mesh', 'char', 'done']
_STAGE_RE = re.compile(r'^\[([a-z_]+)\]')


def _run_bake(job: dict) -> None:
    for scene, extra in job['builds']:
        src = TOOL / 'out' / scene / 'background.png'
        # ⚠ `-u` 不可省:pipeline 的阶段 print 多数没写 flush=True,而子进程 stdout 是
        # 管道时默认**块缓冲** —— 不加 -u 的话所有阶段标签会憋到进程退出才一次性吐出,
        # 阶段清单全程停在"未开始",等于白做(实测就是这个现象)。
        cmd = [sys.executable, '-u', str(TOOL / 'pipeline.py'), str(src), '--name', scene, *extra]
        job['log'] += f'\n=== {scene} ===\n'
        job['scene'] = scene
        job['stages'] = []                      # 本场景已出现过的阶段(有序、去重)
        job['stage'] = ''
        p = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                             text=True, bufsize=1)
        for line in p.stdout:
            job['log'] = (job['log'] + line)[-12000:]
            m = _STAGE_RE.match(line)
            if m:
                tag = m.group(1)
                if tag in BAKE_STAGE_ORDER:
                    if tag not in job['stages']:
                        job['stages'].append(tag)
                    job['stage'] = tag
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
                      'log': '', 'builds': builds, 'stages': [], 'stage': '',
                      'scene': builds[0][0] if builds else '',
                      't0': time.time(), 'total': len(builds)}
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

    def end_headers(self):
        # ⚠ 本地开发工具:一律禁缓存。SimpleHTTPRequestHandler 默认只发 Last-Modified,
        # 浏览器会把 index.html / app.js 缓存住 —— 改完代码刷新看不到变化,得手动硬刷新
        # (app.js 里那句「缺控件…请硬刷新页面(旧 HTML 被缓存)」正是这个坑的补丁)。
        # out/ 下的 .bin/.png 同理:重烘后同名文件被覆盖,缓存会喂旧字节。
        self.send_header('Cache-Control', 'no-store, must-revalidate')
        super().end_headers()

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
        if u.path == '/api/char_shade_core.js':
            # 角色着色核心 GLSL 的唯一真相源(与运行时 CharacterShadingFilter 共用同一份磁盘文件)。
            # 包成 window.CHAR_SHADE_CORE 供 viewer 的 shader 拼接,消灭 shader 镜像漂移。
            glsl = (ROOT / 'src' / 'rendering' / 'charShadeCore.glsl').read_text(encoding='utf-8')
            body = ('window.CHAR_SHADE_CORE=' + json.dumps(glsl) + ';').encode('utf-8')
            self.send_response(200)
            self.send_header('Content-Type', 'application/javascript; charset=utf-8')
            self.send_header('Cache-Control', 'no-store')  # 改 glsl 后硬刷即生效,不被缓存住
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        if u.path == '/api/scenes':
            scenes = []
            for m in sorted((TOOL / 'out').glob('*/manifest.json')):
                try:
                    scenes.append(json.loads(m.read_text()))
                except Exception:
                    pass
            return self._json(scenes)
        if u.path == '/api/game_scenes':
            return self._json(_scene_index())
        if u.path == '/api/import':
            # 首次烘焙一个游戏场景:背景从工程里自动取,场景名 = 游戏场景 id
            sid = q.get('scene', [''])[0]
            try:
                _stage_scene_bg(sid)
            except Exception as e:                 # noqa: BLE001
                return self._json({'ok': False, 'err': str(e)}, 400)
            return self._json(_enqueue([(sid, _extra_from_query(q))], f'首次烘焙 {sid}'))
        if u.path == '/api/job':
            jid = int(q.get('id', ['0'])[0])
            job = _jobs.get(jid)
            if not job:
                return self._json({'ok': False, 'err': 'no such job'}, 404)
            with _lock:
                pos = _queue.index(jid) + 1 if jid in _queue else 0
            return self._json({'ok': True, 'status': job['status'],
                               'label': job['label'], 'queue_position': pos,
                               # B-2:结构化进度,查看器画静态阶段清单
                               'stage': job.get('stage', ''),
                               'stages': job.get('stages', []),
                               'stage_order': BAKE_STAGE_ORDER,
                               'scene': job.get('scene', ''),
                               'total': job.get('total', 1),
                               'elapsed': round(time.time() - job.get('t0', time.time()), 1),
                               'log': job['log'][-3000:]})
        if u.path == '/api/geo_status':
            name = q.get('scene', [''])[0]
            mp = TOOL / 'out' / name / 'manifest.json'
            if not mp.exists():
                return self._json({'ok': False, 'err': 'unknown scene'}, 400)
            man = json.loads(mp.read_text())
            sys.path.insert(0, str(TOOL.parents[1]))
            from tools.character_lighting_lab.pipeline import geometry_signature
            cur = geometry_signature(TOOL / 'out' / name, man['hash'],
                                     {**man['params']})
            baked = man.get('geometry_sig', '')
            return self._json({'ok': True, 'stale': cur != baked,
                               'baked': baked, 'current': cur})
        if u.path == '/api/terrain':
            # 秒级地形预览 + 站位体检(跳过标定网格搜索;不含可走掩膜——那要重烘)
            name = q.get('scene', [''])[0]
            if not (TOOL / 'out' / name).is_dir():
                return self._json({'ok': False, 'err': 'no such baked scene'}, 400)
            try:
                from tools.character_lighting_lab.pipeline import terrain_preview
                return self._json({'ok': True, 'stats': terrain_preview(name)})
            except Exception as e:                      # noqa: BLE001
                return self._json({'ok': False, 'err': f'{type(e).__name__}: {e}'}, 500)
        if u.path == '/api/export_depth':
            name = q.get('scene', [''])[0]
            if not name or not (TOOL / 'out' / name / 'manifest.json').exists():
                return self._json({'ok': False, 'err': 'unknown scene'}, 400)
            try:
                sys.path.insert(0, str(TOOL.parents[1]))
                from tools.character_lighting_lab.pipeline import (
                    export_scene_depth, geometry_signature)
                man = json.loads((TOOL / 'out' / name / 'manifest.json').read_text())
                cur = geometry_signature(TOOL / 'out' / name, man['hash'], {**man['params']})
                if cur != man.get('geometry_sig', ''):
                    return self._json({'ok': False,
                                       'err': '几何已改动但未重烘——先重烘再导出'}, 409)
                cfg = export_scene_depth(name)
                # 回带 depth_per_sy(直立 quad 的深度梯度)——旧的 floor_depth_A 已随最小二乘
                # 拟合地面一起废除,再读就是 KeyError,而 KeyError 会被下面的 except 吞成
                # 「导出失败」,让每一次深度导出都假报错。viewer 只看 ok,这里纯诊断用。
                return self._json({'ok': True, 'depth_per_sy': cfg['shader']['depth_per_sy']})
            except Exception as e:                     # noqa: BLE001
                return self._json({'ok': False, 'err': str(e)}, 500)
        if u.path == '/api/export':
            name = q.get('scene', [''])[0]
            if not name or not (TOOL / 'out' / name / 'manifest.json').exists():
                return self._json({'ok': False, 'err': 'unknown scene'}, 400)
            if not (TOOL / 'out' / name / 'walk_depth.bin').exists():
                return self._json({'ok': False, 'err': '该场景需先重烘一次(缺 walk_depth.bin)'}, 400)
            try:
                sys.path.insert(0, str(TOOL.parents[1]))
                from tools.character_lighting_lab.pipeline import geometry_signature as _gs
                _man = json.loads((TOOL / 'out' / name / 'manifest.json').read_text())
                if _gs(TOOL / 'out' / name, _man['hash'], {**_man['params']}) != _man.get('geometry_sig', ''):
                    return self._json({'ok': False,
                                       'err': '几何已改动但未重烘——先重烘再导出'}, 409)
            except Exception:                          # noqa: BLE001 — 状态查失败不拦导出
                pass
            try:
                sys.path.insert(0, str(TOOL.parents[1]))
                from tools.character_lighting_lab.pipeline import SHADING_DEFAULTS, export_runtime
                # 查看器把面板当前非 bake 着色参数经 query 传入 → 场景配置(shading 块)
                shading = {k: q[k][0] for k in SHADING_DEFAULTS if k in q}
                dest = export_runtime(name, shading=shading or None)
                return self._json({'ok': True, 'dest': str(dest)})
            except Exception as e:                     # noqa: BLE001
                return self._json({'ok': False, 'err': str(e)}, 500)
        if u.path == '/api/shading':
            # 读回该场景**当前已导出**的 shading 块。没有它的话查看器只能显示 HTML 里那个
            # 写死的初值 —— 后果不只是"看不到真值":刷新/切场景后再点「只存着色参数」,
            # 会拿面板上的默认值把之前调好的悄悄覆盖掉(真踩过:teahouse 的 eChroma 被写回 0)。
            name = q.get('scene', [''])[0]
            f = SCENES_RT / name / 'lighting' / 'lighting.json'
            if not (name and f.exists()):
                return self._json({'ok': True, 'shading': None})
            try:
                meta = json.loads(f.read_text(encoding='utf-8'))
                return self._json({'ok': True, 'shading': meta.get('shading'),
                                   'version': meta.get('version')})
            except Exception as e:                     # noqa: BLE001 — 坏载荷不该让面板挂掉
                return self._json({'ok': False, 'err': str(e)})
        if u.path == '/api/export_params':
            name = q.get('scene', [''])[0]
            if not name:
                return self._json({'ok': False, 'err': 'unknown scene'}, 400)
            try:    # 只补 shading 块,不重跑数据通道 → 无需 manifest/几何签名那套闸
                sys.path.insert(0, str(TOOL.parents[1]))
                from tools.character_lighting_lab.pipeline import (
                    SHADING_DEFAULTS, export_shading_params)
                shading = {k: q[k][0] for k in SHADING_DEFAULTS if k in q}
                dest = export_shading_params(name, shading or None)
                return self._json({'ok': True, 'dest': str(dest)})
            except Exception as e:                     # noqa: BLE001
                return self._json({'ok': False, 'err': str(e)}, 400)
        if u.path == '/api/rebuild':
            name = q.get('scene', [''])[0]
            if not name or not (TOOL / 'out' / name / 'background.png').exists():
                return self._json({'ok': False, 'err': 'unknown scene'}, 400)
            try:      # 重烘顺带从工程重取背景:游戏里重画过就自动跟上,不用手动重导入
                _stage_scene_bg(name)
            except Exception:                      # noqa: BLE001 — 孤儿场景/无背景:沿用本地副本
                pass
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
                try:      # 同 /api/rebuild:重烘前从工程重取背景
                    _stage_scene_bg(man['name'])
                except Exception:                  # noqa: BLE001
                    pass
                builds.append((man['name'], per))
            if not builds:
                return self._json({'ok': False, 'err': 'no scenes'}, 400)
            return self._json(_enqueue(builds, f'重烘全部 {len(builds)} 场景'))
        return super().do_GET()

    def do_POST(self):
        u = urlparse(self.path)
        q = parse_qs(u.query)
        if u.path == '/api/save_edit':
            name = q.get('scene', [''])[0]
            kind = q.get('kind', [''])[0]
            if kind not in ('depth', 'collision', 'object') or not (TOOL / 'out' / name).is_dir():
                return self._json({'ok': False, 'err': 'bad scene/kind'}, 400)
            length = int(self.headers.get('Content-Length', 0))
            if length <= 0 or length > 8 * 1024 * 1024:
                return self._json({'ok': False, 'err': 'bad size'}, 400)
            data = self.rfile.read(length)
            fname = {'depth': 'depth_edit.png', 'collision': 'collision_edit.png',
                     'object': 'object_edit.png'}[kind]
            if length <= 8 and data[:5] == b'CLEAR':          # clear-all sentinel
                (TOOL / 'out' / name / fname).unlink(missing_ok=True)
            else:
                (TOOL / 'out' / name / fname).write_bytes(data)
            return self._json({'ok': True, 'stale': True})
        # /api/build_new(上传图片建场景)已废除:场景名从文件名猜 → 三条落点全错位
        # (真踩过:选了 teahouse/background.png,建出叫 "background" 的场景,
        #  照明导到 runtime/scenes/background/ 这个不存在的场景里)。
        # 现在统一走 GET /api/import?scene=<游戏场景id>,背景由工程自动解析。
        return self._json({'ok': False, 'err': 'unknown endpoint'}, 404)

    def log_message(self, *a):
        pass


if __name__ == '__main__':
    from http.server import ThreadingHTTPServer
    port = int(sys.argv[1]) if len(sys.argv) > 1 else PORT
    print(f'character lighting lab: http://localhost:{port}/')
    ThreadingHTTPServer(('127.0.0.1', port), H).serve_forever()
