"""Offline native authoring for C06, S09, S17. Not a runtime content format.

Do not rerun after later batches modify the same NPC topics or schedules.
"""
from native_authoring import *

a = Author('owTemple', '开放世界_庙火', '风口、灰盘与一本借物账', 'pan')
line, run, switch, choice, option = a.line, a.run, a.switch, a.choice, a.option
G, W, B, D = 'flow_ow_incense', 'flow_ow_incense_wind', 'flow_ow_bolt', 'flow_ow_ledger'
fixed, moved = state(G, 'sheltered', True), state(G, 'moved', True)
done = any_of(fixed, moved)
diagnosed = state(W, 'seen', True)
sealed, carrying = state(G, 'sealed'), state(G, 'carrying')
uncommitted = all_of(neg(done), neg(sealed), neg(carrying))
bolt_done, ledger_done = state(B, 'done', True), state(D, 'done', True)
clapper = any_of(has('ow_old_clapper'), has('ow_patched_clapper'))
time = lambda n: act('advanceTime', minutes=n, transition='timelapse')
notice = lambda key, text: act('showNotification', text=a.text(key, text), type='info')
ng = read('data/narrative_graphs.json')

main = graph(G, '香灰落在门外', {
    'initial': '灰盘放在穿堂风里', 'accepted': '查风口，或腾出侧门搬盘',
    'sealed': ('纸浆挡缝，等待现场复查', [take('ow_dry_paper'), take('ow_paste'), time(20),
        notice('seal_notice', '干纸、糨糊各用一份，挡缝二十分钟。回院中小灰盘旁，驻足看灰向再验收。')]),
    'carrying': ('余烬已熄，抱起小灰盘', [give('ow_ash_pan'), time(5),
        notice('carry_notice', '桶取水熄净余烬，木桶留着。抱小灰盘进正殿，安放到殿边平石；这时不再改做纸浆挡缝。')]),
    'sheltered': ('灰不再外扬，扫院僧晚间留院', [act('giveCurrency', amount=6),
        notice('sheltered_notice', '灰向复查通过，收六文。扫院僧二十至二十二点留院，夜里读账也能找到他。')]),
    'moved': ('灰盘安在殿边，扫院僧晚间留殿', [take('ow_ash_pan'), time(10),
        notice('moved_notice', '小盘安稳，殿门正路留通。没有工钱，也没用纸浆；扫院僧二十至二十二点留在殿内照看。')]),
}, [transition('initial', 'accepted', s) for s in ['ow_incense_accept', 'ow_incense_wind']] + [
    transition('accepted', 'sealed', 'ow_incense_seal', diagnosed, has('ow_dry_paper'), has('ow_paste')),
    transition('sealed', 'sheltered', 'ow_incense_verify'),
    *[transition(s, 'carrying', 'ow_incense_lift', bolt_done, has('ow_bucket')) for s in ['initial', 'accepted']],
    transition('carrying', 'moved', 'ow_incense_place', has('ow_ash_pan')),
])
wind = graph(W, '门缝的风向', {'initial': '还没有看清挂丝', 'seen': '破缝挂丝向外，灰向有了依据'},
    [transition('initial', 'seen', 'ow_incense_wind')])
upsert(ng['compositions'], composition(main, 'C06：驻足辨风→纸浆挡缝→回灰盘复查；或先解侧门落闩→熄烬抱盘→进殿安置。方法互斥，夜间人物位置和读账机会不同。', [wrapper(wind, 0, 440)]))
upsert(ng['compositions'], composition(graph(B, '侧门的落闩', {
    'initial': '侧门只开半扇', 'accepted': '蹲下查看卡闩', 'seen': '碎木卡在闩底',
    'done': ('木闩松脱，侧门取水路通', [give('ow_wood_wedge'), time(5),
        notice('bolt_notice', '卡闩已松，收好一块楔木。侧门能开全，搬灰盘时可从这里取水；楔木还能垫灶架。')]),
}, [transition('initial', 'accepted', 'ow_bolt_accept'),
    *[transition(s, 'seen', 'ow_bolt_look') for s in ['initial', 'accepted']],
    transition('seen', 'done', 'ow_bolt_tap', clapper),
    transition('seen', 'done', 'ow_bolt_pry', has('ow_bamboo'))]),
    'S09：蹲看实际卡点，木梆轻震或耗篾挑木。木梆不消耗，可继续交付 C04；得到楔木供灶架。'))
