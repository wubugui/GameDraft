"""Offline native authoring: C03 shore coat, S05 needle, S18 basket binding.

Do not rerun after later revisions to these same events or NPC topics.
"""
from native_authoring import *

a = Author('owCloth', '开放世界_认衣', '河滩认衣与浣衣人的活计', 'coat')
line, run, switch, choice, option = a.line, a.run, a.switch, a.choice, a.option
G, P, O, D = 'flow_ow_coat', 'flow_ow_coat_patch', 'flow_ow_coat_oil', 'flow_ow_coat_borrower'
N, H = 'flow_ow_needle', 'flow_ow_binding'
returned, mended = state(G, 'returned', True), state(G, 'mended', True)
done = any_of(returned, mended)
removed = any_of(state(G, 'carrying'), done)
patch, oil, borrower = state(P, 'seen', True), state(O, 'sampled', True), state(D, 'told', True)
known_account = any_of(*(state('flow_ow_tally', s, True) for s in ['fair', 'witness', 'done']))
proof = any_of(oil, all_of(patch, known_account), borrower)
needle_done, binding_done = state(N, 'done', True), state(H, 'done', True)
ng = read('data/narrative_graphs.json')
main = graph(G, '河滩认衣', {
    'initial': '尚未留意', 'accepted': '一件衣裳不能认定一个人',
    'carrying': ('保留原状，带去当面核对', [give('ow_work_coat')]),
    'returned': ('如实交还，借衣人补做晚工', [take('ow_work_coat'), give('ow_coat_record'), act('giveCurrency', amount=6)]),
    'mended': ('洗补后交还，不追借衣人的失手', [take('ow_cloth'), give('ow_shoulder_pad')]),
}, [transition('initial', 'accepted', s) for s in ['ow_coat_accept', 'ow_coat_patch', 'ow_coat_borrower', 'ow_coat_oil']] + [
    transition('accepted', 'carrying', 'ow_coat_keep', proof),
    transition('carrying', 'returned', 'ow_coat_return', has('ow_work_coat')),
    transition('accepted', 'mended', 'ow_coat_mend', borrower, has('ow_bucket'), has('ow_cloth')),
])
elements = [
    wrapper(graph(P, '补丁上两道长针脚', {'initial': '未看清', 'seen': '看清补丁长针脚'},
                  [transition('initial', 'seen', 'ow_coat_patch', neg(removed))], 'minigame', 'ow_shore_coat'), 0, 450),
    wrapper(graph(O, '袖口留下的船用桐油', {'initial': '未辨认', 'sampled': ('用布吸出油迹', [take('ow_cloth')])},
                  [transition('initial', 'sampled', 'ow_coat_oil', has('ow_cloth'), neg(removed))]), 300, 450),
    wrapper(graph(D, '借衣人说明失手', {'initial': '未问过', 'told': '邓幺承认用借衣垫船板'},
                  [transition('initial', 'told', 'ow_coat_borrower', neg(done))]), 600, 450),
]
upsert(ng['compositions'], composition(main, 'C03：保留借衣痕迹核账，或听借衣人解释后用水与布洗补；拒绝以衣认尸。', elements))
upsert(ng['compositions'], composition(graph(N, '浣衣石下的针', {
    'initial': '未听说', 'accepted': '知道针掉进石缝',
    'carrying': ('蹲下拣出旧针', [give('ow_needle')]),
    'done': ('把针还给何婆婆', [take('ow_needle'), give('ow_cloth')]),
}, [transition('initial', 'accepted', 'ow_needle_accept'),
    *[transition(s, 'carrying', 'ow_needle_take') for s in ['initial', 'accepted']],
    transition('carrying', 'done', 'ow_needle_return', has('ow_needle'))]), 'S05：蹲下辨认石缝反光，归还缝补用针。'))
upsert(ng['compositions'], composition(graph(H, '黄婶缺的绑带', {
    'initial': '未留意', 'accepted': '药篓提梁勒手',
    'done': ('布条包牢提梁磨手处', [take('ow_cloth'), give('mugwort', 3)]),
}, [transition('initial', 'accepted', 'ow_binding_accept'),
    transition('accepted', 'done', 'ow_binding_wrap', has('ow_cloth'))]), 'S18：当面给药篓包布，得到艾草与山口采找线索。'))

