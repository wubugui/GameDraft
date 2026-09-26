import json,sys,bisect
d=json.load(open(sys.argv[1]))
D=d['dump']
steps=[m for m in D['marks'] if m['ev']=='step']
def stepof(t):
  name='(pre)'
  for m in steps:
    if m['t']<=t: name=m['id']
  return name
gates={}
for e in D['e2d']:
  print(f"{stepof(e['t'])[:34]:34s} {e['phase'][:22]:22s} f{e['frame']:<5d} uid{e['uid']:<4d} {str(e['program'])[:26]:26s} {e['blend']:8s} {e['format']:12s} {str(e['depth'])[:6]:6s} {e['stencil']:8s} m{e['mask']} s{e['samples']} {e['topology'][:10]} {e['dt']}ms")
print('--- GPU-level non-engine2d (mipmap etc) ---')
for e in D['log']:
  if e['kind'] in ('rp','cp','rpa') and '→' not in e['label']:
    print(stepof(e['t']), e['phase'], e['frame'], e['kind'], e['label'])
