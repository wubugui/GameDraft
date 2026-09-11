"""查看器 ↔ serve ↔ pipeline 三者之间的两条契约:**参数拼法**与**工作目录**。

这两条只要漂了,工具就整体不能用,而且都不是"少了个功能"这种看得见的坏法:

- 参数拼法(2026-09-08 实测):`serve._extra_from_query` 按参数键拼 `--<key>`(下划线),
  pipeline 那三个手写参数只声明了 `--probe-band` 这种连字符名 → argparse
  `unrecognized arguments` **秒退**,点任何场景的烘焙按钮都是同一条错。
- 工作目录(同日实测):pipeline 2026-08-30 起把产物写进 `out/<场景>/<背景基名>/`,
  serve 与查看器还在读 `out/<场景>/` → 清单里**每个场景都显示未烘焙**、点下去
  画布空白、笔刷编辑存进没人读的目录。

两者都不抛异常,所以只能在这里把口径钉死。
"""
from __future__ import annotations

import inspect
import sys
from pathlib import Path

_ROOT = Path(__file__).resolve().parents[3]
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

from tools.character_lighting_lab import pipeline, serve      # noqa: E402

VIEWER = Path(__file__).resolve().parents[1] / 'viewer' / 'app.js'


def _viewer_code() -> str:
    """app.js 去掉整行注释 —— 否则"别再送 probe_band"那句注释本身会被判成违规。"""
    return '\n'.join(ln for ln in VIEWER.read_text(encoding='utf-8').splitlines()
                     if not ln.lstrip().startswith('//'))


class Test重烘参数拼法:
    def test_查看器送的每个键_pipeline_都接得住(self, monkeypatch) -> None:
        """把 REBUILD_KEYS 整套按 serve 的拼法喂给 pipeline 的 argparse。

        这正是"点重烘"那一刻发生的事:argparse 只要不认其中任何一个,
        整次烘焙**立刻失败**,一行产物都不会有。
        """
        query = {k: [str(pipeline.DEFAULTS[k])] for k in sorted(serve.REBUILD_KEYS)
                 if k in pipeline.DEFAULTS}
        extra = serve._extra_from_query(query)
        assert extra, 'REBUILD_KEYS 一个都没转成命令行参数'

        seen: dict = {}
        monkeypatch.setattr(pipeline, 'build',
                            lambda img, name, params, background=None:
                            seen.update(params=params, name=name, bg=background))
        monkeypatch.setattr(sys, 'argv',
                            ['pipeline', 'bg.png', '--name', 'x', *extra])
        pipeline.main()                       # 认不出任何一个 flag 就 SystemExit
        for k in query:
            assert k in seen['params'], f'{k} 没落到 pipeline 的参数里'

    def test_三个手写参数也收下划线拼法(self, monkeypatch) -> None:
        """serve 一律拼下划线,所以连字符名**不能是唯一拼法**。"""
        seen: dict = {}
        monkeypatch.setattr(pipeline, 'build',
                            lambda img, name, params, background=None:
                            seen.update(params=params))
        monkeypatch.setattr(sys, 'argv',
                            ['pipeline', 'bg.png', '--name', 'x',
                             '--probe_band', '1.25', '--probe_dims', 'auto',
                             '--escape_intensity', '1.0'])
        pipeline.main()
        assert seen['params']['probe_band'] == 1.25
        assert seen['params']['probe_dims'] is None

    def test_只列真被消费的键(self) -> None:
        """已废弃的 probe 参数不许再出现在重烘链路上。

        它们拖了等于没拖(pipeline 早就不读了),而 `probe_band` 更糟:
        查看器送一个写死的 1.6 回去,就把"由角色实高推出盒高"这条修好的
        结论又绑回「角色高 1.5 wu」的老假设上(6 层里 5 层烘在够不着的空中)。
        """
        for dead in ('probe_nx', 'probe_ny', 'probe_nz', 'probe_dirs',
                     'probe_band', 'fold'):
            assert dead not in serve.REBUILD_KEYS, f'{dead} 已无消费者,不该还在重烘键里'
        assert 'probe_band:' not in _viewer_code(), '查看器又开始送 probe_band 了'

    def test_查看器的_probe_旋钮都在重烘键里(self) -> None:
        """面板上拖得动、服务端却丢掉 = 又一根假旋钮。"""
        js = _viewer_code()
        for k in ('probe_cells_per_char_xz', 'probe_cells_per_char_y',
                  'probe_height_chars', 'probe_spp'):
            assert f'{k}:' in js, f'查看器没送 {k}'
            assert k in serve.REBUILD_KEYS, f'{k} 会被服务端丢掉'
            assert k in pipeline.DEFAULTS, f'{k} 不是 pipeline 的参数'


class Test工作目录口径:
    def test_serve_不自己拼扁平路径(self) -> None:
        src = inspect.getsource(serve)
        for bad in ("TOOL / 'out' / sid / 'manifest.json'",
                    "TOOL / 'out' / name / 'manifest.json'",
                    "(TOOL / 'out').glob('*/manifest.json')"):
            assert bad not in src, f'又出现硬拼的扁平工作目录: {bad}'

    def test_wd_与_pipeline_同一函数(self) -> None:
        assert serve._wd('某个不存在的场景') == pipeline.work_dir('某个不存在的场景')

    def test_清单回带工作目录_查看器按它取产物(self) -> None:
        """`dir` 是查看器唯一的静态产物根;两头有一头忘了就是整片 404。"""
        assert "man['dir'] = wd.relative_to" in inspect.getsource(serve.H.do_GET)
        js = _viewer_code()
        assert 'function outBase(' in js
        assert 'man.dir||man.name' in js
        assert '`/out/${encodeURIComponent(man.name)}`' not in js
