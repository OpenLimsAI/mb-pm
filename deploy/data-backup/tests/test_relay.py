"""Real loopback TCP -> synthetic Unix HTTP tests; no backup files or credentials."""
from contextlib import contextmanager
import hashlib
import hmac
import http.client
from http.server import BaseHTTPRequestHandler
import importlib.util
import json
from pathlib import Path
import socket
import socketserver
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

SOURCE = Path(__file__).resolve().parents[1] / 'relay.py'
spec = importlib.util.spec_from_file_location('catalogue_relay_test', SOURCE)
relay = importlib.util.module_from_spec(spec)
spec.loader.exec_module(relay)
SECRET = b'synthetic-relay-test-only-not-a-production-secret'


def headers(method, path, body=b''):
    values = {'X-Backup-Time': '1793836800', 'X-Backup-Nonce': 'a' * 32}
    canonical = '\n'.join((method, path, values['X-Backup-Time'], values['X-Backup-Nonce'], hashlib.sha256(body).hexdigest()))
    values['X-Backup-Signature'] = hmac.new(SECRET, canonical.encode(), hashlib.sha256).hexdigest()
    values['Content-Type'] = 'application/json'
    return values


class UnixServer(socketserver.ThreadingUnixStreamServer):
    daemon_threads = True

    def __init__(self, path):
        self.received = []
        self.response = {'status': 200, 'body': b'{"safe":"metadata"}'}
        super().__init__(str(path), AgentHandler)

    def handle_error(self, request, address):
        pass


