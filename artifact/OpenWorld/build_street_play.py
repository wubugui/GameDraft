"""Offline native S03/S12/S14 author. Preserve unrelated existing content."""
from copy import deepcopy
from native_authoring import *

a = Author('owStreetPlay', '开放世界_街趣', '小钩、糖画与认字', 'stall')
line, run, switch, choice, option = a.line, a.run, a.switch, a.choice, a.option
R, S, PAY, PRIZE, EYE, N = ('flow_ow_ring_hook', 'flow_ow_sugar', 'flow_ow_sugar_payment',
    'flow_ow_sugar_shape', 'flow_ow_child_witness', 'flow_ow_notice')
ng, items, quests = read('data/narrative_graphs.json'), read('data/items.json'), read('data/quests.json')
schedules = read('data/npc_schedules.json')['schedules']
ring_done, sugar_given, sugar_eaten = state(R, 'done', True), state(S, 'given', True), state(S, 'eaten', True)
sugar_done = any_of(sugar_given, sugar_eaten)
paid = neg(state(PAY, 'initial'))
awarded = neg(state(PRIZE, 'initial'))
trusted = any_of(ring_done, sugar_given)
witness = state(EYE, 'heard', True)
notice_done = any_of(state(N, 'luo', True), state(N, 'monk', True))
selling = all_of({'flag':'minutes_of_day','op':'>=','value':420}, {'flag':'minutes_of_day','op':'<','value':1080})
coins = {'flag':'coins','op':'>=','value':1}
time = lambda minutes: act('advanceTime', minutes=minutes, transition='timelapse')
reactive = lambda source, target, condition: {'id':source+'_'+target, 'from':source, 'to':target,
    'trigger':'reactive', 'signal':'__draft__', 'conditions':[condition]}
note = lambda key, prose: act('showNotification', text=a.text(key, prose), type='info')

upsert(ng['compositions'], composition(graph(R, '小满的滚环钩', {
    'initial':'还没留意小钩', 'accepted':'钩子落在路边石缝',
    'carrying':('蹲下取出推环小钩', [give('ow_ring_hook')]),
    'done':('把小钩还给小满', [take('ow_ring_hook'), give('ow_sugar_ticket'),
        note('ring_reward', '小钩还了，收到小满留的一次糖画筹。也能问问他在街上看见的人。')]),
}, [transition('initial','accepted','ow_ring_accept'),
    *[transition(s,'carrying','ow_ring_take') for s in ['initial','accepted']],
    transition('carrying','done','ow_ring_return',has('ow_ring_hook'))]),
    'S03：取回推环钩。小满始终抱着铁环；筹和目击都是后续入口，不自动完成别的事。'))

pay_graph = graph(PAY, '糖画这一份的结账', {'initial':'尚未发射',
    'ticket':('第一次发射用了糖画筹',[take('ow_sugar_ticket')]),
    'cash':('第一次发射付了一文',[act('removeCurrency',amount=1)])}, [
    transition('initial','ticket','ow_sugar_launch',selling,has('ow_sugar_ticket'),neg(awarded)),
    transition('initial','cash','ow_sugar_launch',selling,neg(has('ow_sugar_ticket')),coins,neg(awarded))])
sugar_graph = graph(S, '糖画转到哪个', {'initial':'还没问糖摊', 'accepted':'一筹或一文，亲手转这一份',
    'paid':'已付过这一份，可续转', 'holding':'糖画收在囊里，送人或自用',
    'given':('把糖画送给小满',[take('ow_sugar_prize'), note('sugar_given', '小满收好糖画，肯说先前看见的人。先前还过钩也能问，不必两件都做。')]),
    'eaten':('实际吃掉糖画，留下木签',[take('ow_sugar_prize'),give('ow_sugar_stick'),time(5),
        note('sugar_eaten','糖画吃了，木签留下。侧门闩槽里的碎木可拿它挑，签子用一次便弯。')]),
}, [transition('initial','accepted','ow_sugar_accept'),
    *[reactive(src,'paid',paid) for src in ['initial','accepted']],
    reactive('paid','holding',awarded),
    transition('holding','given','ow_sugar_give',has('ow_sugar_prize')),
    transition('holding','eaten','ow_sugar_eat',has('ow_sugar_prize'))])
