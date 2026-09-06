"""One-shot content authoring record. Runtime truth lives in the editor JSON files."""
import copy
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
AS = ROOT / 'public/assets'
def read(p): return json.loads(p.read_text(encoding='utf-8'))
def write(p, d): p.write_text(json.dumps(d, ensure_ascii=False, indent=2) + '\n', encoding='utf-8', newline='\n')
scenes = {p.stem: read(p) for p in (AS / 'scenes').glob('*.json')}
changed = set()
strings = read(AS/'data/strings.json')
words = strings.setdefault('openWorld', {})
def txt(key, value):
    words[key] = value
    return '[tag:string:openWorld:' + key + ']'
def act(kind, **params): return {'type': kind, 'params': params}
def cond(graph, state, reached=False):
    d = {'narrative': graph, 'state': state}
    if reached: d['reached'] = True
    return d
def pos(sid, x, y):
    d = scenes[sid]
    return {'x': round(d['worldWidth']*x, 2), 'y': round(d['worldHeight']*y, 2)}
def scene(sid): changed.add(sid); return scenes[sid]
def upsert(rows, value):
    field = 'id' if 'id' in value else 'characterId'
    for i, row in enumerate(rows):
        if row.get(field) == value[field]: rows[i] = value; return
    rows.append(value)
def hotspot(sid, hid, label, xy, graph=None, entry=None, conditions=None, text=None):
    h = {'id': hid, 'type': 'inspect', 'label': label, **pos(sid,*xy),
         'interactionRange': 85, 'planes':['normal'], 'data': {}}
    if graph: h['data'] = {'graphId': graph, **({'entry':entry} if entry else {})}
    if text: h['data']['text'] = txt(hid, text)
    if conditions: h.update(conditions=conditions,conditionHidesEntity=True)
    upsert(scene(sid).setdefault('hotspots',[]), h)
    return h
def exit_to(sid, hid, label, xy, dest, spawn, new=False):
    hs = scene(sid).setdefault('hotspots', [])
    h = next((x for x in hs if x['id']==hid), None)
    if h is None:
        h = {'id':hid, 'type':'transition'}; hs.append(h)
    h.update(label=label, **pos(sid,*xy), interactionRange=85, planes=['normal'],
             data={'targetScene':dest,'targetSpawnPoint':spawn})
    h.pop('conditions',None)
    h.pop('autoTrigger',None)
    # Rectangles/polygons of the old exit must not remain at its previous location.
    for k in ['polygon','width','height']: h.pop(k,None)

# Reconnect existing near-country rooms to the production world, including a circuit
# through the west landing, river path and hill shrine. Story-only locations keep gates.
exit_to('雾津街头','T_出城','沿西口去河滩',(.055,.49),'河边','从城里')
exit_to('test_room_b','exit_to_a','回雾津街头',(.23,.94),'雾津街头','from_houxiang')
exit_to('test_room_b','T_回雾津街头','穿过巷口回街',(.85,.27),'雾津街头','from_houxiang')
scene('test_room_b')['spawnPoints']['from_wujin'] = pos('test_room_b',.78,.35)
exit_to('河边','T回城','上石阶回雾津',(.09,.20),'雾津街头','from_river')
exit_to('河边','T到山路','沿河上山',(.19,.89),'mountain_pass','from_street')
scene('河边')['spawnPoints']['从城里'] = pos('河边',.13,.27)
scene('河边')['spawnPoints']['从山路'] = pos('河边',.22,.82)
scene('河边')['spawnPoint'] = pos('河边',.13,.27)
exit_to('mountain_pass','exit_to_street','下山去河滩',(.08,.86),'河边','从山路')
exit_to('mountain_pass','T到河边','沿支路去河滩',(.63,.87),'河边','从山路')
exit_to('mountain_pass','exit_to_temple','沿石阶去旧庙',(.85,.10),'temple_exterior','from_mountain_pass')
scene('mountain_pass')['spawnPoints']['from_street'] = pos('mountain_pass',.17,.77)
scene('mountain_pass')['spawnPoints']['from_temple_exterior'] = pos('mountain_pass',.82,.18)
scene('mountain_pass')['spawnPoints']['spawn_0'] = pos('mountain_pass',.59,.78)
scene('mountain_pass')['spawnPoint'] = pos('mountain_pass',.17,.77)
exit_to('temple_exterior','exit_to_mountain_pass','沿来路下山',(.40,.89),'mountain_pass','from_temple_exterior')
exit_to('temple_exterior','T到庙宇室内','进旧庙正殿',(.265,.36),'temple','from_street')
scene('temple_exterior')['spawnPoints']['from_mountain_pass'] = pos('temple_exterior',.40,.89)
scene('temple_exterior')['spawnPoints']['spawn_0'] = pos('temple_exterior',.285,.415)
scene('temple_exterior')['spawnPoint'] = pos('temple_exterior',.40,.89)
exit_to('temple','T到室外','回到庙前院子',(.46,.91),'temple_exterior','spawn_0')
scene('temple')['spawnPoints']['from_street'] = pos('temple',.51,.84)
scene('temple')['spawnPoint'] = pos('temple',.51,.84)
exit_to('码头白天','ow_去桥下','沿河埠去老桥',(.07,.95),'bridge_underpass','from_street')
exit_to('bridge_underpass','exit_to_street','回到码头河埠',(.045,.61),'码头白天','ow_from_bridge')
exit_to('bridge_underpass','new_hotspot_1','沿右岸去河滩',(.745,.90),'河边','ow_from_bridge')
exit_to('河边','ow_去老桥','顺河去老桥',(.30,.97),'bridge_underpass','ow_from_river')
scene('码头白天').setdefault('spawnPoints',{})['ow_from_bridge'] = pos('码头白天',.16,.91)
scene('bridge_underpass')['spawnPoints']['from_street'] = pos('bridge_underpass',.073,.55)
scene('bridge_underpass')['spawnPoints']['ow_from_river'] = pos('bridge_underpass',.76,.84)
scene('bridge_underpass')['spawnPoint'] = pos('bridge_underpass',.073,.55)
scene('河边')['spawnPoints']['ow_from_bridge'] = pos('河边',.24,.89)

