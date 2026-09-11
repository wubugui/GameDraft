"""Integration tests use the REAL old writers, only redirecting to tmp_path."""
import copy
import json

import pytest
from PySide6.QtWidgets import QApplication

from tools.scene_workbench.backend import Backend, Conflict, revision, start_server
from tools.trajectory_workbench import assets, serve as trajectory
from tools.acoustic_workbench import spaces


@pytest.fixture
def project(tmp_path):
    app = QApplication.instance() or QApplication([])
    scene_dir = tmp_path / 'public/assets/scenes'
    scene_dir.mkdir(parents=True)
    doc = {'id': 'room', 'name': '房间', 'worldWidth': 1000, 'worldHeight': 600,
           'spawnPoint': {'x': 100, 'y': 200}, 'npcs': [], 'hotspots': [],
           'opaque': {'future': [3, 2, 1], 'keepInteger': 7}, 'lighting': {'lights': []}}
    (scene_dir / 'room.json').write_bytes(assets.dumps(doc))
    (scene_dir / 'other.json').write_bytes(assets.dumps({**doc, 'id': 'other'}))
    yield Backend(tmp_path), doc, app


def test_scene_real_save_preserves_unedited_data_and_noop_bytes(project):
    backend, original, _ = project
    path = backend.path('scene', 'room')
    before = path.read_bytes()
    other = backend.path('scene', 'other').read_bytes()
    loaded = backend.read('scene', 'room')
    backend.save('scene', 'room', loaded['doc'], loaded['revision'])
    assert path.read_bytes() == before
    changed = copy.deepcopy(loaded['doc'])
    changed['spawnPoint']['x'] = 321
    saved = backend.save('scene', 'room', changed, loaded['revision'])
    expected = {**original, 'spawnPoint': {'x': 321, 'y': 200}}
    assert json.loads(path.read_bytes()) == expected
    assert saved['doc'] == expected
    assert backend.path('scene', 'other').read_bytes() == other
    assert b'\r' not in path.read_bytes()


def test_stale_editor_does_not_overwrite_external_change(project):
    backend, _, _ = project
    loaded = backend.read('scene', 'room')
    path = backend.path('scene', 'room')
    external = copy.deepcopy(loaded['doc'])
    external['name'] = '外部编辑'
    path.write_bytes(assets.dumps(external))
    loaded['doc']['spawnPoint']['x'] = 99
    with pytest.raises(Conflict):
        backend.save('scene', 'room', loaded['doc'], loaded['revision'])
    assert json.loads(path.read_bytes()) == external


def test_acoustics_calls_original_writer_with_same_output(project, tmp_path):
    backend, _, _ = project
    path = backend.path('acoustic', 'new')
    seed = spaces.new_space_def('room', 'background.png', '测试')
    seed['reflectors'].append({'a': [0, 0], 'b': [100, 0], 'height': 200, 'absorb': 0.2, 'rough': 0.4})
    expected_path = tmp_path / 'expected.json'
    spaces.save_space('new', seed, expected_path)
    backend.save('acoustic', 'new', seed, 'absent')
    assert path.read_bytes() == expected_path.read_bytes()
    assert (path.parent / 'trajectories').exists() is False


def test_trajectory_bakes_and_saves_via_original_owner(project, tmp_path, monkeypatch):
    backend, _, _ = project
    monkeypatch.setattr(assets, 'TRAJECTORIES_DIR', tmp_path / 'trajectories')
    # Screen-space baking only needs a present geometry; no production scene IO.
    monkeypatch.setattr(trajectory, '_doc_geometry', lambda doc: object())
    doc = {'id': 'walk', 'space': 'screen', 'keyframes': [], 'opaque': {'keep': True},
           'authoring': {'sceneId': 'room', 'anchor': {'x': 100, 'y': 100}},
           'source': {'segments': [{'id': 'path', 'kind': 'manual', 'startFrom': 'anchor',
                        'path': {'points': [{'x': 100, 'y': 100}, {'x': 250, 'y': 200}], 'smooth': False},
                        'timing': {'durationMs': 1000}}]}}
    result = backend.save('trajectory', 'walk', doc, 'absent')
    expected = trajectory.save_document(copy.deepcopy(doc))
    assert result['doc'] == expected['doc']
    assert result['doc']['opaque'] == {'keep': True}
    assert len(result['doc']['keyframes']) > 1
    assert result['doc']['keyframes'][0]['atMs'] == 0


def test_http_reuse_no_cache_and_write_boundary(project):
    import urllib.request
    import urllib.error
    backend, _, _ = project
    server = start_server(backend)
    base = f'http://127.0.0.1:{server.server_port}'
    try:
        with urllib.request.urlopen(base + '/reuse/common.js') as response:
            assert 'no-store' in response.headers['Cache-Control']
            assert response.read() == (trajectory.TOOL / 'viewer/common.js').read_bytes()
        request = urllib.request.Request(base + '/api/save', data=b'{}',
            headers={'Content-Type': 'application/json', 'Origin': 'https://other.example'})
        with pytest.raises(urllib.error.HTTPError) as error:
            urllib.request.urlopen(request)
        assert error.value.code == 400
    finally:
        server.shutdown()
        server.server_close()


def test_new_acoustic_cannot_overwrite_newly_created_same_name(project):
    backend, _, _ = project
    path = backend.path('acoustic', 'taken')
    doc = spaces.new_space_def('room')
    spaces.save_space('taken', doc, path)
    original = path.read_bytes()
    with pytest.raises(Conflict):
        backend.save('acoustic', 'taken', {**doc, 'distanceScale': 99}, revision(path), create=True)
    assert path.read_bytes() == original
