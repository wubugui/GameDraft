"""Offline native authoring: C04 watch clapper, S06 lamp, S16 message, S20 cargo.

Run once for this batch. Never rerun over later NPC topic/schedule edits.
"""
from copy import deepcopy
from native_authoring import *

a = Author('owWatch', '开放世界_巡更', '更梆与夜里当班的人', 'cord')
line, run, switch, choice, option = a.line, a.run, a.switch, a.choice, a.option
G, F, B, T = 'flow_ow_watch', 'flow_ow_watch_found', 'flow_ow_watch_splint', 'flow_ow_watch_tie'
L, M, C = 'flow_ow_lamp', 'flow_ow_message', 'flow_ow_cargo'
original, patched = state(G, 'original', True), state(G, 'patched', True)
done = any_of(original, patched)
found, splint, tie = state(F, 'found', True), state(B, 'done', True), state(T, 'done', True)
made = all_of(splint, tie)
repaired = any_of(state('flow_ow_water', 'repaired', True), state('flow_ow_water', 'done', True))
water_done = any_of(repaired, state('flow_ow_water', 'diverted', True))
safe_pull = any_of(repaired, has('ow_rope'))
lamp_done, cargo_done = state(L, 'done', True), state(C, 'done', True)
message_done = any_of(state(M, 'bridge_agreed', True), state(M, 'dock_agreed', True))
ng = read('data/narrative_graphs.json')

main = graph(G, '夜更少了一声', {
    'initial': '未听见缺的那声', 'accepted': '原梆落水，备用梆开裂',
    'original': ('交回原梆，丁四留桥照应', [take('ow_old_clapper'), act('giveCurrency', amount=8)]),
    'patched': ('交出修好的备用梆，丁四回内街应门', [take('ow_patched_clapper'), act('giveCurrency', amount=4)]),
}, [transition('initial', 'accepted', sig) for sig in ['ow_watch_accept', 'ow_watch_found', 'ow_watch_splint', 'ow_watch_tie']] + [
    transition('accepted', 'original', 'ow_watch_return_original', has('ow_old_clapper')),
    transition('accepted', 'patched', 'ow_watch_return_patched', has('ow_patched_clapper')),
])
elements = [
    wrapper(graph(F, '水下的原梆', {'initial': '仍在水下', 'found': ('实际拉出原梆', [give('ow_old_clapper')])},
        [transition('initial', 'found', 'ow_watch_found', safe_pull, neg(done))], 'minigame', 'ow_watch_clapper'), 0, 450),
    wrapper(graph(B, '备用梆裂口垫篾', {'initial': '木纹开裂', 'done': ('薄篾衬住裂纹', [take('ow_bamboo'), act('showNotification', text=a.text('splint_ok', '裂口已衬稳；薄篾用去一片。'), type='info')])},
        [transition('initial', 'done', 'ow_watch_splint', has('ow_bamboo'), neg(done))]), 300, 450),
    wrapper(graph(T, '备用梆穿孔绑带', {'initial': '旧绳磨毛', 'done': ('布带穿好两孔', [take('ow_cloth'), act('showNotification', text=a.text('tie_ok', '布带已穿好；干布用去一条。'), type='info')])},
        [transition('initial', 'done', 'ow_watch_tie', has('ow_cloth'), neg(done))]), 600, 450),
    wrapper(graph('flow_ow_watch_spare', '可带走的备用梆', {'initial': '尚未修齐', 'ready': ('衬篾与绑带齐备', [give('ow_patched_clapper'), act('showNotification', text=a.text('spare_ok', '备用梆修好，已收进摸囊。可退出检视去找丁四。'), type='success')])},
        [{'id': 'parts_ready', 'from': 'initial', 'to': 'ready', 'trigger': 'reactive', 'signal': '__draft__', 'conditions': [made, neg(done)]}]), 900, 450),
]
upsert(ng['compositions'], composition(main, 'C04：原生拉扯捞原梆，或持物点检视热区修备用梆；声音与巡更位置是不同的承诺。', elements))
upsert(ng['compositions'], composition(graph(L, '巡更灯缺油', {
    'initial': '未留意', 'accepted': '灯里余油不多',
    'done': ('压灭灯芯后补足灯油', [take('ow_lamp_oil'), act('giveCurrency', amount=2)]),
}, [transition('initial', 'accepted', 'ow_lamp_accept'), transition('accepted', 'done', 'ow_lamp_fill', has('ow_lamp_oil'))]), 'S06：固定灯位用油，钱叔零货报酬或杨嫂交易提供来源。'))
upsert(ng['compositions'], composition(graph(M, '夜里的口信', {
    'initial': '尚未受托', 'accepted': '替丁四问钱叔能否应声',
    'bridge_reply': '钱叔答复仍守险口', 'dock_reply': '钱叔答复处理后回码头',
    'bridge_agreed': ('丁四知晓钱叔守桥', [act('giveCurrency', amount=3)]),
    'dock_agreed': ('丁四知晓钱叔回船', [act('giveCurrency', amount=3)]),
}, [transition('initial', 'accepted', 'ow_message_accept')] + [
    transition(s, 'bridge_reply', 'ow_message_qian', neg(water_done)) for s in ['accepted', 'dock_reply']
] + [transition(s, 'dock_reply', 'ow_message_qian', water_done) for s in ['accepted', 'bridge_reply']] + [
    transition('bridge_reply', 'bridge_agreed', 'ow_message_report', neg(water_done)),
    transition('dock_reply', 'dock_agreed', 'ow_message_report', water_done),
]), 'S16：收到真实答复才可回报；带话途中水路变化，须重问，不能把旧话当新承诺。'))
upsert(ng['compositions'], composition(graph(C, '码头散落的零货', {
    'initial': '未留意', 'accepted': '钱叔在找小包',
    'carrying': ('蹲下取出压在箱底的包', [give('ow_small_cargo')]),
    'done': ('照封口把包还给守船人', [take('ow_small_cargo'), give('ow_lamp_oil'), give('ow_charcoal', 2)]),
}, [transition('initial', 'accepted', 'ow_cargo_accept'),
    *[transition(s, 'carrying', 'ow_cargo_take') for s in ['initial', 'accepted']],
    transition('carrying', 'done', 'ow_cargo_return', has('ow_small_cargo'))]), 'S20：不用拆包猜奖品；看封口，蹲取，交回取得可用的油与炭。'))

