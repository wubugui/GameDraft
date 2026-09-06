"""Offline native C08/S10 authoring. Do not rerun over later NPC/topic edits."""
from native_authoring import *

a = Author('owStove', '开放世界_灶火', '两家人的一炉火', 'stove')
line, run, switch, choice, option = a.line, a.run, a.switch, a.choice, a.option
G, A, W, M, PAY = 'flow_ow_stove', 'flow_ow_stove_ash', 'flow_ow_stove_foot', 'flow_ow_meal', 'flow_ow_meal_payment'
repaired, borrowed = state(G, 'repaired', True), state(G, 'borrowed', True)
done = any_of(repaired, borrowed)
cold, busy, hot = state(G, 'cold'), state(G, 'cooking'), state(G, 'hot')
choosing = any_of(state(G, 'initial'), state(G, 'accepted'))
ash, foot = state(A, 'done', True), state(W, 'done', True)
partial = any_of(ash, foot)
time = lambda n: act('advanceTime', minutes=n, transition='timelapse')
notice = lambda k, s: act('showNotification', text=a.text(k, s), type='info')
reactive = lambda f, t, *cs: {'id': f+'_'+t, 'from': f, 'to': t, 'trigger': 'reactive', 'signal': '__draft__', 'conditions': list(cs)}
clock = lambda start, end: all_of({'flag': 'minutes_of_day', 'op': '>=', 'value': start*60}, {'flag': 'minutes_of_day', 'op': '<', 'value': end*60})
selling = any_of(all_of(repaired, clock(7, 22)), all_of(neg(repaired), clock(7, 20)))
paid = any_of(state(PAY, 'cash', True), state(PAY, 'voucher', True))
ng = read('data/narrative_graphs.json')

main = graph(G, '一口冷灶两家饭', {
    'initial': '街摊灶脚崩了一角', 'accepted': '修稳街灶，或借后巷炉火',
    'cold': ('抱走带盖生米锅', [give('ow_cold_rice_pot'), notice('cold_notice', '饭锅抱走了，送到后巷浆炉借火。还没下锅可原路放回；暂不拆街灶。')]),
    'cooking': ('饭锅占着浆炉，已煮熟待提', [take('ow_cold_rice_pot'), time(20), notice('cooking_notice', '借桶添水，煮了二十分钟。饭已熟，到炉边提锅腾位；这时浆炉不能熬糨糊，木桶仍在身上。')]),
    'hot': ('提起熟饭，浆炉腾回', [give('ow_hot_rice_pot'), notice('hot_notice', '提起熟饭，浆炉已经腾回。找杨嫂交锅；任务记号会跟着她的班次走。')]),
    'repaired': ('街灶恢复，杨嫂延长街摊晚班', [take('ow_charcoal'), time(30), give('ow_meal_voucher'), act('giveCurrency', amount=6), notice('repair_notice', '炭条画线试平，架锅看水面不偏，再用摊上的灶炭试火。三十分钟修妥，收六文、一张饭筹；杨嫂七至二十二点守街摊。')]),
    'borrowed': ('饭做成，杨嫂把午后生意搬到后巷', [take('ow_hot_rice_pot'), time(5), give('ow_meal_voucher'), notice('borrow_notice', '饭锅交回，收一张饭筹。这回没有工钱；杨嫂十三至二十点改在后巷出饭，早市仍在街头。')]),
}, [transition('initial', 'accepted', 'ow_stove_accept'),
    *[transition(s, 'cold', 'ow_stove_borrow', neg(partial)) for s in ['initial', 'accepted']],
    transition('cold', 'accepted', 'ow_stove_cancel', has('ow_cold_rice_pot')),
    transition('cold', 'cooking', 'ow_stove_cook', has('ow_cold_rice_pot'), has('ow_bucket')),
    transition('cooking', 'hot', 'ow_stove_collect'),
    transition('hot', 'borrowed', 'ow_stove_deliver', has('ow_hot_rice_pot')),
    transition('accepted', 'repaired', 'ow_stove_fire', ash, foot, has('ow_charcoal')),
])
# Re-entering the choice state returns the borrowed pot. Cooking owns its own
# removal; none of the finished states returns here.
main['states']['accepted']['onEnterActions'] = [take('ow_cold_rice_pot')]
parts = []
for gid, sig, iid, label in [(A, 'ow_stove_clear', 'ow_bamboo', '清灰留进风口'), (W, 'ow_stove_wedge', 'ow_wood_wedge', '垫稳缺脚')]:
    parts.append(wrapper(graph(gid, label, {'initial': '未处理', 'done': (label, [take(iid), notice(sig+'_notice', label+'已做妥，用去一份材料。已用修料，这口灶继续修；重复操作不再扣料。')])},
        [transition('initial', 'done', sig, choosing, has(iid))]), len(parts)*300, 430))
