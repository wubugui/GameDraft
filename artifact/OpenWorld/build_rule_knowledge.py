"""One native rule shared by C06/C08; graph state is the sole knowledge source."""
from native_authoring import *

a = Author('owKnowledge', '开放世界_风路规矩', '火与灰，先辨风路', 'end')
rid, gid = 'ow_air_path', 'flow_ow_rule_air'
wind = state('flow_ow_incense_wind', 'seen', True)
fixed = state('flow_ow_stove', 'repaired', True)
moved = state('flow_ow_incense', 'moved', True)
sheltered = state('flow_ow_incense', 'sheltered', True)
ash = state('flow_ow_stove_ash', 'done', True)
heard = any_of(neg(state('flow_ow_incense', 'initial')), neg(state('flow_ow_stove', 'initial')))

def layer(key, prose, verified='unverified'):
    return {'text': a.text(key, prose), 'verified': verified}

variants = {
    'initial': {'layers': {}},
    'heard': {'layers': {'xiang': layer('heard_x', '灰扫了又散，冷灶点不起来。先记个疑问：是东西坏了，还是风走错了路？')}},
    'ash': {'layers': {
        'xiang': layer('ash_x', '薄篾从街灶进风口挑出了冷灰，里面并不是空的。', 'effective'),
        'shu': layer('ash_s', '先通灰口再试火。只清了灰，还没垫稳缺脚，不能算灶已经修成。')}},
    'wind': {'layers': {
        'xiang': layer('wind_x', '庙侧门的挂丝向院里斜伸，风正冲小灰盘。', 'effective'),
        'li': layer('wind_l', '灰可能是顺穿堂风被带过阶沿。要拿处置后的灰向再对照，不能只凭一句顺口话。'),
        'shu': layer('wind_s', '可挡住破缝，也可把灰盘熄净移开。两种办法改变的东西不同。')}},
    'moved': {'layers': {
        'xiang': layer('moved_x', '小灰盘已熄净，移到了殿内平石，门外少了这份灰源。', 'effective'),
        'shu': layer('moved_s', '移盘收住了灰，却没有修风口。不能把这次结果记成“门缝不漏风了”。', 'questionable')}},
    'sheltered': {'layers': {
        'xiang': layer('sealed_x', '堵好门缝，再回灰盘边驻足看，灰不再朝阶外扬。', 'effective'),
        'li': layer('sealed_l', '这一次的散灰确实随着穿堂风改变。这个依据来自同一处的前后对照。', 'effective'),
        'shu': layer('sealed_s', '挡缝后还要复查灰向；别把“材料已经用掉”当作“问题已经解决”。', 'effective')}},
    'stove': {'layers': {
        'xiang': layer('stove_x', '街灶清灰、垫稳后试火成功。进风口要通，灶脚也要承得住锅。', 'effective'),
        'shu': layer('stove_s', '薄篾清灰、楔木垫脚，炭条画线看锅是否倾斜，最后用灶上的燃料试火。', 'effective')}},
    'compared': {'layers': {
        'xiang': layer('both_x', '庙前看见风带灰走，街灶则亲手清灰后恢复了火。两处都找到了具体的风路。', 'effective'),
        'li': layer('both_l', '灰盘要避开直冲的风，灶火却要留进风口。“遇风一概堵死”不是通用办法。', 'effective'),
        'shu': layer('both_s', '先看要留住什么：收灰可挡风或移盘；烧火要通灰口并稳住锅。换场合先复查，莫照搬上一桩事。', 'effective')}},
}
# Most specific evidence wins. Mutually exclusive predicates prevent reactive loops.
priority = [('compared', all_of(fixed, wind)), ('stove', fixed), ('sheltered', sheltered),
            ('moved', moved), ('wind', wind), ('ash', ash), ('heard', heard)]
conditions, higher = {}, []
for sid, predicate in priority:
    conditions[sid] = all_of(predicate, neg(any_of(*higher))) if higher else predicate
    higher.append(predicate)
transitions = []
for source in variants:
    for target, cond in conditions.items():
        if source != target:
            transitions.append({'id': source+'_'+target, 'from': source, 'to': target,
                                'trigger': 'reactive', 'signal': '__draft__', 'conditions': [cond]})
g = graph(gid, '火与灰：当前掌握与信法', {sid: sid for sid in variants}, transitions, 'rule', rid)
ng = read('data/narrative_graphs.json')
upsert(ng['compositions'], composition(g, 'C06/C08 的亲历投影。搬灰不等于堵风；清灶也不是把进风口堵上。只从既成行为派生知识，不发授予 flag。'))
rules = read('data/rules.json')
upsert(rules['rules'], {'id': rid, 'name': a.text('name', '火与灰，先辨风路'),
    'incompleteName': a.text('incomplete', '火灰与风路的见闻'), 'category': 'streetwise',
    'layers': variants['compared']['layers'], 'narrativeStates': variants})
scene = read('scenes/temple_exterior.json')
zone = {'id': 'ow_wind_rule_offer', 'planes': ['normal'],
    'polygon': [{'x':600,'y':465},{'x':680,'y':465},{'x':680,'y':535},{'x':600,'y':535}],
    'conditions': [wind, state('flow_ow_incense', 'accepted')],
    'onEnter': [act('enableRuleOffers', slots=[{'ruleId':rid,'requiredLayers':['shu'],
        'resultActions':[act('startDialogueGraph', graphId='开放世界_庙火', entry='seal_choice')]}])],
    'onExit': [act('disableRuleOffers')]}
upsert(scene.setdefault('zones', []), zone)
a.strings.setdefault('notifications', {})['ruleUpdated'] = '规矩本添了批注：{name}'
write_many([('data/narrative_graphs.json',ng), ('data/rules.json',rules),
            ('data/strings.json',a.strings), ('scenes/temple_exterior.json',scene)])
print('Native rule projection and physical wind-gap rule offer authored; acceptance pending.')