wheel = deepcopy(read('data/sugar_wheel/sugar_chongqing_folk.json'))
wheel.update(id='ow_sugar', label=a.text('wheel_label','街口糖画 · 给自己或小满的一份'))
shape_states, shape_transitions = {'initial':'指针还没实际停稳'}, []
for sector in wheel['sectors']:
    sid, label = sector['id'], sector['label']
    shape_states[sid] = (label+'糖画', [give('ow_sugar_prize'), note('prize_'+sid, '指针停在'+label+'，摊主做好这幅糖画，已收进摸囊。送小满或自己吃都行。')])
    shape_transitions.append(transition('initial',sid,'ow_sugar_land_'+sid,paid))
    sector['label'] = a.text('sector_'+sid,label)
    sector.pop('actionsOnPointerDrag',None)
    sector['actionsOnSpinLanding'] = [emit('ow_sugar_land_'+sid)]
wheel['beforeChargeCondition'] = all_of(selling,neg(awarded),any_of(paid,has('ow_sugar_ticket'),coins))
wheel['beforeChargePassActions'] = [emit('ow_sugar_launch')]
wheel['beforeChargeFailActions'] = [act('sugarWheelShowSpeech',role='stall_owner',text=a.text('charge_block','这一份已经转了就先拿糖；没付过的，要一筹或一文。收摊了等明早。'),durationMs=2400)]
wheel['atmosphereGroups'] = [{'id':'ow_stall_talk','label':a.text('atmo_name','摊前碎嘴'),'weight':1,
    'vars':{}, 'start':[{'op':'say','role':'child_a','text':a.text('spin_start','这回落哪个葛？')}],
    'spinning':[{'op':'wait','sec':1.2},{'op':'say','role':'stall_owner','text':a.text('spin_owner','手松了就看针，莫拿手去拦撒。')}],
    'slowing':[{'op':'say','role':'child_b','text':a.text('spin_slow','慢了慢了，莫眨眼。')}],
    'stop':[{'op':'say','role':'child_a','text':a.text('spin_stop','勒个也好，莫又嫌小。')}]}]
upsert(ng['compositions'],composition(sugar_graph,'S12：原生转盘停针决定实物；发射扣费、取消续转、送人或背包自用。',[
    wrapper(pay_graph,0,450),wrapper(graph(PRIZE,'首次实际停针的形状',shape_states,shape_transitions,'minigame','ow_sugar'),350,450)]))
upsert(ng['compositions'],composition(graph(EYE,'小满亲眼看见的借衣经过',{'initial':'尚未问到','heard':'小满认出抱衣人的两针长补丁'},[
    transition('initial','heard','ow_child_witness',trusted)]),'跨事件目击：S03 或 S12 提供交谈机会，亲眼检视补丁后才可用于 C03。'))

notice_states = {'initial':'街口的告示残纸','accepted':'找得到落纸便能问字','carrying':('拿起落在牌脚的残纸',[give('ow_notice_scrap')])}
for who,label in [('luo','罗伯'),('monk','扫院僧')]:
    notice_states[who] = (label+'念明路告示',[take('ow_notice_scrap'),give('ow_charcoal'),
        act('addArchiveEntry',bookType='document',entryId='doc_ow_notice_'+who),
        note('notice_done_'+who,label+'念过的内容记入文献册，残纸交回；给你一支炭，路况仍要亲眼看。')])
upsert(ng['compositions'],composition(graph(N,'告示认个字',notice_states,[
    transition('initial','accepted','ow_notice_accept'),
    *[transition(s,'carrying','ow_notice_take') for s in ['initial','accepted']],
    *[transition('carrying',who,'ow_notice_read_'+who,has('ow_notice_scrap')) for who in ['luo','monk']]]),
    'S14：拿残纸，请两个现有识字人之一念明；文献保留具体口述者，炭不是已修路的证明。'))

