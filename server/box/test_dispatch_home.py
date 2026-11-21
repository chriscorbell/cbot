"""How the home screen server knows which screen asks: by the address the request came to, one per
dressed screen (dispatchlib.home_address), which that screen's Chrome alone is sent to."""
import http.client
import importlib.util
import json
import os
import pwd
import socket
import tempfile
import threading
import unittest
from unittest import mock

# dispatchlib finds the bots' account when it loads, and refuses to without one: the tests' own.
os.environ.setdefault('DISPATCH_USER', pwd.getpwuid(os.getuid()).pw_name)
import dispatchlib  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
_spec = importlib.util.spec_from_file_location('dispatch_home', os.path.join(HERE, 'dispatch-home.py'))
home = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(home)


def can_bind(address):
    """Linux answers on all of 127.0.0.0/8; some systems only on 127.0.0.1."""
    try:
        with socket.socket() as s:
            s.bind((address, 0))
        return True
    except OSError:
        return False


class Addresses(unittest.TestCase):
    def test_each_screen_has_a_loopback_address_of_its_own_clear_of_127_0_0_1(self):
        self.assertEqual(dispatchlib.home_address(99), '127.1.0.99')
        self.assertEqual(dispatchlib.home_address(100), '127.1.0.100')
        self.assertEqual(dispatchlib.home_address(300), '127.1.1.44')
        self.assertEqual(len({dispatchlib.home_address(n) for n in range(99, 400)}), 301)

    def test_a_bots_chrome_sends_the_home_screens_name_to_its_screens_address(self):
        self.assertEqual(dispatchlib.home_rule(100), 'MAP home.localhost 127.1.0.100')
        self.assertEqual(dispatchlib.SCREEN_HOME_URL, 'http://home.localhost:%d' % dispatchlib.HOME_PORT)
        # The rule is one argument, and the running Chrome is checked for it the same way.
        self.assertIn(dispatchlib.home_rule(100), ' '.join(['chrome', '--host-resolver-rules=' + dispatchlib.home_rule(100)]))


@unittest.skipUnless(can_bind('127.1.0.100'), 'this system answers only on 127.0.0.1')
class Listeners(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        screens = self.tmp.name + '/screens'
        look = {'stamp': 'ada1', 'bot': {'id': 'bot_a', 'name': 'Ada', 'label': 'Research'},
                'colors': {'accent': '#1E86FC', 'ink': '#111111', 'wash': '#eeeeee'}}
        os.makedirs(screens + '/100')
        os.makedirs(screens + '/101')      # a screen undressed: no look, so no listener
        with open(screens + '/100/look.json', 'w') as f:
            json.dump(look, f)
        # Any free port: what matters is the address a request comes to.
        self.patches = [mock.patch.object(dispatchlib, 'SCREENS', screens), mock.patch.object(dispatchlib, 'HOME_PORT', 0),
                        mock.patch.object(home.Handler, 'log_message')]
        for p in self.patches:
            p.start()
        self.main = home.Server('127.0.0.1', None)
        threading.Thread(target=self.main.serve_forever, daemon=True).start()
        home.listen_for_screens()

    def tearDown(self):
        for server in [self.main] + list(home._listeners.values()):
            server.shutdown()
            server.server_close()
        home._listeners.clear()
        for p in self.patches:
            p.stop()
        self.tmp.cleanup()

    def request(self, server, method, path, body=None, headers=None):
        conn = http.client.HTTPConnection(*server.server_address, timeout=5)
        sent = {'Host': home.LOCAL_HOSTS[0]}
        sent.update(headers or {})
        conn.request(method, path, body=body, headers=sent)
        r = conn.getresponse()
        data = r.read()
        conn.close()
        return r.status, data

    def test_only_dressed_screens_get_a_listener_on_their_own_address(self):
        self.assertEqual(sorted(home._listeners), [100])
        self.assertEqual(home._listeners[100].server_address[0], '127.1.0.100')
        self.assertEqual(home._listeners[100].screen, 100)

    def test_a_screens_chrome_gets_its_bots_page_and_anyone_else_the_plain_one(self):
        status, page = self.request(home._listeners[100], 'GET', '/home')
        self.assertEqual(status, 200)
        self.assertIn(b'Welcome back, Ada', page)
        status, stamp = self.request(home._listeners[100], 'GET', '/stamp')
        self.assertEqual(json.loads(stamp), {'stamp': 'ada1', 'screen': 100})
        # 127.0.0.1 never says whose screen it is, whatever the request asks for.
        status, page = self.request(self.main, 'GET', '/home?screen=100')
        self.assertNotIn(b'Ada', page)
        self.assertEqual(json.loads(self.request(self.main, 'GET', '/stamp')[1])['screen'], None)

    def test_the_page_by_its_old_address_sends_a_chrome_on_to_its_screens_own(self):
        conn = http.client.HTTPConnection(*self.main.server_address, timeout=5)
        conn.request('GET', '/home', headers={'Host': home.LOCAL_HOSTS[1]})          # 127.0.0.1:<port>
        r = conn.getresponse()
        r.read()
        conn.close()
        self.assertEqual(r.status, 302)
        self.assertEqual(r.getheader('Location'), dispatchlib.SCREEN_HOME_URL + '/home')
        # By that name, a Chrome without a screen of its own comes back here and gets the plain page.
        status, page = self.request(self.main, 'GET', '/home')
        self.assertEqual(status, 200)
        self.assertNotIn(b'Ada', page)

    def test_a_request_that_names_another_host_gets_nothing(self):
        status, _ = self.request(home._listeners[100], 'GET', '/home', headers={'Host': 'evil.example:%d' % dispatchlib.HOME_PORT})
        self.assertEqual(status, 403)

    def test_apps_open_on_the_screen_whose_address_the_page_came_from(self):
        launch = {'X-Dispatch': '1', 'Origin': dispatchlib.SCREEN_HOME_URL, 'Sec-Fetch-Site': 'same-origin',
                  'Content-Type': 'application/json'}
        with mock.patch.object(dispatchlib, 'find_app', return_value={'id': 'terminal'}), \
                mock.patch.object(dispatchlib, 'launch_app') as launch_app:
            status, _ = self.request(home._listeners[100], 'POST', '/launch', b'{"id": "terminal"}', launch)
            self.assertEqual(status, 200)
            launch_app.assert_called_once_with(100, 'terminal')
            # Not from a screen's address: there is no screen to open it on.
            status, _ = self.request(self.main, 'POST', '/launch', b'{"id": "terminal"}', launch)
            self.assertEqual(status, 404)
            # Not from the home page itself.
            status, _ = self.request(home._listeners[100], 'POST', '/launch', b'{"id": "terminal"}',
                                     dict(launch, Origin='http://127.0.0.1:%d' % dispatchlib.HOME_PORT))
            self.assertEqual(status, 403)
            self.assertEqual(launch_app.call_count, 1)


if __name__ == '__main__':
    unittest.main()
