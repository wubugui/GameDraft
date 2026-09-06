"""One-shot native authoring: C05 paper work, S11 paste, S13 drying paper.

Not a runtime format. Do not rerun over later topic/schedule edits.
"""
from copy import deepcopy
from native_authoring import *

a = Author('owPaper', '开放世界_纸扎', '纸、糨糊和站不稳的纸人', 'bench')
line, run, switch, choice, option = a.line, a.run, a.switch, a.choice, a.option
G, B, P, S, R, D = ('flow_ow_paper', 'flow_ow_paper_splint', 'flow_ow_paper_seam',
                    'flow_ow_paste', 'flow_ow_paste_recipe', 'flow_ow_dry_paper')
remade, braced = state(G, 'remade', True), state(G, 'braced', True)
done = any_of(remade, braced)
new_ready, old_ready = state(G, 'remade_ready'), state(G, 'braced_ready')
ready = any_of(new_ready, old_ready)
split, seam = state(B, 'done', True), state(P, 'done', True)
repair_started = any_of(split, seam)
not_prepared = all_of(neg(done), neg(ready))
dry_done, paste_done = state(D, 'done', True), state(S, 'done', True)
daylight = all_of({'flag': 'minutes_of_day', 'op': '>=', 'value': 420},
                 {'flag': 'minutes_of_day', 'op': '<', 'value': 1020})
time = lambda minutes: act('advanceTime', minutes=minutes, transition='timelapse')
notice = lambda key, text: act('showNotification', text=a.text(key, text), type='info')
reactive = lambda source, target, *cs: {'id': source + '_' + target, 'from': source, 'to': target,
    'trigger': 'reactive', 'signal': '__draft__', 'conditions': list(cs)}
ng = read('data/narrative_graphs.json')

main = graph(G, '纸人不肯站', {
    'initial': '尚未看到歪脚', 'accepted': '重做骨架，或衬稳旧脚',
    'remade_ready': ('新纸人待交', [take('ow_dry_paper'), take('ow_paste'), time(45), give('ow_new_servant'),
        notice('new_ready_notice', '重做合格：干纸与糨糊各用一份，耗时四十五分钟。纸人已收好，交罗伯领十六文。')]),
    'braced_ready': ('旧纸人修稳待交', [time(15), give('ow_braced_servant'),
        notice('old_ready_notice', '两脚已修稳，耗时十五分钟。旧纸人已收好，交罗伯领八文。')]),
    'remade': ('新作交付，罗伯晚些留巷理料', [take('ow_new_servant'), act('giveCurrency', amount=16)]),
    'braced': ('修旧交付，罗伯照常去茶馆', [take('ow_braced_servant'), act('giveCurrency', amount=8)]),
}, [transition('initial', 'accepted', sig) for sig in ['ow_paper_accept', 'ow_paper_splint', 'ow_paper_seam']] + [
    transition('accepted', 'remade_ready', 'ow_paper_success', has('ow_dry_paper'), has('ow_paste'), neg(repair_started)),
    reactive('accepted', 'braced_ready', split, seam),
    transition('remade_ready', 'remade', 'ow_paper_deliver', has('ow_new_servant')),
    transition('braced_ready', 'braced', 'ow_paper_deliver', has('ow_braced_servant')),
])
elements = []
for gid, sig, item, label in [(B, 'ow_paper_splint', 'ow_bamboo', '左踝衬篾'), (P, 'ow_paper_seam', 'ow_paste', '右脚糊缝')]:
    elements.append(wrapper(graph(gid, label, {'initial': '尚未用料', 'done': (label + '已妥', [take(item),
        notice(sig + '_notice', label + '已做妥，材料用去一份。重复放料不会再扣。')])},
        [transition('initial', 'done', sig, has(item), not_prepared)]), len(elements) * 300, 450))
upsert(ng['compositions'], composition(main, 'C05：真实装配重做，或检视持物修旧。第一次补料锁定修旧；失败试摆保留材料。交付改变罗伯晚班。', elements))
recipe = graph(R, '浆炉熬料', {'initial': '还没熬过',
    'mixed': ('熬成一碗', [take('nuomi'), give('ow_paste'), time(15), notice('paste_ready_notice', '糯米用去一份，木桶留着。搅煮十五分钟，收好一碗糨糊。')]),
    'empty': '上一碗已用完，可再熬'},
    [transition(s, 'mixed', 'ow_paste_cook', has('nuomi'), has('ow_bucket'), neg(has('ow_paste'))) for s in ['initial', 'empty']] +
    [reactive('mixed', 'empty', neg(has('ow_paste')))])