class AgentHandler(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    def log_message(self, *args):
        pass

    def do_GET(self):
        body = self.rfile.read(int(self.headers.get('Content-Length', '0')))
        self.server.received.append({'method': self.command, 'path': self.path, 'body': body,
                                     'headers': self.headers})
        response = self.server.response
        if response.get('disconnect'):
            self.connection.shutdown(socket.SHUT_RDWR)
            self.connection.close()
            return
        if response.get('delay'):
            time.sleep(response['delay'])
        payload = response.get('body', b'{}')
        self.send_response(response.get('status', 200))
        self.send_header('Content-Type', response.get('type', 'application/json'))
        self.send_header('Connection', 'close')
        if not response.get('omit_length'):
            self.send_header('Content-Length', str(response.get('length', len(payload))))
        for key, value in response.get('headers', []):
            self.send_header(key, value)
        self.end_headers()
        try:
            if response.get('drip_delay'):
                for byte in payload:
                    self.wfile.write(bytes([byte])); self.wfile.flush()
                    time.sleep(response['drip_delay'])
            else:
                self.wfile.write(payload)
        except OSError:
            pass
        self.close_connection = True

    do_POST = do_GET


@contextmanager
def fixture():
    with tempfile.TemporaryDirectory(prefix='backup-relay-', dir='/tmp') as name:
        path = Path(name).resolve() / 'agent.sock'
        upstream = UnixServer(path)
        server = relay.Relay(('127.0.0.1', 0), path)
        threads = [threading.Thread(target=value.serve_forever, kwargs={'poll_interval': 0.01}, daemon=True)
                   for value in (upstream, server)]
        for thread in threads:
            thread.start()
        try:
            yield server, upstream
        finally:
            for value in (server, upstream):
                value.shutdown(); value.server_close()
            for thread in threads:
                thread.join(timeout=2)


def request(server, method='GET', path='/v1/snapshot', body=b'', extra=None):
    client = http.client.HTTPConnection('127.0.0.1', server.server_port, timeout=3)
    try:
        client.request(method, path, body=body, headers=headers(method, path, body) | (extra or {}))
        response = client.getresponse()
        return response.status, dict(response.headers), response.read()
    finally:
        client.close()


def raw(server, content):
    with socket.create_connection(('127.0.0.1', server.server_port), timeout=3) as client:
        client.sendall(content)
        result = bytearray()
        while True:
            data = client.recv(65536)
            if not data:
                return bytes(result)
            result.extend(data)


class RelayTest(unittest.TestCase):
    def test_exact_body_and_hmac_headers_preserved_for_all_operations(self):
        with fixture() as (server, upstream):
            for method, path in sorted(relay.OPERATIONS):
                body = b'' if method == 'GET' else '{ "actor": "合成账号", "token":"synthetic-token", "spacing": [ 1, 2 ] }\n'.encode()
                status, result_headers, output = request(server, method, path, body,
                                                        {'Cookie': 'must-not-forward', 'Authorization': 'must-not-forward'})
                self.assertEqual((status, output), (200, b'{"safe":"metadata"}'))
                self.assertEqual(result_headers['Cache-Control'], 'no-store')
                received = upstream.received[-1]
                self.assertEqual((received['method'], received['path'], received['body']), (method, path, body))
                for key in relay.HMAC_HEADERS:
                    self.assertEqual(received['headers'][key], headers(method, path, body)[key])
                self.assertIsNone(received['headers'].get('Cookie'))
                self.assertIsNone(received['headers'].get('Authorization'))
                self.assertEqual(received['headers']['Connection'], 'close')
            self.assertEqual(len(upstream.received), len(relay.OPERATIONS))

    def test_fixed_method_and_exact_path_only(self):
        with fixture() as (server, upstream):
            for method, path in (('GET', '/v1/deletions'), ('POST', '/v1/snapshot'),
                                 ('GET', '/v1/snapshot?path=/etc/passwd'), ('GET', 'http://evil.example/v1/snapshot'),
                                 ('POST', '/v1/backup'), ('DELETE', '/v1/deletions'),
                                 ('GET', '/v1/%73napshot'), ('POST', '/v1/deletions/../backup')):
                status, _, _ = request(server, method, path, b'{}' if method == 'POST' else b'')
                self.assertEqual(status, 400)
            self.assertEqual(upstream.received, [])

    def test_missing_duplicate_hmac_headers_rejected_without_forwarding(self):
        with fixture() as (server, upstream):
            for header in relay.HMAC_HEADERS:
                message = b'GET /v1/snapshot HTTP/1.1\r\nHost: test\r\n'
                for key, value in headers('GET', '/v1/snapshot').items():
                    if key != header:
                        message += f'{key}: {value}\r\n'.encode()
                self.assertIn(b'401', raw(server, message + b'\r\n').split(b'\r\n')[0])
            message = b'GET /v1/snapshot HTTP/1.1\r\nHost: test\r\n'
            for key, value in headers('GET', '/v1/snapshot').items():
                message += f'{key}: {value}\r\n'.encode()
            message += b'X-Backup-Nonce: duplicate\r\n\r\n'
            self.assertIn(b'401', raw(server, message).split(b'\r\n')[0])
            self.assertEqual(upstream.received, [])

    def test_invalid_framing_and_encoding_never_forwarded(self):
        with fixture() as (server, upstream):
            examples = [b'Content-Length: 2\r\nContent-Length: 2\r\n',
                        b'Transfer-Encoding: chunked\r\nContent-Length: 2\r\n',
                        b'Transfer-Encoding:\r\nContent-Length: 2\r\n',
                        b'Content-Length: -1\r\n', b'Content-Length: not-number\r\n',
                        b'Content-Length: 65537\r\n', b'']
            signed = b''.join(f'{key}: {value}\r\n'.encode() for key, value in headers('POST', '/v1/deletions', b'{}').items())
            for framing in examples:
                message = b'POST /v1/deletions HTTP/1.1\r\nHost: test\r\n' + signed + framing + b'\r\n{}'
                status_line = raw(server, message).split(b'\r\n')[0]
                self.assertTrue(b'400' in status_line or b'413' in status_line, status_line)
            status, _, _ = request(server, 'GET', '/v1/snapshot', b'{}')
            self.assertEqual(status, 400)
            for extra in ({'Content-Type': 'text/plain'}, {'Content-Encoding': 'gzip'}):
                status, _, _ = request(server, 'POST', '/v1/deletions', b'{}', extra)
                self.assertEqual(status, 400)
            self.assertEqual(upstream.received, [])

    def test_body_limit_allows_exact_64k_but_rejects_larger(self):
        with fixture() as (server, upstream):
            status, _, _ = request(server, 'POST', '/v1/delete-preview', b'x' * relay.MAX_BODY)
            self.assertEqual(status, 200)
            self.assertEqual(len(upstream.received[-1]['body']), relay.MAX_BODY)
            status, _, _ = request(server, 'POST', '/v1/delete-preview', b'x' * (relay.MAX_BODY + 1))
            self.assertEqual(status, 413)
            self.assertEqual(len(upstream.received), 1)

    def test_authentication_and_operation_errors_propagate_exactly(self):
        with fixture() as (server, upstream):
            for code in (400, 401, 403, 409, 422, 429, 503):
                payload = json.dumps({'error': {'code': 'synthetic-auth-or-operation-error'}}).encode()
                upstream.response = {'status': code, 'body': payload,
                                     'headers': [('Set-Cookie', 'must-not-forward'), ('Location', 'must-not-forward')]}
                status, result_headers, output = request(server, 'POST', '/v1/deletions', b'{}')
                self.assertEqual((status, output), (code, payload))
                self.assertNotIn('Set-Cookie', result_headers)
                self.assertNotIn('Location', result_headers)
            self.assertEqual(len(upstream.received), 7)

    def test_delete_disconnect_is_not_retried_and_error_does_not_leak(self):
        with fixture() as (server, upstream):
            upstream.response = {'disconnect': True}
            status, _, body = request(server, 'POST', '/v1/deletions', b'{"token":"synthetic"}')
            self.assertEqual(status, 502)
            self.assertEqual(json.loads(body), {'error': {'code': 'relay_unavailable'}})
            self.assertEqual(len(upstream.received), 1)
            self.assertNotIn(str(server.socket_path).encode(), body)
            self.assertNotIn(b'synthetic', body)

    def test_missing_or_replaced_socket_is_generic_502(self):
        with fixture() as (server, upstream):
            server.socket_path = server.socket_path.with_name('missing.sock')
            status, _, body = request(server)
            self.assertEqual(status, 502)
            self.assertEqual(json.loads(body), {'error': {'code': 'relay_unavailable'}})
            self.assertEqual(upstream.received, [])

    def test_bad_or_oversized_upstream_response_is_bounded_502(self):
        with fixture() as (server, upstream):
            examples = [
                {'body': b'{}', 'length': relay.MAX_RESPONSE + 1},
                {'body': b'{}', 'length': 20},
                {'body': b'x' * (relay.MAX_RESPONSE + 1), 'omit_length': True},
                {'body': b'{}', 'headers': [('Content-Length', '2')]},
                {'body': b'{}', 'headers': [('Transfer-Encoding', 'chunked')]},
                {'body': b'{}', 'headers': [('Content-Encoding', 'gzip')]},
                {'body': b'{}', 'type': 'text/html'},
                {'body': b'{}', 'status': 302, 'headers': [('Location', 'http://evil.example')]},
            ]
            for response in examples:
                upstream.response = response
                status, _, body = request(server)
                self.assertEqual(status, 502, response.keys())
                self.assertLess(len(body), 100)
            self.assertEqual(len(upstream.received), len(examples))

    def test_exact_maximum_upstream_response_supported(self):
        with fixture() as (server, upstream):
            payload = b' ' * relay.MAX_RESPONSE
            upstream.response = {'body': payload}
            status, _, body = request(server)
            self.assertEqual((status, len(body)), (200, relay.MAX_RESPONSE))

    def test_upstream_timeout_is_bounded_and_never_retried(self):
        with fixture() as (server, upstream):
            upstream.response = {'delay': 0.3}
            with patch.object(relay, 'TIMEOUT', 0.1):
                start = time.monotonic()
                status, _, body = request(server, 'POST', '/v1/deletions', b'{}')
                self.assertEqual(status, 502)
                self.assertLess(time.monotonic() - start, 0.7)
            self.assertEqual(len(upstream.received), 1)
            self.assertEqual(json.loads(body), {'error': {'code': 'relay_unavailable'}})

    def test_slow_trickle_response_cannot_extend_absolute_deadline(self):
        with fixture() as (server, upstream):
            upstream.response = {'body': b'x' * 30, 'drip_delay': 0.02}
            with patch.object(relay, 'TIMEOUT', 0.1):
                start = time.monotonic()
                status, _, body = request(server, 'POST', '/v1/deletions', b'{}')
                self.assertEqual(status, 502)
                self.assertLess(time.monotonic() - start, 0.4)
            self.assertEqual(len(upstream.received), 1)
            self.assertEqual(json.loads(body), {'error': {'code': 'relay_unavailable'}})

    def test_public_listeners_and_unsafe_socket_path_rejected(self):
        with tempfile.TemporaryDirectory(prefix='backup-relay-', dir='/tmp') as name:
            path = Path(name).resolve() / 'agent.sock'
            for host in ('8.8.8.8', '224.0.0.1', '169.254.1.1', '::1'):
                with self.assertRaises(ValueError): relay.Relay((host, 0), path)
            for value in ('relative.sock', '/transport/../secret.sock'):
                with self.assertRaises(ValueError): relay.Relay(('127.0.0.1', 0), value)
            link = path.with_name('symlink.sock'); link.symlink_to(path)
            with self.assertRaises(ValueError): relay.Relay(('127.0.0.1', 0), link)
            server = relay.Relay(('0.0.0.0', 0), path)
            server.server_close()

    def test_saturated_server_never_creates_extra_handlers(self):
        with fixture() as (server, upstream):
            acquired = [server.slots.acquire(False) for _ in range(16)]
            self.assertTrue(all(acquired))
            self.assertFalse(server.slots.acquire(False))
            with socket.create_connection(('127.0.0.1', server.server_port), timeout=2) as client:
                client.sendall(b'GET /v1/snapshot HTTP/1.1\r\nHost: test\r\n\r\n')
                try:
                    self.assertEqual(client.recv(1024), b'')
                except ConnectionResetError:
                    pass
            self.assertEqual(upstream.received, [])
            for _ in acquired:
                server.slots.release()


if __name__ == '__main__':
    unittest.main()