run('focus', [emit('ow_watch_accept'), act('setFocusedQuest', id='ow_watch', objectiveId='watch_choose_obj')], 'methods')
switch('cord', [(done, 'cord_done'), (found, 'cord_empty')], 'cord_intro')
line('cord_intro', '桥边石环挂着一截磨断的绳。水里碰出两下木响，第三下叫水声吞了。不是有人喊你。', 'focus')
line('cord_done', '桥边断绳还在。丁四已经拿到能用的梆，没必要再为旧物涉水。')
line('cord_empty', '原梆已收进摸囊。丁四傍晚先到桥下，深夜去处看他的当班约定。', 'methods')
choice('methods',
    option('recover', '捞回水里的原梆', 'pull_check', all_of(neg(found), neg(done)), '原梆已经取走，或丁四已经收下一副梆。'),
    option('spare_where', '去街头，修丁四留下的备用梆', 'bench_route', neg(done)),
    option('leave_watch', '先记住这件事', 'end'))
line('bench_where', '街头丁四常歇脚处放着备用旧梆。裂口要一片薄篾，穿孔要一条干布；修好声音会闷些，他只能沿内街逐门应答。')
run('bench_route', [act('setFocusedQuest', id='ow_watch', objectiveId='watch_bench_obj')], 'bench_where')
switch('pull_check', [(safe_pull, 'pull_time')], 'pull_blocked')
line('pull_blocked', '低岸还不稳。先带一截完整缆绳保稳，或把桥下水路修好；修备用梆不必下水。缆绳可在罗伯处买，也可帮钱叔补扣换取。')
switch('pull_time', [({'timePhase': '夜'}, 'pull_night')], 'pull_day')
run('pull_day', [act('setFocusedQuest', id='ow_watch', objectiveId='watch_water_obj'), act('startWaterMinigame', id='ow_watch_clapper')], 'pull_after')
run('pull_night', [act('setFocusedQuest', id='ow_watch', objectiveId='watch_water_obj'), act('startWaterMinigame', id='ow_watch_clapper_night')], 'pull_after')
switch('pull_after', [(found, 'pull_got')], 'pull_again')
line('pull_got', '原梆捞起来了。交还丁四得八文，他二十至二十二点留桥边应声；若另交备用梆，他会改走内街。')
line('pull_again', '木梆仍在水里。脱手可以再试；也可以退出，改去街头修备用梆。')