# Only the bamboo method consumes bamboo. The method-specific signal is handled
# in its own one-shot wrapper, so the shared terminal cannot charge the other method.
bolt_comp = next(c for c in ng['compositions'] if c['mainGraph']['id'] == B)
bolt_comp['elements'] = [wrapper(graph('flow_ow_bolt_material', '挑闩耗篾', {
    'initial': '未用薄篾', 'used': ('挑出碎木用去一片', [take('ow_bamboo')])},
    [transition('initial', 'used', 'ow_bolt_pry', state(B, 'seen'), has('ow_bamboo'))]), 0, 440)]
# Remove the cross-graph signal ordering dependency: charge first in a material
# state, then let the main graph react to the actual successful tool use.
bolt_comp['mainGraph']['transitions'] = [t for t in bolt_comp['mainGraph']['transitions'] if t.get('signal') != 'ow_bolt_pry']
bolt_comp['mainGraph']['transitions'].append({'id': 'seen_done_bamboo', 'from': 'seen', 'to': 'done',
    'trigger': 'reactive', 'signal': '__draft__', 'conditions': [state('flow_ow_bolt_material', 'used', True)]})
upsert(ng['compositions'], composition(graph(D, '香案上的旧账', {
    'initial': '还没留意借物账', 'accepted': '到殿边取账页',
    'carrying': ('捧起借物账页', [give('ow_temple_ledger')]),
    'done': ('请扫院僧念明，借物有据', [take('ow_temple_ledger'), give('ow_lamp_oil'),
        act('addArchiveEntry', bookType='document', entryId='doc_ow_temple_accounts'),
        notice('ledger_notice', '旧账收进文献册，账页交回；借得一份清灯油，可添巡更灯或留作夜路准备。')]),
}, [transition('initial', 'accepted', 'ow_ledger_accept'),
    *[transition(s, 'carrying', 'ow_ledger_take') for s in ['initial', 'accepted']],
    transition('carrying', 'done', 'ow_ledger_read', has('ow_temple_ledger'))]),
    'S17：取实物账页，按真实日程找识字的扫院僧，文献留有出处；纸张回收、灯油只借一次。'))

switch('pan', [(fixed, 'pan_fixed'), (moved, 'pan_moved'), (carrying, 'pan_carried'), (sealed, 'verify_pose')], 'pan_intro')
line('pan_intro', '大铜炉前另放着一只小灰盘，扫起的灰又吹到下阶。侧门破缝正对着盘；先看风口能修，或把小盘熄净搬到殿内。', 'pan_focus')
run('pan_focus', [emit('ow_incense_accept'), act('setFocusedQuest', id='ow_incense')], 'pan_methods')
choice('pan_methods',
    option('go_wind', '查侧门风缝：用纸浆挡风可得六文', 'wind_where'),
    option('lift_pan', '木桶取水熄烬，抱盘进殿；不花纸浆', 'lift_check'),
    option('pan_later', '先看看周围', 'end'))