HUBS=['雾津街头','teahouse','test_room_b','码头白天','bridge_underpass','河边','mountain_pass','temple_exterior','temple']
# Preserve existing story actors when enabling phase filtering in an older room.
for sid in HUBS:
    d=scene(sid)
    if not d.get('dayNight',{}).get('enabled'):
        for n in d.get('npcs',[]): n.setdefault('phases',['辰','午','暮','夜'])
    d.setdefault('dayNight',{})['enabled']=True
    d.setdefault('entityGroups',[])
    upsert(d['entityGroups'],{'id':'ow_居民','label':'开放生活圈 · 居民','phases':['辰','午','暮','夜'],'planes':['normal']})

# Each placement is inspected against the painted floor before authoring. Short patrols
# follow individual work areas; stationary work and travel schedules are independent.
PEOPLE=[
 ('zhou','周三 · 码头脚夫','npc_lifu_anim','lifu_stand',[
   ('码头白天',.51,.61),('teahouse',.14857,.3619),('雾津街头',.60,.91)],
   [('07:00','11:00','码头白天'),('11:00','13:00','teahouse'),('13:00','18:00','码头白天'),('18:00','20:00','雾津街头'),('20:00','07:00',None)],
   '一担一担数清楚，莫拿汗水当零头。','晌午我在茶馆门边歇气，午后回货栈，向晚沿大街回家。','码头西头沿河埠能到老桥。要上山，先走西口河滩。','下工咯，肚皮比扁担还空。'),
 ('yang','杨嫂 · 热面摊','npc_teahouse_owner_anim','idle',[
   ('雾津街头',.4075,.8485),('test_room_b',.49,.73)],
   [('07:00','18:00','雾津街头'),('18:00','20:00','test_room_b'),('20:00','07:00',None)],
   '辣子自己添，莫把一钵油全舀起跑咯。','白天守铺，向晚收了碗回后巷。黑了就莫敲锅咯。','补篾匠罗伯在后巷右手摊口。周三晌午要去茶馆。','收摊咯！锅铲也要歇气。'),
 ('luo','罗伯 · 补篾匠','npc_storyteller_anim','idle',[
   ('test_room_b',.685,.63),('teahouse',.383,.429)],
   [('07:00','18:00','test_room_b'),('18:00','20:00','teahouse'),('20:00','07:00',None)],
   '篾条要泡软，急起编，头一担就散给你看。','辰时开摊，天擦黑切茶馆喝碗茶。夜里眼睛不得行，要回屋。','出后巷就是大街，热面摊在茶馆旁边。莫拐进摆白幡的人家。','手杆酸咯，切喝碗茶。'),
 ('he','何婆婆 · 浣衣人','npc_popo_anim','idle',[
   ('河边',.405,.575),('test_room_b',.49,.715)],
   [('07:00','11:00','河边'),('11:00','18:00','test_room_b'),('18:00','07:00',None)],
   '鞋底那层泥莫带过来，刚漂清的衣裳。','早起河滩漂衣裳，午后回巷子晾。太阳落了我就关门。','沿土路上头是回城的石阶，下头接山路，莫抄水边那条亮路。','衣裳收起，黑了潮气重。'),
 ('deng','邓幺 · 跑腿人','npc_coolie_c_anim','idle',[
   ('雾津街头',.295,.665),('码头白天',.77,.36),('test_room_b',.61,.49)],
   [('07:00','11:00','雾津街头'),('11:00','18:00','码头白天'),('18:00','20:00','test_room_b'),('20:00','07:00',None)],
   '借过哈，嘴巴快没得用，脚杆快才赶得上饭。','早上跑街，午后货栈交信，向晚钻后巷。你原地等，我可等不起。','茶馆、后巷、码头都通。看图能认地方，记不清就问守摊的。','最后一趟，送完就回切。'),
 ('ding','丁四 · 巡更人','官差刀_anim','官兵刀_站立',[
   ('bridge_underpass',.69,.65),('雾津街头',.62,.80)],
   [('07:00','18:00',None),('18:00','20:00','bridge_underpass'),('20:00','07:00','雾津街头')],
   '檐下火星踩熄了再走。喊你防火，不是防我。','白天补觉，向晚看一遍桥头，入夜巡街。走不动就在路边歇一哈。','城门的事找城门当差的。我只管这条街的火。河滩夜路照样能回城。','换个地方看一转，火烛当心。'),
 ('monk','扫院僧','npc_ascetic_monk_anim','monk_stand',[
   ('temple_exterior',.325,.46),('temple',.58,.80)],
   [('07:00','11:00','temple_exterior'),('11:00','20:00','temple'),('20:00','07:00',None)],
   '香灰扫到一边就好，莫对到别人鞋面扬。','早起扫院子，午后在殿边拾掇。入夜落闩，人要走，我给你留条路。','下山认石阶，到了岔路往河滩。荒草里头那些白纸，不是指路的。','扫帚收咯，脚下慢点。'),
 ('man','小满 · 滚环小孩','boy_ring_anim','boy_stand_ring',[
   ('雾津街头',.245,.715),('test_room_b',.585,.585)],
   [('07:00','18:00','雾津街头'),('18:00','20:00','test_room_b'),('20:00','07:00',None)],
   '我没撞你，是勒个环先跑过去的！','白天在街上滚环，向晚回后巷，黑了我娘要拧耳朵。','找杨嫂就闻辣子味，找罗伯就听篾条响。你啷个连勒个都不晓得？','回家咯，再耍要挨骂。'),
 ('qian','钱叔 · 守船人','npc_coolie_a_anim','idle',[
   ('码头白天',.625,.675),('bridge_underpass',.735,.81)],
   [('07:00','18:00','码头白天'),('18:00','07:00','bridge_underpass')],
   '过跳板莫抢，人摔了比货难捞。','白天守码头，向晚把小船拢到桥下，黑了也在那里。','码头往西，沿河埠就到老桥。桥另一头的小路接河滩，绕得回城。','小船要拢岸了，明早再卸。'),
 ('huang','黄婶 · 采药人','npc_popo_anim','idle',[
   ('mountain_pass',.54,.675),('test_room_b',.64,.52)],
   [('07:00','18:00','mountain_pass'),('18:00','20:00','test_room_b'),('20:00','07:00',None)],
   '叶子认不准就莫往嘴巴头塞，苦不苦不是验毒的法子。','太阳在就上山，向晚背篓子回后巷，天黑收工。','岔口往上走石阶是旧庙，往下到河滩。阎王岭是另一条路，莫认错了。','这篓够了，天黑前下山。'),
]
registry=read(AS/'data/character_registry.json')
schedules=read(AS/'data/npc_schedules.json')
bubbles=read(AS/'data/bubble_lines.json')
bubbles.setdefault('tuning', {})['audibleRange'] = 480
dialogue={'schemaVersion':1,'id':'开放世界_街坊','entry':'zhou','meta':{'title':'雾津街坊 · 职业、作息、问路与委托'},'nodes':{'end':{'type':'end'}}}
nodes=dialogue['nodes']
def line(key, text, next='end', speaker='npc'):
    nodes[key]={'type':'line','speaker':{'kind':speaker},'text':txt(key,text),'next':next}