switch('bench', [(done, 'bench_done'), (made, 'bench_ready')], 'bench_intro')
line('bench_intro', '两片旧木板放在丁四的歇脚处。一片沿木纹裂开，穿孔的绳也磨毛了。薄篾衬裂口，干布换绑带，两处都要亲手处理。', 'bench_focus')
run('bench_focus', [emit('ow_watch_accept'), act('setFocusedQuest', id='ow_watch', objectiveId='watch_bench_obj')], 'bench_choice')
choice('bench_choice', option('bench_work', '拿近些，摸囊取材料来修', 'bench_open'), option('bench_later', '先去备材料', 'end'))
run('bench_open', [act('startObjectExamine', id='ow_watch_bench')], 'bench_after')
switch('bench_after', [(made, 'bench_ready')], 'bench_incomplete')
line('bench_incomplete', '没修完的地方先留着。薄篾找罗伯，干布找何婆婆；已用上的材料不必再放一份。')
line('bench_ready', '备用梆修好，已经装进摸囊。丁四夜里来当班时，可以当面商量用哪一副。')
line('bench_done', '丁四已经取用一副梆。余下的材料收起，这桩活不再重复领钱。')

switch('ding', [(original, 'ding_original_done'), (patched, 'ding_patched_done')], 'ding_intro')
line('ding_intro', '昨晚上我拉人避水，梆绳叫石口磨断了。你莫听到少一声就往鬼头上想。原梆响得远，备用那副又裂了，背时得很。', 'focus_ding', '丁四')
run('focus_ding', [emit('ow_watch_accept'), act('setFocusedQuest', id='ow_watch')], 'ding_choice')
choice('ding_choice',
    option('give_original', '交原梆：八文，二十至二十二点守桥', 'original_commit', has('ow_old_clapper'), '原梆还在桥边水里，须实际捞起。'),
    option('give_spare', '交备用梆：四文，同一时段应内街的门', 'patched_commit', has('ow_patched_clapper'), '街头备用梆的裂口和绑带还没修齐。'),
    option('ding_methods', '两种办法啷个做？', 'methods'), option('ding_later', '我再想一哈', 'end'))
run('original_commit', [emit('ow_watch_return_original')], 'ding_original_done')
run('patched_commit', [emit('ow_watch_return_patched')], 'ding_patched_done')
line('ding_original_done', '勒副响得远，二十点过后我还在桥下待两个钟头。钱叔的信要问明白，莫以为我守桥就能替他守船。', 'end', '丁四')
line('ding_patched_done', '你衬得牢，可声音闷。我二十点回内街挨门应，桥那头听不到。走水边就先问钱叔，莫隔河等我。', 'end', '丁四')
line('deng', '我亲眼看到绳断，丁四拉的是个活人。梆落在桥边石环下面。你要的是梆，不是去水里找人，记清楚。', 'focus', '邓幺')

switch('lamp', [(lamp_done, 'lamp_done')], 'lamp_intro')
line('lamp_intro', '灯里只剩薄薄一层油，勉强亮着。旁边压着丁四的记号：添一份清灯油。船用桐油黏，不能往灯芯上倒。', 'lamp_focus')
run('lamp_focus', [emit('ow_lamp_accept'), act('setFocusedQuest', id='ow_lamp')], 'lamp_choice')
choice('lamp_choice', option('lamp_use', '压灭灯芯，倒入一份灯油，再点稳', 'lamp_commit', has('ow_lamp_oil'), '身上没有清灯油。杨嫂卖油；钱叔收回零货也肯匀出一份。'), option('lamp_later', '先去找清灯油', 'end'))
run('lamp_commit', [emit('ow_lamp_fill')], 'lamp_done')
line('lamp_done', '灯芯吃足了油，火苗稳下来。压在灯脚的两文补油钱已经收好。这盏灯只照近处，走远仍要选路。')
run('oil_shop', [act('openShop', shopId='ow_yang_oil')])