upsert(ng['compositions'], composition(graph(S, '熬一碗糨糊', {'initial': '未认出浆炉', 'accepted': '备米与桶，到浆炉熬料',
    'done': '亲手熬过一碗，手艺可以再用'}, [transition('initial', 'accepted', 'ow_paste_accept'),
        *[reactive(s, 'done', state(R, 'mixed', True)) for s in ['initial', 'accepted']]]),
    'S11：糯米经浆炉转成可用糨糊；重复制作不冒充新支线或重复领奖。', [wrapper(recipe, 0, 400)]))
upsert(ng['compositions'], composition(graph(D, '晒错地方的纸', {
    'initial': '墙脚一叠潮纸', 'accepted': '离开潮墙，搬到晾板',
    'carrying': ('抱起受潮的纸', [give('ow_damp_paper')]),
    'done': ('守着翻到干，收好工钱', [take('ow_damp_paper'), time(30), give('ow_dry_paper'), act('giveCurrency', amount=3)]),
}, [transition('initial', 'accepted', 'ow_dry_accept'),
    *[transition(s, 'carrying', 'ow_dry_take') for s in ['initial', 'accepted']],
    transition('carrying', 'done', 'ow_dry_spread', has('ow_damp_paper'), daylight)]),
    'S13：先取潮纸，再在通风晾板实际铺开。白天明确守候三十分钟，夜里不会凭空晒干。'))

run('focus', [emit('ow_paper_accept'), act('setFocusedQuest', id='ow_paper')], 'methods')
switch('bench', [(done, 'bench_done'), (ready, 'bench_ready')], 'bench_intro')
line('bench_intro', '铺前留着一具歪脚纸人，旁边压着罗伯的篾样。左踝的篾裂了，右脚纸缝也开了。重做得十六文；修稳旧作得八文。', 'focus')
choice('methods',
    option('new_method', '重做：干纸、糨糊各一份；四十五分钟', 'remake_check', neg(repair_started), '旧脚已经用了补料，这具继续修旧；不再拆开重做。'),
    option('old_method', '修旧：薄篾、糨糊各一份；十五分钟', 'repair_terms'),
    option('paper_supplies', '材料从哪点来？', 'supplies'),
    option('paper_leave', '先记住两种办法', 'end'))
line('supplies', '薄篾找罗伯；干纸可帮他晒一叠，糨糊可在铺前浆炉用糯米和木桶熬。罗伯也卖干纸、糨糊，材料不必全靠帮忙。')
switch('remake_check', [(all_of(has('ow_dry_paper'), has('ow_paste')), 'remake_terms')], 'remake_short')
line('remake_short', '重做需要一叠干纸和一碗糨糊。先备齐，再到这张工台；材料只有做合格才扣。', 'supplies')
line('remake_terms', '先试摆，再收口。站直、脚落地，手别朝人张开；用白纸，脸留空，糨糊收边。试坏不扣料，合格才花四十五分钟糊成。', 'remake_choice')
choice('remake_choice', option('remake_start', '上工台，亲手装配', 'remake_start'), option('remake_wait', '稍后再做', 'end'))
run('remake_start', [act('setFocusedQuest', id='ow_paper', objectiveId='paper_new_obj'), act('startPaperCraftMinigame', id='ow_paper_remake')], 'paper_after')
line('repair_terms', '左踝要薄篾，右脚翘缝要糨糊。摸囊拿材料，分别点到坏处；第一份补料用下去，就继续修旧。两处齐了才花十五分钟收稳。', 'repair_choice')
choice('repair_choice', option('repair_start', '拿近检视，按坏处用料', 'repair_open'), option('repair_wait', '先备料', 'end'))
run('repair_open', [act('setFocusedQuest', id='ow_paper', objectiveId='paper_old_obj'), act('startObjectExamine', id='ow_paper_frame')], 'paper_after')
switch('paper_after', [(ready, 'bench_ready')], 'paper_unfinished')
line('paper_unfinished', '工台还留着。没合格的试摆可重试；旧脚已补的地方保留，余下材料找罗伯。')
line('bench_ready', '纸人已收好。找罗伯当面验收，任务记号跟着他的班次走；二十点后可先在后巷歇脚等开工。', 'return_focus')
run('return_focus', [act('setFocusedQuest', id='ow_paper', objectiveId='paper_return_obj')])
line('bench_done', '这具已经交清，工台上的篾样收了起来。罗伯的工钱只结一回。')
switch('luo', [(remade, 'luo_new_done'), (braced, 'luo_old_done'), (ready, 'luo_check')], 'luo_request')
line('luo_request', '勒具纸人站不起，是我赶工把脚篾削薄了。莫急着说它要走。你重做一具，我给十六文；衬稳旧脚给八文，两样活路你挑。', 'luo_focus', '罗伯')
run('luo_focus', [emit('ow_paper_accept'), act('setFocusedQuest', id='ow_paper')], 'luo_where')
line('luo_where', '活放在后巷纸扎工台。新的费四十五分钟，旧的十五分钟；干纸、薄篾、糨糊都可买，也有零活能换。到工台再挑做法。', 'end', '罗伯')
line('luo_check', '提起来给我看哈。新的要齐整，旧的要两脚牢；没做完的我不充好货收。', 'deliver_choice', '罗伯')
choice('deliver_choice', option('deliver', '交付纸人，按做法结工钱', 'deliver'), option('deliver_later', '我等一哈再交', 'end'))
run('deliver', [emit('ow_paper_deliver')], 'luo')
line('luo_new_done', '做得齐整，十六文拿起。我多出些整料，今天十八到二十点就留巷子理料，你还缺篾或糨糊，来工位找。', 'end', '罗伯')
line('luo_old_done', '旧脚衬牢了，八文拿起。我按原来的班收工，十八到二十点在茶馆喝茶。莫拿补过的当全新价卖，勒个账要讲清楚。', 'end', '罗伯')

