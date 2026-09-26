import json,sys
d=json.load(open(sys.argv[1]))
D=d['dump']
steps=[m for m in D['marks'] if m['ev']=='step']
def stepof(t):
  name='(pre)'
  for m in steps:
    if m['t']<=t: name=m['id']
  return name
for l,u in sorted(D['used'].items(), key=lambda x:x[1]['first']):
  print(f"{l[:60]:60s} first f{u['first']} {stepof(u['firstT'])[:30]:30s} n={u['n']}")
print(D['marks'][:12])