switch('message', [(message_done, 'message_done'), (state(M, 'bridge_reply'), 'report_check'), (state(M, 'dock_reply'), 'report_check')], 'message_intro')
line('message_intro', '你碰到钱叔，替我问一句：今天黑了，他是在桥口应声，还是回去守船？听他亲口讲，别拿白天的闲话凑。', 'message_accept', '丁四')
run('message_accept', [emit('ow_message_accept'), act('setFocusedQuest', id='ow_message')])
switch('report_check', [(any_of(all_of(state(M, 'bridge_reply'), neg(water_done)), all_of(state(M, 'dock_reply'), water_done)), 'report_choice')], 'message_stale')
choice('report_choice', option('report_now', '把钱叔当面答复的班次说清', 'report_commit'), option('report_wait', '等一哈再说', 'end'))
run('report_commit', [emit('ow_message_report')], 'message_done')
line('message_done', '话带明白了。钱叔守哪头，我就不白往那头喊。三文跑腿钱你拿起；真过夜路，还要看水和灯。', 'end', '丁四')
line('message_stale', '你带话之后水路又变了，钱叔未必还守原处。重新问他一句，别叫两个人在夜里空等。', 'end', '丁四')
switch('qian_message', [(state(M, 'initial'), 'qian_no_message'), (message_done, 'qian_message_done')], 'qian_reply')
line('qian_no_message', '丁四有啥子事要问我，喊他把话说明白。夜班不能凭你一声猜。', 'end', '钱叔')
run('qian_reply', [emit('ow_message_qian'), act('setFocusedQuest', id='ow_message')], 'qian_reply_where')
switch('qian_reply_where', [(water_done, 'qian_reply_dock')], 'qian_reply_bridge')
line('qian_reply_dock', '水路有了处理，我二十点以后回码头守船。告诉丁四：桥下喊不到我，找我就到系缆处。', 'end', '钱叔')
line('qian_reply_bridge', '险口没处理，我黑了还得在桥下看着。告诉丁四：隔岸听到两下才是我应声，水响不算。', 'end', '钱叔')
line('qian_message_done', '丁四晓得我的班次了。路要是再变，我们照新的水情当班，你看找人的记号就是。', 'end', '钱叔')

switch('cargo', [(cargo_done, 'cargo_done'), (state(C, 'carrying'), 'cargo_carried'), ({'posture': 'crouch'}, 'cargo_take')], 'cargo_stand')
line('cargo_stand', '箱底露出半角油纸包，绳上是钱叔系的双结。站着伸不进手；蹲下再试。', 'cargo_accept')
run('cargo_accept', [emit('ow_cargo_accept'), act('setFocusedQuest', id='ow_cargo')])
run('cargo_take', [emit('ow_cargo_take'), act('setFocusedQuest', id='ow_cargo')], 'cargo_carried')
line('cargo_carried', '小包取出来了，双结没拆。把原包交给钱叔，他认得自家的结。')
switch('qian_cargo', [(cargo_done, 'cargo_done'), (state(C, 'carrying'), 'cargo_return_choice')], 'cargo_request')
line('cargo_request', '我一小包零货落到货箱脚边了，双结绳的。你看见帮我带过来，莫拆散，油和炭一混就糟蹋了。', 'cargo_accept', '钱叔')
choice('cargo_return_choice', option('return_cargo', '把没拆的小包交还', 'cargo_commit'), option('keep_cargo', '先留在身上', 'end'))
run('cargo_commit', [emit('ow_cargo_return')], 'cargo_done')
line('cargo_done', '封口好好的，多谢你。分一份清灯油、两支炭给你。油能添巡更灯，炭能拓字或标路，别当黑泥扔了。', 'end', '钱叔')