switch('damp', [(dry_done, 'dry_done'), (state(D, 'carrying'), 'damp_carried')], 'damp_intro')
line('damp_intro', '纸叠贴着潮墙，底下发软，墨记倒没糊。罗伯留话请人搬到通风晾板，白天守着翻半个钟头，板下压了三文工钱。', 'dry_focus')
run('dry_focus', [emit('ow_dry_accept'), act('setFocusedQuest', id='ow_dry_paper')], 'damp_choice')
choice('damp_choice', option('damp_take', '抱起整叠潮纸', 'damp_take'), option('damp_later', '暂时不搬', 'end'))
run('damp_take', [emit('ow_dry_take')], 'damp_carried')
line('damp_carried', '纸抱起来了。送到巷中通风晾板；七至十七点有日光，守着翻三十分钟才收。', 'dry_track')
run('dry_track', [act('setFocusedQuest', id='ow_dry_paper')])
switch('rack', [(dry_done, 'dry_done'), (state(D, 'carrying'), 'rack_time')], 'rack_empty')
line('rack_empty', '通风晾板离墙有一段空隙。墙脚还有叠潮纸，先整叠抱过来，别一张一张来回跑。', 'dry_request_focus')
line('dry_request', '纸放潮墙脚了，你去整叠搬起，送到巷中晾板。白天守着翻半个钟头，干纸归你，板下另压了三文钱。', 'dry_request_focus', '罗伯')
run('dry_request_focus', [emit('ow_dry_accept'), act('setFocusedQuest', id='ow_dry_paper')])
switch('rack_time', [(daylight, 'rack_choice')], 'rack_dark')
choice('rack_choice', option('rack_spread', '铺开潮纸，守着翻三十分钟', 'rack_spread'), option('rack_wait', '等一哈再铺', 'end'))
run('rack_spread', [emit('ow_dry_spread')], 'dry_done')
line('rack_dark', '这时段晾不干。纸先留在身上，歇脚等开工再来；罗伯也有现成干纸卖。')
line('dry_done', '纸已翻干，干纸和三文工钱都收好了。干纸可拿上工台重做纸人；这叠不能再领一次。')

switch('stove', [(has('ow_paste'), 'paste_have')], 'stove_intro')
line('stove_intro', '小炭炉上架着浆锅，旁边是取水缸。糯米磨开，拿木桶舀水，边搅边熬一刻钟，能成一碗糨糊。', 'stove_focus')
run('stove_focus', [emit('ow_paste_accept'), act('setFocusedQuest', id='ow_paste')], 'stove_choice')
choice('stove_choice', option('stove_cook', '用一份糯米和木桶，搅煮十五分钟', 'stove_cook', all_of(has('nuomi'), has('ow_bucket')), '要一份糯米和木桶。米罗伯有卖；河边可捞木桶。只要成品也可直接买糨糊。'),
    option('stove_buy', '记住：成品可找罗伯买', 'paste_buy'), option('stove_leave', '暂时不熬', 'end'))
