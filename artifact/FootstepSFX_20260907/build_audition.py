# -*- coding: utf-8 -*-
"""生成试听页：把入库的 20 条脚步 one-shot 按地面分组，浏览器里点着听。

我判断不了「好不好听」，只能判断「是不是一次干净的冲击」（qc.py 的几何判据）。
听感验收得人来，所以给一页能连点、能连播的表。

用法:
    sh scripts/py.sh artifact/FootstepSFX_20260907/build_audition.py
产物: artifact/FootstepSFX_20260907/audition.html
      （用 dev server 打开：http://127.0.0.1:5191/... 或直接双击，后者需要同目录有音频副本）
本页直接引用 dev server 上的 /resources/runtime/audio/footsteps/，所以要在服务起着时看。
"""
from __future__ import annotations

import json
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parent.parent
CONFIG = REPO / "public" / "assets" / "data" / "audio_config.json"
SETS = REPO / "public" / "assets" / "data" / "footstep_sets.json"

cfg = json.loads(CONFIG.read_text(encoding="utf-8"))
sets = json.loads(SETS.read_text(encoding="utf-8"))

rows = []
for set_id, s in sets["sets"].items():
    ids = s["variants"]["walk"]
    rows.append((set_id, s.get("label", ""), [(i, cfg["sfx"][i]["src"]) for i in ids]))

html = ["""<!doctype html><meta charset="utf-8"><title>脚步声试听</title>
<style>
body{background:#16161a;color:#e8e6e3;font:14px/1.6 system-ui,"Microsoft YaHei",sans-serif;margin:0;padding:24px 28px}
h1{font-size:19px;margin:0 0 4px}
.sub{color:#9a9a a0;color:#9a9aa0;margin:0 0 22px}
.grp{margin:0 0 26px;border:1px solid #2c2c33;border-radius:8px;overflow:hidden}
.hd{background:#1e1e24;padding:10px 14px;display:flex;align-items:center;gap:12px}
.hd b{font-size:15px}.hd span{color:#9a9aa0;font-size:13px}
.hd button{margin-left:auto}
button{background:#33333d;color:#e8e6e3;border:1px solid #45454f;border-radius:5px;
       padding:5px 12px;cursor:pointer;font:13px system-ui}
button:hover{background:#3d3d49}
.row{display:flex;align-items:center;gap:12px;padding:7px 14px;border-top:1px solid #24242a}
.row code{color:#c8c6c0;min-width:230px;font:12px ui-monospace,Consolas,monospace}
.row audio{height:30px}
.tip{color:#8a8a92;font-size:12.5px;margin:18px 0 0;line-height:1.7}
</style>
<h1>脚步声 one-shot 试听</h1>
<p class="sub">火山引擎 openspeech · seed-audio-1.0 生成 → 按能量包络切成单次触地 → 归一到 RMS −20 dBFS</p>
"""]
for set_id, label, items in rows:
    html.append('<div class="grp"><div class="hd"><b>%s</b><span>%s</span>'
                '<button onclick="seq(this)">连播这一组</button></div>' % (set_id, label))
    for aid, src in items:
        html.append('<div class="row"><code>%s</code>'
                    '<audio controls preload="none" src="%s"></audio></div>' % (aid, src))
    html.append('</div>')
html.append("""
<p class="tip">
听的时候重点是三件事：<br>
① <b>是不是一次干净的落脚</b>——不该有第二声、不该拖出连续的沙沙；<br>
② <b>五条彼此够不够不一样</b>——太像的话轮换起来仍然会听成机枪；<br>
③ <b>材质对不对</b>——木栈道该闷该空、纸灰该脆该碎、石地该硬该带碎粒、纸钱该有纸的窸窣。<br>
哪条不行告诉我编号，我从同批切出来的候选里换（纸钱 15 条 / 木栈道 8 条 / 石地 14 条 / 纸灰 34 条，
现在各只用了 5 条）。
</p>
<script>
function seq(btn){
  const rows=[...btn.closest('.grp').querySelectorAll('audio')];
  let i=0; const next=()=>{ if(i>=rows.length) return; const a=rows[i++];
    a.currentTime=0; a.play(); a.onended=()=>setTimeout(next,260); };
  next();
}
</script>""")

out = HERE / "audition.html"
out.write_text("".join(html), encoding="utf-8", newline="\n")
print("已写", out)
print("dev server 起着时打开：http://127.0.0.1:5191/@fs/" + str(out).replace("\\", "/"))