image = '/resources/runtime/images/examine/ow_watch_clapper.png'
examine = {'id': 'ow_watch_bench', 'label': a.text('bench_label', '检视：备用旧梆'), 'title': a.text('bench_title', '修备用梆'),
    'allFoundHint': a.text('bench_hint', '看清不等于修好；摸囊拿薄篾衬裂口，用干布换绑带。'),
    'presentation': {'kind': 'still', 'image': image, 'physicalWidthCm': 32, 'backgroundPreset': 'wood', 'contactAoIntensity': 0.5, 'contactAoRadiusCm': 0.6},
    'ambience': {'headSway': {'amplitude': 0.2}, 'breathing': False, 'dust': False},
    'hotspots': [
        {'id': 'split', 'label': a.text('split_name', '顺木纹的裂口'), 'x': 405, 'y': 725, 'width': 145, 'height': 295,
         'narration': a.text('split_look', '木纹顺着裂开。用薄篾衬住裂处，别塞进两片木板相碰的缝里。'),
         'itemUses': [{'itemId': 'ow_bamboo', 'label': a.text('split_use', '衬住裂口'),
                      'narration': a.text('split_work', '薄篾顺着裂纹试位。已有衬片就不再叠放；成功时会扣去一片。'), 'actions': [emit('ow_watch_splint')]}]},
        {'id': 'cord', 'label': a.text('cord_name', '磨毛的穿孔绳'), 'x': 345, 'y': 30, 'width': 475, 'height': 280,
         'narration': a.text('cord_look', '绳毛磨开了。干布穿过两孔，结打在上头，留够两板相碰的空隙。'),
         'itemUses': [{'itemId': 'ow_cloth', 'label': a.text('cord_use', '穿布换绑带'),
                      'narration': a.text('cord_work', '布条对着两处穿孔。已有绑带就不再绕一层；成功时会扣去一条。'), 'actions': [emit('ow_watch_tie')]}]},
        {'id': 'face', 'label': a.text('face_name', '磨亮的击面'), 'x': 735, 'y': 600, 'width': 90, 'height': 265, 'decoy': True,
         'narration': a.text('face_look', '击面是平的，不必刮。添了衬和布，声音会比原梆闷，能近处应门，传不到对岸。')},
    ]}
water = deepcopy(read('data/water_minigames/ow_bridge_clear.json'))
water.update(id='ow_watch_clapper', label='桥边捞更梆', spotId='ow_watch_hollow')
water['entities'] = [water['entities'][0], {
    'id': 'watch_clapper', 'category': 'sunken', 'sprite': image, 'pos': {'x': 410, 'y': 285}, 'depth': 0.32,
    'valueTier': 'normal', 'consumeOnSuccess': True, 'displaySize': 95, 'hitRadius': 60,
    'pull': {'zoneSize': 0.3, 'sliderSpeed': 0.48, 'rhythm': 'burst', 'failurePolicy': 'slip', 'timeLimitSec': 24},
    'cue': a.text('water_cue', '两片木板叫断绳牵在石缝边，回水一阵一阵把它往下拽。'),
    'onPullSuccess': [emit('ow_watch_found')],
    'onPullFail': [act('showNotification', text=a.text('water_fail', '更梆滑回石缝，仍可重试。'), type='info')],
}]
night = deepcopy(water)
night.update(id='ow_watch_clapper_night', label='桥边捞更梆 · 夜')
night['surface']['time'] = 'night'
night['waterBottom']['tint'] = '#111d2b'
# Both presentations share a spot and a narrative-owned pickup, so switching time
# cannot grant the object twice. Each minigame has its own owner wrapper below.
original_wrapper = elements[0]['graph']
original_wrapper['ownerType'] = 'flow'
original_wrapper['ownerId'] = F
elements[0]['ownerType'] = 'flow'
elements[0]['ownerId'] = F

