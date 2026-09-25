import re,glob,os
root='./src'
files=[f for f in glob.glob(root+'/**/*.ts',recursive=True) if '/engine2d/' not in f and not f.endswith('.test.ts')]
structs={}  # name -> list of (file, members[(name,type)])
allstructs=[]
for f in files:
    s=open(f,encoding='utf-8').read()
    for m in re.finditer(r'struct\s+(\w+)\s*\{([^}]*)\}',s):
        body=re.sub(r'//[^\n]*','',m.group(2))
        mem=re.findall(r'(\w+)\s*:\s*([\w<>, ]+?)\s*(?:,|$)',body)
        mem=[(a,b.strip()) for a,b in mem]
        allstructs.append((f,m.group(1),mem))
# uniform groups: find sequences of  name: { value: ..., type: '...'(, size: N)? }
groups=[]
for f in files:
    s=open(f,encoding='utf-8').read()
    # find object literal entries with type:'...'
    ents=[(m.start(),m.group(1),m.group(2)) for m in re.finditer(r"(\w+)\s*:\s*\{[^{}]*?type:\s*'([^']+)'[^{}]*?\}",s)]
    # sizes
    cur=[];last=-1
    for pos,name,typ in ents:
        seg=s[last:pos] if last>=0 else ''
        if last>=0 and (len(seg)>400 or re.search(r'\}\s*\)|new UniformGroup|\}\s*,\s*\{?\s*\w+\s*:\s*\{\s*$',seg) and '},' not in seg[-5:]):
            pass
        cur.append((pos,name,typ))
        last=pos
    # split by gaps: consecutive entries whose separation text contains only '},' and whitespace/comments/value exprs
    grp=[];prev_end=None
    for m in re.finditer(r"(\w+)\s*:\s*\{([^{}]*?type:\s*'([^']+)'[^{}]*?)\}",s):
        gap=s[prev_end:m.start()] if prev_end is not None else None
        if gap is not None and re.fullmatch(r"[\s,]*(//[^\n]*\n[\s,]*)*",gap):
            grp.append((m.group(1),m.group(3),m.group(2)))
        else:
            if grp: groups.append((f,grp))
            grp=[(m.group(1),m.group(3),m.group(2))]
        prev_end=m.end()
    if grp: groups.append((f,grp))
def norm(t):
    return t.replace(' ','')
for f,grp in groups:
    names=[g[0] for g in grp]
    if not all(n.startswith('u') for n in names): continue
    cands=[(sf,sn,mem) for sf,sn,mem in allstructs if set(a for a,_ in mem)==set(names)]
    if not cands:
        # partial match
        best=[(sf,sn,mem) for sf,sn,mem in allstructs if len(set(a for a,_ in mem)&set(names))>=max(2,len(names)//2)]
        print('NOSTRUCT',os.path.relpath(f,root),names[:6],'...' if len(names)>6 else '', 'partial:',[(os.path.relpath(b[0],root),b[1]) for b in best][:3])
        continue
    for sf,sn,mem in cands:
        exp=[]
        for n,t,body in grp:
            sz=re.search(r'size:\s*([\w.]+)',body)
            exp.append((n,norm(t),sz.group(1) if sz else None))
        got=[(a,norm(b)) for a,b in mem]
        bad=[]
        for i,(n,t,sz) in enumerate(exp):
            if i>=len(got) or got[i][0]!=n: bad.append(f'order@{i}:{n} vs {got[i][0] if i<len(got) else None}')
            else:
                gt=got[i][1]
                if sz: 
                    if not gt.startswith('array<'): bad.append(f'{n}: size {sz} but wgsl {gt}')
                elif gt!=t: bad.append(f'{n}: {t} vs {gt}')
        print('OK ' if not bad else 'BAD',os.path.relpath(f,root),'->',os.path.relpath(sf,root),sn,bad[:5])
