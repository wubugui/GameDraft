"""Author C02, S04, S15 and S19 into the native content files.

Offline only. Do not rerun after later authors revise these same event graphs.
"""
from copy import deepcopy
from native_authoring import *

a = Author('owWater', '开放世界_水路', '桥下与河滩', 'post')
line, run, switch, choice, option = a.line, a.run, a.switch, a.choice, a.option
W, R, C, M = 'flow_ow_water', 'flow_ow_water_rig', 'flow_ow_water_clear', 'flow_ow_water_mark'
F, B, S = 'flow_ow_mooring', 'flow_ow_bucket', 'flow_ow_steps'
done = any_of(*(state(W, s, True) for s in ['done', 'repaired', 'diverted']))
repaired = state(W, 'repaired', True)
diverted = state(W, 'diverted', True)
cleared, rigged, marked = state(C, 'cleared', True), state(R, 'ready', True), state(M, 'marked', True)
stone = state('flow_ow_water_stone', 'seen', True)
observed = any_of(*(state('flow_ow_water_' + x, 'seen', True) for x in ['post', 'reed', 'stone']))
f_done, b_done, s_done = state(F, 'done', True), state(B, 'done', True), state(S, 'done', True)
graphs = read('data/narrative_graphs.json')
for comp in graphs['compositions']:
    if comp['mainGraph']['id'].startswith('flow_ow_'):
        for element in comp['elements']:
            if element.get('kind') == 'wrapperGraph':
                element.setdefault('meta', {'emits': [], 'reads': [], 'commands': []})
old = next(c for c in graphs['compositions'] if c['mainGraph']['id'] == W)
legacy_done = deepcopy(old['mainGraph']['states']['done'])
main = graph(W, '桥下倒走的水痕', {
    'initial': '尚未留意', 'accepted': '知道险口', 'ready': '已有依据，可选处理方法',
    'done': '旧存档：已经处理',
    'repaired': ('疏通并修好承重岸边', [take('ow_bamboo'), act('giveCurrency', amount=12)]),
    'diverted': ('封险口，留下高路标记', [act('giveCurrency', amount=5)]),
}, [transition('initial', 'accepted', sig) for sig in ['ow_water_accept', 'ow_water_post', 'ow_water_reed', 'ow_water_stone', 'ow_water_rig']] + [
    {'id': 'one_clue_is_enough', 'from': 'accepted', 'to': 'ready', 'trigger': 'reactive', 'signal': '__draft__', 'conditions': [observed]},
] + [transition(src, 'repaired', 'ow_water_repair', cleared, has('ow_bamboo')) for src in ['accepted', 'ready']]
  + [transition(src, 'diverted', 'ow_water_divert', marked) for src in ['accepted', 'ready']])
main['states']['done'] = legacy_done
elements = []
for i, (key, owner, label) in enumerate([('post', 'ow_water_post', '木桩回水'), ('reed', 'ow_water_reed', '芦苇挂物'), ('stone', 'ow_water_stone', '高处旧水线')]):
    elements.append(wrapper(graph('flow_ow_water_' + key, label, {'initial': '未辨认', 'seen': '已经辨认'},
        [transition('initial', 'seen', 'ow_water_' + key)], 'hotspot', owner), i * 300, 400))
