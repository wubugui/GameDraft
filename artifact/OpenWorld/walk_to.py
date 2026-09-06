"""Drive player input over walkable waypoints, using observed player/entity positions."""
import json, sys, urllib.request, math
from pathlib import Path
from fit_world_routes import route,_scene_geometry
ROOT=Path(__file__).resolve().parents[2]
def evaluate(code):
 req=urllib.request.Request('http://127.0.0.1:5181/eval',data=json.dumps({'code':code}).encode(),headers={'Content-Type':'application/json'})
 data=json.load(urllib.request.urlopen(req,timeout=55))
 if not data['ok']:raise RuntimeError(data)
 return data['result']
sid=sys.argv[1];v=evaluate('() => ow.view()')
if sys.argv[2]=='--label':
 e=next(e for e in v['entities'] if sys.argv[3] in e['label']);b=(e['x'],e['y'])
else:b=tuple(map(float,sys.argv[2:4]))
a=(v['player']['x'],v['player']['y'])
d=json.loads((ROOT/'public/assets/scenes'/f'{sid}.json').read_text(encoding='utf8'));g=_scene_geometry(sid,d,d['depthConfig'])
points=evaluate('() => ow.plan('+json.dumps(b)+','+str(70 if sys.argv[2]=='--label' else 0)+')')
print('Walkable waypoints:',points,flush=True)
for p in points[1:]:
 distance=math.dist(a,p);ticks=min(200,max(15,math.ceil(distance/2.2)))
 result=evaluate('async () => ow.move('+str(p[0])+','+str(p[1])+','+str(ticks)+')')
 for i in range(12):
  if math.dist((result['player']['x'],result['player']['y']),p)<15:break
  if not result['moving']:raise RuntimeError('Navigation stopped short: '+json.dumps(result,ensure_ascii=False))
  result=evaluate('async () => {await ow.step(120);return ow.brief();}')
 else:raise RuntimeError('Navigation stuck: '+json.dumps(result,ensure_ascii=False))
 a=(result['player']['x'],result['player']['y'])
print(json.dumps(result,ensure_ascii=False),flush=True)