switch('coat', [(returned, 'coat_gone_returned'), (mended, 'coat_gone_mended'), (state(G, 'carrying'), 'coat_gone_carried')], 'coat_first')
line('coat_first', '浣衣石上摊着一件湿工衣。补丁露着两道长针脚，袖口油黑，衣摆只有一道浅水痕。没有人在里面。', 'coat_accept')
run('coat_accept', [emit('ow_coat_accept'), act('setFocusedQuest', id='ow_coat')], 'coat_menu')
choice('coat_menu', option('coat_look', '摊近些，细看补丁与袖口', 'coat_examine'),
    option('coat_keep_choice', '保留原状，带给周三当面核对', 'coat_keep_confirm', proof, '先辨明袖口油迹，或拿补丁问借衣人；核过工票的人也认识周三这块补丁。'),
    option('coat_mend_choice', '用木桶浇洗，再拿布补好袖口', 'coat_mend_confirm', all_of(borrower, has('ow_bucket'), has('ow_cloth')), '先听邓幺说明衣物来路，再准备木桶与一条布料。'),
    option('coat_ask_choice', '先问问借衣的人', 'coat_directions'), option('coat_leave', '先放在石上', 'end'))
run('coat_examine', [act('startObjectExamine', id='ow_shore_coat')], 'coat_after_examine')
switch('coat_after_examine', [(oil, 'coat_oil_result'), (all_of(patch, known_account), 'coat_known_patch'), (patch, 'coat_patch_result')], 'coat_menu')
line('coat_oil_result', '布上吸出的是黏稠桐油，水珠另凝在旁边。这袖口垫过上油的船板；湿衣出现在河边，并不能证明它从死人子身上脱下来。', 'coat_menu')
line('coat_known_patch', '你核过周三的工票，记得他肩上这块两针长补丁。衣裳是他的，穿衣过河的是谁还得问本人。', 'coat_menu')
line('coat_patch_result', '两针长补丁算得上一条认物的依据。何婆婆认针脚，邓幺跑码头，都能问；不必再把每一道污痕看齐。', 'coat_menu')
line('coat_directions', '何婆婆上午在河滩浣衣，午后进后巷收补衣。邓幺白天跑街头和码头，晚上是否留下做工，要看他欠下哪件事。')
line('coat_keep_confirm', '不洗水痕、不盖油迹，把衣物和经过一并交给周三。他能当面核对借衣的损耗，邓幺得留下补做晚工；你会得到六文与一份认物记录。', 'coat_keep_menu')
choice('coat_keep_menu', option('coat_keep_yes', '卷好带走，照实说', 'coat_take'), option('coat_keep_no', '先不动', 'coat_menu'))
run('coat_take', [emit('ow_coat_keep')], 'coat_gone_carried')
line('coat_gone_carried', '工衣已经卷在囊里。找周三当面核对；不要拿它替水里的人认名字。')
line('coat_mend_confirm', '邓幺借衣垫船板时失了手，怕的是赔不起。你花一条布，借木桶洗补，何婆婆替他交回；水痕与油迹会消失，之后不能再走原状核对这一路。不发工钱，换一块旧肩垫。', 'coat_mend_menu')
choice('coat_mend_menu', option('coat_mend_yes', '浇水去污，用布补牢磨破的袖口', 'coat_mend'), option('coat_mend_no', '留下原状再想想', 'coat_menu'))
run('coat_mend', [emit('ow_coat_mend')], 'coat_gone_mended')
line('coat_gone_mended', '衣物洗补好，留在何婆婆交回的衣堆里。她把一块旧肩垫放进你的囊：背重物时先垫住磨肩处。木桶仍归你借用。')
line('coat_gone_returned', '工衣已交还，石上只留一道干水印。邓幺傍晚在码头补工；他之后换班回来，也记得你照实说过这件事。')