elements += [
    wrapper(graph(R, '牢靠的牵引点', {'initial': '未系绳', 'ready': '缆绳系到完整石环'},
                  [transition('initial', 'ready', 'ow_water_rig', has('ow_rope'), neg(done))]), 0, 650),
    wrapper(graph(C, '卡在桥孔的货箱', {'initial': '箱角阻水', 'cleared': '实际捞出，低岸露出'},
                  [transition('initial', 'cleared', 'ow_water_pull_success', rigged, neg(done))], 'minigame', 'ow_bridge_clear'), 320, 650),
    wrapper(graph(M, '高处改道记号', {'initial': '尚无记号', 'marked': ('炭线标出高路', [take('ow_charcoal')])},
                  [transition('initial', 'marked', 'ow_water_mark', stone, has('ow_charcoal'), neg(done))]), 640, 650),
]
upsert(graphs['compositions'], composition(main, 'C02：疏通修岸或标记改道；单处线索即可跟进；捞取亲手完成。', elements))
upsert(graphs['compositions'], composition(graph(F, '缆绳少一扣', {
    'initial': '尚未留意', 'accepted': '知道缺扣', 'carrying': ('拾起尚可用的绳尾', [give('ow_rope_tail')]),
    'fixed': ('短绳补上系缆扣', [take('ow_rope_tail')]),
    'done': ('钱叔换出一截旧缆绳', [give('ow_rope')]),
}, [transition('initial', 'accepted', 'ow_mooring_accept'),
    *[transition(src, 'carrying', 'ow_rope_tail_take') for src in ['initial', 'accepted']],
    transition('carrying', 'fixed', 'ow_mooring_fix', has('ow_rope_tail')),
    transition('fixed', 'done', 'ow_mooring_return')]), 'S04：先找到短绳或先发现缺扣；修好后换取完整工具。'))
upsert(graphs['compositions'], composition(graph(B, '河边落下的木桶', {
    'initial': '尚未听说', 'accepted': '知道木桶挂在芦根',
    'carrying': ('从浅水实际捞起木桶', [give('ow_bucket')]),
    'done': ('何婆婆把木桶借给你', [give('ow_cloth', 2)]),
}, [transition('initial', 'accepted', 'ow_bucket_accept'),
    *[transition(src, 'carrying', 'ow_bucket_pull_success') for src in ['initial', 'accepted']],
    transition('carrying', 'done', 'ow_bucket_return', has('ow_bucket'))]), 'S15：水中真实拉扯；告知失主后借用，取得布条。'))
upsert(graphs['compositions'], composition(graph(S, '石阶上的青苔', {
    'initial': '尚未注意', 'accepted': '蹲看发现落脚处发滑',
    'done': ('用水和薄篾清出落脚处', [take('ow_bamboo')]),
}, [transition('initial', 'accepted', 'ow_steps_inspect'),
    transition('accepted', 'done', 'ow_steps_clean', has('ow_bucket'), has('ow_bamboo'))]), 'S19：查看青苔、现场用水与薄篾；高阶可以负重通行。'))

# Bridge entry: the clue and the work live at the same physical fixture.
switch('post', [(repaired, 'post_repaired'), (diverted, 'post_diverted'), (state(W, 'done'), 'post_legacy'), (cleared, 'post_clear')], 'post_first')
line('post_first', '桥孔边卡着一只散货箱，水打过箱角又倒卷回来。旁边的木桩朽了，岸石上还有一只完整石环。', 'post_seen')
run('post_seen', [emit('ow_water_post')], 'post_menu')
choice('post_menu',
    option('water_rig_choice', '把缆绳系到石环上', 'rig', all_of(has('ow_rope'), neg(rigged)), '需要完整缆绳。周三可借，钱叔有换绳的活，罗伯也卖。'),
    option('water_pull_choice', '牵住绳子，捞出卡水的箱子', 'pull', rigged, '先把缆绳系到石环，别拿烂木桩吃力。'),
    option('water_divert_choice', '封住险口，让人按炭线改道', 'divert_confirm', marked, '先到山口旧水线，用炭条标出高处回城方向。'),
    option('water_other_choice', '先找高处回城的路', 'other_route'),
    option('water_leave_choice', '先离开水边', 'end'))
line('other_route', '河滩石阶通回街上，山口旧水线能判断哪段没泡过。先留下标记，再回来挡住这条险口。')
run('rig', [emit('ow_water_rig')], 'rig_result')
line('rig_result', '绳头穿过完整石环，另一头兜住露出水面的箱角。系牢了，箱子仍得你自己牵出来。', 'post_menu')
run('pull', [act('startWaterMinigame', id='ow_bridge_clear')])
line('post_clear', '箱子已拖上岸。水不再顶着桥孔倒卷，低岸边的横档却裂了；一片薄篾能把松开的接头箍住。', 'post_clear_menu')
choice('post_clear_menu',
    option('water_repair_choice', '用一片薄篾箍紧横档（低岸可负重）', 'repair', has('ow_bamboo'), '需要一片薄篾。可归还罗伯的篾刀取得，或找他买。'),
    option('water_clear_divert', '仍封住低岸，按高路标记走', 'divert_confirm', marked, '先在山口旧水线留下炭记。'),
    option('water_clear_leave', '回去拿材料', 'end'))