line('wind_where', '到侧门破缝前按住 X 驻足看挂丝。看明原因，再用干纸、糨糊各一份挡缝；做完回来查灰向。', 'wind_focus')
run('wind_focus', [act('setFocusedQuest', id='ow_incense', objectiveId='incense_wind_obj')])
switch('lift_check', [(neg(bolt_done), 'lift_bolt'), (neg(has('ow_bucket')), 'lift_bucket')], 'lift_confirm')
line('lift_bolt', '侧门卡住，桶过不去取水。先到侧门蹲看落闩，用薄篾挑碎木或木梆轻震。正殿入口仍可通行。', 'bolt_focus')
line('lift_bucket', '要用木桶取水熄净余烬，才敢抱盘。河边能捞何婆婆的桶；木桶会留下，不是一次性材料。')
choice('lift_confirm', option('lift_now', '熄净余烬，抱起小灰盘', 'lift'), option('lift_cancel', '暂时不搬', 'end'))
run('lift', [emit('ow_incense_lift'), act('setFocusedQuest', id='ow_incense')], 'pan_carried')
line('pan_carried', '小盘里的余烬已熄净。进正殿，放在殿边平石上，留出门口供人通行。')
switch('verify_pose', [({'posture': 'gaze'}, 'verify')], 'verify_hint')
line('verify_hint', '挡缝还得复查。在小灰盘旁按住 X 驻足看灰向，再按 E；不能凭刚糊上的纸就算完工。', 'verify_focus')
run('verify_focus', [act('setFocusedQuest', id='ow_incense', objectiveId='incense_verify_obj')])
line('verify', '你盯着盘边。浮灰落回盘内，阶沿不再添新灰，侧门挂丝也贴下来了。', 'verify_commit')
run('verify_commit', [emit('ow_incense_verify')], 'pan_fixed')
line('pan_fixed', '小盘仍在院中，灰留在盘内。扫院僧二十至二十二点会留院照看，可找他念借物账。')
line('pan_moved', '小灰盘已安在殿边，院中大铜炉保持原位。夜里找扫院僧到殿内，二十二点后歇脚等开工。')

switch('wind', [(done, 'wind_done'), (carrying, 'pan_carried'), (sealed, 'verify_hint'), (diagnosed, 'seal_choice'), ({'posture': 'gaze'}, 'wind_seen')], 'wind_hint')
line('wind_hint', '侧门上方纸缝破了一线，挂丝一直偏着。按住 X 抬头驻足再看；只盯地上灰，看不出风从哪点来。', 'wind_start')
run('wind_start', [emit('ow_incense_accept'), act('setFocusedQuest', id='ow_incense', objectiveId='incense_wind_obj')])
line('wind_seen', '挂丝从门缝向院内斜伸，正冲着小灰盘。是穿堂风把灰带过阶沿；封住破缝，盘子便可留在外头。', 'wind_record')
run('wind_record', [emit('ow_incense_wind'), act('setFocusedQuest', id='ow_incense', objectiveId='incense_seal_obj')], 'seal_choice')
choice('seal_choice', option('seal', '干纸、糨糊各一份，挡缝二十分钟', 'seal_commit', all_of(has('ow_dry_paper'), has('ow_paste')), '缺干纸或糨糊。后巷可晒纸、熬浆，罗伯也卖现货；不想花纸浆可修落闩后搬灰盘。'), option('seal_later', '先备材料，或去灰盘改走搬移', 'end'))
run('seal_commit', [emit('ow_incense_seal'), act('setFocusedQuest', id='ow_incense', objectiveId='incense_verify_obj')], 'verify_hint')
line('wind_done', '小灰盘的去处已经安排妥当。要问借物或夜里落脚，按扫院僧的班次去找。')
switch('stand', [(moved, 'pan_moved'), (carrying, 'stand_choice')], 'stand_empty')
line('stand_empty', '殿边平石离木柱有一段空隙，可以安放熄净的小灰盘。盘子还在院里，木桶取水前先解开侧门落闩。', 'pan_focus')
choice('stand_choice', option('stand_place', '把小灰盘稳放石台，留开通路', 'stand_place'), option('stand_later', '等一哈再放', 'end'))
run('stand_place', [emit('ow_incense_place'), act('setFocusedQuest', id='ow_incense')], 'pan_moved')

switch('bolt', [(bolt_done, 'bolt_done'), (state(B, 'seen'), 'bolt_choice'), ({'posture': 'crouch'}, 'bolt_look')], 'bolt_hint')
line('bolt_hint', '侧门木闩落到一半卡住，门外就是水缸。按住 C 蹲下看闩底；硬推门扇只会卡得更紧。', 'bolt_focus')
run('bolt_focus', [emit('ow_bolt_accept'), act('setFocusedQuest', id='ow_bolt')])
line('bolt_look', '一片碎木斜塞在闩槽底。薄篾能挑出；木梆在槽边轻震也能松开，莫朝门板砸。', 'bolt_seen')
run('bolt_seen', [emit('ow_bolt_look'), act('setFocusedQuest', id='ow_bolt')], 'bolt_choice')
choice('bolt_choice', option('bolt_pry', '用一片薄篾挑出碎木', 'bolt_pry', has('ow_bamboo'), '罗伯可卖薄篾，也能寻回篾刀换两片。'), option('bolt_tap', '用木梆轻震闩槽，梆子留下', 'bolt_tap', clapper, '要有已捞出的原梆或修好的备用梆。没有梆子可改用薄篾。'), option('bolt_leave', '先去备工具', 'end'))
run('bolt_pry', [emit('ow_bolt_pry')], 'bolt_done')
run('bolt_tap', [emit('ow_bolt_tap')], 'bolt_done')
line('bolt_done', '闩槽已清，侧门能开全。收好的楔木留着垫灶架；搬小灰盘时木桶能从这里取水。')

