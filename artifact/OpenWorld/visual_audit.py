"""Final diagnostic checkpoints. Quest acceptance uses the separate player-input records."""
import json
import sys
import time
import urllib.request
from pathlib import Path

OUT = Path(__file__).resolve().parent


def request(route, payload):
    req = urllib.request.Request('http://127.0.0.1:5181/' + route,
                                 data=json.dumps(payload).encode('utf-8'),
                                 headers={'Content-Type': 'application/json'})
    result = json.load(urllib.request.urlopen(req, timeout=55))
    if not result['ok']:
        raise RuntimeError(result)
    return result['result']


def evaluate(code):
    return request('eval', {'code': code})


scene, phase, name = sys.argv[1:4]
evaluate("async () => { __gameDevAPI.suppressSceneEnterForVisualCapture(true); "
         "await __game.actionExecutor.executeAwait({type:'advanceTimeTo',params:{phase:"
         + json.dumps(phase) + ",transition:'cut'}}); "
         "return ow.act('debugSwitchScene',{sceneId:" + json.dumps(scene) + "}); }")
for _ in range(50):
    time.sleep(.2)
    if evaluate('() => ow.view().mode') == 'exploring':
        break
else:
    raise RuntimeError('Scene transition did not settle')
snapshot = """() => ({scene:ow.view().scene,minutes:__game.dayManager.minutesOfDay,
    actors:__game.sceneManager.getCurrentNpcs().filter(n=>n.def.characterId?.startsWith('ow_'))
      .map(n=>{const s=n.getDebugVisualState();return {id:n.id,visible:s.visible,x:s.x,y:s.y,
      animation:s.animation?.state,frame:s.animation?.frameIndex};})})"""
frames = [evaluate(snapshot)]
for _ in range(3):
    evaluate('async () => { await ow.step(120); return true; }')
    frames.append(evaluate(snapshot))
request('shot', {'name': name})
report = {'method': 'Registered time action and diagnostic scene checkpoint; fixed ticks sample native movement.',
          'samples': frames}
(OUT / (name + '.json')).write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
print(json.dumps(report, ensure_ascii=False), flush=True)
