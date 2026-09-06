"""Author-time collision-aware waypoint fitting; exports ordinary editor patrol data."""
import sys, math, heapq
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[2]))
from tools.character_lighting_lab.audit_walkable import _scene_geometry as depth_geometry

def _scene_geometry(sid,data,cfg):
 g=depth_geometry(sid,data,cfg)
 if isinstance(g,str):return g
 depth_blocked=g.blocked_at
 polygons=[h['collisionPolygon'] for h in data.get('hotspots',[]) if h.get('collisionPolygon') and h['id'].startswith('ow_water_')]
 def inside(poly,x,y):
  hit=False
  for a,b in zip(poly,poly[1:]+poly[:1]):
   if (a['y']>y)!=(b['y']>y) and x<(b['x']-a['x'])*(y-a['y'])/(b['y']-a['y'])+a['x']:hit=not hit
  return hit
 g.blocked_at=lambda x,y:depth_blocked(x,y) or any(inside(p,x,y) for p in polygons)
 return g

def clear(g,a,b):
 n=max(1,math.ceil(math.dist(a,b)/3))
 return all(not g.blocked_at(a[0]+(b[0]-a[0])*i/n,a[1]+(b[1]-a[1])*i/n) for i in range(n+1))

def route(g,a,b,radius=0):
 if clear(g,a,b):return [a,b]
 step=8
 queue=[(math.dist(a,b),0,(0,0))];cost={(0,0):0};parents={}
 point=lambda k:(a[0]+k[0]*step,a[1]+k[1]*step)
 end=None
 while queue and len(cost)<150000:
  _,paid,k=heapq.heappop(queue)
  if paid>cost[k]:continue
  p=point(k)
  if radius and math.dist(p,b)<radius:end=k;b=p;break
  if math.dist(p,b)<step*2 and clear(g,p,b):end=k;break
  for dx,dy in [(1,0),(-1,0),(0,1),(0,-1),(1,1),(1,-1),(-1,1),(-1,-1)]:
   nk=(k[0]+dx,k[1]+dy);q=point(nk)
   if not(0<=q[0]<=g.WW and 0<=q[1]<=g.HH) or not clear(g,p,q):continue
   nc=paid+step*math.hypot(dx,dy)
   if nc>=cost.get(nk,float('inf')):continue
   cost[nk]=nc;parents[nk]=k;heapq.heappush(queue,(nc+math.dist(q,b),nc,nk))
 if end is None:raise RuntimeError(f'No walkable path {a} -> {b}')
 points=[b,point(end)]
 while end in parents:end=parents[end];points.append(point(end))
 points.reverse();simple=[points[0]];i=0
 while i<len(points)-1:
  j=len(points)-1
  while j>i+1 and not clear(g,points[i],points[j]):j-=1
  simple.append(points[j]);i=j
 return simple

def fit_patrols(scenes,hubs):
 for sid in hubs:
  d=scenes[sid];g=_scene_geometry(sid,d,d['depthConfig'])
  if isinstance(g,str):raise RuntimeError(sid+': '+g)
  for n in d['npcs']:
   if not n['id'].startswith('ow_'):continue
   old=n.get('patrol',{}).get('route',[])
   if len(old)<2:continue
   pts=[(p['x'],p['y']) for p in old];new=[]
   for a,b in zip(pts,pts[1:]+pts[:1]):new+=route(g,a,b)[:-1]
   n['patrol']['route']=[{'x':round(x,2),'y':round(y,2)} for x,y in new]