run('stove_cook', [emit('ow_paste_cook')], 'paste_have')
line('paste_have', '摸囊已有一碗糨糊。先用掉再熬，免得放坏；能糊纸人的翘缝，也能拿上工台收边。木桶仍可用。')
line('paste_buy', '罗伯在后巷做活，傍晚去处看他的收工安排。干纸、糨糊、糯米都有现货。')

image = '/resources/runtime/images/examine/ow_paper_frame.png'
examine = {'id': 'ow_paper_frame', 'label': a.text('frame_label', '检视：歪脚纸人'), 'title': a.text('frame_title', '修稳两只纸脚'),
    'allFoundHint': a.text('frame_hint', '摸囊拿薄篾衬左踝，再拿糨糊粘右脚翘缝；两处可换序。'),
    'presentation': {'kind': 'still', 'image': image, 'physicalWidthCm': 48, 'backgroundPreset': 'wood', 'contactAoIntensity': 0.4, 'contactAoRadiusCm': 0.5},
    'ambience': {'headSway': {'amplitude': 0.12}, 'breathing': False, 'dust': False},
    'hotspots': [
        {'id': 'left_ankle', 'label': a.text('left_label', '左踝裂篾'), 'x': 290, 'y': 1180, 'width': 150, 'height': 220,
         'narration': a.text('left_look', '竹篾向外劈开，力落不到脚底。薄篾顺原架衬入；补料不是塞在纸面上。'),
         'itemUses': [{'itemId': 'ow_bamboo', 'label': a.text('left_use', '衬进裂踝'), 'narration': a.text('left_work', '薄篾对准裂处试位。补过的地方不再叠料；用成会扣一片。'), 'actions': [emit('ow_paper_splint')]}]},
        {'id': 'right_foot', 'label': a.text('right_label', '右脚翘纸缝'), 'x': 610, 'y': 1180, 'width': 145, 'height': 220,
         'narration': a.text('right_look', '篾没有断，是纸边翘开，脚一落地便滑。糨糊抹在翘缝内，不能拿清灯油来粘。'),
         'itemUses': [{'itemId': 'ow_paste', 'label': a.text('right_use', '糊牢翘缝'), 'narration': a.text('right_work', '把纸边压回原缝。粘过的地方不再糊一遍；用成会扣一碗糨糊。'), 'actions': [emit('ow_paper_seam')]}]},
        {'id': 'face', 'label': a.text('face_label', '留空的纸脸'), 'x': 410, 'y': 40, 'width': 200, 'height': 230, 'decoy': True,
         'narration': a.text('face_look', '脸上本来就不点眼。站不稳的问题在脚，别往脸上添东西。')},
    ]}
paper = deepcopy(read('data/paper_craft/wujin_paper_servant_daywork.json'))
paper.update(id='ow_paper_remake', label=a.text('paper_label', '罗伯工台：重做纸人'))
order = paper['orders'][0]
order.update(id='paper_standing', title=a.text('order_title', '重做一具站稳的纸人'),
    description=a.text('order_desc', '试摆不扣料；合格后用干纸、糨糊各一份，耗时四十五分钟。'),
    targetHint=a.text('order_hint', '直身、脚落地，手不招人；白纸、空脸，糨糊收边。'),
    finishQuestion=a.text('finish_question', '怎样收边？'), successScore=99, warnScore=55)
order['slots'] = [s for s in order['slots'] if s['id'] != 'charm']
allowed = {p for s in order['slots'] for p in s['accepts']}
good_parts = {'head_plain', 'body_straight', 'arms_down', 'legs_plain'}
order['parts'] = [p for p in order['parts'] if p['id'] in allowed]
for p in order['parts']:
    p['image'] = '/resources/runtime/images/minigames/paper_craft/parts/' + p['id'] + '.png'
    p['score'] = 20 if p['id'] in good_parts else 0
for p in order['paperOptions']: p['score'] = 4 if p['id'] == 'white' else -6
for p in order['finishOptions']: p['score'] = 4 if p['id'] == 'paste_plain' else 0
for field in ['parts', 'slots', 'paperOptions', 'finishOptions']:
    for row in order[field]:
        row['label'] = a.text(field + '_' + row['id'], row['label'])
        if 'tags' in row: row['tags'] = [a.text('tag_' + row['id'] + '_' + str(i), t) for i, t in enumerate(row['tags'])]