switch('hook',[(state(R,'carrying',True),'hook_empty'),({'posture':'crouch'},'hook_take')],'hook_hint')
line('hook_hint','石缝里横着一截小铁钩。按住 C 蹲下，再按 E 才够得着；小满抱着环，在找推环的钩。','hook_accept')
run('hook_accept',[emit('ow_ring_accept'),act('setFocusedQuest',id='ow_ring_hook')])
line('hook_take','你顺着石缝抽出小钩，弯头上缠着小满那截红线。铁环还在他怀里，缺的正是这根钩。','hook_commit')
run('hook_commit',[emit('ow_ring_take'),act('setFocusedQuest',id='ow_ring_hook')])
line('hook_empty','小钩已经取走。石缝空着，没有第二根。')
switch('child_hook',[(ring_done,'hook_returned'),(has('ow_ring_hook'),'hook_return_choice')],'child_request')
line('child_request','环没落，是钩落到石缝里了！老子……我又不是只会抱着它转。你帮我够一哈，我留的糖画筹给你。','child_accept','小满')
run('child_accept',[emit('ow_ring_accept'),act('setFocusedQuest',id='ow_ring_hook')])
choice('hook_return_choice',option('return_hook','把推环钩还给小满','hook_return'),option('keep_hook','一哈再给','end'))
run('hook_return',[emit('ow_ring_return')],'hook_returned')
line('hook_returned','钩回来了撒！这张筹还没转过，街口糖摊认。你问街上的事，我看见的就说，没看见的莫逼我编。','child_menu','小满')
switch('child_sugar',[(sugar_given,'child_got_sugar'),(has('ow_sugar_prize'),'sugar_offer')],'child_sugar_none')
line('child_sugar_none','糖摊在街口，给一筹或一文，自己拨针。转到哪个就做哪个，莫说花篮不是糖。','child_menu','小满')
choice('sugar_offer',option('sugar_give','把这份糖画给小满，听他讲目击','sugar_give'),option('sugar_keep','我自己留着；还过钩也能问事','child_menu'))
run('sugar_give',[emit('ow_sugar_give')],'child_got_sugar')
line('child_got_sugar','糖我拿起了。你要问抱衣裳过街的那个，我倒看得清，不是猜的。','child_menu','小满')
choice('child_menu',option('ask_witness','你看见谁抱着湿衣裳？','child_witness',trusted,'先帮他取回小钩，或送一份实际转来的糖画；不必两样都做。'),option('child_done','你耍，我走了','end'))
switch('child_witness',[(neg(trusted),'child_wont'),(witness,'witness_again')],'witness_line')
line('child_wont','你一来就追到问，我又不认得你。先看清我的环还在，落的是钩嘛。','end','小满')
line('witness_line','邓幺从船边抱着湿衣裳过来，肩头补丁两道长针脚。我看见的是他抱衣裳，没看见有人穿着落水。衣裳现在摊在河滩。','witness_commit','小满')
run('witness_commit',[emit('ow_child_witness')],'witness_again')
line('witness_again','河滩那件要先看补丁，跟我说的对上才算数。光听一句，莫给哪个认名。','witness_choice','小满')
choice('witness_choice',option('follow_coat','去河滩看看那块补丁','coat_handoff'),option('witness_leave','我记着了','end'))
run('coat_handoff',[emit('ow_coat_accept'),act('setFocusedQuest',id='ow_coat')])

switch('stall',[(sugar_done,'stall_finished'),(awarded,'sugar_holding'),(neg(selling),'stall_closed')],'stall_intro')
line('stall_intro','一张筹抵一文，亲手按住蓄力，松手让针自己停。第一次拨出去才结这一份；中途退开，下次来不用再付。','stall_accept','糖画摊主')
run('stall_accept',[emit('ow_sugar_accept'),act('setFocusedQuest',id='ow_sugar')],'stall_choices')
choice('stall_choices',option('play_sugar','我来拨针，做这一份糖画','play',any_of(paid,has('ow_sugar_ticket'),coins),'还缺一文或一张糖画筹。小满找回推环钩会给筹；晒纸等零活也能挣铜钱。'),option('sugar_later','先不拨，不结账','end'))
run('play',[act('startSugarWheelMinigame',id='ow_sugar')],'after_play')
switch('after_play',[(awarded,'sugar_holding'),(paid,'sugar_paid')],'sugar_not_paid')
line('sugar_paid','这一份已经付过，针没落定。回摊续转就行，不会再扣筹或铜钱。')
line('sugar_not_paid','没拨出去就没结账。想转再来。')
line('sugar_holding','糖画在摸囊里，形状就是刚才指针停的那格。给小满可换目击；自己吃就留一根木签。两样只选一项。','holding_choices')
choice('holding_choices',option('track_child','带去找小满','sugar_child_focus'),option('keep_candy','我留着，空处从摸囊吃','end'))
run('sugar_child_focus',[act('setFocusedQuest',id='ow_sugar',objectiveId='sugar_child_obj')])
line('stall_finished','你那一份已经结清。糖去了哪点、木签剩不剩，看你自己怎么处置。')
line('stall_closed','糖炉歇了，七至十八点开摊。歇脚等开市，已经付过的那一份照认。','stall_accept_closed')
run('stall_accept_closed',[emit('ow_sugar_accept'),act('setFocusedQuest',id='ow_sugar')])

