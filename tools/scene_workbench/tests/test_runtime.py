"""Original Vite handlers with a private root: test real HTTP and real files."""
import json
import urllib.request
import urllib.error

from tools.scene_workbench.backend import ROOT, Backend, start_server
from tools.scene_workbench.runtime_host import RuntimeHost


def test_runtime_uses_original_scene_reader_and_private_original_writers(tmp_path):
    host = RuntimeHost(tmp_path)
    try:
        base = host.start()
        with urllib.request.urlopen(base + '/assets/scenes/test_room_b.json') as response:
            assert response.read() == (ROOT / 'public/assets/scenes/test_room_b.json').read_bytes()
            assert 'no-store' in response.headers['Cache-Control']
        body = {'sceneId': 'test_room_b', 'writer': 'scene-workbench-isolation-test',
                'lighting': {'lights': [], 'sky': {}, 'display': {}}}
        request = urllib.request.Request(base + '/__gamedraft-api/runtime-lighting',
            data=json.dumps(body).encode(), headers={'Content-Type': 'application/json'})
        with urllib.request.urlopen(request) as response:
            assert json.load(response)['ok']
        private = tmp_path / 'resources/editor_projects/editor_data/runtime_lighting.json'
        assert json.loads(private.read_text())['writer'] == body['writer']
        real = ROOT / 'resources/editor_projects/editor_data/runtime_lighting.json'
        if real.exists():
            assert json.loads(real.read_text(encoding='utf-8')).get('writer') != body['writer']
        with urllib.request.urlopen(base + '/@vite/client') as response:
            client = response.read().decode()
        assert 'const forwardConsole = {"enabled":false' in client
        assert 'transport.connect(createHMRHandler(handleMessage));' not in client
        assert 'setupForwardConsoleHandler(transport, forwardConsole);' not in client

        # Exercise the real adapter and old transport against the real Vite slot.
        # The old transport emits phase=""; the adapter must retain the game's
        # known phase so a subsequent pull cannot put night settings in the base.
        body['phase'] = 'night'
        request = urllib.request.Request(base + '/__gamedraft-api/runtime-lighting',
            data=json.dumps(body).encode(), headers={'Content-Type': 'application/json'})
        urllib.request.urlopen(request).close()
        adapter = Backend(game_url=base)
        adapter.start_runtime()
        api_server = start_server(adapter)
        def post(route, value):
            request = urllib.request.Request(f'http://127.0.0.1:{api_server.server_port}' + route,
                data=json.dumps(value).encode(), headers={'Content-Type': 'application/json'})
            try:
                with urllib.request.urlopen(request) as response:
                    return json.load(response)
            except urllib.error.HTTPError as error:
                raise AssertionError(error.read().decode()) from error
        try:
            lighting = {'lights': [], 'sky': {'brightness': 1}, 'display': {}}
            variants = {'night': {'lighting': {'sky': {'brightness': 0.25}}}}
            post('/api/lighting/publish', {'sceneId': 'test_room_b', 'lighting': lighting, 'variants': variants})
            payload = json.loads(private.read_text())
            assert payload['lighting']['sky']['brightness'] == 0.25
            pulled = post('/api/lighting/pull', {'sceneId': 'test_room_b', 'base': lighting, 'variants': variants})
            assert pulled['phase'] == 'night'
            assert pulled['lighting']['sky']['brightness'] == 1
            assert pulled['variant']['sky']['brightness'] == 0.25
        finally:
            api_server.shutdown()
            api_server.server_close()
            adapter.close()
    finally:
        host.stop()
    assert host.process is None