switch('zhou_coat', [(returned, 'zhou_coat_after'), (mended, 'zhou_coat_mended'), (state(G, 'carrying'), 'zhou_coat_return')], 'zhou_coat_before')
line('zhou_coat_before', '我那件旧衣裳借给邓幺了，两针长补丁，一眼认得。你若在水边见着，先问他，衣裳能借，人不能凭衣裳瞎认。', 'zhou_coat_accept', '周三')
run('zhou_coat_accept', [emit('ow_coat_accept'), act('setFocusedQuest', id='ow_coat')])
line('zhou_coat_return', '是我的。袖口这油，是拿去垫船板了。衣裳我收回，六文拿着；邓幺夜里到码头补这趟活。认物的经过我写在旧布签上，往后莫光凭一件衣裳认人。', 'zhou_coat_finish', '周三')
run('zhou_coat_finish', [emit('ow_coat_return')])
line('zhou_coat_after', '邓幺傍晚在码头补活，到八点才歇。你有话要带给他，照这个时候找。', npc='周三')
line('zhou_coat_mended', '何婆婆把衣裳送回来了，袖口补得细。我晓得是借出去那件，不追他这一回失手了。', npc='周三')
switch('deng_coat', [(returned, 'deng_coat_after'), (mended, 'deng_coat_mended')], 'deng_coat_before')
line('deng_coat_before', '衣裳是周三借我的。我拿袖子垫了一哈漏油的船板，没抓稳，掉河里了。人没掉！你要照实说，我补工；肯替我洗补，我记得这个忙。', 'deng_coat_told', '邓幺')
run('deng_coat_told', [emit('ow_coat_borrower'), act('setFocusedQuest', id='ow_coat')])
line('deng_coat_after', '这晚要在码头补活。衣裳确实是我糟蹋的，认；但莫再说水里那件就是谁的寿衣。', npc='邓幺')
line('deng_coat_mended', '袖口补好了，周三没追这回失手。傍晚我照旧进后巷交脚程，不用在码头耗到黑。', npc='邓幺')
switch('he_coat', [(returned, 'he_coat_returned'), (mended, 'he_coat_mended')], 'he_coat_before')
line('he_coat_before', '石上那件是周三借出去的工衣，我补过。袖口黏的是船板桐油，你拿干布吸一哈就分得开。要洗，先听邓幺把经过说清楚；水一浇，原来的痕就没了。', 'he_coat_menu', '何婆婆')
choice('he_coat_menu', option('he_coat_start', '我去石上看看', 'he_coat_accept'),
    option('he_needle_topic', '缝补用的针在哪点？', 'he_needle'), option('he_cloth_shop', '买些干净布料', 'he_shop'), option('he_coat_bye', '先不动衣物', 'end'))
run('he_coat_accept', [emit('ow_coat_accept'), act('setFocusedQuest', id='ow_coat')])
line('he_coat_returned', '认清衣裳，和认清一个死人子，是两码事。你把经过留下了，往后遇到湿衣，先问是不是借的。', npc='何婆婆')
line('he_coat_mended', '衣裳交回去了。那块旧肩垫随你用，干布条要留一两条，山口黄婶的篓提梁也磨手。', npc='何婆婆')
run('he_shop', [act('openShop', shopId='ow_he_cloth')])

switch('needle', [(any_of(state(N, 'carrying', True), needle_done), 'needle_empty'), ({'posture': 'crouch'}, 'needle_found')], 'needle_hint')
line('needle_hint', '石缝里闪了一点细光。蹲下来（按住 C）才能分清是针尖还是湿沙。')
line('needle_found', '你贴近石面，从细缝抽出一根弯针。针眼还穿着短蓝线，是何婆婆缝补时留下的。', 'needle_take')
run('needle_take', [emit('ow_needle_take'), act('setFocusedQuest', id='ow_needle')])
line('needle_empty', '那根弯针已经拾起，石缝里剩的是湿沙。')
switch('he_needle', [(needle_done, 'he_needle_done'), (state(N, 'carrying'), 'he_needle_return')], 'he_needle_first')
line('he_needle_first', '弯针落在浣衣石下头了，挂着蓝线。别拿脚乱搓，蹲下看细缝；捡回来，我给你一条干布。', 'he_needle_accept', '何婆婆')
run('he_needle_accept', [emit('ow_needle_accept'), act('setFocusedQuest', id='ow_needle')])
line('he_needle_return', '就是这根，蓝线还是我穿的。针放这儿，这条干布拿去；吸油、包提梁都用得着。', 'he_needle_finish', '何婆婆')
run('he_needle_finish', [emit('ow_needle_return')])
line('he_needle_done', '针在我手里，不必再下石缝找。布料用完了可以买，别把别人的衣摆撕来顶数。', 'he_needle_done_menu', '何婆婆')
choice('he_needle_done_menu', option('he_buy_after_needle', '买布料', 'he_shop'), option('he_needle_bye', '针找回就好', 'end'))