switch('notice',[(notice_done,'notice_after'),(has('ow_notice_scrap'),'notice_carry')],'notice_intro')
line('notice_intro','路告示下面落着一小片带字的残纸。整张牌还在，捡这片问人就行。你认得上面的箭头，底下几行却念不全。','notice_choices')
choice('notice_choices',option('take_notice','拣起落纸，请人念明','notice_take'),option('notice_wait','先记住位置','notice_track'))
run('notice_take',[emit('ow_notice_take'),act('setFocusedQuest',id='ow_notice')],'notice_carry')
run('notice_track',[emit('ow_notice_accept'),act('setFocusedQuest',id='ow_notice')])
line('notice_carry','带落纸找罗伯，或去旧庙找扫院僧。一个念明就够；可在任务里选择找谁。')
line('notice_after','残纸已经交给念字的人。文献册留着他的口述；路牌没替你查看今天的桥岸。')
for who,label in [('luo','罗伯'),('monk','扫院僧')]:
    switch('notice_'+who,[(notice_done,'notice_after'),(has('ow_notice_scrap'),'read_'+who)],'reader_where')
    line('read_'+who,'上头说：临水的旧跳板坏了，莫照旧牌背重货。先验路，再留记号。我给你念，不替你看今天涨没涨水。勒片纸留下，炭拿一支去画记号。','read_commit_'+who,label)
    run('read_commit_'+who,[emit('ow_notice_read_'+who)],'notice_after')
line('reader_where','街口路牌脚下有落纸，拿来才能逐字念。莫隔着半条街让我猜。')

for iid,label,description in [
    ('ow_ring_hook','小满的推环钩','石缝里取出的小铁钩，弯头缠着红线。交给抱铁环的小满。'),
    ('ow_sugar_ticket','小满留的糖画筹','给街口糖摊抵一文，只用一次；真正松手发射时才收走。'),
    ('ow_sugar_prize','刚做好的糖画','街口实际转来的糖画。送小满可听目击，自己从摸囊吃则留木签；只是一份。'),
    ('ow_sugar_stick','吃完糖画留下的木签','窄薄木签可以伸进侧门闩槽挑碎木。用一次便弯，不能当木梆砸。'),
    ('ow_notice_scrap','路牌脚下的告示残纸','箭头认得，字认不全。请罗伯或扫院僧念，原纸交回，口述进文献册。')]:
    upsert(items,{'id':iid,'name':a.text(iid+'_name',label),'description':a.text(iid+'_desc',description),'type':'key','maxStack':1})
prize = next(i for i in items if i['id']=='ow_sugar_prize')
prize['dynamicDescriptions'] = [{'conditions':[state(PRIZE,sid,True)],'text':a.text('sugar_desc_'+sid,label+'形糖画，指针实际停在这一格。送小满听目击，或从摸囊吃掉留下木签。')} for sid,label in [(s['id'],a.strings[a.category]['sector_'+s['id']]) for s in wheel['sectors']]]
prize['use'] = {'label':a.text('eat_sugar','吃掉，留木签'),'consume':False,
    'conditions':[state(S,'holding'),has('ow_sugar_prize')],'disableHint':a.text('eat_sugar_disabled','这一份已经送出或吃掉。'),
    'actions':[emit('ow_sugar_eat')],'resultText':a.text('eat_sugar_result','糖一口口嚼碎，五分钟歇够了。木签留着，去挑卡槽里松动的碎木正合适。')}

street = read('scenes/雾津街头.json')
for h in [a.hotspot('ow_ring_hook_gap','路边石缝的小铁钩',1030,1640,'hook',size=38),
    a.hotspot('ow_sugar_stall','街口糖画摊',1210,1680,'stall',size=48),
    a.hotspot('ow_notice','路告示下的落纸',2270,2083,'notice',size=42)]:upsert(street['hotspots'],h)
next(h for h in street['hotspots'] if h['id']=='ow_sugar_stall')['displayImage'] = {
    'image':'/resources/runtime/images/props/ow_sugar_stall.png', 'worldWidth':110, 'worldHeight':110}

