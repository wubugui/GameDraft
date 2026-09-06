"""Local, headless verification session; all game input uses runtime commands."""
import json
import traceback
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from playwright.sync_api import sync_playwright

OUT=Path(__file__).resolve().parent
errors=[]
pw=sync_playwright().start()
browser=pw.chromium.launch(headless=True, executable_path=str(Path.home()/'AppData/Local/ms-playwright/chromium_headless_shell-1148/chrome-win/headless_shell.exe'), args=['--use-angle=swiftshader','--disable-background-timer-throttling','--disable-renderer-backgrounding'])
page=browser.new_page(viewport={'width':1280,'height':800}, device_scale_factor=1)
page.on('pageerror',lambda e: errors.append(str(e)))
page.on('console',lambda m: errors.append(m.type+': '+m.text) if m.type in ('error','warning') else None)
page.goto('http://127.0.0.1:5173/?mode=dev&ndbg=0&narrativeWarp='+__import__('urllib.parse',fromlist=['quote']).quote('开放雾津'))
class Handler(BaseHTTPRequestHandler):
 def do_POST(self):
  try:
   req=json.loads(self.rfile.read(int(self.headers.get('Content-Length','0'))))
   if self.path=='/eval': result=page.evaluate(req['code'])
   elif self.path=='/shot':
    target=OUT/(req.get('name','world')+'.png');page.screenshot(path=str(target));result=str(target)
   elif self.path=='/reload':
    page.reload();result=True
   elif self.path=='/errors': result=errors[-70:]
   else: raise ValueError(self.path)
   body=json.dumps({'ok':True,'result':result},ensure_ascii=False).encode('utf-8')
   self.send_response(200)
  except Exception as e:
   body=json.dumps({'ok':False,'error':str(e)},ensure_ascii=False).encode('utf-8');self.send_response(500)
  self.send_header('Content-Type','application/json; charset=utf-8');self.end_headers();self.wfile.write(body)
 def log_message(self,*args):pass
print('Headless driver on 127.0.0.1:5181',flush=True)
try:HTTPServer(('127.0.0.1',5181),Handler).serve_forever()
finally:browser.close();pw.stop()