order['onSuccessActions'] = [emit('ow_paper_success')]
order['onWarnActions'] = [notice('paper_warn', '这副还不稳。检查身架、脚和手，再核对白纸与糨糊收边。未扣材料，可回工台重试。')]
order['onBadActions'] = [notice('paper_bad', '这副不能交。先按工台提示重新试摆；未扣材料，可重试。')]

schedules_data = read('data/npc_schedules.json')
schedules = schedules_data['schedules']
luo = next(s for s in schedules if s['characterId'] == 'ow_luo')
luo['entries'] = [{'from': '07:00', 'to': '18:00', 'scene': 'test_room_b'},
    {'from': '18:00', 'to': '20:00', 'scene': 'test_room_b', 'conditions': [remade]},
    {'from': '18:00', 'to': '20:00', 'scene': 'teahouse', 'conditions': [neg(remade)]},
    {'from': '20:00', 'to': '07:00', 'scene': None}]
npc_guide = a.npc_guidance('ow_luo', schedules)
quests = read('data/quests.json')
obj = a.objective
bench_marker = marker('test_room_b', 'hotspot', 'hs_纸扎日工')
upsert(quests, a.quest('ow_paper', '纸人不肯站', '罗伯赶坏了一具纸人。重做与修旧任选，工钱、耗时和他的晚班不同。第一次补料后继续修旧。', neg(state(G, 'initial')), done, [
    obj('paper_choose_obj', '到后巷纸扎工台，重做或修旧任选', any_of(ready, done), bench_marker, not_prepared),
    obj('paper_new_obj', '工台亲手装配：干纸、糨糊各一份；合格才扣', any_of(new_ready, done), bench_marker, all_of(not_prepared, neg(repair_started)), True),
    obj('paper_old_obj', '检视旧纸人：薄篾衬左踝，糨糊粘右脚', any_of(old_ready, done), bench_marker, not_prepared, True),
    obj('paper_return_obj', '把做好的纸人交给罗伯，结工钱', done, npc_guide, ready),
]))
upsert(quests, a.quest('ow_paste', '熬一碗糨糊', '浆炉把糯米熬成可用糨糊。带一份糯米与可重复使用的木桶，搅煮十五分钟；成品也可向罗伯买。', neg(state(S, 'initial')), paste_done, [
    obj('paste_cook_obj', '在后巷浆炉，用糯米与木桶熬一碗', paste_done, marker('test_room_b', 'hotspot', 'ow_paste_stove')),
]))
upsert(quests, a.quest('ow_dry_paper', '晒错地方的纸', '把潮纸从墙脚搬到通风晾板。七至十七点可翻晒三十分钟，取得干纸与三文工钱。', neg(state(D, 'initial')), dry_done, [
    obj('dry_take_obj', '整叠抱起墙脚潮纸', state(D, 'carrying', True), marker('test_room_b', 'hotspot', 'ow_damp_paper')),
    obj('dry_spread_obj', '七至十七点在晾板铺纸，翻晒三十分钟', dry_done, marker('test_room_b', 'hotspot', 'ow_paper_rack'), state(D, 'carrying')),
]))
for q in quests:
    for o in q.get('objectives', []):
        if any(g.get('entityId') == 'ow_luo' for g in o.get('guidance', [])): o['guidance'] = npc_guide

items = read('data/items.json')
for iid, label, desc, kind, icon in [
    ('ow_dry_paper', '干净白纸', '通风晾干的一叠白纸，或罗伯的现货。纸扎工台重做一具用一叠。', 'consumable', None),
    ('ow_damp_paper', '墙脚的潮纸', '整叠抱起的潮纸。七至十七点送到后巷晾板，守着翻三十分钟。', 'key', None),
    ('ow_paste', '一碗糨糊', '糯米熬的粘料。可糊纸人的翘缝，或在工台收边；一处用一碗。', 'consumable', None),
    ('ow_new_servant', '重做的纸人', '在工台亲手装配的合格纸人。交给罗伯领十六文，他晚些留后巷理料。', 'key', '/resources/runtime/images/icons/ow_paper_finished.png'),
    ('ow_braced_servant', '修稳的旧纸人', '左踝衬了薄篾，右脚糊牢纸缝。交给罗伯领八文，他照原作息收工。', 'key', '/resources/runtime/images/icons/ow_paper_finished.png'),
]:
    row = {'id': iid, 'name': a.text(iid + '_name', label), 'description': a.text(iid + '_desc', desc), 'type': kind, 'maxStack': 10 if kind == 'consumable' else 1}
    if icon: row['icon'] = icon
    upsert(items, row)