upsert(ng['compositions'], composition(main, 'C08：持物检视修灶，或抱锅借炉、提锅腾位、交饭。浆炉占用由 cooking 态派生，S11 与它共用实体；两个结局改变杨嫂营业地点与时长。', parts))
payment = graph(PAY, '饭包结账', {'initial': '未结账',
    'cash': ('付三文取饭', [act('removeCurrency', amount=3)]),
    'voucher': ('交饭筹取饭', [take('ow_meal_voucher')])},
    [transition('initial', 'cash', 'ow_meal_buy', selling, neg(state(M, 'done', True)), {'flag': 'coins', 'op': '>=', 'value': 3}),
     transition('initial', 'voucher', 'ow_meal_redeem', selling, neg(state(M, 'done', True)), has('ow_meal_voucher'))])
meal = graph(M, '收摊前留一份饭', {'initial': '还没问过留饭', 'accepted': '营业时向杨嫂取饭包',
    'carrying': ('饭包收好，可从摸囊吃', [give('ow_travel_meal'), notice('meal_taken_notice', '饭包收进摸囊。找空处打开摸囊，选饭包吃掉；吃饭花十分钟，包纸留下。')]),
    'done': ('吃过饭，留好干净包纸', [take('ow_travel_meal'), give('ow_clean_wrapper'), time(10)])},
    [transition('initial', 'accepted', 'ow_meal_accept'), *[reactive(s, 'carrying', paid) for s in ['initial', 'accepted']],
     transition('carrying', 'done', 'ow_meal_eat', has('ow_travel_meal'))])
upsert(ng['compositions'], composition(meal, 'S10：按营业时段结账取得实物，摸囊实际用饭。结账方式独立一次，吃饭只耗一次并留包纸。', [wrapper(payment, 0, 410)]))

switch('stove', [(repaired, 'fixed'), (borrowed, 'loan_done'), (cold, 'cold_choices'), (busy, 'cooking_hint'), (hot, 'hot_hint')], 'intro')
line('intro', '杨嫂的饭锅搁在旁边，灶底灰堵住了风口，右前脚又缺一角。她答应了脚夫的晚饭，纸扎铺却也等着用那口浆炉。', 'accept')
run('accept', [emit('ow_stove_accept'), act('setFocusedQuest', id='ow_stove')], 'methods')
choice('methods', option('repair_method', '修街灶：薄篾、楔木、炭；得六文和饭筹', 'repair_terms'),
    option('borrow_method', '抱锅借浆炉：不花修料，只有饭筹', 'borrow_terms', neg(partial), '已经用了修料，继续修稳这口灶。'),
    option('stove_later', '我先看看缺哪样', 'end'))
