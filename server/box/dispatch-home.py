#!/usr/bin/env python3
"""dispatch-home: the home screen every Chrome on this computer shows on a new tab.

One small server serves a different page to each screen, and knows which screen asks by the address
the request came to. Each bot's Chrome reaches the home screen as http://home.localhost:<port>, and is
started with a rule that sends that name to its own screen's loopback address (dispatchlib.home_address),
where this server listens for that screen alone. Another Chrome resolves home.localhost to 127.0.0.1
itself, and gets the plain page that the extension's files and updates are served beside.
"""
import html
import json
import os
import re
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import dispatchlib  # noqa: E402

TEMPLATE = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'home.html')

NEUTRAL = {
    'stamp': 'neutral',
    'bot': {'id': '', 'name': '', 'label': ''},
    'colors': {'accent': '#6b7280', 'ink': '#1f2430', 'wash': '#f1f2f4'},
    'avatarSvg': '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48"><circle cx="24" cy="24" r="20" fill="#fff"/>'
                 '<circle cx="24" cy="24" r="17" fill="#9aa1ad"/></svg>',
    'wallSvg': '<svg xmlns="http://www.w3.org/2000/svg" width="__W__" height="__H__"><defs>'
               '<linearGradient id="n" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#f6f7f8"/>'
               '<stop offset="1" stop-color="#e6e8ec"/></linearGradient></defs>'
               '<rect width="100%" height="100%" fill="url(#n)"/></svg>',
}

# ---------------------------------------------------------------- one listener per screen

class Server(ThreadingHTTPServer):
    """A listener on one address. `screen` is the screen whose Chrome reaches it, or None on 127.0.0.1."""
    daemon_threads = True

    def __init__(self, address, screen):
        self.screen = screen
        super().__init__((address, dispatchlib.HOME_PORT), Handler)


_listeners = {}
_refused = set()


def _dressed_screens():
    try:
        names = os.listdir(dispatchlib.SCREENS)
    except OSError:
        return []
    return [int(name) for name in names if name.isdigit() and os.path.exists(dispatchlib.screen_dir(name) + '/look.json')]


def listen_for_screens():
    """Start a listener for every dressed screen that has none. The dressing waits for it before it
    starts the screen's Chrome (dispatch-screen.py), so a new screen is answered from its first tab."""
    for n in _dressed_screens():
        if n in _listeners:
            continue
        try:
            server = Server(dispatchlib.home_address(n), n)
        except OSError as e:
            if n not in _refused:
                _refused.add(n)
                sys.stderr.write('%s cannot listen for screen %d on %s: %s\n' % (time.strftime('%F %T'), n, dispatchlib.home_address(n), e))
            continue
        _refused.discard(n)
        _listeners[n] = server
        threading.Thread(target=server.serve_forever, daemon=True).start()


def follow_screens():
    while True:
        try:
            listen_for_screens()
        except Exception as e:  # never let one odd folder stop new screens getting their page
            sys.stderr.write('following the screens failed: %r\n' % e)
        time.sleep(0.5)


# ---------------------------------------------------------------- icons

_icon_cache = {}
_ICON_SIZES = ('64x64', '48x48', 'scalable', '128x128', '96x96', '256x256', '32x32', '24x24')
_ICON_KINDS = ('apps', 'places', 'categories', 'devices', 'mimetypes', 'actions', 'legacy')


def find_icon(name):
    if not name:
        return None
    if name in _icon_cache:
        return _icon_cache[name]
    found = None
    if name.startswith('/'):
        found = name if os.path.isfile(name) else None
    else:
        themes = [dispatchlib.icon_theme(), 'Papirus', 'hicolor', 'Adwaita', 'gnome', 'elementary-xfce', 'Humanity']
        roots = ['/usr/share/icons', os.path.expanduser('~/.local/share/icons'), '/usr/local/share/icons']
        for root in roots:
            for theme in themes:
                base = '%s/%s' % (root, theme)
                if not os.path.isdir(base):
                    continue
                for size in _ICON_SIZES:
                    for kind in _ICON_KINDS:
                        for layout in ('%s/%s/%s' % (base, size, kind), '%s/%s/%s' % (base, kind, size.split('x')[0])):
                            for ext in ('svg', 'png'):
                                path = '%s/%s.%s' % (layout, name, ext)
                                if os.path.isfile(path):
                                    found = path
                                    break
                            if found:
                                break
                        if found:
                            break
                    if found:
                        break
                if found:
                    break
            if found:
                break
        if not found:
            for ext in ('svg', 'png', 'xpm'):
                path = '/usr/share/pixmaps/%s.%s' % (name, ext)
                if os.path.isfile(path) and ext != 'xpm':
                    found = path
                    break
    _icon_cache[name] = found
    return found