switch('ledger', [(ledger_done, 'ledger_done'), (state(D, 'carrying'), 'ledger_carry')], 'ledger_intro')
line('ledger_intro', '借物账夹在殿边，纸角压着颗石子。你认不全字，倒看得出油壶和木桶的小画；可把这一页拿去请扫院僧念清，再还回。', 'ledger_choice')
choice('ledger_choice', option('ledger_take', '拿起这页账，找扫院僧念', 'ledger_take'), option('ledger_leave', '先记住位置', 'ledger_focus'))
run('ledger_take', [emit('ow_ledger_take'), act('setFocusedQuest', id='ow_ledger')], 'ledger_carry')
run('ledger_focus', [emit('ow_ledger_accept'), act('setFocusedQuest', id='ow_ledger')])
line('ledger_carry', '账页在摸囊里，找扫院僧念清。七至十一点扫院，十一至二十点在殿里；灰盘处置后他才留到二十二点，去处随做法变。')
switch('monk_ledger', [(ledger_done, 'ledger_done'), (has('ow_temple_ledger'), 'ledger_read')], 'ledger_where')
line('ledger_where', '借物账在殿边。你拿来，我照到念，别把画了油壶的那行当别人欠你的钱。', 'ledger_focus', '扫院僧')
line('ledger_read', '勒页写的是公用灯油和水桶。借东西有出处，捡到衣裳只认得衣裳，莫替死人子认名。灯油借你一份，去添该添的灯；账纸留下，我还要记。', 'ledger_read_commit', '扫院僧')
run('ledger_read_commit', [emit('ow_ledger_read')], 'ledger_done')
line('ledger_done', '账页已交还，文献册记了出处。清灯油只借一份；可添街口巡更灯，也可留着备夜路。')
switch('monk', [(fixed, 'monk_fixed'), (moved, 'monk_moved')], 'monk_request')
line('monk_request', '小灰盘昨哈摆在风口，扫了又散。我守着正殿，你看门缝能不能挡；不想费纸浆，把小盘熄净搬进来也要得。大铜炉莫动。', 'monk_accept', '扫院僧')
run('monk_accept', [emit('ow_incense_accept'), act('setFocusedQuest', id='ow_incense')])
line('monk_fixed', '风挡稳了，我今天黑了留院子，二十二点才歇。要念账、问借物，来灰盘旁找我。', 'end', '扫院僧')
line('monk_moved', '小盘搬妥了，我今天黑了守在殿里，二十二点才歇。院子风还在，别坐阶口守我。', 'end', '扫院僧')

exterior, interior = read('scenes/temple_exterior.json'), read('scenes/temple.json')
old_pan = next(h for h in exterior['hotspots'] if h['id'] == 'ow_incense')
old_pan.update(x=865, y=678, interactionRange=38, data={'graphId': a.dg['id'], 'entry': 'pan'}, label=a.text('pan_label', '院中小灰盘'))
# The movable small pan has a separate display entity; the work target remains
# discoverable after removal and reports its destination instead of disappearing.
pan_image = '/resources/runtime/images/examine/ow_incense_pan.png'
for scene, hid, x, y, cond in [(exterior, 'ow_incense_pan_outside', 865, 678, all_of(neg(carrying), neg(moved))),
                              (interior, 'ow_incense_pan_inside', 530, 380, moved)]:
    h = a.hotspot(hid, '小陶灰盘', x, y, 'pan' if scene is exterior else 'stand', [cond], size=25)
    h['displayImage'] = {'image': pan_image, 'worldWidth': 32, 'worldHeight': 20}
    upsert(scene['hotspots'], h)
