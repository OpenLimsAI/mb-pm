#!/usr/bin/env python3
"""Private bridge-to-Unix HTTP relay. No credentials, backup access or Docker API.

Run only in an unpublished private-network container. Mount the dedicated transport
socket directory read-only; never mount the state DB, keys or backup directories.
The host agent authenticates each request. This relay never retries an operation.
"""
import argparse
import http.client
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import ipaddress
import json
from pathlib import Path
import re
import signal
import socket
import stat
import threading

MAX_BODY = 64 * 1024
MAX_RESPONSE = 2 * 1024 * 1024
TIMEOUT = 12
HMAC_HEADERS = ('X-Backup-Time', 'X-Backup-Nonce', 'X-Backup-Signature')
OPERATIONS = {('GET', '/v1/snapshot'), ('POST', '/v1/delete-preview'), ('POST', '/v1/deletions'), ('POST', '/v1/plan')}


def socket_path(value):
    path = Path(value)
    if not path.is_absolute() or '..' in path.parts or '\0' in str(path):
        raise ValueError('An absolute fixed Unix socket is required')
    if any(p.is_symlink() for p in (path, *path.parents)):
        raise ValueError('Unix socket path must not follow symlinks')
    return path


def shutdown_socket(value):
    if value is not None:
        try:
            value.shutdown(socket.SHUT_RDWR)
        except OSError:
            pass
        value.close()


class UnixConnection(http.client.HTTPConnection):
    def __init__(self, path):
        super().__init__('localhost', timeout=TIMEOUT)
        self.path = path
        self.transport_socket = None

    def connect(self):
        path = socket_path(self.path)
        if not stat.S_ISSOCK(path.stat().st_mode):
            raise OSError('Unix socket unavailable')
        transport = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.transport_socket = self.sock = transport
        transport.settimeout(TIMEOUT)
        transport.connect(str(path))

    def abort(self):
        # Keep a reference even after HTTPConnection detaches a Connection: close
        # response; shutdown interrupts an in-progress response read at the deadline.
        shutdown_socket(self.transport_socket)

    def close(self):
        super().close()
        if self.transport_socket is not None:
            self.transport_socket.close()


def forward(path, method, target, headers, body):
    if (method, target) not in OPERATIONS or len(body) > MAX_BODY:
        raise ValueError('Unsupported relay operation')
    connection = UnixConnection(path)
    deadline = threading.Timer(TIMEOUT, connection.abort)
    deadline.daemon = True
    deadline.start()
    response = None
    try:
        outgoing = {key: headers[key] for key in HMAC_HEADERS}
        outgoing.update({'Content-Type': 'application/json', 'Content-Length': str(len(body)),
                         'Accept': 'application/json', 'Accept-Encoding': 'identity', 'Connection': 'close'})
        connection.request(method, target, body=body, headers=outgoing)
        response = connection.getresponse()
        if not 200 <= response.status <= 599 or 300 <= response.status < 400:
            raise ValueError('Unexpected upstream status')
        if response.getheader('Transfer-Encoding') is not None or response.getheader('Content-Encoding', 'identity').lower() != 'identity':
            raise ValueError('Encoded upstream response refused')
        if response.headers.get_content_type() != 'application/json':
            raise ValueError('Unexpected upstream content type')
        lengths = response.headers.get_all('Content-Length', [])
        if len(lengths) > 1:
            raise ValueError('Ambiguous upstream response length')
        length = lengths[0] if lengths else None
        if length is not None and (not re.fullmatch(r'[0-9]{1,10}', length) or int(length) > MAX_RESPONSE):
            raise ValueError('Upstream response too large')
        output = bytearray()
        while True:
            chunk = response.read1(min(64 * 1024, MAX_RESPONSE + 1 - len(output)))
            if not chunk:
                break
            output.extend(chunk)
            if len(output) > MAX_RESPONSE:
                raise ValueError('Upstream response too large')
        if length is not None and len(output) != int(length):
            raise ValueError('Incomplete upstream response')
        return response.status, output
    finally:
        deadline.cancel()
        if response is not None:
            response.close()
        connection.close()


