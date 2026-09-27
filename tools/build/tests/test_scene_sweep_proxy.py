"""scene_sweep 的记录代理:游戏页跑在 WebView2 里(QtWebEngine 没有 WebGPU),请求改在代理上记。

漏记一条请求 = 扫描看不见一个漏抽的文件,所以这里把"原样转发 + 一条不漏地记 + HTML 注入 + websocket 打通"钉死。
纯网络逻辑,不需要 Qt / GPU。
"""
from __future__ import annotations

import http.client
import socket
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest

_ROOT = Path(__file__).resolve().parents[3]
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

from tools.build.scene_sweep import RecordingProxy, inject_into_head, normalize_request_url  # noqa: E402

_HTML = b"<!DOCTYPE html><html><head><meta charset='utf-8'></head><body>game</body></html>"


class _Upstream(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *_args) -> None:
        pass

    def _reply(self, status: int, body: bytes, ctype: str, extra: dict | None = None) -> None:
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def do_GET(self) -> None:  # noqa: N802
        if self.headers.get("Upgrade") == "websocket":
            self.send_response(101, "Switching Protocols")
            self.send_header("Upgrade", "websocket")
            self.send_header("Connection", "Upgrade")
            self.end_headers()
            self.wfile.flush()
            data = self.connection.recv(64)
            self.connection.sendall(b"echo:" + data)
            self.close_connection = True
            return
        if self.path.startswith("/index"):
            return self._reply(200, _HTML, "text/html; charset=utf-8")
        if self.path.startswith("/gz"):
            return self._reply(200, _HTML, "text/html", {"Content-Encoding": "identity-test"})
        if self.path.startswith("/range"):
            return self._reply(206, b"abc", "audio/ogg", {"Content-Range": f"bytes 0-2/10 ({self.headers.get('Range')})"})
        if self.path.startswith("/assets/"):
            return self._reply(200, b"x" * 100_000, "application/octet-stream")
        return self._reply(404, b"nope", "text/plain")

    do_HEAD = do_GET

    def do_POST(self) -> None:  # noqa: N802
        body = self.rfile.read(int(self.headers.get("Content-Length") or 0))
        self._reply(200, b"got:" + body, "text/plain")


@pytest.fixture()
def proxy():
    upstream = ThreadingHTTPServer(("127.0.0.1", 0), _Upstream)
    threading.Thread(target=upstream.serve_forever, daemon=True).start()
    seen: list[tuple[str, str]] = []
    p = RecordingProxy(f"http://127.0.0.1:{upstream.server_address[1]}", inject_head="window.__injected=1;",
                       on_request=lambda url, method: seen.append((url, method)))
    yield p, seen
    p.close()
    upstream.shutdown()
    upstream.server_close()


def _get(p: RecordingProxy, method: str, path: str, body: bytes | None = None, headers: dict | None = None):
    conn = http.client.HTTPConnection("127.0.0.1", p.port, timeout=10)
    try:
        conn.request(method, path, body=body, headers=headers or {})
        resp = conn.getresponse()
        return resp.status, dict(resp.getheaders()), resp.read()
    finally:
        conn.close()


def test_forwards_and_records_every_request(proxy) -> None:
    p, seen = proxy
    status, _h, body = _get(p, "GET", "/assets/a.png?v=1")
    assert status == 200 and body == b"x" * 100_000
    assert _get(p, "HEAD", "/assets/b.png")[0] == 200
    assert _get(p, "GET", "/resources/missing.png")[0] == 404, "404 原样回给页面(可选 sidecar 探测靠它)"
    assert _get(p, "POST", "/__gamedraft-api/x", body=b"{}", headers={"Content-Type": "application/json"})[2] == b"got:{}"
    methods = [(e[2], normalize_request_url(e[1])) for e in p.snapshot()]
    assert methods == [("GET", "assets/a.png"), ("HEAD", "assets/b.png"), ("GET", "resources/missing.png"), ("POST", None)]
    assert len(seen) == 4


def test_html_gets_console_capture_injected_at_head_start(proxy) -> None:
    p, _seen = proxy
    status, headers, body = _get(p, "GET", "/index.html")
    assert status == 200
    assert body.startswith(b"<!DOCTYPE html><html><head><script>window.__injected=1;</script><meta")
    assert int(headers["Content-Length"]) == len(body)


def test_encoded_html_is_left_alone(proxy) -> None:
    p, _seen = proxy
    assert _get(p, "GET", "/gz")[2] == _HTML


def test_range_requests_pass_through(proxy) -> None:
    p, _seen = proxy
    status, headers, body = _get(p, "GET", "/range", headers={"Range": "bytes=0-2"})
    assert status == 206 and body == b"abc" and "bytes=0-2" in headers["Content-Range"]


def test_upgrade_is_tunnelled(proxy) -> None:
    """vite 的 HMR websocket:代理打通成隧道,行为与直连一致。"""
    p, _seen = proxy
    s = socket.create_connection(("127.0.0.1", p.port), timeout=10)
    try:
        s.sendall(b"GET /ws HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n")
        buf = b""
        while b"\r\n\r\n" not in buf:
            buf += s.recv(1024)
        assert buf.startswith(b"HTTP/1.1 101")
        s.sendall(b"ping")
        rest = buf.split(b"\r\n\r\n", 1)[1]
        while b"echo:ping" not in rest:
            chunk = s.recv(1024)
            if not chunk:
                break
            rest += chunk
        assert b"echo:ping" in rest
    finally:
        s.close()


def test_inject_without_head_prepends() -> None:
    assert inject_into_head(b"<p>x</p>", b"<script></script>") == b"<script></script><p>x</p>"
    assert inject_into_head(b"<HEAD lang=zh>x", b"S") == b"<HEAD lang=zh>Sx"