def option(key,text,next,conditions=None):
    v={'id':key,'text':txt(key,text),'next':next}
    if conditions: v['requireCondition']={'all':conditions}
    return v
for key,name,bundle,idle,places,entries,greeting,day,road,leave in PEOPLE:
    cid='ow_'+key
    upsert(registry['characters'],{'id':cid,'name':name,'animFile':f'/resources/runtime/animation/{bundle}/anim.json', 'dialogueGraphId':'开放世界_街坊','dialogueGraphEntry':key})
    upsert(schedules['schedules'],{'characterId':cid,'entries':[{'from':a,'to':b,'scene':s} for a,b,s in entries], 'exitLine':txt(key+'_exit',leave)})
    for sid,x,y in places:
        walk={'npc_lifu_anim':'lifu_walk','官差刀_anim':'官兵刀_走路','npc_ascetic_monk_anim':'monk_walk','boy_ring_anim':'boy_walk'}.get(bundle,'walk')
        n={'id':cid,'characterId':cid,**pos(sid,x,y),'initialAnimState':idle,'interactionRange':95,'initialFacing':'left' if x>.5 else 'right','group':'ow_居民','planes':['normal'],'phases':['辰','午','暮','夜'],'patrol':{'route':[pos(sid,x,y)],'speed':55,'moveAnimState':walk}}
        upsert(scene(sid).setdefault('npcs',[]),n)
    nodes[key]={'type':'switch','cases':[{'conditions':[{'timePhase':'夜'}],'next':key+'_night'}], 'defaultNext':key+'_hello'}
    line(key+'_hello',greeting,key+'_menu')
    line(key+'_night',('这哈夜深了。'+greeting) if key in ['qian','ding'] else greeting,key+'_menu')
    line(key+'_day',day,key+'_menu'); line(key+'_road',road,key+'_menu')
    nodes[key+'_menu']={'type':'choice','options':[
        option(key+'_ask_day','你平时在哪点？',key+'_day'),
        option(key+'_ask_road','附近的路啷个走？',key+'_road'),
        option(key+'_bye','行，我走一转。','end')]}
    upsert(bubbles['lineSets'],{'id':cid+'_ambient','speaker':{'kind':'character','characterId':cid},'cooldownMs':36000+len(key)*2100,'pickMode':'sequence','durationMs':3400,'lines':[{'text':txt(key+'_bark1',greeting.split('，')[0]+'。')},{'text':txt(key+'_bark2',{'zhou':'一担两担，数清楚再记工。','yang':'热面起锅，过路的让一哈！','luo':'勒根篾条，泡软了再用。','he':'鞋上的泥莫甩到衣裳上！','deng':'借过哈，赶到交信！','ding':'火烛当心，门闩看好。','monk':'灰扫开，路留出来。','man':'勒一圈不算，再来！','qian':'跳板窄，一个一个过。','huang':'认不准的叶子莫乱摘。'}[key])}]})