shops = read('data/shops.json')
shop = next(s for s in shops if s['id'] == 'ow_luo_supplies')
for iid, price in [('ow_dry_paper', 4), ('ow_paste', 3), ('nuomi', 2)]:
    shop['items'] = [i for i in shop['items'] if i['itemId'] != iid] + [{'itemId': iid, 'price': price}]
alley = read('scenes/test_room_b.json')
bench = next(h for h in alley['hotspots'] if h['id'] == 'hs_纸扎日工')
bench.update(label=a.text('bench_spot', '纸扎工台 · 歪脚纸人'), x=1000, y=565, interactionRange=45,
    data={'graphId': a.dg['id'], 'entry': 'bench'})
upsert(alley['hotspots'], a.hotspot('ow_damp_paper', '墙脚潮纸', 1160, 555, 'damp', size=35))
upsert(alley['hotspots'], a.hotspot('ow_paper_rack', '通风晾板', 885, 546, 'rack', size=35))
stove = a.hotspot('ow_paste_stove', '铺前浆炉', 950, 630, 'stove', size=35)
stove['displayImage'] = {'image': '/resources/runtime/images/examine/ow_paste_stove.png', 'worldWidth': 34, 'worldHeight': 44}
upsert(alley['hotspots'], stove)
folk = read('dialogues/graphs/开放世界_街坊.json')
for key, prose, entry in [('paper', '纸人站不起，要我搭把手？', 'luo'), ('dry_paper', '有纸需要晾干？', 'dry_request')]:
    handoff = 'ow_' + key + '_handoff'
    folk['nodes'][handoff] = {'type': 'runActions', 'actions': [act('startDialogueGraph', graphId=a.dg['id'], entry=entry)], 'next': 'end'}
    opts = folk['nodes']['luo_menu']['options']
    opts[:] = [o for o in opts if o['id'] != 'ow_' + key + '_topic']
    opts.insert(0, {'id': 'ow_' + key + '_topic', 'text': a.text(key + '_topic', prose), 'next': handoff})
folk['nodes']['luo_day'] = {'type': 'switch', 'cases': [{'condition': remade, 'next': 'ow_paper_day_changed'}], 'defaultNext': 'ow_paper_day_normal'}
for nid, text in [('ow_paper_day_changed', '纸人重做齐整，我多出些料要理。七点到二十点都在后巷，过了就歇；要买材料趁我还没收。'),
                  ('ow_paper_day_normal', '七点开工，十八点收活去茶馆坐两个钟头，二十点就歇。别黑灯瞎火蹲在工位空等我。')]:
    folk['nodes'][nid] = {'type': 'line', 'speaker': {'kind': 'literal', 'name': '罗伯'}, 'text': a.text(nid, text), 'next': 'luo_menu'}
index = read('data/object_examine/index.json')
upsert(index, {'id': examine['id'], 'label': '检视：歪脚纸人', 'file': examine['id'] + '.json'})
pindex = read('data/paper_craft/index.json')
upsert(pindex, {'id': paper['id'], 'label': '罗伯工台：重做纸人', 'file': paper['id'] + '.json'})
signals = set()
def collect(v):
    if isinstance(v, dict):
        if v.get('type') == 'emitNarrativeSignal': signals.add(v['params']['signal'])
        for child in v.values(): collect(child)
    elif isinstance(v, list):
        for child in v: collect(child)
for source in [a.dg, examine, paper]: collect(source)
for sig in sorted(signals):
    if not any(s['id'] == sig for s in ng['signals']): ng['signals'].append({'id': sig, 'label': sig})
for path, data in [
    ('data/narrative_graphs.json', ng), ('data/quests.json', quests), ('data/strings.json', a.strings),
    ('data/items.json', items), ('data/shops.json', shops), ('data/npc_schedules.json', schedules_data),
    ('data/object_examine/index.json', index), ('data/object_examine/ow_paper_frame.json', examine),
    ('data/paper_craft/index.json', pindex), ('data/paper_craft/ow_paper_remake.json', paper),
    ('scenes/test_room_b.json', alley), ('dialogues/graphs/开放世界_街坊.json', folk),
    ('dialogues/graphs/开放世界_纸扎.json', a.dg),
]: write(path, data)
print('C05 + S11/S13 authored; native, causal and physical acceptance pending.')