run('repair', [emit('ow_water_repair')], 'post_repaired')
line('post_repaired', '横档箍紧了，踩下去不再晃。低岸可以负重通行；钱叔留下十二文工钱，夜里回码头看船。')
line('divert_confirm', '这样省下修岸的薄篾，但低岸仍不能负重通过。钱叔会守到入夜，之后回码头；重东西须从河滩高阶上街。', 'divert_menu')
choice('divert_menu', option('divert_yes', '把旧横木挡在险口，留下改道标记', 'divert'), option('divert_no', '再想一哈', 'end'))
run('divert', [emit('ow_water_divert')], 'post_diverted')
line('post_diverted', '旧横木横在险口，炭记指向河滩高阶。钱叔付了五文；低岸还承不住重东西。')
line('post_legacy', '钱叔早已收起这段坏跳板。旧事已经结清，负重回城仍要走河滩高阶。')

# A separate water entry lets a small favour introduce the same hand control.
switch('reed', [(any_of(state(B, 'carrying'), b_done), 'reed_after')], 'reed_first')
line('reed_first', '芦苇被压得倒向桥孔。一只木桶挂在浅处，桶把还露在水上；比桥孔里那只沉箱轻得多。', 'reed_seen')
run('reed_seen', [emit('ow_water_reed'), emit('ow_bucket_accept')], 'reed_menu')
choice('reed_menu', option('bucket_pull_choice', '抓住桶把，把木桶牵回来', 'bucket_pull'), option('reed_leave', '先不下手', 'end'))
run('bucket_pull', [act('startWaterMinigame', id='ow_river_bucket')])
line('reed_after', '木桶已不在芦根里。水仍沿着倒伏的苇秆流向桥孔。', 'reed_after_emit')
run('reed_after_emit', [emit('ow_water_reed')])

switch('stone', [(marked, 'stone_marked'), (done, 'stone_done'), ({'posture': 'gaze'}, 'stone_seen')], 'stone_hint')
line('stone_hint', '石上深浅两道水线挨得近。停下来注视（按住 X），才能分清新泥和旧苔。')
line('stone_seen', '新泥只到下面那道，通街的高阶没被这一涨水淹过。炭记应当顺着高阶朝街上指，不能朝桥孔画。', 'stone_emit')
run('stone_emit', [emit('ow_water_stone')], 'stone_menu')
choice('stone_menu', option('mark_high_route', '用一支炭标向高阶', 'mark', has('ow_charcoal'), '需要一支炭条，罗伯处可买，找回篾刀也能取得。'),
       option('stone_leave', '先记在心里', 'end'))
run('mark', [emit('ow_water_mark')], 'stone_marked')
line('stone_marked', '炭线指向河滩高阶。桥头险口还须有人拦好，路人才不会顺着旧跳板下去。')
line('stone_done', '高处旧水线还在。河滩高阶朝街上，桥下低岸是否能承重，要看横档有没有修好。')

# Mooring: body action obtains a real piece of rope, then use it at the target.
switch('tail', [(any_of(state(F, 'carrying', True), f_done), 'tail_empty'), ({'posture': 'crouch'}, 'tail_found')], 'tail_hint')
line('tail_hint', '废缆卷下露着半截没泡烂的绳尾。蹲下（按住 C）才够得着里面那一截。')
line('tail_found', '你从缆卷底抽出短绳。长不够捞重物，补一只系缆扣倒合适。', 'tail_take')
run('tail_take', [emit('ow_rope_tail_take')])
line('tail_empty', '能用的短绳已经取走，只剩松散的麻絮。')
switch('mooring', [(f_done, 'mooring_done'), (state(F, 'fixed'), 'mooring_fixed')], 'mooring_first')
line('mooring_first', '钱叔船头的系缆扣少了一截。拿整条长绳塞进去太粗，找一截短绳补扣就够。', 'mooring_accept')
run('mooring_accept', [emit('ow_mooring_accept')], 'mooring_menu')
choice('mooring_menu', option('mooring_use', '把短绳穿过缺口，补好系缆扣', 'mooring_fix', has('ow_rope_tail'), '短绳在码头废缆卷底下，蹲下能抽出来。'),
       option('mooring_leave', '去找短绳', 'end'))
