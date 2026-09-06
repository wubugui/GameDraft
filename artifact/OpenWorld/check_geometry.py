import sys, json, math
from pathlib import Path
ROOT=Path(__file__).resolve().parents[2]
sys.path.insert(0,str(ROOT))
from fit_world_routes import _scene_geometry,clear
out=[]
for sid in ['雾津街头','teahouse','test_room_b','码头白天','bridge_underpass','河边','mountain_pass','temple_exterior','temple']:
 d=json.loads((ROOT/'public/assets/scenes'/f'{sid}.json').read_text(encoding='utf-8'))
 g=_scene_geometry(sid,d,d['depthConfig'])
 if isinstance(g,str):out.append([sid,g]);continue
 def check(label,p):
  if g.blocked_at(p['x'],p['y']):
   n=g.nearest_walkable(p['x'],p['y'])
   out.append([sid,label,[p['x'],p['y']],list(n) if n else None])
 for n in d['npcs']:
  if not n['id'].startswith('ow_'):continue
  check(n['id'],n)
  route=n.get('patrol',{}).get('route',[])
  anchor=next(a for a in d['exitAnchors'] if a['id']=='ow_exit_'+n['id'][3:])
  for p in route or [n]:
   if not clear(g,(p['x'],p['y']),(anchor['x'],anchor['y'])):
    out.append([sid,n['id']+' obstructed schedule walk'])
  for i,(a,b) in enumerate(zip(route,route[1:]+route[:1])):
   count=max(1,math.ceil(math.hypot(b['x']-a['x'],b['y']-a['y'])/8))
   hits=0
   for j in range(count+1):
    p={k:a[k]+(b[k]-a[k])*j/count for k in ['x','y']}
    if g.blocked_at(p['x'],p['y']):hits+=1
   if hits:out.append([sid,n['id']+' patrol '+str(i),hits,count+1])
 for p in d.get('exitAnchors',[]):check(p['id'],p)
 for k,p in d.get('spawnPoints',{}).items():check('spawn '+k,p)
 for h in d.get('hotspots',[]):
  if h['id'].startswith('ow_') or h['type']=='transition':check('hotspot '+h['id'],h)
(Path(__file__).parent/'geometry-report.json').write_text(json.dumps(out,ensure_ascii=False,indent=2),encoding='utf-8')
print(json.dumps(out,ensure_ascii=False,indent=2))
