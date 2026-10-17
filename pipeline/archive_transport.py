"""Thread-local persistent HTTPS connections and shared per-host pacing."""
import email.utils
import base64
import http.client
import ssl
import threading
import time
import urllib.parse
import urllib.request


class Transport:
    def __init__(self):
        self.local = threading.local()
        self.context = ssl.create_default_context()

    def request(self, url, *, method='GET', data=None, headers=None, maximum=8 * 1024 * 1024):
        parsed = urllib.parse.urlsplit(url)
        if parsed.scheme != 'https' or parsed.username or parsed.password:
            raise ValueError('HTTPS URL without embedded credentials required')
        connections = getattr(self.local, 'connections', None)
        if connections is None:
            connections = self.local.connections = {}
        authority = (parsed.hostname, parsed.port or 443)
        connection = connections.get(authority)
        if connection is None:
            proxy_url = urllib.request.getproxies().get('https')
            if proxy_url and not urllib.request.proxy_bypass(parsed.hostname):
                proxy = urllib.parse.urlsplit(proxy_url)
                if proxy.scheme != 'http':
                    raise OSError('unsupported HTTPS proxy transport')
                connection = http.client.HTTPSConnection(proxy.hostname, proxy.port or 80, timeout=20, context=self.context)
                tunnel_headers = {}
                if proxy.username is not None:
                    credential = urllib.parse.unquote(proxy.username) + ':' + urllib.parse.unquote(proxy.password or '')
                    tunnel_headers['Proxy-Authorization'] = 'Basic ' + base64.b64encode(credential.encode()).decode()
                connection.set_tunnel(*authority, headers=tunnel_headers)
            else:
                connection = http.client.HTTPSConnection(*authority, timeout=20, context=self.context)
            connections[authority] = connection
        try:
            target = urllib.parse.urlunsplit(('', '', parsed.path or '/', parsed.query, ''))
            connection.request(method, target, body=data, headers=headers or {})
            response = connection.getresponse()
            body = response.read(maximum + 1)
            result = response.status, dict(response.getheaders()), body
            if response.will_close or len(body) > maximum:
                connection.close()
                connections.pop(authority, None)
            return result
        except (OSError, http.client.HTTPException):
            connection.close()
            connections.pop(authority, None)
            raise OSError('HTTPS transport interrupted') from None


class HostPacing:
    def __init__(self, starts_per_second=8):
        self.minimum = 1.0 / starts_per_second
        self.lock = threading.Lock()
        self.hosts = {}

    def acquire(self, host):
        while True:
            with self.lock:
                state = self.hosts.setdefault(host, {'next': 0.0, 'interval': self.minimum, 'success': 0})
                current = time.monotonic()
                delay = max(state['next'], state.get('blocked_until', 0.0)) - current
                if delay <= 0:
                    state['next'] = current + state['interval']
                    return
            # Re-check after waiting so a new Retry-After applies to every worker.
            time.sleep(min(delay, 1.0))

    def observe(self, host, status, headers):
        with self.lock:
            state = self.hosts.setdefault(host, {'next': 0.0, 'interval': self.minimum, 'success': 0})
            if status in (429, 503):
                value = next((v for k, v in headers.items() if k.lower() == 'retry-after'), '')
                try:
                    delay = float(value)
                except ValueError:
                    try:
                        delay = email.utils.parsedate_to_datetime(value).timestamp() - time.time()
                    except (TypeError, ValueError):
                        delay = 10.0
                state['interval'] = min(4.0, state['interval'] * 2)
                state['blocked_until'] = time.monotonic() + max(1.0, delay)
                state['next'] = max(state['next'], time.monotonic() + max(1.0, delay))
                state['success'] = 0
            elif status == 200:
                state['success'] += 1
                if state['success'] >= 64:
                    state['interval'] = max(self.minimum, state['interval'] * 0.9)
                    state['success'] = 0
