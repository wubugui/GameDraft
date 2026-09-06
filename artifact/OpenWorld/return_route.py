import json, urllib.request, subprocess, time
from pathlib import Path
ROOT=Path(__file__).resolve().parents[2]
def evaluate(code):
 req=urllib.request.Request('http://127.0.0.1:5181/eval',data=json.dumps({'code':code}).encode(),headers={'Content-Type':'application/json'})
 result=json.load(urllib.request.urlopen(req,timeout=55))
 if not result['ok']:raise RuntimeError(result)
 return result['result']
def cross():
 evaluate('async () => ow.interact()')
 for _ in range(40):
  time.sleep(.4)
  v=evaluate('() => ow.brief()')
  if v['mode']=='exploring':return v
 raise RuntimeError('Scene did not finish loading')
cross()
for sid,label in [('temple_exterior','沿来路下山'),('mountain_pass','下山去河滩'),('河边','顺河去老桥')]:
 subprocess.run([str(ROOT/'.tools/venv/Scripts/python.exe'),str(Path(__file__).parent/'walk_to.py'),sid,'--label',label],check=True)
 v=cross();print('Entered:',v['scene'],v['player'],flush=True)