class Relay(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def __init__(self, address, path):
        host = ipaddress.ip_address(address[0])
        if host.version != 4 or not (host.is_private or host.is_loopback or str(host) == '0.0.0.0') or host.is_multicast or host.is_link_local:
            raise ValueError('Use an unpublished private IPv4 bridge listener')
        self.socket_path = socket_path(path)
        self.slots = threading.BoundedSemaphore(16)
        super().__init__(address, Handler)

    def process_request(self, request, address):
        if not self.slots.acquire(False):
            request.close()
            return
        try:
            super().process_request(request, address)
        except Exception:
            self.slots.release()
            raise

    def process_request_thread(self, request, address):
        try:
            super().process_request_thread(request, address)
        finally:
            self.slots.release()

    def handle_error(self, request, address):
        # Do not log request data or upstream diagnostics.
        pass


class Handler(BaseHTTPRequestHandler):
    def setup(self):
        super().setup()
        self.connection.settimeout(TIMEOUT)
        self.deadline = threading.Timer(TIMEOUT, shutdown_socket, args=(self.connection,))
        self.deadline.daemon = True
        self.deadline.start()

    def finish(self):
        self.deadline.cancel()
        try:
            super().finish()
        except OSError:
            pass

    def log_message(self, *args):
        pass

    def reply(self, status, body):
        self.close_connection = True
        try:
            self.send_response(status)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Cache-Control', 'no-store')
            self.send_header('Content-Length', str(len(body)))
            self.send_header('Connection', 'close')
            self.end_headers()
            self.wfile.write(body)
        except OSError:
            pass

    def reject(self, status, code):
        self.reply(status, json.dumps({'error': {'code': code}}, separators=(',', ':')).encode())

    def send_error(self, code, message=None, explain=None):
        self.reject(code, 'invalid_request')

    def handle_request(self):
        if (self.command, self.path) not in OPERATIONS or self.headers.get_all('Transfer-Encoding'):
            return self.reject(400, 'invalid_request')
        lengths = self.headers.get_all('Content-Length', [])
        if len(lengths) > 1 or self.command == 'POST' and not lengths:
            return self.reject(400, 'invalid_request')
        length = lengths[0] if lengths else '0'
        if not re.fullmatch(r'[0-9]{1,6}', length) or int(length) > MAX_BODY:
            return self.reject(413, 'invalid_request')
        if self.command == 'GET' and int(length) or self.command == 'POST' and self.headers.get_content_type() != 'application/json':
            return self.reject(400, 'invalid_request')
        if self.headers.get('Content-Encoding', 'identity').lower() != 'identity':
            return self.reject(400, 'invalid_request')
        if any(len(self.headers.get_all(key, [])) != 1 or len(self.headers[key]) > 256 for key in HMAC_HEADERS):
            return self.reject(401, 'unauthorized')
        try:
            body = self.rfile.read(int(length))
            if len(body) != int(length):
                return self.reject(400, 'invalid_request')
            self.deadline.cancel()
            status, output = forward(self.server.socket_path, self.command, self.path, self.headers, body)
            self.reply(status, output)
        except (OSError, ValueError, http.client.HTTPException):
            self.reject(502, 'relay_unavailable')

    do_GET = handle_request
    do_POST = handle_request
    do_PUT = handle_request
    do_DELETE = handle_request
    do_HEAD = handle_request
    do_OPTIONS = handle_request
    do_PATCH = handle_request


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--socket', required=True, type=Path)
    parser.add_argument('--bind', default='0.0.0.0')
    parser.add_argument('--port', default=18941, type=int)
    args = parser.parse_args()
    if not 1024 <= args.port <= 65535:
        parser.error('Use an unprivileged private port')
    server = Relay((args.bind, args.port), args.socket)
    def stop(signum, frame):
        threading.Thread(target=server.shutdown, daemon=True).start()
    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    try:
        server.serve_forever(poll_interval=0.25)
    finally:
        server.server_close()


if __name__ == '__main__':
    main()