schedules_data = read('data/npc_schedules.json')
schedules = schedules_data['schedules']
ding = next(s for s in schedules if s['characterId'] == 'ow_ding')
ding['entries'] = [
    {'from': '07:00', 'to': '18:00', 'scene': None},
    {'from': '18:00', 'to': '20:00', 'scene': 'bridge_underpass'},
    {'from': '20:00', 'to': '22:00', 'scene': 'bridge_underpass', 'conditions': [original]},
    {'from': '20:00', 'to': '22:00', 'scene': '雾津街头', 'conditions': [neg(original)]},
    {'from': '22:00', 'to': '07:00', 'scene': '雾津街头'},
]
npc_guide = lambda npc: a.npc_guidance(npc, schedules)
quests = read('data/quests.json')
obj = a.objective
upsert(quests, a.quest('ow_watch', '夜更少了一声', '丁四的原梆落水，备用梆开裂。捞取或修补任选；交哪副梆，会改变他二十至二十二点守桥还是应内街。', neg(state(G, 'initial')), done, [
    obj('watch_choose_obj', '捞回原梆，或修好街头备用梆（任选一种）', any_of(found, made), marker('bridge_underpass', 'hotspot', 'ow_watch_cord') + marker('雾津街头', 'hotspot', 'ow_watch_bench'), all_of(neg(found), neg(made))),
    obj('watch_water_obj', '办法一：桥边捞原梆；低岸未修须带缆绳', found, marker('bridge_underpass', 'hotspot', 'ow_watch_cord'), neg(found), True),
    obj('watch_bench_obj', '办法二：街头备用梆，用薄篾衬裂、干布换绳', made, marker('雾津街头', 'hotspot', 'ow_watch_bench'), neg(made), True),
    obj('watch_return_obj', '将一副可用的梆交给丁四，选定他的夜班', done, npc_guide('ow_ding'), any_of(found, made)),
]))
upsert(quests, a.quest('ow_lamp', '巡更灯缺油', '清灯油添在街口巡更灯里；船用桐油不能代替。钱叔可分油，杨嫂也有卖。', neg(state(L, 'initial')), lamp_done, [
    obj('lamp_oil_obj', '备一份清灯油：还钱叔零货或找杨嫂买', has('ow_lamp_oil'), npc_guide('ow_yang'), neg(has('ow_lamp_oil')), True),
    obj('lamp_fill_obj', '在街口巡更灯处使用灯油', lamp_done, marker('雾津街头', 'hotspot', 'ow_watch_lamp')),
]))
reply = any_of(state(M, 'bridge_reply'), state(M, 'dock_reply'))
fresh = any_of(all_of(state(M, 'bridge_reply'), neg(water_done)), all_of(state(M, 'dock_reply'), water_done))
upsert(quests, a.quest('ow_message', '夜里的口信', '丁四要知道钱叔夜里在哪头应声。听本人答复，再向丁四回报；中途水情改变就重问。', neg(state(M, 'initial')), message_done, [
    obj('message_ask_obj', '当面问钱叔夜班；水路改变后须重新问', fresh, npc_guide('ow_qian'), neg(fresh)),
    obj('message_report_obj', '返回丁四，把钱叔的答复说清', message_done, npc_guide('ow_ding'), fresh),
]))
upsert(quests, a.quest('ow_cargo', '码头散落的零货', '钱叔的双结油纸包压在货箱脚边。取出时别拆封，交还可分到清灯油与炭。', neg(state(C, 'initial')), cargo_done, [
    obj('cargo_find_obj', '在码头货箱脚边蹲取双结小包（按住 C）', state(C, 'carrying', True), marker('码头白天', 'hotspot', 'ow_small_cargo')),
    obj('cargo_return_obj', '把未拆的小包交给钱叔', cargo_done, npc_guide('ow_qian'), state(C, 'carrying')),
]))
# Existing NPC objective markers must follow the amended schedule as well.
for q in quests:
    for o in q.get('objectives', []):
        if any(g.get('entityId') == 'ow_ding' for g in o.get('guidance', [])):
            o['guidance'] = npc_guide('ow_ding')

items = read('data/items.json')
for iid, title, desc, kind, icon in [
    ('ow_old_clapper', '丁四的原梆', '从桥边实际捞回的木梆，响声传得远。交丁四换取守桥的晚班约定。', 'key', image),
    ('ow_patched_clapper', '修好的备用梆', '薄篾衬裂，干布换绳，声音闷些。交丁四后，他走内街应门。', 'key', image),
    ('ow_lamp_oil', '清灯油', '供灯芯用的清油，一份可以添满街口巡更灯。船用桐油不能代替。', 'consumable', None),
    ('ow_small_cargo', '双结零货包', '箱底取出的小包，封绳有钱叔的双结。别拆散，交还他会分些有用的小物。', 'key', None),
]:
    row = {'id': iid, 'name': a.text(iid + '_name', title), 'description': a.text(iid + '_desc', desc), 'type': kind, 'maxStack': 10 if kind == 'consumable' else 1}
    if icon: row['icon'] = icon
    upsert(items, row)
shops = read('data/shops.json')
upsert(shops, {'id': 'ow_yang_oil', 'name': a.text('oil_shop_title', '杨嫂匀出的灯油'), 'items': [{'itemId': 'ow_lamp_oil', 'price': 3}]})

