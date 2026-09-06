import json, sys, urllib.request
mode = sys.argv[1] if len(sys.argv)>1 else 'eval'
payload = {'code':sys.stdin.read()} if mode=='eval' else {'name':sys.argv[2] if len(sys.argv)>2 else 'world'}
request=urllib.request.Request('http://127.0.0.1:5181/'+mode,data=json.dumps(payload).encode('utf-8'),headers={'Content-Type':'application/json'})
try:
 response=urllib.request.urlopen(request,timeout=55)
 print(response.read().decode('utf-8'))
except urllib.error.HTTPError as e:
 print(e.read().decode('utf-8'));sys.exit(1)