line('repair_terms', '先拿近看：摸囊持薄篾清前下方灰口，持楔木垫右前缺脚。两处做好，退出近看，用炭条在锅壁画线试平；确认水面不偏，才用摊上的灶炭试火。第一份修料落下，就不改借炉。', 'repair_choices')
choice('repair_choices', option('look_stove', '拿近看，按坏处用工具', 'examine'),
    option('fire_stove', '耗一支炭条画线试平，再试火；三十分钟', 'fire', all_of(ash, foot, has('ow_charcoal')), '先清灰、垫脚，再备一支画记号的炭条。楔木可从庙门取，也能在罗伯处买。'),
    option('repair_wait', '先备材料', 'end'))
run('examine', [act('setFocusedQuest', id='ow_stove', objectiveId='stove_repair_obj'), act('startObjectExamine', id='ow_noodle_stove')], 'repair_after')
line('repair_after', '已做的部位留着。两处都好了，就在冷灶前选画线试平、架锅试火；不用重新放料。')
run('fire', [emit('ow_stove_fire')], 'fixed')
line('fixed', '灶脚垫稳，灰口通风，饭锅可安稳架住。杨嫂七至二十二点在街头出饭，原来去后巷找她的活也改到街摊。')
line('borrow_terms', '锅里是杨嫂留好的生米，带盖能搬。后巷借炉时用木桶添水，煮二十分钟；提走饭锅，罗伯才能继续熬浆。熟饭交杨嫂，她午后改在后巷做饭。', 'borrow_choice')
choice('borrow_choice', option('take_pot', '抱起冷饭锅，送后巷浆炉', 'borrow'), option('dont_borrow', '先不借', 'end'))
run('borrow', [emit('ow_stove_borrow'), act('setFocusedQuest', id='ow_stove')], 'cold_hint')
line('cold_hint', '冷饭锅在身上，到后巷浆炉添水煮饭。没有木桶，先捞桶；要改修街灶，可把没煮的锅放回原处。')
choice('cold_choices', option('cold_continue', '继续送往后巷浆炉', 'cold_hint'), option('cold_cancel', '把冷锅放回，再选修灶或借炉', 'cancel'))
run('cancel', [emit('ow_stove_cancel')], 'methods')
switch('loan_stove', [(busy, 'collect_choice'), (cold, 'cook_choice'), (hot, 'hot_stove')], 'loan_intro')
line('loan_intro', '这口炉平时熬糨糊。杨嫂街摊的灶坏了，可以把带盖饭锅搬来借火；锅还在街摊，不能凭空在这点煮成。', 'loan_intro_choice')
choice('loan_intro_choice', option('loan_go', '记下街头的冷灶位置', 'loan_focus'), option('paste_instead', '照常熬糨糊', 'paste_handoff'), option('loan_leave', '先不动炉子', 'end'))
run('loan_focus', [emit('ow_stove_accept'), act('setFocusedQuest', id='ow_stove')])
run('paste_handoff', [act('startDialogueGraph', graphId='开放世界_纸扎', entry='stove_available')])
line('hot_stove', '饭锅已经提起，炉位空出来了。熟饭还没交杨嫂；要先熬浆也行，先把饭锅搁稳。', 'hot_stove_choices')
choice('hot_stove_choices', option('keep_delivery', '先把熟饭交杨嫂', 'delivery_focus'), option('paste_first', '炉子空了，我先熬糨糊', 'paste_handoff'), option('stove_freed_leave', '先不动炉子', 'end'))
run('delivery_focus', [act('setFocusedQuest', id='ow_stove', objectiveId='stove_deliver_obj')])
choice('cook_choice', option('cook_rice', '用桶添水，借炉煮二十分钟', 'cook', has('ow_bucket'), '需要可复用木桶；河边能捞。没煮的锅仍可放回街摊，再改修灶。'), option('cook_wait', '先不占炉', 'end'))
run('cook', [emit('ow_stove_cook'), act('setFocusedQuest', id='ow_stove')], 'collect_choice')
choice('collect_choice', option('collect_rice', '提起熟饭，腾回浆炉', 'collect'), option('leave_rice', '先留在炉上，这时不能熬浆', 'end'))
run('collect', [emit('ow_stove_collect'), act('setFocusedQuest', id='ow_stove')], 'hot_hint')
line('cooking_hint', '饭已熟，锅还占着后巷浆炉。回炉边提锅腾位，熬浆才恢复；任务记号指向同一口炉。')
line('hot_hint', '熟饭已提起来，浆炉腾回去了。找杨嫂把锅交给她；她若收摊，歇脚等开工。')
line('loan_done', '这顿饭借后巷炉火做成了。街灶没修，杨嫂改在后巷接午后的生意；十三至二十点找后巷，七至十三点仍在街头。')
switch('yang', [(hot, 'delivery'), (repaired, 'fixed'), (borrowed, 'loan_done'), (busy, 'cooking_hint'), (cold, 'cold_hint')], 'yang_request')
line('yang_request', '两家的锅争一口火，光端着生米啷个交差嘛。街灶修稳了，我守到二十二点；借后巷的火做成，我就把午后生意挪过去。修有修的钱，借有借的饭筹。', 'yang_accept', '杨嫂')
run('yang_accept', [emit('ow_stove_accept'), act('setFocusedQuest', id='ow_stove')])
line('delivery', '热饭提回来就好。我端进后巷出饭，十三到二十点在那点；早市还在街头卖备好的吃食。勒张饭筹你拿起，没修灶就不算修灶工钱。', 'delivery_choice', '杨嫂')
choice('delivery_choice', option('give_rice', '交回熟饭锅，收饭筹', 'deliver'), option('keep_rice', '等一哈再交', 'end'))
run('deliver', [emit('ow_stove_deliver')], 'loan_done')