run('mooring_fix', [emit('ow_mooring_fix')], 'mooring_fixed')
line('mooring_fixed', '短绳穿过两只旧孔，绷住了松动的缆扣。找钱叔说一声，他答应用一截完整旧缆绳换这个活。')
line('mooring_done', '补上的短绳仍绷着。钱叔换出的长缆绳在你手里，能反复用来系牢牵引点。')

switch('qian', [(repaired, 'qian_repaired'), (diverted, 'qian_diverted'), (state(W, 'done'), 'qian_legacy')], 'qian_before')
line('qian_before', '桥孔那只箱子把水顶回来了。我守得住一晚，守不住天天。你要动它，先系完整石环；不动也成，得给人留条明白的高路。', 'qian_accept', '钱叔')
run('qian_accept', [emit('ow_water_accept')], 'qian_menu')
line('qian_repaired', '水走顺了，横档也稳。夜里我回码头看船，桥口不用再蹲个人。', 'qian_menu', '钱叔')
line('qian_diverted', '险口挡好了。我守到八点，认清炭记的人多了，就回码头。背重东西走河滩高阶，青苔要先清。', 'qian_menu', '钱叔')
line('qian_legacy', '坏跳板早已收了。重东西走河滩高阶，我夜里还是回码头。', 'qian_menu', '钱叔')
choice('qian_menu', option('qian_mooring', '你船头少的那只扣……', 'qian_mooring_case'),
       option('qian_water_work', '桥孔和高路，具体在哪点？', 'qian_directions'),
       option('qian_time', '夜里到哪点找你？', 'qian_time_case'), option('qian_bye_water', '你忙，我走了', 'end'))
switch('qian_mooring_case', [(f_done, 'qian_rope_done'), (state(F, 'fixed'), 'qian_rope_reward')], 'qian_rope_offer')
line('qian_rope_offer', '码头废缆卷下还有截短绳，没泡烂。你拿它补我船头的扣，我换条完整旧缆绳给你。', 'qian_rope_accept', '钱叔')
run('qian_rope_accept', [emit('ow_mooring_accept')])
line('qian_rope_reward', '扣补得紧。这条长的你拿去，别拿短麻絮往水里硬拽。', 'qian_rope_give', '钱叔')
run('qian_rope_give', [emit('ow_mooring_return')])
line('qian_rope_done', '长绳已经换给你了，补在船上的短绳我留着用。', 'end', '钱叔')
line('qian_directions', '桥下靠河滩那头，旧木桩旁就是箱子。顺河上山看岔路石水线；想走高路，就从河滩石阶上街。', 'end', '钱叔')
switch('qian_time_case', [(any_of(repaired, state(W, 'done')), 'qian_time_dock'), (diverted, 'qian_time_divert')], 'qian_time_watch')
line('qian_time_dock', '白天夜里都在码头。水口处理好了，我能安心看船。', 'end', '钱叔')
line('qian_time_divert', '白天码头，傍晚守桥，八点过后回码头。标记刚留下，总得等人认得路。', 'end', '钱叔')
line('qian_time_watch', '白天在码头，六点以后到桥口守险处。水口一天没处理，我就得多守一晚。', 'end', '钱叔')

switch('bucket_he', [(b_done, 'he_bucket_done'), (state(B, 'carrying'), 'he_bucket_return')], 'he_bucket_offer')
line('he_bucket_offer', '我的小木桶滑到芦根里去了。浅处够得着，抓桶把，莫去扯那团水草。', 'he_bucket_accept', '何婆婆')
run('he_bucket_accept', [emit('ow_bucket_accept')])
line('he_bucket_return', '捞起来就好。我这边还有大桶，小的先借你用；这两根干净布条也拿着。用完别把脏水往我洗衣石上倒。', 'he_bucket_reward', '何婆婆')
run('he_bucket_reward', [emit('ow_bucket_return')])
line('he_bucket_done', '木桶你先用着。上街那段青苔拿水浇湿、薄篾刮开，背重物才落得稳脚。', 'end', '何婆婆')