switch('huang_binding', [(binding_done, 'huang_binding_done')], 'huang_binding_first')
line('huang_binding_first', '篓提梁磨开了，草叶夹进去也垫不稳。你若有干布，替我绕住这个破口，留着活结好换；三叶艾草归你。', 'binding_accept', '黄婶')
run('binding_accept', [emit('ow_binding_accept'), act('setFocusedQuest', id='ow_binding')], 'binding_menu')
choice('binding_menu', option('binding_use', '取一条布，交错缠住提梁磨手处', 'binding_wrap', has('ow_cloth'), '需要一条布。捞桶或还针能换，何婆婆也卖。'), option('binding_leave', '先找合用的布料', 'end'))
run('binding_wrap', [emit('ow_binding_wrap')], 'huang_binding_done')
line('huang_binding_done', '提梁不勒了。艾草给你，山口要认草，背阴石根的叶背比叶面浅，别把晒蔫的杂叶全塞篓里。', npc='黄婶')

# Close view is observation and actual targeted use, not a three-node checklist.
coat_image = '/resources/runtime/images/examine/ow_shore_coat.png'
examine = {'id': 'ow_shore_coat', 'label': a.text('coat_ex_label', '检视：河滩工衣'),
    'title': a.text('coat_ex_title', '河滩工衣'),
    'allFoundHint': a.text('coat_ex_all', '已看过这些痕迹。可以退出检视，再决定是否保留原状。'),
    'presentation': {'kind': 'still', 'image': coat_image, 'backgroundPreset': 'stone', 'physicalWidthCm': 120,
                     'contactAoIntensity': 0.7, 'contactAoRadiusCm': 1.5},
    'ambience': {'headSway': {'amplitude': 0.3}, 'breathing': False, 'dust': False},
    'smell': {'scent': 'mold', 'intensity': 15},
    'hotspots': [
        {'id': 'patch', 'label': a.text('patch_label', '补丁长针脚'), 'x': 470, 'y': 250, 'width': 185, 'height': 190,
         'anomalyShade': a.text('patch_shade', '补丁针脚很长'), 'anomalyRevealed': a.text('patch_seen', '两道长针脚的补丁'),
         'shadeUiX': 0.16, 'shadeUiY': 0.23,
         'narration': a.text('patch_detail', '补丁上两道长针脚，缝得牢，不讲究好看。是记得的人能认出的旧补法。'),
         'actions': [emit('ow_coat_patch')]},
        {'id': 'cuff', 'label': a.text('cuff_label', '黏黑袖口'), 'x': 1290, 'y': 725, 'width': 205, 'height': 160,
         'anomalyShade': a.text('cuff_shade', '袖口黑痕不全是泥'), 'anomalyRevealed': a.text('cuff_seen', '袖口有黏稠油迹'),
         'shadeUiX': 0.8, 'shadeUiY': 0.35,
         'operations': [{'id': 'smell_cuff', 'label': a.text('cuff_smell', '闻闻袖口'),
             'narration': a.text('cuff_detail', '不是香粉，也不是尸臭，是船板上黏重的桐油气。干布能把油和水分开。'),
             'actions': [act('setSmell', scent='ow_tung_oil', intensity=65)]}],
         'itemUses': [{'itemId': 'ow_cloth', 'label': a.text('cuff_use', '用干布吸辨油迹'),
             'narration': a.text('cuff_used', '布上吸着黏稠油迹，水珠另凝在旁边：袖口接触过船用桐油。取过一次即可退出检视，不必再浪费布。'),
             'actions': [emit('ow_coat_oil')]}]},
        {'id': 'hem', 'label': a.text('hem_label', '衣摆浅水线'), 'x': 300, 'y': 910, 'width': 920, 'height': 95,
         'decoy': True, 'narration': a.text('hem_detail', '一道浅水痕，能说明泡过水；说明不了是穿着落水，还是单独漂来的。')},
    ]}