switch('meal', [(state(M, 'done', True), 'meal_done'), (state(M, 'carrying'), 'meal_have'), (neg(selling), 'meal_closed')], 'meal_intro')
line('meal_intro', '灶坏也还有事先蒸好的饭包，修好便现做。三文一份，有饭筹就用饭筹；收进摸囊，赶路前再吃。', 'meal_accept', '杨嫂')
run('meal_accept', [emit('ow_meal_accept'), act('setFocusedQuest', id='ow_meal')], 'meal_choices')
choice('meal_choices', option('meal_voucher', '交一张饭筹，取饭包', 'redeem', has('ow_meal_voucher'), '修灶或借炉把饭做成交回，杨嫂给饭筹；也能付三文。'),
    option('meal_cash', '付三文，取饭包', 'buy', {'flag': 'coins', 'op': '>=', 'value': 3}, '还缺三文。可先帮忙晒纸、核账，或把冷灶的活做成换饭筹。'),
    option('meal_wait', '暂时不留饭', 'end'))
run('buy', [emit('ow_meal_buy')], 'meal_have')
run('redeem', [emit('ow_meal_redeem')], 'meal_have')
line('meal_have', '饭包已经收在摸囊。找个空处打开摸囊，选饭包吃掉；吃饭花十分钟，干净包纸留下。')
line('meal_done', '饭已经吃了，干净包纸留在身上，可包护怕潮的小物。这一份已经结清，不用再付钱。')
line('meal_closed', '这时已经收摊。任务记号会指歇脚处；等开市，再按杨嫂当前的营业地点找。', 'meal_track')
run('meal_track', [emit('ow_meal_accept'), act('setFocusedQuest', id='ow_meal')])

examine = {'id': 'ow_noodle_stove', 'label': a.text('ex_label', '检视：堵灰缺脚的冷灶'), 'title': a.text('ex_title', '先通风、再站稳'),
    'allFoundHint': a.text('ex_all', '清灰口要薄篾，右前缺脚要楔木；做好再退出近看，炭条画线试平、架锅试火。'),
    'presentation': {'kind': 'still', 'image': '/resources/runtime/images/examine/ow_noodle_stove.png', 'physicalWidthCm': 32, 'backgroundPreset': 'stone', 'contactAoIntensity': 0.4, 'contactAoRadiusCm': 0.6},
    'ambience': {'headSway': {'amplitude': 0.12}, 'breathing': False, 'dust': False}, 'hotspots': []}