upsert(exterior['hotspots'], a.hotspot('ow_temple_wind', '侧门破纸缝', 644, 484, 'wind', size=38))
upsert(exterior['hotspots'], a.hotspot('ow_temple_bolt', '侧门落闩', 605, 491, 'bolt', size=30))
upsert(interior['hotspots'], a.hotspot('ow_temple_stand', '殿边平石', 530, 380, 'stand', size=25))
upsert(interior['hotspots'], a.hotspot('ow_temple_ledger', '压在石下的借物账', 330, 380, 'ledger', size=25))
schedules_data = read('data/npc_schedules.json')
schedules = schedules_data['schedules']
monk = next(s for s in schedules if s['characterId'] == 'ow_monk')
monk['entries'] = [{'from': '07:00', 'to': '11:00', 'scene': 'temple_exterior'},
    {'from': '11:00', 'to': '20:00', 'scene': 'temple'},
    {'from': '20:00', 'to': '22:00', 'scene': 'temple_exterior', 'conditions': [fixed]},
    {'from': '20:00', 'to': '22:00', 'scene': 'temple', 'conditions': [moved]},
    {'from': '20:00', 'to': '22:00', 'scene': None, 'conditions': [neg(done)]},
    {'from': '22:00', 'to': '07:00', 'scene': None}]
guide = a.npc_guidance('ow_monk', schedules)
quests = read('data/quests.json')
obj = a.objective
outside = lambda h: marker('temple_exterior', 'hotspot', h)
inside = lambda h: marker('temple', 'hotspot', h)
upsert(quests, a.quest('ow_incense', '香灰落在门外', '可查风后挡缝复查，也可先解侧门闩、熄烬抱盘进殿。做法改变晚间落脚和扫院僧的去处。', neg(state(G, 'initial')), done, [
    obj('incense_choose_obj', '查风挡缝，或到灰盘熄烬搬移', any_of(sealed, carrying, done), outside('ow_incense'), uncommitted),
    obj('incense_wind_obj', '侧门按住 X 看挂丝，找出风向', diagnosed, outside('ow_temple_wind'), all_of(uncommitted, neg(diagnosed)), True),
    obj('incense_seal_obj', '侧门用干纸、糨糊各一份挡缝', any_of(sealed, done), outside('ow_temple_wind'), all_of(uncommitted, diagnosed), True),
    obj('incense_verify_obj', '回小灰盘旁，按住 X 看灰向并复查', done, outside('ow_incense'), sealed),
    obj('incense_place_obj', '抱小灰盘进正殿，放到殿边平石', done, inside('ow_temple_stand'), carrying),
]))
upsert(quests, a.quest('ow_bolt', '侧门的落闩', '蹲看闩底卡住的碎木，用薄篾挑或用木梆轻震。正殿入口不受影响；侧门开全后可提桶取水。', neg(state(B, 'initial')), bolt_done, [
    obj('bolt_look_obj', '侧门按住 C 蹲看闩底', state(B, 'seen', True), outside('ow_temple_bolt')),
    obj('bolt_tool_obj', '用薄篾挑碎木，或用木梆轻震', bolt_done, outside('ow_temple_bolt'), state(B, 'seen')),
]))
upsert(quests, a.quest('ow_ledger', '香案上的旧账', '取殿边账页，请扫院僧念明并归还，文献册留下来源。白日可找；夜里须先处理灰盘，他才留到二十二点。', neg(state(D, 'initial')), ledger_done, [
    obj('ledger_take_obj', '拿起殿边石下的借物账页', state(D, 'carrying', True), inside('ow_temple_ledger')),
    obj('ledger_read_obj', '请扫院僧念账，交回账页', ledger_done, guide, state(D, 'carrying')),
]))
for q in quests:
    for o in q.get('objectives', []):
        if any(g.get('entityId') == 'ow_monk' for g in o.get('guidance', [])): o['guidance'] = guide