schedules_data = read('data/npc_schedules.json')
schedules = schedules_data['schedules']
deng = next(s for s in schedules if s['characterId'] == 'ow_deng')
deng['entries'] = [e for e in deng['entries'] if e.get('from') != '18:00']
deng['entries'][0:0] = [
    {'from': '18:00', 'to': '20:00', 'scene': '码头白天', 'conditions': [returned]},
    {'from': '18:00', 'to': '20:00', 'scene': 'test_room_b', 'conditions': [neg(returned)]},
]
npc_guide = lambda npc: a.npc_guidance(npc, schedules)
obj = a.objective
quests = read('data/quests.json')
upsert(quests, a.quest('ow_coat', '河滩认衣', '河滩工衣牵着一笔借还的人情。保留痕迹当面核对，或听明来路后洗补；一件湿衣不能替死人子认名。', neg(state(G, 'initial')), done, [
    obj('coat_decide_obj', '在河滩浣衣石检视工衣，选如何处置', removed, marker('河边', 'hotspot', 'ow_laundry'), neg(removed)),
    obj('coat_borrower_obj', '可选：问邓幺借衣经过，打开洗补办法', borrower, npc_guide('ow_deng'), neg(removed), True),
    obj('coat_he_obj', '可选：问何婆婆针脚或补充布料', proof, npc_guide('ow_he'), neg(removed), True),
    obj('coat_return_obj', '把保留原状的工衣交给周三', returned, npc_guide('ow_zhou'), state(G, 'carrying')),
    obj('coat_bucket_obj', '洗补要用木桶：河滩芦根可捞取', has('ow_bucket'), marker('河边', 'hotspot', 'ow_water_reed'), all_of(borrower, neg(removed), neg(has('ow_bucket'))), True),
]))
upsert(quests, a.quest('ow_needle', '浣衣石下的针', '石缝里有一根穿着蓝线的弯针。找回交给何婆婆。', neg(state(N, 'initial')), needle_done, [
    obj('needle_find_obj', '在浣衣石下蹲看细缝（按住 C）', state(N, 'carrying', True), marker('河边', 'hotspot', 'ow_needle_gap')),
    obj('needle_return_obj', '把弯针交还何婆婆', needle_done, npc_guide('ow_he'), state(N, 'carrying', True)),
]))
upsert(quests, a.quest('ow_binding', '黄婶缺的绑带', '药篓提梁磨手，一条干布能包住破口。', neg(state(H, 'initial')), binding_done, [
    obj('binding_cloth_obj', '准备一条干布：何婆婆处可取得', has('ow_cloth'), npc_guide('ow_he'), neg(has('ow_cloth')), True),
    obj('binding_use_obj', '在黄婶身边，用布包住药篓提梁', binding_done, npc_guide('ow_huang')),
]))
for q in quests:
    for o in q.get('objectives', []):
        if q['id'] != 'ow_coat' and any(g.get('entityId') == 'ow_deng' for g in o.get('guidance', [])):
            o['guidance'] = npc_guide('ow_deng')

