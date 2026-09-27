# -*- coding: utf-8 -*-
"""工作台桌面壳的本地服务（``tools/desktop_shell.start_server``）：

* 系统分配端口（port 0）不许落在 Chromium 拒绝连接的端口上（ERR_UNSAFE_PORT，页面直接装不上；实测撞过 5060、1719，
  粒子台 Qt 自检偶发起不来）——撞上就放掉重分；显式给这种端口当场报错；
* 监听队列 64（缺省 5：页面一开几十个并发请求时 Windows 上会被拒连）。

用假的"系统分配"复现：前两次 bind 让它报出 5060 / 1719（真实端口另记），看 start_server 返回的是不是浏览器能连的、真在听的端口。
"""
from __future__ import annotations

import socketserver
import sys
import urllib.request
from http.server import BaseHTTPRequestHandler
from pathlib import Path

import pytest

_ROOT = Path(__file__).resolve().parents[3]
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

from tools import desktop_shell  # noqa: E402


class _Ok(BaseHTTPRequestHandler):
    def do_GET(self):  # noqa: N802
        body = b"ok"
        self.send_response(200)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *a):
        pass


def test_system_assigned_port_never_lands_on_a_chromium_restricted_port(monkeypatch) -> None:
    fake = [5060, 1719]
    real_bind = socketserver.TCPServer.server_bind
    real_ports: list[int] = []

    def bind(self):
        real_bind(self)
        real_ports.append(self.server_address[1])
        if fake:          # 这一次"系统"分到了浏览器不许连的端口
            self.server_address = (self.server_address[0], fake.pop(0))

    monkeypatch.setattr(socketserver.TCPServer, "server_bind", bind)
    port = desktop_shell.start_server(_Ok, 0)
    assert port not in desktop_shell.CHROMIUM_RESTRICTED_PORTS, port
    assert port == real_ports[-1] and len(real_ports) == 3, (port, real_ports)
    with urllib.request.urlopen(f"http://127.0.0.1:{port}/", timeout=10) as r:
        assert r.read() == b"ok"


def test_explicit_restricted_port_is_refused() -> None:
    with pytest.raises(ValueError, match="5060"):
        desktop_shell.start_server(_Ok, 5060)
    assert {5060, 5061, 1719, 1720, 6000, 10080, 6667} <= desktop_shell.CHROMIUM_RESTRICTED_PORTS


def test_listen_backlog_is_64(monkeypatch) -> None:
    seen: list[int] = []
    real_activate = socketserver.TCPServer.server_activate

    def activate(self):
        seen.append(self.request_queue_size)
        real_activate(self)

    monkeypatch.setattr(socketserver.TCPServer, "server_activate", activate)
    desktop_shell.start_server(_Ok, 0)
    assert seen and seen[-1] >= 64, seen