for hid, xywh, iid, label, narration, work, sig in [
    ('ash', (382, 750, 390, 220), 'ow_bamboo', '堵灰的进风口', '冷灰把进风口堵住了。用薄篾挑松带出，莫拿灯油往里灌。', '薄篾带出冷灰，风口留通。已经清好的不用再清，是否用料看任务记录。', 'ow_stove_clear'),
    ('foot', (795, 935, 175, 165), 'ow_wood_wedge', '右前缺脚', '右前脚崩了一角，锅一偏就晃。把硬楔木垫在缺脚下，纸片承不住。', '把硬楔木塞在缺脚下，灶架站稳。已经垫过的不再多塞。', 'ow_stove_wedge')]:
    x,y,w,h = xywh
    examine['hotspots'].append({'id': hid, 'label': a.text(hid+'_label', label), 'x': x, 'y': y, 'width': w, 'height': h,
        'narration': a.text(hid+'_look', narration), 'itemUses': [{'itemId': iid, 'label': a.text(hid+'_use', '用薄篾清灰' if hid=='ash' else '用楔木垫脚'), 'narration': a.text(hid+'_work', work), 'actions': [emit(sig)]}]})
examine['hotspots'].append({'id':'ring', 'x':310, 'y':390, 'width':470, 'height':175, 'label':a.text('ring_label','铁锅圈'), 'narration':a.text('ring_look','锅圈没断，不必拆。要处理的是下面的进风口和缺脚。'), 'decoy': True})

street, alley = read('scenes/雾津街头.json'), read('scenes/test_room_b.json')
h = a.hotspot('ow_noodle_stove', '杨嫂摊前冷灶', 1638, 1948, 'stove', size=42)
upsert(street['hotspots'], h)
for hid, label, cond, filename in [('ow_stove_image_broken', '堵灰缺脚的街灶', neg(repaired), 'ow_noodle_stove.png'),
                                  ('ow_stove_image_repaired', '已清灰垫稳的街灶', repaired, 'ow_noodle_stove_repaired.png')]:
    display = a.hotspot(hid, label, 1638, 1948, 'stove', [cond], size=30)
    display['displayImage'] = {'image': '/resources/runtime/images/examine/'+filename, 'worldWidth': 38, 'worldHeight': 48}
    upsert(street['hotspots'], display)
# One existing physical paste stove owns both uses; keep its ID and location.
paste_dg = read('dialogues/graphs/开放世界_纸扎.json')
paste_dg['nodes']['stove']['cases'] = [c for c in paste_dg['nodes']['stove']['cases'] if c.get('next') != 'ow_rice_handoff']
paste_dg['nodes']['stove']['cases'].insert(0, {'condition': any_of(cold, busy, hot), 'next': 'ow_rice_handoff'})
paste_dg['nodes']['stove_available'] = {'type': 'switch', 'cases': [{'condition': has('ow_paste'), 'next': 'paste_have'}], 'defaultNext': 'stove_intro'}
paste_dg['nodes']['ow_rice_handoff'] = {'type':'runActions','actions':[act('startDialogueGraph', graphId=a.dg['id'], entry='loan_stove')], 'next':'end'}
opts = paste_dg['nodes']['stove_choice']['options']
opts[:] = [o for o in opts if o['id']!='ow_rice_topic']
opts.insert(0, {'id':'ow_rice_topic','text':a.text('rice_topic','杨嫂的饭锅能借这口炉？'),'next':'ow_rice_handoff'})
for c in ng['compositions']:
    for g in [c['mainGraph']] + [e['graph'] for e in c.get('elements',[]) if e.get('graph')]:
        if g['id'] == 'flow_ow_paste_recipe':
            for t in g['transitions']:
                if t.get('signal') == 'ow_paste_cook' and neg(busy) not in t.get('conditions',[]): t.setdefault('conditions',[]).append(neg(busy))

