"""Tests for dispatchlib that need no display: `npm run test:box` (part of `npm test`)."""
import json
import multiprocessing
import os
import tempfile
import time
import unittest

import dispatchlib


def hold_for(path, seconds, ready):
    with dispatchlib.held_lock(path):
        ready.set()
        time.sleep(seconds)


class HeldLock(unittest.TestCase):
    def setUp(self):
        self.path = os.path.join(tempfile.mkdtemp(), 'jobs', 'dress-100.lock')

    def other_process_holds(self, seconds):
        ready = multiprocessing.Event()
        p = multiprocessing.Process(target=hold_for, args=(self.path, seconds, ready))
        p.start()
        ready.wait(5)
        return p

    def test_waits_for_the_holder(self):
        p = self.other_process_holds(0.5)
        start = time.time()
        with dispatchlib.held_lock(self.path, timeout=5) as held:
            self.assertTrue(held)
            self.assertGreaterEqual(time.time() - start, 0.3)
        p.join()

    def test_gives_up_after_the_timeout(self):
        p = self.other_process_holds(2)
        start = time.time()
        with dispatchlib.held_lock(self.path, timeout=0.3) as held:
            self.assertFalse(held)
        self.assertLess(time.time() - start, 1.5)
        p.join()

    def test_free_lock_is_taken_at_once(self):
        with dispatchlib.held_lock(self.path, timeout=0) as held:
            self.assertTrue(held)

    def test_dress_lock_is_the_dressing_jobs_lock(self):
        # dispatch-screen.py's run_job locks JOBS/<job name>.lock, and dressing jobs are named dress-<n>.
        self.assertEqual(dispatchlib.dress_lock(101), dispatchlib.JOBS + '/dress-101.lock')


class Machine(unittest.TestCase):
    """The scripts read machine.json, as server/src/machine.ts does (test/machine.test.ts)."""

    def setUp(self):
        with open(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'machine.json')) as f:
            self.machine = json.load(f)

    def test_folders_and_ports_come_from_machine_json(self):
        m = self.machine
        self.assertEqual(dispatchlib.ROOT, m['boxRoot'])
        self.assertEqual(dispatchlib.LOGS, m['logs'])
        self.assertEqual(dispatchlib.RUN, m['run'])
        self.assertEqual(dispatchlib.PROFILES, m['botsRoot'] + '/profiles')
        self.assertEqual(dispatchlib.LIBRARY, m['botsRoot'] + '/files')
        self.assertEqual(dispatchlib.HOME_URL, 'http://127.0.0.1:%d' % m['homePort'])
        self.assertEqual(dispatchlib.cdp_port(99), m['cdpPortBase'] + 99)

    def test_the_extension_names_the_home_screen_only_through_its_placeholder(self):
        ext = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'ext')
        for name in ('newtab.html', 'newtab.js'):
            with open(os.path.join(ext, name)) as f:
                text = f.read()
            self.assertIn('__HOME_URL__', text)
            self.assertNotIn('127.0.0.1', text)


class Units(unittest.TestCase):
    """What the box scripts start runs as systemd units, named as server/src/units.ts names them."""

    def test_bot_ids_are_escaped_as_systemd_escape_and_units_ts_do_it(self):
        # The same ids as server/test/units.test.ts.
        self.assertEqual(dispatchlib.unit_key('bot_Ab9_x'), 'bot_Ab9_x')
        self.assertEqual(dispatchlib.unit_key('bot_ab-cd'), 'bot_ab\\x2dcd')
        self.assertEqual(dispatchlib.bot_slice('bot_ab-cd'), 'dispatch-bot-bot_ab\\x2dcd.slice')
        self.assertEqual(dispatchlib.chrome_unit('bot_ab-cd'), 'dispatch-chrome-bot_ab\\x2dcd.service')

    def test_a_service_gets_its_environment_folder_and_slice_from_systemd_run(self):
        argv = dispatchlib.service_argv('dispatch-chrome-bot_1.service', 'dispatch-bot-bot_1.slice', ['/opt/google/chrome/chrome', '--x'],
                                        {'DISPLAY': ':101', 'HOME': '/root'})
        self.assertEqual(argv[:5], ['systemd-run', '--quiet', '--collect', '--unit=dispatch-chrome-bot_1.service', '--slice=dispatch-bot-bot_1.slice'])
        self.assertIn('--working-directory=/root', argv)
        self.assertIn('--setenv=DISPLAY=:101', argv)
        self.assertEqual(argv[argv.index('--'):], ['--', '/opt/google/chrome/chrome', '--x'])

    def test_a_scope_runs_the_program_in_place_in_its_slice(self):
        self.assertEqual(dispatchlib.scope_argv('dispatch-term-101-5.scope', 'dispatch-bot-bot_1.slice', ['xfce4-terminal']),
                         ['systemd-run', '--scope', '--quiet', '--collect', '--unit=dispatch-term-101-5.scope',
                          '--slice=dispatch-bot-bot_1.slice', '--', 'xfce4-terminal'])

    def test_what_opens_on_a_screen_goes_in_its_bots_slice_and_undressing_finds_it(self):
        root = tempfile.mkdtemp()
        old = dispatchlib.SCREENS
        dispatchlib.SCREENS = root
        try:
            self.assertEqual(dispatchlib.screen_slice(101), dispatchlib.DISPLAYS_SLICE)
            dispatchlib.write_json(root + '/101/look.json', {'bot': {'id': 'bot_ab-cd'}})
            self.assertEqual(dispatchlib.screen_slice(101), 'dispatch-bot-bot_ab\\x2dcd.slice')
        finally:
            dispatchlib.SCREENS = old
        self.assertEqual(dispatchlib.screen_scopes(101), ['dispatch-term-101-*.scope', 'dispatch-files-101-*.scope', 'dispatch-app-101-*.scope'])


if __name__ == '__main__':
    unittest.main()