# Patrol only animated walkers; the NPCs who repair, wash or serve stay at their station.
PATROLS=[('雾津街头','deng',[(.29,.67),(.27,.733)],65,'walk'),
 ('码头白天','deng',[(.74,.40),(.79,.34),(.84,.29)],64,'walk'),
 ('雾津街头','man',[(.235,.74),(.265,.68),(.28,.65)],72,'boy_walk'),
 ('雾津街头','ding',[(.66,.82),(.72,.74)],48,'官兵刀_走路'),
 ('temple_exterior','monk',[(.30,.46),(.34,.48),(.385,.515)],32,'monk_walk')]
for sid,key,route,speed,anim in PATROLS:
    n=next(n for n in scene(sid)['npcs'] if n['id']=='ow_'+key)
    n.update(pos(sid,*route[0])); n['patrol']={'route':[pos(sid,*xy) for xy in route],'speed':speed,'moveAnimState':anim}

# Door anchors sit on the same local walkable corridor as the station, not on roofs.
ANCHORS={'雾津街头':[(.23,.79),(.425,.79),(.59,.91),(.774,.647)],
 'teahouse':[(.20,.333),(.35,.39)], 'test_room_b':[(.45,.745),(.64,.69),(.78,.37)],
 '码头白天':[(.54,.64),(.67,.71),(.87,.24)],'河边':[(.355,.61)],
 'bridge_underpass':[(.765,.85),(.75,.74)],'mountain_pass':[(.58,.71)],
 'temple_exterior':[(.405,.545)],'temple':[(.695,.79)]}
for sid,pts in ANCHORS.items():
    d=scene(sid); d['exitAnchors']=[{'id':f'ow_door_{i}',**pos(sid,*xy)} for i,xy in enumerate(pts)]

# Give each resident a door on their side of the building; nearest Euclidean distance
# alone picks doors through walls in the street and the back alley.
door_choices={('雾津街头','yang'):0,('雾津街头','ding'):3,('test_room_b','luo'):2,('test_room_b','he'):1}
door_points={('teahouse','zhou'):(112,179),('temple','monk'):(408,375)}
for key,_,_,_,places,*_ in PEOPLE:
    exit_id='ow_exit_'+key
    next(s for s in schedules['schedules'] if s['characterId']=='ow_'+key)['preferredExit']=exit_id
    for sid,*_ in places:
        d=scene(sid);n=next(n for n in d['npcs'] if n['id']=='ow_'+key)
        anchors=[a for a in d['exitAnchors'] if a['id'].startswith('ow_door_')]
        a=anchors[door_choices[(sid,key)]] if (sid,key) in door_choices else min(anchors,key=lambda a:(n['x']-a['x'])**2+(n['y']-a['y'])**2)
        x,y=door_points.get((sid,key),(a['x'],a['y']))
        upsert(d['exitAnchors'],{'id':exit_id,'x':x,'y':y})

# Independent signal flows; no new global progress flags.
nar=read(AS/'data/narrative_graphs.json')
quests=read(AS/'data/quests.json')
items=read(AS/'data/items.json')
for iid,name,desc in [('ow_tally','折角工票','货栈的工票。周三那一担货压在折角下面，朱点还看得清。'),('ow_bowl','缺口粗瓷碗','杨嫂借给脚夫的饭碗。缺口用红线缠着，认不错。')]:
    upsert(items,{'id':iid,'name':name,'type':'key','description':desc,'maxStack':1})
def signal(key):
    sid='ow_'+key
    upsert(nar['signals'],{'id':sid,'label':'开放生活圈 · '+key})
    return sid
def emit_node(key, sig): nodes[key]={'type':'runActions','actions':[act('emitNarrativeSignal',signal=signal(sig))],'next':'end'}
def transition(fr,to,sig,conditions=None):
    t={'id':fr+'_'+to+'_'+sig,'from':fr,'to':to,'signal':signal(sig)}
    if conditions:t['conditions']=conditions
    return t
def flow(gid,label,states,transitions,elements=None):
    graph={'id':gid,'label':label,'ownerType':'flow','ownerId':gid,'initialState':'initial','states':{},'transitions':transitions}
    for i,(state,title,actions) in enumerate(states):
        graph['states'][state]={'id':state,'label':title,'meta':{'editor':{'x':i*260,'y':0}}}
        if actions:graph['states'][state]['onEnterActions']=actions
    c={'id':gid+'_composition','label':label,'description':'雾津开放生活圈 · 独立信号流程，不推进寻狗主线。','mainGraph':graph,'elements':elements or []}
    upsert(nar['compositions'],c)
    return graph
TALLY='flow_ow_tally'; BOWL='flow_ow_bowl'; WATER='flow_ow_water'
flow(TALLY,'折角工票',[
 ('initial','未问工票',[]),('accepted','答应找票',[]),
 ('found','找到折角工票',[act('giveItem',id='ow_tally',count=1,critical=True)]),
 ('done','当面核清工钱',[act('removeItem',id='ow_tally',count=1),act('giveCurrency',amount=12)])],
 [transition('initial','accepted','tally_accept'),transition('accepted','found','tally_find'),transition('found','done','tally_return')])