items = read('data/items.json')
for iid, name, desc, icon in [
    ('ow_ash_pan', '熄净余烬的小灰盘', '用木桶取水熄净后抱起的小陶盘。送进正殿，稳放殿边平石；不是院中大铜炉。', pan_image),
    ('ow_wood_wedge', '一块硬楔木', '从侧门闩底收下的硬木，尺寸适合垫稳小灶架。留作修灶工具。', None),
    ('ow_temple_ledger', '庙里的借物账页', '纸上画着油壶和木桶。请扫院僧念明，再交回保管；不能自己凭图猜账。', None),
]:
    row = {'id': iid, 'name': a.text(iid + '_name', name), 'description': a.text(iid + '_desc', desc), 'type': 'key', 'maxStack': 1}
    if icon: row['icon'] = icon
    upsert(items, row)
docs = read('data/archive/documents.json')
upsert(docs, {'id': 'doc_ow_temple_accounts', 'name': a.text('doc_name', '旧庙借物账 · 扫院僧口述'),
    'content': a.text('doc_content', '油壶旁记的是公用灯油，不是赏钱；水桶记的是借出与归还。扫院僧说：取水先看门闩，挪火先灭余烬。夜路若要用油，先问清是不是供灯芯的清油。\n\n衣物、器具只能说明物的来处，不能替不认识的人定名。'),
    'annotation': a.text('doc_annotation', '关二狗不识全字。这页由扫院僧逐项念过，原账已经交回；记在册中的是他的口述。'),
    'discoverConditions': [ledger_done]})
folk = read('dialogues/graphs/开放世界_街坊.json')
for key, text, entry in [('incense', '灰扫了又出门，是哪点漏风？', 'monk'), ('ledger', '账上画的油壶，是啥子意思？', 'monk_ledger')]:
    nid = 'ow_' + key + '_handoff'
    folk['nodes'][nid] = {'type': 'runActions', 'actions': [act('startDialogueGraph', graphId=a.dg['id'], entry=entry)], 'next': 'end'}
    opts = folk['nodes']['monk_menu']['options']
    opts[:] = [o for o in opts if o['id'] != 'ow_' + key + '_topic']
    opts.insert(0, {'id': 'ow_' + key + '_topic', 'text': a.text(key + '_topic', text), 'next': nid})
folk['nodes']['monk_day'] = {'type': 'switch', 'cases': [{'condition': fixed, 'next': 'ow_monk_late_outside'}, {'condition': moved, 'next': 'ow_monk_late_inside'}], 'defaultNext': 'ow_monk_day_normal'}
for nid, text in [('ow_monk_late_outside', '七至十一点扫院，白天在殿里，二十点出来照看小灰盘，二十二点歇。'),
    ('ow_monk_late_inside', '七至十一点扫院，其余都在殿里。小盘搬进来了，我守到二十二点才歇。'),
    ('ow_monk_day_normal', '七至十一点扫院，十一点回殿里，二十点歇。灰盘还没处置，黑了我不留班。')]:
    folk['nodes'][nid] = {'type': 'line', 'speaker': {'kind': 'literal', 'name': '扫院僧'}, 'text': a.text(nid, text), 'next': 'monk_menu'}
a.strings['owFirst']['luo_shop_option'] = '买点修补材料。'
signals = set()
def collect(v):
    if isinstance(v, dict):
        if v.get('type') == 'emitNarrativeSignal': signals.add(v['params']['signal'])
        for child in v.values(): collect(child)
    elif isinstance(v, list):
        for child in v: collect(child)
collect(a.dg)
for sig in sorted(signals):
    if not any(s['id'] == sig for s in ng['signals']): ng['signals'].append({'id': sig, 'label': sig})
write_many([('data/narrative_graphs.json', ng), ('data/quests.json', quests), ('data/items.json', items),
    ('data/strings.json', a.strings), ('data/npc_schedules.json', schedules_data), ('data/archive/documents.json', docs),
    ('scenes/temple_exterior.json', exterior), ('scenes/temple.json', interior),
    ('dialogues/graphs/开放世界_街坊.json', folk), ('dialogues/graphs/开放世界_庙火.json', a.dg)])
print('C06 + S09/S17 authored. Causal, editor and native input acceptance pending.')