folk=read('dialogues/graphs/开放世界_街坊.json')
for menus,key,prose,entry in [(['man_menu'],'hook','推环的小钩找到了没得？','child_hook'),
    (['man_menu'],'sugar','勒份糖画，你要不要？','child_sugar'),
    (['man_menu'],'witness','抱湿衣裳的人，你看清没得？','child_witness'),
    (['luo_menu'],'read_notice_luo','路牌落的这几行字，念一哈？','notice_luo'),
    (['monk_menu'],'read_notice_monk','路牌落的这几行字，念一哈？','notice_monk')]:
    nid='ow_street_'+key
    folk['nodes'][nid]={'type':'runActions','actions':[act('startDialogueGraph',graphId=a.dg['id'],entry=entry)],'next':'end'}
    for menu in menus:
        opts=folk['nodes'][menu]['options'];opts[:]=[o for o in opts if o['id']!=nid]
        row={'id':nid,'text':a.text('topic_'+key,prose),'next':nid}
        if key=='witness':row.update(requireCondition=trusted,disabledClickHint=a.text('topic_witness_hint','还过小钩或送过糖画，便可问这条目击。'))
        opts.insert(0,row)

obj=a.objective
street_guide=lambda hid:marker('雾津街头','hotspot',hid)
upsert(quests,a.quest('ow_ring_hook','小满的滚环钩','铁环在他怀里，推环钩落进石缝。蹲下找回，可换糖画筹，也能问他在街上的目击。',neg(state(R,'initial')),ring_done,[
    obj('ring_take_obj','路边石缝按住 C，再按 E 取小钩',state(R,'carrying',True),street_guide('ow_ring_hook_gap')),
    obj('ring_return_obj','把小钩还给抱铁环的小满',ring_done,a.npc_guidance('ow_man',schedules),state(R,'carrying'))]))
stall_guidance=street_guide('ow_sugar_stall')
for g in stall_guidance:g['conditions']=[selling]
for g in marker('雾津街头','hotspot','ow_rest','歇脚等开摊'):g['conditions']=[neg(selling)];stall_guidance.append(g)
upsert(quests,a.quest('ow_sugar','糖画转到哪个','亲手拨针，筹或一文只结这一份；糖画送小满换目击，或自己吃后留木签。',neg(state(S,'initial')),sugar_done,[
    obj('sugar_spin_obj','到糖摊按住蓄力、松手，等针停稳',awarded,stall_guidance),
    obj('sugar_child_obj','可送糖给小满，听他讲见闻',sugar_done,a.npc_guidance('ow_man',schedules),state(S,'holding'),True),
    obj('sugar_eat_obj','也可从摸囊吃糖，留下挑闩木签',sugar_done,[],state(S,'holding'),True)]))
upsert(quests,a.quest('ow_notice','告示认个字','拿街口落纸，请罗伯或扫院僧念明。只要一人；原纸交回，口述与炭条留下。',neg(state(N,'initial')),notice_done,[
    obj('notice_take_obj','拿起路告示脚下的残纸',state(N,'carrying',True),street_guide('ow_notice')),
    obj('notice_luo_obj','请罗伯念残纸',notice_done,a.npc_guidance('ow_luo',schedules),state(N,'carrying'),True),
    obj('notice_monk_obj','也可请扫院僧念残纸',notice_done,a.npc_guidance('ow_monk',schedules),state(N,'carrying'),True)]))

# Witness supplements physical patch observation; it never becomes the borrower's confession.
coat=next(c for c in ng['compositions'] if c['mainGraph']['id']=='flow_ow_coat')
keep=next(t for t in coat['mainGraph']['transitions'] if t.get('signal')=='ow_coat_keep')
child_proof=all_of(state('flow_ow_coat_patch','seen',True),witness)
if child_proof not in keep['conditions'][0]['any']:keep['conditions'][0]['any'].append(child_proof)
coat_dialogue=read('dialogues/graphs/开放世界_认衣.json')
for o in coat_dialogue['nodes']['coat_menu']['options']:
    if o['id']=='coat_keep_choice':o['requireCondition']=deepcopy(keep['conditions'][0]);o['disabledClickHint']=a.text('coat_proof_hint','可吸辨袖口油迹、问借衣人，或把亲眼看的补丁与核账记忆、小满目击核对；不必集齐。')