sch = read('data/npc_schedules.json'); schedules = sch['schedules']
yang = next(s for s in schedules if s['characterId']=='ow_yang')
yang['entries'] = [
    {'from':'07:00','to':'22:00','scene':'雾津街头','conditions':[repaired]},
    {'from':'22:00','to':'07:00','scene':None,'conditions':[repaired]},
    {'from':'07:00','to':'13:00','scene':'雾津街头','conditions':[borrowed]},
    {'from':'13:00','to':'20:00','scene':'test_room_b','conditions':[borrowed]},
    {'from':'20:00','to':'07:00','scene':None,'conditions':[borrowed]},
    {'from':'07:00','to':'18:00','scene':'雾津街头','conditions':[neg(done)]},
    {'from':'18:00','to':'20:00','scene':'test_room_b','conditions':[neg(done)]},
    {'from':'20:00','to':'07:00','scene':None,'conditions':[neg(done)]}]
guide = a.npc_guidance('ow_yang', schedules)
quests = read('data/quests.json'); obj=a.objective
stove_mark = marker('雾津街头','hotspot','ow_noodle_stove')
loan_mark = marker('test_room_b','hotspot','ow_paste_stove')
upsert(quests,a.quest('ow_stove','一口冷灶两家饭','修冷灶恢复街摊，或抱锅借后巷浆炉。饭锅占炉时不能熬浆；提走便腾回。两条路的材料、工钱与营业地点不同。',neg(state(G,'initial')),done,[
    obj('stove_choose_obj','街摊修灶，或抱锅借后巷炉火',any_of(partial,cold,busy,hot,done),stove_mark,all_of(choosing,neg(partial))),
    obj('stove_repair_obj','近看冷灶：薄篾清灰、楔木垫缺脚',all_of(ash,foot),stove_mark,choosing),
    obj('stove_fire_obj','退出近看，用炭条试平，架锅试火',done,stove_mark,all_of(choosing,ash,foot)),
    obj('stove_cook_obj','带饭锅与木桶，到后巷浆炉煮饭',any_of(busy,hot,done),loan_mark,cold),
    obj('stove_collect_obj','从浆炉提起熟饭，腾回工位',any_of(hot,done),loan_mark,busy),
    obj('stove_deliver_obj','把熟饭锅交回杨嫂',done,guide,hot)]))
upsert(quests,a.quest('ow_meal','收摊前留一份饭','营业时向杨嫂用饭筹或三文取饭包，再从摸囊吃掉；进食十分钟，干净包纸留下。',neg(state(M,'initial')),state(M,'done',True),[
    obj('meal_get_obj','营业时找杨嫂：饭筹或三文取饭',state(M,'carrying',True),guide,any_of(state(M,'initial'),state(M,'accepted'))),
    obj('meal_eat_obj','打开摸囊，选饭包吃掉',state(M,'done',True),None,state(M,'carrying'))]))
for q in quests:
    for o in q.get('objectives',[]):
        if any(g.get('entityId')=='ow_yang' for g in o.get('guidance',[])):o['guidance']=guide
folk=read('dialogues/graphs/开放世界_街坊.json')
for key, prose, entry in [('stove','灶脚晃成恁个，晚饭啷个办？','yang'),('meal','给我留一份饭。','meal')]:
    nid='ow_'+key+'_handoff'
    folk['nodes'][nid]={'type':'runActions','actions':[act('startDialogueGraph',graphId=a.dg['id'],entry=entry)],'next':'end'}
    for mid,node in list(folk['nodes'].items()):
        if mid.startswith('yang_menu') and node['type']=='choice':
            node['options']=[o for o in node['options'] if o['id']!='ow_'+key+'_topic']
            node['options'].insert(0,{'id':'ow_'+key+'_topic','text':a.text(key+'_topic',prose),'next':nid})