items = read('data/items.json')
for iid, title, desc, icon in [
    ('ow_work_coat', '待认的湿工衣', '保留了水痕和桐油迹的借用工衣。带给周三核对；不能凭它确认水中人的身份。', coat_image),
    ('ow_coat_record', '借衣认物布签', '周三留下的布签：工衣曾借给邓幺垫船板，单独落水。后续辨物可用这条记录提醒自己：先认衣物来路，再问人。', None),
    ('ow_shoulder_pad', '旧肩垫', '何婆婆留下的厚布肩垫。背重物前垫在磨肩处，可以重复使用；不代替选路和照看脚下。', None),
    ('ow_needle', '穿蓝线的弯针', '何婆婆掉进浣衣石缝的旧针。针眼仍挂着短蓝线，应当交还。', None),
]:
    row = {'id': iid, 'name': a.text(iid + '_name', title), 'description': a.text(iid + '_desc', desc), 'type': 'key', 'maxStack': 1}
    if icon: row['icon'] = icon
    upsert(items, row)
shops = read('data/shops.json')
upsert(shops, {'id': 'ow_he_cloth', 'name': a.text('he_shop_title', '何婆婆的干布'), 'items': [{'itemId': 'ow_cloth', 'price': 2}]})
smells = read('data/smell_profiles.json')
smells['profiles']['ow_tung_oil'] = {'name': a.text('oil_name', '船用桐油'), 'color': '#a78d59', 'rise': 0.25, 'sway': 2.0, 'swayFreq': 0.8, 'jitter': 0.03, 'heavy': True}
river = read('scenes/河边.json')
laundry = next(h for h in river['hotspots'] if h['id'] == 'ow_laundry')
laundry['data'] = {'graphId': a.dg['id'], 'entry': 'coat'}
laundry['label'] = a.text('laundry_label', '浣衣石')
upsert(river['hotspots'], a.hotspot('ow_needle_gap', '浣衣石下的细缝', 516, 479, 'needle', size=40))
street = read('dialogues/graphs/开放世界_街坊.json')
for menus, topic, prose, entry in [
    (['zhou_menu_plain', 'zhou_menu_bowl'], 'zhou_coat', '河滩那件借出去的工衣……', 'zhou_coat'),
    (['deng_menu'], 'deng_coat', '你借周三的工衣到哪点去了？', 'deng_coat'),
    (['he_menu'], 'he_coat', '浣衣石上那件湿工衣……', 'he_coat'),
    (['he_menu'], 'he_needle', '你缝衣服的针找着没有？', 'he_needle'),
    (['he_menu'], 'he_cloth', '买一条干布', 'he_shop'),
    (['huang_menu'], 'huang_binding', '药篓的提梁勒手不？', 'huang_binding'),
]:
    key = topic + '_handoff'
    street['nodes'][key] = {'type': 'runActions', 'actions': [act('startDialogueGraph', graphId=a.dg['id'], entry=entry)], 'next': 'end'}
    for menu in menus:
        opts = street['nodes'][menu]['options']
        opts[:] = [o for o in opts if o['id'] != topic + '_topic']
        opts.insert(0, {'id': topic + '_topic', 'text': a.text(topic + '_topic', prose), 'next': key})

index = read('data/object_examine/index.json')
upsert(index, {'id': examine['id'], 'label': '检视：河滩工衣', 'file': 'ow_shore_coat.json'})
signals = set()
def collect(v):
    if isinstance(v, dict):
        if v.get('type') == 'emitNarrativeSignal': signals.add(v['params']['signal'])
        for child in v.values(): collect(child)
    elif isinstance(v, list):
        for child in v: collect(child)
for source in [a.dg, examine]: collect(source)
a.strings['objectExamine']['hint'] = '点物件看细节；摸摸囊选道具，再点要使用的位置。Esc 退一步。'
for sig in sorted(signals):
    if not any(s['id'] == sig for s in ng['signals']): ng['signals'].append({'id': sig, 'label': sig})
for path, value in [
    ('data/narrative_graphs.json', ng), ('data/quests.json', quests), ('data/items.json', items),
    ('data/shops.json', shops), ('data/strings.json', a.strings), ('data/smell_profiles.json', smells),
    ('data/npc_schedules.json', schedules_data), ('data/object_examine/index.json', index),
    ('data/object_examine/ow_shore_coat.json', examine), ('scenes/河边.json', river),
    ('dialogues/graphs/开放世界_街坊.json', street), ('dialogues/graphs/开放世界_认衣.json', a.dg),
]: write(path, value)
print('Authored C03 + S05/S18. Data and physical acceptance still required.')