coat_dialogue['nodes']['coat_after_examine']['cases'][:]=[c for c in coat_dialogue['nodes']['coat_after_examine']['cases'] if c['next']!='ow_child_patch']
coat_dialogue['nodes']['coat_after_examine']['cases'].insert(1,{'condition':child_proof,'next':'ow_child_patch'})
coat_dialogue['nodes']['ow_child_patch']={'type':'line','speaker':{'kind':'literal','name':'旁白'},'text':a.text('child_patch','两道长针脚和小满说的对上了。能确认邓幺抱过这件衣裳，可原样交周三；小满没看见谁穿它落水。'),'next':'coat_menu'}
# The eaten candy stick is a third physical tool, consumed independently from bamboo.
bolt=next(c for c in ng['compositions'] if c['mainGraph']['id']=='flow_ow_bolt')
material='flow_ow_bolt_stick'
upsert(bolt['elements'],wrapper(graph(material,'糖画木签挑闩',{'initial':'未用木签','used':('挑出碎木，签子折弯',[take('ow_sugar_stick')])},[
    transition('initial','used','ow_bolt_stick',state('flow_ow_bolt','seen'),has('ow_sugar_stick'))]),350,440))
upsert(bolt['mainGraph']['transitions'],reactive('seen','done',state(material,'used',True)) | {'id':'seen_done_stick'})
temple=read('dialogues/graphs/开放世界_庙火.json')
opts=temple['nodes']['bolt_choice']['options'];opts[:]=[o for o in opts if o['id']!='ow_stick_pry']
opts.insert(1,option('ow_stick_pry','用糖画木签挑碎木，签子用掉','ow_stick_pry',has('ow_sugar_stick'),'实际转糖画，再从摸囊吃掉，能留下一根木签。'))
temple['nodes']['ow_stick_pry']={'type':'runActions','actions':[emit('ow_bolt_stick')],'next':'bolt_done'}
for o in next(q for q in quests if q['id']=='ow_bolt')['objectives']:
    if o['id']=='bolt_tool_obj':o['text']=a.text('bolt_tools','用薄篾或糖画木签挑，或用木梆震松')

docs=read('data/archive/documents.json')
for who,label in [('luo','罗伯'),('monk','扫院僧')]:
    upsert(docs,{'id':'doc_ow_notice_'+who,'name':a.text('doc_'+who,'路告示残纸 · '+label+'口述'),
        'content':a.text('doc_body_'+who,'临水旧跳板有损，负重者勿凭旧牌下行。沿河滩高阶上街，仍须看苔滑不滑；走低岸，须看横档稳不稳。\n\n'+label+'补的一句：[clue:ow_notice_road]先验路，再信牌[/clue]。告示记的是贴纸那天，水与木头不会跟着字停住。'),
        'annotation':a.text('doc_note_'+who,'关二狗带来的落纸由'+label+'念过，原纸已经交回。这是口述记录，不是关二狗忽然识得整页字。'),
        'discoverConditions':[state(N,who,True)]})
clues=read('data/clues.json')
upsert(clues['clues'],{'id':'ow_notice_road','title':a.text('clue_title','先验路，再信牌'),'desc':a.text('clue_desc','路告示提醒：高阶要看青苔，低岸要看横档；旧牌不能证明今天可背重物通过。找路后仍得亲手处理。'),'category':'saying'})
index=read('data/sugar_wheel/index.json');upsert(index,{'id':'ow_sugar','label':wheel['label'],'file':'ow_sugar.json'})
def emitted_signals(value):
    if isinstance(value,dict):
        if value.get('type')=='emitNarrativeSignal':yield value['params']['signal']
        for child in value.values():yield from emitted_signals(child)
    elif isinstance(value,list):
        for child in value:yield from emitted_signals(child)
for signal in sorted(set(emitted_signals([a.dg,items,wheel,temple]))):
    if not any(s['id']==signal for s in ng['signals']):ng['signals'].append({'id':signal,'label':signal})
write_many([('data/narrative_graphs.json',ng),('data/items.json',items),('data/quests.json',quests),('data/strings.json',a.strings),
    ('data/sugar_wheel/ow_sugar.json',wheel),('data/sugar_wheel/index.json',index),('data/archive/documents.json',docs),('data/clues.json',clues),
    ('scenes/雾津街头.json',street),('dialogues/graphs/'+a.dg['id']+'.json',a.dg),('dialogues/graphs/开放世界_街坊.json',folk),
    ('dialogues/graphs/开放世界_认衣.json',coat_dialogue),('dialogues/graphs/开放世界_庙火.json',temple)])
print('Authored S03/S12/S14; actual-input and editor gates remain required.')
