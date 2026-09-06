"""Offline helpers for authoring native editor data; never imported by the game."""
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
ASSETS = ROOT / 'public/assets'


def read(path):
    return json.loads((ASSETS / path).read_text('utf-8'))


def write(path, data):
    write_many([(path, data)])


def write_many(rows):
    """Use the editor's transaction writer; unchanged files do not wake Vite."""
    if str(ROOT) not in sys.path:
        sys.path.insert(0, str(ROOT))
    from tools.editor.file_io import StagedJsonWriter
    writer = StagedJsonWriter()
    try:
        for path, data in rows:
            target = ASSETS / path
            blob = (json.dumps(data, ensure_ascii=False, indent=2) + '\n').encode('utf-8')
            if target.is_file() and target.read_bytes() == blob:
                continue
            writer.add(target, data)
        writer.commit()
    finally:
        writer.abort()


def state(graph, name, reached=False):
    c = {'narrative': graph, 'state': name}
    if reached:
        c['reached'] = True
    return c


def any_of(*cs): return {'any': list(cs)}
def all_of(*cs): return {'all': list(cs)}
def neg(c): return {'not': c}
def has(item): return {'flag': 'has_item_' + item}
def act(kind, **params): return {'type': kind, 'params': params}
def emit(signal): return act('emitNarrativeSignal', signal=signal)
def give(item, count=1): return act('giveItem', id=item, count=count, critical=True)
def take(item, count=1): return act('removeItem', id=item, count=count)


def transition(source, target, signal, *conditions):
    t = {'id': f'{source}_{target}_{signal}', 'from': source, 'to': target, 'signal': signal}
    if conditions:
        t['conditions'] = list(conditions)
    return t


def graph(gid, label, states, transitions, owner_type='flow', owner_id=None):
    mapped = {}
    for i, (key, spec) in enumerate(states.items()):
        title, actions = spec if isinstance(spec, tuple) else (spec, [])
        mapped[key] = {'id': key, 'label': title, 'meta': {'editor': {'x': i % 4 * 270, 'y': i // 4 * 180}}}
        if actions:
            mapped[key]['onEnterActions'] = actions
    return {'id': gid, 'label': label, 'ownerType': owner_type, 'ownerId': owner_id or gid,
            'initialState': 'initial', 'states': mapped, 'transitions': transitions}


def wrapper(g, x, y):
    return {'id': g['id'] + '_element', 'kind': 'wrapperGraph', 'label': g['label'], 'refId': '',
            'x': x, 'y': y, 'ownerType': g['ownerType'], 'ownerId': g['ownerId'], 'graph': g,
            'meta': {'emits': [], 'reads': [], 'commands': []}}


def composition(g, description, elements=None):
    return {'id': g['id'] + '_composition', 'label': g['label'], 'description': description,
            'mainGraph': g, 'elements': elements or []}


def upsert(rows, row):
    for i, r in enumerate(rows):
        if r['id'] == row['id']:
            rows[i] = row
            return
    rows.append(row)


def marker(scene, kind, entity, label='察看'):
    return [{'kind': 'mapMarker', 'sceneId': scene}, {'kind': 'worldMarker', 'sceneId': scene,
             'entityKind': kind, 'entityId': entity, 'label': label, 'offscreenArrow': True}]


class Author:
    def __init__(self, category, gid, title, entry):
        self.category = category
        self.strings = read('data/strings.json')
        self.strings.setdefault(category, {})
        self.dg = {'schemaVersion': 1, 'id': gid, 'entry': entry,
                   'meta': {'title': title}, 'nodes': {'end': {'type': 'end'}}}
        self.nodes = self.dg['nodes']

    def text(self, key, prose):
        self.strings[self.category][key] = prose
        return f'[tag:string:{self.category}:{key}]'

    def line(self, key, prose, next_id='end', npc=None):
        speaker = {'kind': 'literal', 'name': npc or '旁白'}
        self.nodes[key] = {'type': 'line', 'speaker': speaker, 'text': self.text(key, prose), 'next': next_id}

    def run(self, key, actions, next_id='end'):
        self.nodes[key] = {'type': 'runActions', 'actions': actions, 'next': next_id}

    def switch(self, key, cases, default):
        self.nodes[key] = {'type': 'switch', 'cases': [{'condition': c, 'next': n} for c, n in cases], 'defaultNext': default}

    def option(self, key, prose, next_id, condition=None, hint=None):
        o = {'id': key, 'text': self.text(key, prose), 'next': next_id}
        if condition is not None: o['requireCondition'] = condition
        if hint: o['disabledClickHint'] = self.text(key + '_disabled', hint)
        return o

    def choice(self, key, *options):
        self.nodes[key] = {'type': 'choice', 'options': list(options)}

    def objective(self, oid, prose, complete, guidance=None, available=None, optional=False):
        o = {'id': oid, 'text': self.text(oid, prose), 'completeWhen': [complete]}
        if guidance: o['guidance'] = guidance
        if available is not None: o['availableWhen'] = [available]
        if optional: o['optional'] = True
        return o

    def quest(self, qid, title, description, active, done, objectives):
        return {'id': qid, 'group': 'xungou', 'type': 'side', 'autoFocus': True,
                'title': self.text(qid + '_title', title), 'description': self.text(qid + '_desc', description),
                'preconditions': [active], 'completionConditions': [done], 'objectives': objectives,
                'rewards': [], 'nextQuests': []}

    def npc_guidance(self, npc, schedules):
        out = []
        entries = next(s for s in schedules if s['characterId'] == npc)['entries']
        rest = next(e['scene'] for e in entries if e['scene'])
        for e in entries:
            a, b = [sum(int(v) * m for v, m in zip(e[k].split(':'), [60, 1])) for k in ['from', 'to']]
            after, before = {'flag': 'minutes_of_day', 'op': '>=', 'value': a}, {'flag': 'minutes_of_day', 'op': '<', 'value': b}
            cs = ([after, before] if a < b else [any_of(after, before)]) + e.get('conditions', [])
            for m in marker(e['scene'] or rest, 'npc' if e['scene'] else 'hotspot', npc if e['scene'] else 'ow_rest', '交谈' if e['scene'] else '歇脚等人'):
                m['conditions'] = cs
                out.append(m)
            if not e['scene']:
                out.append({'kind': 'sceneHint', 'sceneId': rest, 'conditions': cs,
                            'text': self.text(npc + '_rest_hint', '人已歇下，可在歇脚处等到开工。')})
        return out

    def hotspot(self, hid, label, x, y, entry, conditions=None, planes=None, size=65):
        h = {'id': hid, 'type': 'inspect', 'label': self.text(hid + '_label', label), 'x': x, 'y': y,
             'interactionRange': size, 'planes': planes or ['normal'], 'data': {'graphId': self.dg['id'], 'entry': entry}}
        if conditions:
            h.update(conditions=conditions, conditionHidesEntity=True)
        return h