flow(BOWL,'借出去的一只碗',[
 ('initial','还没问起',[]),('accepted','替杨嫂带话',[]),
 ('carrying','取回粗瓷碗',[act('giveItem',id='ow_bowl',count=1,critical=True)]),
 ('done','碗回面摊',[act('removeItem',id='ow_bowl',count=1),act('giveCurrency',amount=6)])],
 [transition('initial','accepted','bowl_accept'),transition('accepted','carrying','bowl_collect'),transition('carrying','done','bowl_return')])
def offer(who,key,label,text,sig,conditions):
    line(key,text,key+'_emit'); emit_node(key+'_emit',sig)
    nodes[who+'_menu']['options'].insert(0,option(key+'_option',label,key,conditions))
offer('zhou','tally_offer','你在数啥子？','货栈少算我一担。工票折了角，收缆绳时不晓得夹到哪点了。你沿货栈门前找哈，莫往水头跳。','tally_accept',[cond(TALLY,'initial')])
offer('zhou','tally_return','把折角工票递过去。','就是勒张！折角下面还有个朱点。整整一担，不是我讹他。跑腿钱拿到，今天这口气算顺咯。','tally_return',[cond(TALLY,'found')])
offer('yang','bowl_offer','锅边啷个少个碗？','周三把碗端走还没还。我不催他饭钱，就缺勒只盛面的碗。晌午茶馆、午后货栈，向晚大街，帮我喊他一声。','bowl_accept',[cond(BOWL,'initial')])
offer('zhou','bowl_collect','杨嫂喊你还碗。','哎哟，碗洗干净了，揣在担子头忘咯。你替我带回去。她向晚在后巷，黑了就等明天，莫去拍门。','bowl_collect',[cond(BOWL,'accepted')])
offer('yang','bowl_return','把洗干净的碗放回去。','缺口上的红线还在，是我的。周三那个脑壳哟。给你留碗热汤，这几文抵你跑腿。','bowl_return',[cond(BOWL,'carrying')])
for who,gid,thanks in [('zhou',TALLY,'货栈今天没敢再装糊涂。你来的话，茶钱算我那一份。'),('yang',BOWL,'碗回来了。你往旁边站，我给后头下力的舀面，莫遭滚水烫了。')]:
    nodes[who]['cases'].insert(0,{'conditions':[cond(gid,'done')],'next':who+'_thanks'})
    line(who+'_thanks',thanks,who+'_menu')
    upsert(bubbles['lineSets'],{'id':'ow_'+who+'_thanks','speaker':{'kind':'character','characterId':'ow_'+who},'when':cond(gid,'done'),'trigger':'approach','priority':3,'cooldownMs':60000,'lines':[{'text':txt(who+'_thanks_bark',thanks)}]})

offer('qian','water_offer','桥下有啥子不对？','昨晚上没涨水，桥脚却多了一道湿痕。我守船走不开。你看哈桥头木桩、河滩芦苇、山路旧水线。三处比到看，莫只听江水响就自己吓自己。','water_accept',[cond(WATER,'initial')])
water_elements=[]
EVIDENCE=[('post','bridge_underpass','桥头旧木桩',(.725,.845),'木桩朝水的一面是干的，背水的一面却有一道新湿痕。指腹贴上去，冷。'),
 ('reed','河边','岸边倒伏的芦苇',(.43,.615),'芦苇根边的细灰没被冲散。倒伏的几根朝着岸上，像有人从水头拖过东西。'),
 ('stone','mountain_pass','岔路石上的旧水线',(.545,.705),'石脚的旧水线已经发白。上面新沾的泥只有窄窄一条，到背阴处便断了。')]
for i,(key,sid,label,xy,description) in enumerate(EVIDENCE):
    gid='flow_ow_water_'+key
    graph={'id':gid,'label':label,'ownerType':'hotspot','ownerId':'ow_water_'+key,'initialState':'initial','states':{'initial':{'id':'initial','label':'未察看','meta':{}},'seen':{'id':'seen','label':'已经察看','meta':{}}},'transitions':[transition('initial','seen','water_'+key,[cond(WATER,'accepted')])]}
    water_elements.append({'id':'water_'+key,'kind':'wrapperGraph','label':label,'refId':'','x':i*300,'y':250,'ownerType':'hotspot','ownerId':'ow_water_'+key,'graph':graph,'meta':{'emits':[],'reads':[],'commands':[]}})
    line('water_'+key,description,'water_'+key+'_emit',speaker='player')
    # Narration is neutral, not attributed to the illiterate protagonist.
    nodes['water_'+key]['speaker']={'kind':'literal','name':'旁白'}
    emit_node('water_'+key+'_emit','water_'+key)
    hotspot(sid,'ow_water_'+key,label,xy,'开放世界_街坊','water_'+key,[cond(WATER,'accepted')])
all_seen=[cond('flow_ow_water_'+k,'seen',True) for k,*_ in EVIDENCE]
g=flow(WATER,'桥下那道水痕',[('initial','未问起',[]),('accepted','三处对照',[]),('ready','带回见闻',[]),('done','钱叔收起跳板',[act('giveCurrency',amount=8)])],
 [transition('initial','accepted','water_accept'),{'id':'clues_ready','from':'accepted','to':'ready','trigger':'reactive','signal':'__draft__','conditions':all_seen},transition('ready','done','water_report')],water_elements)