switch('steps', [(s_done, 'steps_cleaned'), ({'posture': 'crouch'}, 'steps_inspected')], 'steps_hint')
line('steps_hint', '石阶边沿泛着一层湿亮，站着像是水。蹲下（按住 C）看看落脚处。')
line('steps_inspected', '是贴在石面的薄青苔，鞋底一拧就滑。先用桶盛水浇开，再拿一片薄篾刮出落脚面。', 'steps_seen')
run('steps_seen', [emit('ow_steps_inspect')], 'steps_menu')
choice('steps_menu', option('steps_clean_choice', '用木桶浇水，薄篾刮开青苔', 'steps_clean', all_of(has('ow_bucket'), has('ow_bamboo')), '需要木桶和一片薄篾。河边可捞桶，罗伯有薄篾。'),
       option('steps_leave', '先准备东西', 'end'))
run('steps_clean', [emit('ow_steps_clean')], 'steps_cleaned')
line('steps_cleaned', '落脚的几级露出粗石面，脏水流回河里。薄篾刮裂了，木桶还好；这段高阶现在能负重上街。')

# Explicit route feedback, including carry restrictions, stays in native graphs.
switch('low_route', [(all_of({'plane': '背尸'}, neg(repaired)), 'low_blocked')], 'low_travel')
line('low_blocked', '低岸横档还承不住这个重量。修好桥下横档才能从这里负重过去；也可回码头上街。')
run('low_travel', [act('switchScene', targetScene='河边', targetSpawnPoint='ow_from_bridge')])
switch('high_route', [(all_of({'plane': '背尸'}, neg(s_done)), 'high_blocked')], 'high_travel')
line('high_blocked', '背着东西踩这层青苔会滑。得先放下重物，用木桶和薄篾清出落脚处。')
run('high_travel', [act('switchScene', targetScene='雾津街头', targetSpawnPoint='from_river')])

# Reuse the actual water simulation, with persistent targets and retryable failure.
base = read('data/water_minigames/dock_crate_tutorial.json')
crate = deepcopy(next(e for e in base['entities'] if e['id'] == 'crate_target'))
crate.update(id='wedged_crate', valueTier='normal', cue=a.text('crate_cue', '顶住回水的箱角'),
             displaySize=108, hitRadius=60, depth=0.48, pos={'x': 430, 'y': 305},
             onPullSuccess=[emit('ow_water_pull_success'), act('showNotification', text=a.text('crate_success', '箱子上岸了。退出水面，到旧木桩边修好横档。'), type='success')],
             onPullFail=[act('showNotification', text=a.text('crate_fail', '箱角滑脱了，岸上的绳结没散。可以再试，或先退出水面。'), type='info')])
crate['pull'] = {'zoneSize': 0.27, 'sliderSpeed': 0.59, 'rhythm': 'heavy_sink', 'failurePolicy': 'slip', 'timeLimitSec': 24}
water = deepcopy(base)
water.update(id='ow_bridge_clear', label='桥孔捞出阻水箱', spotId='ow_bridge_work', entities=[deepcopy(base['entities'][0]), crate])
water['entities'][0]['hint'] = a.text('bridge_grass', '苇根贴着岸。要牵的是右边露角的箱子。')
write('data/water_minigames/ow_bridge_clear.json', water)
bucket = deepcopy(crate)
bucket.update(id='laundry_bucket', category='sunken', sprite='/resources/runtime/images/minigames/water/ow_wooden_bucket.png',
              displaySize=90, hitRadius=65, depth=0.2, pos={'x': 350, 'y': 260},
              cue=a.text('bucket_cue', '挂在芦根的木桶把'),
              pull={'zoneSize': 0.36, 'sliderSpeed': 0.4, 'rhythm': 'stable', 'failurePolicy': 'slip', 'timeLimitSec': 24},
              onPullSuccess=[emit('ow_bucket_pull_success'), act('showNotification', text=a.text('bucket_success', '木桶捞起来了。退出水面，找何婆婆说明。'), type='success')],
              onPullFail=[act('showNotification', text=a.text('bucket_fail', '桶把滑了，又挂回芦根。还能再试。'), type='info')])