street = read('scenes/雾津街头.json')
bench_h = a.hotspot('ow_watch_bench', '巡更备用梆', 2760, 1930, 'bench', size=45)
bench_h['displayImage'] = {'image': image, 'worldWidth': 35, 'worldHeight': 35}
upsert(street['hotspots'], bench_h)
lamp_h = a.hotspot('ow_watch_lamp', '街口巡更灯', 2635, 1930, 'lamp', size=45)
lamp_h['displayImage'] = {'image': '/resources/runtime/images/props/dream/dream_oil_lamp_table_prop.png', 'worldWidth': 21, 'worldHeight': 47}
upsert(street['hotspots'], lamp_h)
bridge = read('scenes/bridge_underpass.json')
upsert(bridge['hotspots'], a.hotspot('ow_watch_cord', '石环上的断梆绳', 2820, 1865, 'cord', size=55))
dock = read('scenes/码头白天.json')
upsert(dock['hotspots'], a.hotspot('ow_small_cargo', '箱底双结小包', 1570, 1040, 'cargo', size=42))

folk = read('dialogues/graphs/开放世界_街坊.json')
water_dialogue = read('dialogues/graphs/开放世界_水路.json')
for doc, menus, key, prose, entry in [
    (folk, ['ding_menu'], 'watch', '更梆少了一声，是啷个回事？', 'ding'),
    (folk, ['ding_menu'], 'message', '钱叔夜班那句口信……', 'message'),
    (folk, ['deng_menu'], 'watch_witness', '你看到丁四的更梆落水？', 'deng'),
    (folk, ['yang_menu_0', 'yang_menu_1', 'yang_menu_2', 'yang_menu_3'], 'oil', '匀一份清灯油', 'oil_shop'),
    (water_dialogue, ['qian_menu'], 'watch_message', '丁四托我来问今天的夜班', 'qian_message'),
    (water_dialogue, ['qian_menu'], 'cargo', '箱底那包零货是你的？', 'qian_cargo'),
]:
    handoff = 'ow_' + key + '_handoff'
    doc['nodes'][handoff] = {'type': 'runActions', 'actions': [act('startDialogueGraph', graphId=a.dg['id'], entry=entry)], 'next': 'end'}
    for menu in menus:
        opts = doc['nodes'][menu]['options']
        opts[:] = [o for o in opts if o['id'] != 'ow_' + key + '_topic']
        opts.insert(0, {'id': 'ow_' + key + '_topic', 'text': a.text(key + '_topic', prose), 'next': handoff})

index = read('data/object_examine/index.json')
upsert(index, {'id': examine['id'], 'label': '检视：备用旧梆', 'file': examine['id'] + '.json'})
windex = read('data/water_minigames/index.json')
for w in [water, night]: upsert(windex, {'id': w['id'], 'label': w['label'], 'file': w['id'] + '.json'})
signals = set()
def collect(v):
    if isinstance(v, dict):
        if v.get('type') == 'emitNarrativeSignal': signals.add(v['params']['signal'])
        for ch in v.values(): collect(ch)
    elif isinstance(v, list):
        for ch in v: collect(ch)
for source in [a.dg, examine, water, night]: collect(source)
for sig in sorted(signals):
    if not any(s['id'] == sig for s in ng['signals']): ng['signals'].append({'id': sig, 'label': sig})
for path, data in [
    ('data/narrative_graphs.json', ng), ('data/quests.json', quests), ('data/strings.json', a.strings),
    ('data/items.json', items), ('data/shops.json', shops), ('data/npc_schedules.json', schedules_data),
    ('data/object_examine/index.json', index), ('data/object_examine/ow_watch_bench.json', examine),
    ('data/water_minigames/index.json', windex), ('data/water_minigames/ow_watch_clapper.json', water),
    ('data/water_minigames/ow_watch_clapper_night.json', night),
    ('scenes/雾津街头.json', street), ('scenes/bridge_underpass.json', bridge), ('scenes/码头白天.json', dock),
    ('dialogues/graphs/开放世界_街坊.json', folk), ('dialogues/graphs/开放世界_水路.json', water_dialogue),
    ('dialogues/graphs/开放世界_巡更.json', a.dg),
]: write(path, data)
print('Authored C04 + S06/S16/S20. Physical and native round-trip validation pending.')