offer('qian','water_report','把三处看到的都摆出来。','没涨水，湿痕却在背水面……晓得了。今天不把船拴桥脚。勒几文拿到，往后见到没把握的东西，绕开就是，莫逞能。','water_report',[cond(WATER,'ready')])
nodes['qian']['cases'].insert(0,{'conditions':[cond(WATER,'done')],'next':'qian_after'})
line('qian_after','船挪到亮处咯。你问那道印子？还在。我没拿刷子碰它。','qian_menu')
# Listening changes where the boatkeeper spends the night, not only his dialogue.
qian_schedule=next(s for s in schedules['schedules'] if s['characterId']=='ow_qian')
qian_schedule['entries'].insert(0,{'from':'18:00','to':'07:00','scene':'码头白天','conditions':[cond(WATER,'done')]})
nodes['qian_day_before']=nodes['qian_day']
nodes['qian_day']={'type':'switch','cases':[{'condition':cond(WATER,'done'),'next':'qian_safe_day'}],'defaultNext':'qian_day_before'}
line('qian_safe_day','往后白天夜里都在码头看船。桥脚先不拴咯，有事到货栈前头喊我。','qian_menu')

hotspot('码头白天','ow_tally_pickup','缆绳旁的折角纸片',(.465,.68),'开放世界_街坊','tally_find',[cond(TALLY,'accepted')])
line('tally_find','缆绳底下压着张折角工票。把折角抹平，一枚朱点从纸缝里露出来。','tally_find_emit')
nodes['tally_find']['speaker']={'kind':'literal','name':'旁白'}
emit_node('tally_find_emit','tally_find')

def quest(gid,title,description,objectives):
    upsert(quests,{'id':gid.replace('flow_',''),'group':'xungou','type':'side','sideType':'errand','title':txt(gid+'_title',title),'description':txt(gid+'_desc',description),'preconditions':[cond(gid,'accepted',True)],'completionConditions':[cond(gid,'done',True)],'acceptActions':[],'rewards':[],'nextQuests':[],'announce':'toast','autoFocus':False,'objectives':objectives})
def objective(key,text,conditions,sid=None,entity=None):
    o={'id':key,'text':txt(key,text),'completeWhen':conditions}
    if sid:o['guidance']=[{'kind':'mapMarker','sceneId':sid}]
    if entity:o['guidance'].append({'kind':'worldMarker','sceneId':sid,'entityKind':'hotspot','entityId':entity,'label':'察看','offscreenArrow':True,'showDistance':True})
    return o
quest(TALLY,'折角工票','周三少算了一担工钱。去货栈门前缆绳旁找折角工票，再按他的作息找到他核清。',[
 objective('tally_find_obj','检查货栈门前缆绳旁的纸片',[cond(TALLY,'found',True)],'码头白天','ow_tally_pickup'),
 objective('tally_return_obj','把工票交还周三；晌午茶馆、午后货栈、向晚大街',[cond(TALLY,'done',True)])])
quest(BOWL,'借出去的一只碗','杨嫂的碗还在周三手里。找到他取碗，白天还到街头面摊；向晚去后巷，入夜可等到明早。',[
 objective('bowl_collect_obj','找到周三，取回杨嫂的粗瓷碗',[cond(BOWL,'carrying',True)]),
 objective('bowl_return_obj','把碗交还杨嫂',[cond(BOWL,'done',True)])])
quest(WATER,'桥下那道水痕','钱叔看见桥脚有一道不合水势的湿痕。三处可以按任意顺序看，查清后回来告诉守船人。',[
 *[objective('water_'+k+'_obj','察看'+label,[cond('flow_ow_water_'+k,'seen',True)],sid,'ow_water_'+k) for k,sid,label,xy,description in EVIDENCE],
 objective('water_report_obj','回去找钱叔；白天码头、向晚和夜里桥下',[cond(WATER,'done',True)])])

# Rest is an explicit player choice. A finite utility flow owns the time actions.
REST='flow_ow_rest'
rest_states=[('initial','闲坐',[])]
rest_trans=[]
rest_nodes={'end':{'type':'end'}}
opts=[]
for phase,title in [('辰','歇到辰时开市'),('午','歇到晌午'),('暮','歇到向晚'),('夜','等到入夜')]:
    key='wait_'+phase
    rest_states.append((key,title,[act('fadeWorldToBlack',durationMs=350),act('advanceTimeTo',phase=phase,transition='timelapse'),act('fadeWorldFromBlack',durationMs=450)]))
    rest_trans.append(transition('initial',key,'rest_'+phase))
    rest_trans.append({'id':key+'_return','from':key,'to':'initial','trigger':'reactive','signal':'__draft__','conditions':[{'all':[]}]})
    opts.append(option(key,title,key))
    rest_nodes[key]={'type':'runActions','actions':[act('emitNarrativeSignal',signal=signal('rest_'+phase))],'next':'end'}
opts.append(option('wait_no','这哈不歇。','end'))
rest_nodes['root']={'type':'line','speaker':{'kind':'literal','name':'歇脚处'},'text':txt('rest_intro','找个落脚处，把脚杆上的劲松下来。歇到哪一阵？若等眼下这个时辰，就到明天咯。'),'next':'choose'}
rest_nodes['choose']={'type':'choice','options':opts}
flow(REST,'街坊歇脚 · 行动推进时辰',rest_states,rest_trans)
write(AS/'dialogues/graphs/开放世界_歇脚.json',{'schemaVersion':1,'id':'开放世界_歇脚','entry':'root','meta':{'title':'公共歇脚点 · 时段选择'},'nodes':rest_nodes})
for sid,xy in [('雾津街头',(.393,.87)),('码头白天',(.365,.735)),('test_room_b',(.675,.60)),('河边',(.37,.66)),('bridge_underpass',(.43,.865)),('mountain_pass',(.52,.665)),('temple_exterior',(.34,.50)),('temple',(.67,.77))]:
    hotspot(sid,'ow_rest','歇脚 · 等一等',xy,'开放世界_歇脚')