water2 = deepcopy(water)
water2.update(id='ow_river_bucket', label='河滩捞木桶', spotId='ow_river_shallow', entities=[deepcopy(base['entities'][0]), bucket])
water2['waterBottom']['texture'] = '/resources/runtime/images/minigames/water/riverbed_wild_morning.png'
water2['surface']['location'] = 'wild'
water2['entities'][0]['hint'] = a.text('bucket_grass', '木桶挂在芦根旁，桶把还露着。')
write('data/water_minigames/ow_river_bucket.json', water2)
index = read('data/water_minigames/index.json')
for w in [water, water2]: upsert(index, {'id': w['id'], 'label': w['label'], 'file': w['id'] + '.json'})

items = read('data/items.json')
for iid, title, kind, stack, description in [
    ('ow_rope_tail', '还结实的短绳', 'key', 1, '从码头废缆卷底抽出的短绳。长不够牵重物，可以补船头系缆扣。'),
    ('ow_bucket', '何婆婆的小木桶', 'key', 1, '从河边芦根捞起。何婆婆在河边或后巷洗衣；借用后可在河边高阶盛水清苔，木桶不会耗掉。'),
    ('ow_cloth', '干净布条', 'consumable', 10, '何婆婆从旧衣里拆出的干净布条。可做绑带或包护脆弱的物件。'),
]:
    row = {'id': iid, 'name': a.text(iid + '_name', title), 'type': kind, 'maxStack': stack, 'description': a.text(iid + '_desc', description)}
    if iid == 'ow_bucket': row['icon'] = '/resources/runtime/images/minigames/water/ow_wooden_bucket.png'
    upsert(items, row)
shops = read('data/shops.json')
shop = next(s for s in shops if s['id'] == 'ow_luo_supplies')
if not any(i['itemId'] == 'ow_rope' for i in shop['items']): shop['items'].append({'itemId': 'ow_rope', 'price': 8})