def letter_icon(label, accent):
    letter = html.escape((label or '?').strip()[:1].upper() or '?')
    return ('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect x="6" y="6" width="52" height="52" rx="14" fill="%s"/>'
            '<text x="32" y="42" font-family="sans-serif" font-size="28" font-weight="600" text-anchor="middle" fill="#fff">%s</text></svg>'
            % (accent, letter)).encode('utf-8')


# ---------------------------------------------------------------- pages

def render_home(look):
    template = dispatchlib.read_text(TEMPLATE)
    if not template:
        return '<!doctype html><title>Home</title><body style="font-family:sans-serif">Home</body>'
    colors = dict(NEUTRAL['colors'])
    colors.update(look.get('colors') or {})
    bot = look.get('bot') or {}
    name = (bot.get('name') or '').strip()
    backdrop = (look.get('wallSvg') or NEUTRAL['wallSvg']).replace('__W__', '100%').replace('__H__', '100%')
    values = {
        'ACCENT': colors['accent'], 'INK': colors['ink'], 'WASH': colors['wash'],
        'STAMP': html.escape(str(look.get('stamp') or ''), quote=True),
        'TITLE': 'Home',
        'GREETING': html.escape('Welcome back, %s' % name if name else 'Welcome back'),
        'LABEL': html.escape((bot.get('label') or '').strip()),
        'AVATAR_SVG': look.get('avatarSvg') or NEUTRAL['avatarSvg'],
        'BACKDROP_SVG': backdrop,
    }
    return re.sub(r'\{\{([A-Z_]+)\}\}', lambda m: values.get(m.group(1), ''), template)


# How Chrome and the box scripts name this server: the bots' Chrome as home.localhost (dispatchlib.SCREEN_HOME_URL),
# the extension's updates and the scripts by its address (dispatchlib.HOME_URL).
LOCAL_HOSTS = ('%s:%d' % (dispatchlib.HOME_HOST, dispatchlib.HOME_PORT), '127.0.0.1:%d' % dispatchlib.HOME_PORT,
               'localhost:%d' % dispatchlib.HOME_PORT)