# Signs and small observations give routes a reason to be explored without forced scenes.
FLAVOR=[('雾津街头','ow_sign','街口旧路牌',(.554,.955),'西口通河滩，河埠通码头；后巷补锅补篾，茶馆歇脚问人。过路的人拿炭笔添了一句：夜路也认原路，莫跟生人抄近道。'),
 ('test_room_b','ow_bamboo','铺边泡着的篾条',(.715,.60),'长篾条盘在水盆里，粗细分了三捆。盆沿有一串小刀豁口，做篾的人比日历记得清。'),
 ('码头白天','ow_port_rules','货栈墙上的脚帮规矩',(.52,.52),'先点担，后记工。跳板只许一人过。最后一行被雨水洇开了，旁边新添一道朱点。'),
 ('河边','ow_laundry','石边晾衣绳',(.37,.575),'树根间搭着一根细绳，结头打在背水的一面。洗衣人来得早，衣裳干不干，要看雾肯不肯散。'),
 ('mountain_pass','ow_fork','岔路脚印',(.465,.455),'上石阶的鞋印浅，下河滩的草鞋印深。树下那些零碎白纸没有字，谁也没拿它指路。'),
 ('temple_exterior','ow_incense','院门香灰',(.405,.53),'香灰扫成一道细细的边，避开了人进出的路。墙角有新扎的扫帚，庙破，人还在打整。'),
 ('bridge_underpass','ow_bridge_rule','栏杆上的刻痕',(.35,.41),'栏杆上刻着几个歪字：过桥莫数人。最末一个字被摸得发亮，像不少人在这里停过手。')]
for sid,hid,label,xy,description in FLAVOR: hotspot(sid,hid,label,xy,text=description)

# The old bridge depth bake treats the open water as floor. Native hotspot collision
# polygons close that shortcut while preserving the bridge deck and both banks.
for hid,label,xy,points,text in [
 ('ow_water_downstream','桥下缓水',(.135,.61),[(.17,.555),(.22,.42),(.31,.45),(.42,.52),(.53,.60),(.66,.67),(.76,.75),(.70,.82),(.60,.87),(.50,.855),(.38,.785),(.25,.715),(.16,.61)],'水面看起平，桥墩背后却有个慢慢打转的涡。岸边和桥面能走，水里没有落脚的地方。'),
 ('ow_water_upstream','桥外江面',(.32,.365),[(.135,0),(.93,0),(.81,.155),(.74,.245),(.645,.35),(.65,.45),(.67,.465),(.65,.50),(.57,.425),(.48,.375),(.38,.30),(.335,.235),(.28,.19),(.16,.21)],'雾把远岸吃掉一半，灯影落下去就散了。顺着桥栏走，莫拿水里的亮处当石头。')]:
    h=hotspot('bridge_underpass',hid,label,xy,text=text)
    h['collisionPolygon']=[pos('bridge_underpass',*p) for p in points]

map_data=read(AS/'data/map_config.json')
for n in map_data['nodes']:
    if n['sceneId'] in HUBS:
        n['runtimeVisible']=True; n.pop('devOnly',None); n['unlockConditions']=[]
        if n['sceneId']=='temple': n.update(name='旧庙正殿', y=116.0)
        if n['sceneId']=='temple_exterior': n['name']='旧庙前院'
        if n['sceneId']=='mountain_pass': n['name']='河滩山路'
        if n['sceneId']=='bridge_underpass': n['name']='老桥河埠'

# No dangling invented eco stats: use actual witnessed events for these older authored
# observations, preserving their detailed and plain branches.
for p in (AS/'dialogues/graphs').glob('未接_生态*.json'):
    data=read(p); dirty=False
    def repair(v):
        if isinstance(v,dict):
            if v.get('narrative')=='eco_眼力':
                v.update(narrative=WATER,state='done',reached=True);return True
            if v.get('narrative')=='eco_风评':
                v.update(narrative=TALLY if v.get('state')=='面熟' else 'scenario_背尸',state='done' if v.get('state')=='面熟' else 'fled',reached=True);return True
            return any_results([repair(x) for x in v.values()])
        if isinstance(v,list): return any_results([repair(x) for x in v])
        return False
    def any_results(results):return any(results)
    if repair(data):write(p,data)

# The original opening contains an empty-key no-op; remove only that invalid action.
p=AS/'dialogues/graphs/序章_寻狗_听书开场.json';d=read(p)
n=d['nodes']['k_zoom_back']
n['actions']=[a for a in n.get('actions',[]) if not(a.get('type')=='setFlag' and not a.get('params',{}).get('key'))]
write(p,d)

# A one-frame funeral bearer cannot convincingly walk: Laizi keeps his authored spot.
n=next(n for n in scene('雾津街头')['npcs'] if n['id']=='NPC_癞子');n.pop('patrol',None)
for sid in ['码头白天','mountain_pass','temple','bridge_underpass']:
    for n in scene(sid).get('npcs',[]):
        if n.get('name')=='New NPC': n['name']='拴船的木箱' if '箱子' in n.get('animFile','') else '歇脚的行路人'