schedule_data = read('data/npc_schedules.json')
qian = next(s for s in schedule_data['schedules'] if s['characterId'] == 'ow_qian')
night_home = any_of(repaired, state(W, 'done'))
qian['entries'] = [
    {'from': '07:00', 'to': '18:00', 'scene': '码头白天'},
    {'from': '18:00', 'to': '07:00', 'scene': '码头白天', 'conditions': [night_home]},
    {'from': '18:00', 'to': '20:00', 'scene': 'bridge_underpass', 'conditions': [diverted]},
    {'from': '20:00', 'to': '07:00', 'scene': '码头白天', 'conditions': [diverted]},
    {'from': '18:00', 'to': '07:00', 'scene': 'bridge_underpass', 'conditions': [neg(done)]},
]
schedules = schedule_data['schedules']
npc_guide = lambda npc: a.npc_guidance(npc, schedules)
obj = a.objective
quests = read('data/quests.json')
upsert(quests, a.quest('ow_water', '桥下倒走的水痕', '卡水的货箱与发松的横档，让低岸成了险口。可以捞箱修岸，也可以标出高路、封住低岸；不需要把三处线索看齐。', neg(state(W, 'initial')), done, [
    obj('water_decide', '到桥头旧木桩，判断如何处理险口', any_of(cleared, marked, done), marker('bridge_underpass', 'hotspot', 'ow_water_post'), all_of(neg(cleared), neg(marked))),
    obj('water_repair_finish', '在桥头用薄篾修好横档，或选择改道', done, marker('bridge_underpass', 'hotspot', 'ow_water_post'), cleared),
    obj('water_divert_finish', '回桥头封住险口，让人按炭线改道', done, marker('bridge_underpass', 'hotspot', 'ow_water_post'), marked),
    obj('water_rope_source', '准备完整缆绳：借、修扣换取或购买', rigged, npc_guide('ow_qian'), all_of(neg(done), neg(rigged), neg(has('ow_rope'))), True),
    obj('water_rig_obj', '把缆绳系牢，再亲手捞出阻水箱', cleared, marker('bridge_underpass', 'hotspot', 'ow_water_post'), all_of(has('ow_rope'), neg(done)), True),
    obj('water_bamboo_obj', '找罗伯取得一片薄篾，回桥头修岸', done, npc_guide('ow_luo'), all_of(cleared, neg(has('ow_bamboo')), neg(done)), True),
    obj('water_high_obj', '另一办法：注视山口水线，用炭标高路', marked, marker('mountain_pass', 'hotspot', 'ow_water_stone'), neg(done), True),
]))
upsert(quests, a.quest('ow_mooring', '缆绳少一扣', '钱叔的船头系缆扣缺一截短绳。补好后可以换完整缆绳，不必先解决周三的工钱。', neg(state(F, 'initial')), f_done, [
    obj('mooring_tail_obj', '蹲取码头废缆卷下的短绳', state(F, 'carrying', True), marker('码头白天', 'hotspot', 'ow_rope_tail')),
    obj('mooring_fix_obj', '在船头系缆处使用短绳', state(F, 'fixed', True), marker('码头白天', 'hotspot', 'ow_mooring'), state(F, 'carrying', True)),
    obj('mooring_return_obj', '找钱叔换取完整旧缆绳', f_done, npc_guide('ow_qian'), state(F, 'fixed', True)),
]))
upsert(quests, a.quest('ow_bucket', '河边落下的木桶', '小木桶挂在河滩浅处的芦根。牵回木桶，告诉何婆婆。', neg(state(B, 'initial')), b_done, [
    obj('bucket_pull_obj', '在河滩芦根亲手捞回木桶', state(B, 'carrying', True), marker('河边', 'hotspot', 'ow_water_reed')),
    obj('bucket_return_obj', '找何婆婆说明木桶已经捞起', b_done, npc_guide('ow_he'), state(B, 'carrying', True)),
]))
upsert(quests, a.quest('ow_steps', '石阶上的青苔', '高阶能上街，但湿苔让负重的人落不稳脚。木桶浇水，薄篾刮苔。', neg(state(S, 'initial')), s_done, [
    obj('steps_bucket_obj', '准备木桶：河滩芦根能捞到', has('ow_bucket'), marker('河边', 'hotspot', 'ow_water_reed'), neg(has('ow_bucket')), True),
    obj('steps_bamboo_obj', '准备一片薄篾：罗伯处可取得', has('ow_bamboo'), npc_guide('ow_luo'), neg(has('ow_bamboo')), True),
    obj('steps_clean_obj', '在河边高阶使用木桶和薄篾', s_done, marker('河边', 'hotspot', 'ow_steps')),
]))

# Existing IDs and geometry remain; only their native interactions change.
bridge, river, dock, mountain = [read('scenes/' + s + '.json') for s in ['bridge_underpass', '河边', '码头白天', 'mountain_pass']]
for sc, hid, entry in [(bridge, 'ow_water_post', 'post'), (river, 'ow_water_reed', 'reed'), (mountain, 'ow_water_stone', 'stone')]:
    h = next(h for h in sc['hotspots'] if h['id'] == hid)
    h['data'] = {'graphId': a.dg['id'], 'entry': entry}
    h.pop('conditions', None); h.pop('conditionHidesEntity', None)
for sc, hid, entry, enabled, target, spawn in [
    (bridge, 'new_hotspot_1', 'low_blocked', repaired, '河边', 'ow_from_bridge'),
    (river, 'T回城', 'high_blocked', s_done, '雾津街头', 'from_river'),
]:
    h = next(h for h in sc['hotspots'] if h['id'] == hid)
    h.update(type='transition', planes=['normal', '背尸'],
             conditions=[any_of(neg({'plane': '背尸'}), enabled)], conditionHidesEntity=True,
             data={'targetScene': target, 'targetSpawnPoint': spawn})
    # Preserve the native exit identity for map/route readers. Only a blocked
    # carrier sees the explanatory inspect point at that same physical entrance.
    upsert(sc['hotspots'], a.hotspot('ow_' + entry, '负重通路尚未处理', h['x'], h['y'], entry,
                                   [neg(enabled)], ['背尸'], size=h['interactionRange']))