class Handler(BaseHTTPRequestHandler):
    server_version = 'dispatch-home'
    protocol_version = 'HTTP/1.1'

    def log_message(self, fmt, *args):  # quiet: one line per error only
        if args and str(args[1] if len(args) > 1 else '').startswith(('4', '5')):
            sys.stderr.write('%s %s\n' % (time.strftime('%H:%M:%S'), fmt % args))

    def _send(self, code, body, ctype, cache='no-store'):
        if isinstance(body, str):
            body = body.encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', ctype)
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', cache)
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.end_headers()
        if self.command != 'HEAD':
            self.wfile.write(body)

    def _json(self, code, obj):
        self._send(code, json.dumps(obj), 'application/json')

    def _named_us(self):
        """Whether the request names this server as Chrome reaches it. A web page that points its own
        name at 127.0.0.1 (DNS rebinding) still sends that name, and gets nothing: the bots' names
        and roles are on the home page."""
        if self.headers.get('Host') in LOCAL_HOSTS:
            return True
        self._send(403, 'Forbidden', 'text/plain')
        return False

    def _look(self):
        n = self.server.screen
        look = dispatchlib.look_for(n) if n is not None else None
        return n, (look or NEUTRAL)

    def do_GET(self):
        if not self._named_us():
            return
        url = urlparse(self.path)
        query = parse_qs(url.query)
        path = url.path
        try:
            if path in ('/', '/home'):
                _, look = self._look()
                self._send(200, render_home(look), 'text/html; charset=utf-8')
            elif path == '/stamp':
                n, look = self._look()
                self._json(200, {'stamp': str(look.get('stamp') or ''), 'screen': n})
            elif path == '/apps':
                apps = [{'id': a['id'], 'name': a['name'], 'kind': a['kind']} for a in dispatchlib.list_apps()]
                self._json(200, {'apps': apps})
            elif path == '/icon':
                app = dispatchlib.find_app((query.get('id') or [''])[0])
                icon = find_icon(app['icon']) if app else None
                if icon:
                    with open(icon, 'rb') as f:
                        data = f.read()
                    self._send(200, data, 'image/svg+xml' if icon.endswith('.svg') else 'image/png', 'max-age=300')
                else:
                    _, look = self._look()
                    accent = (look.get('colors') or {}).get('accent', '#6b7280')
                    self._send(200, letter_icon(app['name'] if app else '?', accent), 'image/svg+xml', 'max-age=60')
            elif path == '/favicon.svg' or path == '/favicon.ico':
                _, look = self._look()
                self._send(200, look.get('avatarSvg') or NEUTRAL['avatarSvg'], 'image/svg+xml', 'max-age=60')
            elif path == '/ext/updates.xml':
                data = dispatchlib.read_text(dispatchlib.EXT + '/updates.xml')
                if data is None:
                    self._send(404, 'not built', 'text/plain')
                else:
                    self._send(200, data, 'application/xml')
            elif path == '/ext/home.crx':
                try:
                    with open(dispatchlib.EXT + '/home.crx', 'rb') as f:
                        self._send(200, f.read(), 'application/x-chrome-extension')
                except OSError:
                    self._send(404, 'not built', 'text/plain')
            elif path == '/health':
                self._json(200, {'ok': True, 'pid': os.getpid()})
            else:
                self._send(404, 'Not found', 'text/plain')
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception as e:  # never let one bad request take the server down
            sys.stderr.write('error on %s: %r\n' % (self.path, e))
            try:
                self._send(500, 'error', 'text/plain')
            except Exception:
                pass

    do_HEAD = do_GET

    def do_POST(self):
        url = urlparse(self.path)
        length = min(int(self.headers.get('Content-Length') or 0), 4096)
        raw = self.rfile.read(length) if length else b''
        if not self._named_us():
            return
        if url.path != '/launch':
            self._send(404, 'Not found', 'text/plain')
            return
        # Only our own page may launch apps: a same-origin fetch that carries our custom header.
        site = self.headers.get('Sec-Fetch-Site')
        origin = self.headers.get('Origin')
        if self.headers.get('X-Dispatch') != '1' or (site and site != 'same-origin') or (origin and origin != dispatchlib.SCREEN_HOME_URL):
            self._json(403, {'ok': False, 'error': 'forbidden'})
            return
        try:
            app_id = str(json.loads(raw.decode('utf-8') or '{}').get('id') or '')
        except ValueError:
            app_id = ''
        n = self.server.screen
        if n is None or not dispatchlib.find_app(app_id):
            self._json(404, {'ok': False, 'error': 'unknown app or screen'})
            return
        try:
            dispatchlib.launch_app(n, app_id)
            self._json(200, {'ok': True})
        except Exception as e:
            sys.stderr.write('launch %s on %s failed: %r\n' % (app_id, n, e))
            self._json(500, {'ok': False, 'error': 'could not start'})


def main():
    server = Server('127.0.0.1', None)
    listen_for_screens()
    threading.Thread(target=follow_screens, daemon=True).start()
    dispatchlib.write_atomic(dispatchlib.ROOT + '/home.pid', str(os.getpid()))
    sys.stderr.write('%s dispatch-home listening on %s\n' % (time.strftime('%F %T'), dispatchlib.HOME_URL))
    sys.stderr.flush()
    server.serve_forever()


if __name__ == '__main__':
    main()
