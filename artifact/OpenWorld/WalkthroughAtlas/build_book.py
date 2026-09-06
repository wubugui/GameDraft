"""Build the walkthrough's local presentation data; no network or media writes."""
from __future__ import annotations
import json
import os
import re
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
SCENES = [
    ('雾津街头','街','street','雾津街头'),('test_room_b','巷','alley','后巷'),
    ('码头白天','码','dock','码头'),('河边','河','river','河边'),
    ('bridge_underpass','桥','bridge','桥下'),('mountain_pass','山','mountain','山路'),
    ('temple_exterior','院','temple-yard','庙前院'),('temple','殿','temple-hall','城隍庙内'),
    ('teahouse','茶','teahouse','茶馆'),
]


def main():
    atlas = json.loads((HERE/'atlas-data.json').read_text(encoding='utf-8'))
    route = json.loads((HERE/'route.json').read_text(encoding='utf-8'))
    strings = json.loads((ROOT/'public/assets/data/strings.json').read_text(encoding='utf-8'))
    def resolve(value):
        if not isinstance(value,str): return value
        def sub(m):
            try: return str(strings[m[1]][m[2]])
            except KeyError: return m[0]
        return re.sub(r'\[tag:string:([^:]+):([^\]]+)\]',sub,value)
    raw_items = json.loads((ROOT/'public/assets/data/items.json').read_text(encoding='utf-8'))
    if isinstance(raw_items,dict): raw_items = raw_items.get('items',list(raw_items.values()))
    names = {x['id']:resolve(x.get('name',x['id'])) for x in raw_items if isinstance(x,dict) and 'id' in x}
    quests = json.loads((ROOT/'public/assets/data/quests.json').read_text(encoding='utf-8'))
    quest_names = {q['id']:resolve(q.get('title',q['id'])) for q in quests if q['id'].startswith('ow_')}
    by_scene = {s['id']:s for s in atlas['scenes']}
    scenes = []
    for sid,prefix,slug,title in SCENES:
        s = by_scene[sid]
        bg = dict(s['background'])
        bg['fileHref'] = Path(os.path.relpath(bg['absolutePath'],HERE)).as_posix()
        entities=[]
        for i,e in enumerate(sorted(s['entities'],key=lambda e:(e['anchor']['y'],e['anchor']['x'],e['entityId'])),1):
            keep = {k:e[k] for k in ['markerId','entityId','kind','name','anchor','motion','schedule','scheduleAllEntries','hours','interactionRange','conditions','exit','questLinks','warning','notes','shape','geometry','anchorMeaning'] if k in e}
            keep['code'] = prefix+str(i).zfill(2)
            keep['name'] = resolve(keep['name'])
            if keep['entityId']=='z_梦待死之礼':
                keep['name']='梦境剧情触发区'
            if keep['entityId']=='ow_wind_rule_offer':
                keep['name']='侧门风缝 · 用规矩区域'
            if sid=='teahouse' and keep['entityId']=='ow_luo':
                keep['accessNote']='备用工位暂不可达；本攻略在后巷找罗伯。'
            if keep['kind']=='hotspot' and re.search('石缝|案板底|细缝|废缆卷|双结|落纸|潮纸|借物账|折角工票',keep['name']):
                keep['displayKind']='pickup'
            else: keep['displayKind']='hotspot' if keep['kind']=='zone' else keep['kind']
            entities.append(keep)
        if sid=='雾津街头':
            spawn=next(p for p in s['spawns'] if p['id']=='default')
            entities.append({'markerId':sid+'::@start','entityId':'@start','kind':'start','displayKind':'exit',
                             'name':'全新试玩起点','anchor':{'x':spawn['x'],'y':spawn['y']},'code':'起点'})
        scenes.append({'id':sid,'name':title,'prefix':prefix,'slug':slug,
                       'worldWidth':s['worldWidth'],'worldHeight':s['worldHeight'],
                       'background':bg,'entities':entities,'spawns':s['spawns']})
    out={'atlas':{'scenes':scenes,'totals':atlas['totals']},'route':route,'itemNames':names,'questNames':quest_names}
    (HERE/'app-data.js').write_text('window.WALKTHROUGH_DATA = '+json.dumps(out,ensure_ascii=False,separators=(',',':'))+';\n',encoding='utf-8')
    codes={e['markerId']:{'code':e['code'],'name':e['name'],'scene':s['name']} for s in scenes for e in s['entities']}
    (HERE/'marker-index.json').write_text(json.dumps(codes,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
    missing=[(st['id'],e['markerId']) for st in route['steps'] for e in st['entities'] if e['markerId'] not in codes]
    if missing: raise ValueError(f'Unmapped route targets: {missing}')
    print(json.dumps({'scenes':len(scenes),'markers':len(codes),'steps':len(route['steps']),'output':'app-data.js'},ensure_ascii=False))


if __name__=='__main__': main()