for key in ['low_route', 'low_travel', 'high_route', 'high_travel']:
    del a.nodes[key]
upsert(dock['hotspots'], a.hotspot('ow_rope_tail', '废缆卷底下', 1350, 1090, 'tail', size=60))
upsert(dock['hotspots'], a.hotspot('ow_mooring', '船头系缆扣', 1845, 1080, 'mooring', size=70))
upsert(river['hotspots'], a.hotspot('ow_steps', '高阶上的湿苔', 160, 215, 'steps', size=65))

# Keep external entry IDs stable and use the native deferred dialogue handoff.
street = read('dialogues/graphs/开放世界_街坊.json')
sn = street['nodes']
for key in list(sn):
    if key.startswith(('qian_', 'water_')) or key == 'qian':
        del sn[key]
for entry, target in [('qian', 'qian')]:
    sn[entry] = {'type': 'runActions', 'actions': [act('startDialogueGraph', graphId=a.dg['id'], entry=target)], 'next': 'end'}
# He retains her existing daily conversation and gains one concrete topic.
he_menu = sn['he_menu']
assert he_menu['type'] == 'choice'
he_menu['options'] = [o for o in he_menu['options'] if o['id'] != 'he_bucket_topic']
he_menu['options'].insert(0, {'id': 'he_bucket_topic', 'text': a.text('he_bucket_topic', '芦根挂着的木桶是你的不？'), 'next': 'he_bucket_handoff'})
sn['he_bucket_handoff'] = {'type': 'runActions', 'actions': [act('startDialogueGraph', graphId=a.dg['id'], entry='bucket_he')], 'next': 'end'}

# Signals are authored in their owning action trees; this list only labels them.
signals = set()
def collect(value):
    if isinstance(value, dict):
        if value.get('type') == 'emitNarrativeSignal': signals.add(value['params']['signal'])
        for v in value.values(): collect(v)
    elif isinstance(value, list):
        for v in value: collect(v)
for source in [a.dg, water, water2]: collect(source)
a.strings['waterMinigame']['pullSlip'] = '[脱手] 滑回原处了。点中它，可以重新牵。'
# Explicitly resuming work restores its guide after another favour finished.
# This is UI focus only; progress still belongs to the native state graph.
for entry, qid in [
    ('post_seen', 'ow_water'), ('rig', 'ow_water'), ('pull', 'ow_water'),
    ('stone_emit', 'ow_water'), ('mark', 'ow_water'), ('qian_accept', 'ow_water'),
    ('reed_seen', 'ow_bucket'), ('bucket_pull', 'ow_bucket'),
    ('mooring_accept', 'ow_mooring'), ('qian_rope_accept', 'ow_mooring'),
    ('steps_seen', 'ow_steps'),
]:
    focus = act('setFocusedQuest', id=qid)
    if entry in ['pull', 'bucket_pull']:
        a.nodes[entry]['actions'].insert(0, focus)
    else:
        a.nodes[entry]['actions'].append(focus)
for sig in sorted(signals):
    if not any(s['id'] == sig for s in graphs['signals']): graphs['signals'].append({'id': sig, 'label': sig})

for path, value in [('data/narrative_graphs.json', graphs), ('data/quests.json', quests), ('data/items.json', items),
                    ('data/shops.json', shops), ('data/strings.json', a.strings), ('data/npc_schedules.json', schedule_data),
                    ('data/water_minigames/index.json', index), ('dialogues/graphs/开放世界_水路.json', a.dg),
                    ('dialogues/graphs/开放世界_街坊.json', street), ('scenes/bridge_underpass.json', bridge),
                    ('scenes/河边.json', river), ('scenes/码头白天.json', dock), ('scenes/mountain_pass.json', mountain)]:
    write(path, value)
print('Authored C02 + S04/S15/S19. Requires art, round-trip, causal tests and actual input acceptance.')