folk['nodes']['yang_day']={'type':'switch','cases':[{'condition':repaired,'next':'ow_yang_fixed_day'},{'condition':borrowed,'next':'ow_yang_loan_day'}],'defaultNext':'ow_yang_normal_day'}
for nid,prose in [('ow_yang_fixed_day','灶修稳，我七点开摊，一直守街头到二十二点，今天多煮几锅。要找我就来摊边。'),('ow_yang_loan_day','后巷那口火借顺手了。七至十三点在街头，十三至二十点去后巷出饭，过后就歇。'),('ow_yang_normal_day','七点到十八点我守街摊，后头去后巷收拾到二十点。灶还坏着，只卖备好的饭包。')]:
    folk['nodes'][nid]={'type':'line','speaker':{'kind':'literal','name':'杨嫂'},'text':a.text(nid,prose),'next':'yang_menu'}
items=read('data/items.json')
for iid,label,desc in [('ow_cold_rice_pot','带盖的生米饭锅','杨嫂的生米已在锅里。带到后巷浆炉，借木桶添水煮熟；还没煮可放回街摊改选修灶。'),('ow_hot_rice_pot','提离浆炉的熟饭锅','饭已经煮好，浆炉腾回去了。按杨嫂的日程找她，把饭锅交回。'),('ow_meal_voucher','杨嫂的一张饭筹','把冷灶的活做成所得。杨嫂营业时可换一份饭包，只能用一次。'),('ow_travel_meal','干净纸包的饭团','向杨嫂买来或用饭筹换来的饭包。打开摸囊可以吃掉，耗时十分钟，干净包纸留下。'),('ow_clean_wrapper','留好的干净包纸','吃饭前叠在旁边、没弄脏的外层包纸。可包护怕潮的小物。')]:
    row={'id':iid,'name':a.text(iid+'_name',label),'description':a.text(iid+'_desc',desc),'type':'key','maxStack':1}
    if iid=='ow_travel_meal': row['use']={'label':a.text('eat_label','坐定吃饭 · 十分钟'),'conditions':[state(M,'carrying'),has(iid)],'disableHint':a.text('eat_disabled','这份饭已吃过。'),'consume':False,'actions':[emit('ow_meal_eat')],'resultText':a.text('eat_result','饭团慢慢咽下，肚皮总算不叫了。外层干净包纸先叠在旁边，吃完仍可用。')}
    upsert(items,row)
shops=read('data/shops.json');shop=next(s for s in shops if s['id']=='ow_luo_supplies')
if not any(i['itemId']=='ow_wood_wedge' for i in shop['items']):shop['items'].append({'itemId':'ow_wood_wedge','price':2})
index=read('data/object_examine/index.json');upsert(index,{'id':examine['id'],'label':'检视：街摊冷灶','file':examine['id']+'.json'})
def signals(v):
    if isinstance(v,dict):
        if v.get('type')=='emitNarrativeSignal':yield v['params']['signal']
        for child in v.values():yield from signals(child)
    elif isinstance(v,list):
        for child in v:yield from signals(child)
for sig in sorted(set(signals([a.dg,examine,items]))):
    if not any(s['id']==sig for s in ng['signals']):ng['signals'].append({'id':sig,'label':sig})
write_many([('data/narrative_graphs.json',ng),('data/quests.json',quests),('data/strings.json',a.strings),('data/items.json',items),('data/shops.json',shops),('data/npc_schedules.json',sch),('data/object_examine/index.json',index),('data/object_examine/ow_noodle_stove.json',examine),('scenes/雾津街头.json',street),('dialogues/graphs/开放世界_纸扎.json',paste_dg),('dialogues/graphs/开放世界_街坊.json',folk),('dialogues/graphs/开放世界_灶火.json',a.dg)])
print('C08 and S10 authored. C07 remains unimplemented. Native acceptance pending.')
