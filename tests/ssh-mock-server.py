#!/usr/bin/env python3
"""极简 SSH 服务器（仅用于本项目的隧道测试）：
监听 127.0.0.1:2222，密码认证 tunnel/test123，
接受 direct-tcpip 通道并转发到 127.0.0.1:3307（测试 MySQL）。

用法：python3 tests/ssh-mock-server.py [port]  （默认 2222，Ctrl+C 退出）
"""
import select
import socket
import sys
import threading

import paramiko

HOST_KEY = paramiko.RSAKey.generate(2048)
USER = "tunnel"
PASS = "test123"
FORWARD_HOST = "127.0.0.1"
FORWARD_PORT = 3307


import os as _os
_VERBOSE = _os.environ.get("MOCK_SSH_VERBOSE") == "1"


def log(msg):
    if _VERBOSE:
        import time
        print(f"[{time.strftime('%H:%M:%S')}.{int(time.time()*1000)%1000:03d}] {msg}", flush=True)


def pump(a, b, tag=""):
    try:
        while True:
            r, _, _ = select.select([a, b], [], [], 60)
            if not r:
                continue
            if a in r:
                data = a.recv(16384)
                if not data:
                    log(f"{tag} chan->upstream EOF")
                    break
                log(f"{tag} c2u {len(data)}B")
                b.sendall(data)
            if b in r:
                data = b.recv(16384)
                if not data:
                    log(f"{tag} upstream->chan EOF")
                    break
                log(f"{tag} u2c {len(data)}B")
                a.sendall(data)
    except OSError:
        pass
    finally:
        try: a.close()
        except OSError: pass
        try: b.close()
        except OSError: pass


def handle_client(sock):
    transport = paramiko.Transport(sock)
    transport.add_server_key(HOST_KEY)

    def check_auth(username, password):
        if username == USER and password == PASS:
            return paramiko.AUTH_SUCCESSFUL
        return paramiko.AUTH_FAILED

    class Server(paramiko.ServerInterface):
        def __init__(self, pending):
            self._pending = pending

        def check_auth_password(self, username, password):
            return check_auth(username, password)

        def get_allowed_auths(self, username):
            return "password"

        def check_channel_request(self, kind, chanid):
            return paramiko.OPEN_SUCCEEDED

        def check_channel_direct_tcpip_request(self, chanid, origin, destination):
            # 只允许转发到测试 MySQL；记录目的地，accept 循环里取到 Channel 后接线
            if (destination[0], destination[1]) != (FORWARD_HOST, FORWARD_PORT):
                return paramiko.OPEN_FAILED_ADMINISTRATIVELY_PROHIBITED
            pending[chanid] = destination
            return paramiko.OPEN_SUCCEEDED

        def check_channel_shell_request(self, channel):
            return False

        def check_channel_exec_request(self, channel, command):
            return False

    pending = {}
    event = threading.Event()
    try:
        transport.start_server(server=Server(pending), event=event)
        event.wait(10)
        # accept 循环：每条新开的 direct-tcpip 通道接到上游
        while transport.is_active():
            chan = transport.accept(0.5)
            if chan is None:
                continue
            dest = pending.pop(chan.get_id(), None)
            if dest is None:
                chan.close()
                continue
            try:
                upstream = socket.create_connection(dest, timeout=5)
            except OSError:
                chan.close()
                continue
            log(f"channel {chan.get_id()} connected")
            threading.Thread(target=pump, args=(chan, upstream, f"ch{chan.get_id()}"), daemon=True).start()
    except (OSError, paramiko.SSHException):
        pass
    finally:
        try: transport.close()
        except OSError: pass


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 2222
    server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    server.bind(("127.0.0.1", port))
    server.listen(20)
    print(f"mock sshd listening on 127.0.0.1:{port} -> {FORWARD_HOST}:{FORWARD_PORT}", flush=True)
    while True:
        client, addr = server.accept()
        threading.Thread(target=handle_client, args=(client,), daemon=True).start()


if __name__ == "__main__":
    main()