# Give the existing unvoiced passers-by a reason to occupy their authored stations.
PASSERS=[
 ('码头白天','new_npc_0','候船的老客','port_waiter','船没靠拢，人倒先挤成一堆。你有急事就问守船的钱叔，我只等我屋头那个背包袱的。'),
 ('码头白天','new_hotspot_4','候船的洋人女子','port_lady','我等人。船来了，他还没到……你认得去茶馆的路？我再等一哈。'),
 ('码头白天','new_hotspot_6','歇肩的搬运工','port_porter','肩头压麻了，换边也不得行。让我歇两口气，下一担就起。跳板上莫站人。'),
 ('mountain_pass','new_npc_0','歇脚的挑担客','hill_traveler','石阶一层一层爬，莫看着庙檐就往草里头钻。我歇够了就下山，你要回城认河滩那头。'),
 ('temple','new_npc_0','看香的道人','temple_keeper','香灰莫乱扒，瓦也莫乱踩。下过雨，梁上要掉灰。找扫院的，白天就在院里和殿边。'),
 ('bridge_underpass','new_npc_0','桥边等人的汉子','bridge_waiter','说好在桥边碰头，他还没来。水响听起近，岸脚滑得很，等人就等人，莫往下面探。')]
for sid,nid,name,key,speech in PASSERS:
    n=next(n for n in scene(sid)['npcs'] if n['id']==nid)
    n.update(name=name,dialogueGraphId='开放世界_街坊',dialogueGraphEntry=key)
    if sid in ['mountain_pass','bridge_underpass']:
        n.update(animFile='/resources/runtime/animation/npc_coolie_b_anim/anim.json',initialAnimState='idle')
    line(key,speech)
    upsert(bubbles['lineSets'],{'id':'ow_'+key,'speaker':{'kind':'entity','id':nid},'scenes':[sid],'cooldownMs':59000,'durationMs':3000,'lines':[{'text':txt(key+'_bark',speech.split('。')[0]+'。')}]})
n=next(h for h in scene('码头白天')['hotspots'] if h['id']=='new_hotspot_3')
n.update(label='磨亮的河埠石阶')
n['data']={'text':txt('port_steps','石阶正中磨得发亮，边上却长着一层薄青苔。常走的人都踏中间，挑重担的尤其小心。')}
for sid,hid,label in [('雾津街头','主线_吃饭点A','包子铺'),('雾津街头','主线s1藏钱点A','墙脚藏钱处'),('码头白天','主线s1藏钱点B','货栈藏钱处'),('码头白天','new_hotspot_箱子堆','堆起的货箱'),('码头白天','new_hotspot_13','落水货箱的捞取处'),('temple_exterior','庙宇-纸人','墙边纸人'),('temple_exterior','庙宇-洋人棺材','院内的洋人棺材')]:
    next(h for h in scene(sid)['hotspots'] if h['id']==hid)['label']=label
h=next(h for h in scene('bridge_underpass')['hotspots'] if h['id']=='new_hotspot_2')
h.update(label='石阶边的旧灯座')
h['data']={'text':txt('bridge_lamp','灯座底下积着一圈黑油。风吹得火苗偏过去，石阶还是照得清。沿栏杆走，上桥下桥都认得路。')}

warps=read(AS/'data/dev_narrative_warps.json')
upsert(warps['warps'],{'id':'开放雾津','label':'开放世界 · 街坊与近郊','scene':'雾津街头','flowGraph':'flow_xungou_main','flowState':'state_2'})
write(AS/'data/dev_narrative_warps.json',warps)
# Route to a menu containing only the topics this resident can discuss now.
# Keep requireCondition on each option as a second guard if state changes mid-dialogue.
for menu_id, menu in list(nodes.items()):
    if menu.get('type')!='choice': continue
    gated=[o for o in menu['options'] if 'requireCondition' in o]
    if not gated: continue
    cases=[]
    for mask in range(1<<len(gated)):
        selected=[o for o in menu['options'] if o not in gated or mask & (1<<gated.index(o))]
        variant=menu_id+'_'+str(mask)
        nodes[variant]={'type':'choice','options':selected}
        tests=[o['requireCondition'] if mask & (1<<i) else {'not':o['requireCondition']} for i,o in enumerate(gated)]
        cases.append({'condition':{'all':tests},'next':variant})
    nodes[menu_id]={'type':'switch','cases':cases,'defaultNext':menu_id+'_0'}
write(AS/'dialogues/graphs/开放世界_街坊.json',dialogue)
# Keep the teahouse door interactable from the actual foot of its steps.
next(h for h in scenes['雾津街头']['hotspots'] if h['id']=='T_进茶馆').update(x=1726,y=1790)
from fit_world_routes import fit_patrols
fit_patrols(scenes,HUBS)
for sid in changed:write(AS/'scenes'/f'{sid}.json',scenes[sid])
for f,d in [('strings.json',strings),('character_registry.json',registry),('npc_schedules.json',schedules),('bubble_lines.json',bubbles),('narrative_graphs.json',nar),('quests.json',quests),('items.json',items),('map_config.json',map_data)]:write(AS/'data'/f,d)
print('Authored',len(changed),'scenes;',len(PEOPLE),'residents;',sum(len(p[4]) for p in PEOPLE),'placements;',len(words),'text entries')
