"""冒烟测试：在雾津街头上跑通整条链路，产物写到临时目录（不碰仓库）。

用法：`python tools/lightbake/_smoke.py`
"""
from __future__ import annotations

import sys
import tempfile
import time
from pathlib import Path

for _s in (sys.stdout, sys.stderr):
    if hasattr(_s, 'reconfigure'):
        _s.reconfigure(encoding='utf-8', errors='replace')

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from tools.lightbake.bake import bake_scene            # noqa: E402
from tools.lightbake.check import any_failed, run_checks  # noqa: E402
from tools.lightbake.payload import write_payload       # noqa: E402
from tools.lightbake.report import build_report         # noqa: E402


def main() -> int:
    t0 = time.time()
    print('load + bake ...', flush=True)
    b = bake_scene('雾津街头', work_w=512, spp=8, vol_density=3, char_spp=64, progress=True)
    print(f'bake done in {time.time() - t0:.1f}s', flush=True)

    t1 = time.time()
    results = run_checks(b)
    print(f'checks done in {time.time() - t1:.1f}s', flush=True)
    for r in results:
        print(f'  自检 {r.cid:>2} {"绿" if r.ok else "红"}  {r.name}: {r.detail}', flush=True)

    t2 = time.time()
    out = Path(tempfile.mkdtemp(prefix='lightbake-smoke-'))
    write_payload(b, out)
    print(f'write_payload done in {time.time() - t2:.1f}s -> {out}', flush=True)
    for p in sorted(out.iterdir()):
        print(f'    {p.name}  {p.stat().st_size} bytes', flush=True)

    t3 = time.time()
    html = build_report(b, results)
    (out / 'preview').mkdir(exist_ok=True)
    rp = out / 'preview' / 'report.html'
    rp.write_text(html, encoding='utf-8')
    print(f'report done in {time.time() - t3:.1f}s -> {rp}', flush=True)

    print('roundtrip p99_255 =', b['roundtrip']['p99_255'], flush=True)
    print('gather_gain =', b['gather_gain'], flush=True)
    print('vol grid =', b['volume']['grid'], 'validity =', round(b['volume']['validity_coverage'], 4), flush=True)
    print('sun found =', b['sun'].get('found'), 'dir =', b['sun'].get('dir'), flush=True)

    if '--open' in sys.argv:
        import webbrowser
        webbrowser.open(rp.resolve().as_uri())
    return 1 if any_failed(results) else 0


if __name__ == '__main__':
    raise SystemExit(main())
