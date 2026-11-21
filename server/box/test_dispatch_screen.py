"""What dispatch-screen.py answers the server (server/src/desk.ts), and how it knows its setup is current.
Nothing here starts a display, a unit or a job: what would is replaced in each test."""
import base64
import contextlib
import gzip
import importlib.util
import io
import json
import os
import pwd
import tempfile
import unittest
from unittest import mock

# dispatchlib finds the bots' account when it loads, and refuses to without one: the tests' own.
os.environ.setdefault('DISPATCH_USER', pwd.getpwuid(os.getuid()).pw_name)
import dispatchlib  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
_spec = importlib.util.spec_from_file_location('dispatch_screen', os.path.join(HERE, 'dispatch-screen.py'))
screen = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(screen)


def look_arg(stamp='s1', bot='bot_a'):
    return base64.b64encode(gzip.compress(json.dumps({'stamp': stamp, 'bot': {'id': bot}}).encode())).decode()


def run(*argv):
    out = io.StringIO()
    with contextlib.redirect_stdout(out):
        screen.main(list(argv))
    return json.loads(out.getvalue())


class Answers(unittest.TestCase):
    def test_a_screen_already_dressed_answers_done_without_a_job(self):
        with mock.patch.object(screen, 'screen_ok', return_value=True) as ok, mock.patch.object(screen, 'start_job') as job:
            self.assertEqual(run('dress', '100', '-', look_arg()), {'done': {'ok': True, 'already': True, 'warnings': []}})
        ok.assert_called_once_with(100, 's1', 'bot_a')
        job.assert_not_called()

    def test_dressing_goes_on_in_a_job_whose_result_file_the_answer_names(self):
        with tempfile.TemporaryDirectory() as jobs, \
                mock.patch.object(screen, 'JOBS', jobs), \
                mock.patch.object(screen, 'screen_ok', return_value=False), \
                mock.patch.object(dispatchlib, 'spawn', return_value=4242) as spawn:
            answer = run('dress', '100', '-', look_arg())
            self.assertEqual(answer['pid'], 4242)
            self.assertTrue(answer['job'].startswith('dress-100-'))
            self.assertEqual(answer['result'], os.path.join(jobs, answer['job'] + '.json'))
        argv = spawn.call_args[0][0]
        self.assertEqual(argv[2:5], ['_job', answer['job'], 'dress-100'])
        self.assertEqual(spawn.call_args[0][3], 'dispatch-job-%s.scope' % answer['job'])

    def test_a_flag_always_dresses_again(self):
        with mock.patch.object(screen, 'screen_ok', return_value=True), \
                mock.patch.object(screen, 'start_job', return_value={'job': 'j', 'pid': 1, 'result': '/r'}) as job:
            self.assertEqual(run('dress', '100', 'x', look_arg())['job'], 'j')
        job.assert_called_once_with('dress-100', ['100', 'x', look_arg()])

    def test_setup_runs_as_a_job_only_when_it_is_not_current(self):
        with mock.patch.object(screen, 'base_current', return_value=True), \
                mock.patch.object(screen, 'start_home', return_value=True), mock.patch.object(screen, 'start_job') as job:
            self.assertTrue(run('base')['done']['ok'])
        job.assert_not_called()
        with mock.patch.object(screen, 'base_current', return_value=False), \
                mock.patch.object(screen, 'start_job', return_value={'job': 'base-1', 'pid': 1, 'result': '/r'}) as job:
            self.assertEqual(run('base')['job'], 'base-1')
        job.assert_called_once_with('base', [])

    def test_a_command_it_does_not_know_exits_2(self):
        for argv in (['go', '100'], ['wait', 'job', '25'], ['base', 'abc'], []):
            with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit) as stop:
                screen.main(argv)
            self.assertEqual(stop.exception.code, 2)

    def test_a_job_that_crashes_writes_a_failure_with_its_trace(self):
        with tempfile.TemporaryDirectory() as jobs, mock.patch.object(screen, 'JOBS', jobs), \
                mock.patch.object(screen, 'log'), mock.patch.object(screen, 'do_dress', side_effect=KeyError('bot')):
            screen.run_job('dress-100-1', 'dress-100', ['100', '-', look_arg()])
            with open(os.path.join(jobs, 'dress-100-1.json')) as f:
                result = json.load(f)
        self.assertFalse(result['ok'])
        self.assertTrue(result['crashed'])
        self.assertEqual(result['error'], "KeyError: 'bot'")
        self.assertIn('Traceback', result['trace'])


class Setup(unittest.TestCase):
    def test_setup_is_current_only_for_these_very_scripts(self):
        version = dispatchlib.code_version()
        self.assertRegex(version, r'^[0-9a-f]{20}$')
        with tempfile.TemporaryDirectory() as root, mock.patch.object(screen, 'ROOT', root):
            self.assertFalse(screen.base_current())
            for recorded, current in (({'hash': 'old'}, False), ({'code': 'other'}, False), ({'code': version}, True)):
                dispatchlib.write_json(root + '/base.json', recorded)
                self.assertEqual(screen.base_current(), current)

    def test_the_copies_earlier_versions_ran_from_go_and_the_state_stays(self):
        with tempfile.TemporaryDirectory() as root, mock.patch.object(screen, 'ROOT', root):
            for name in ('dispatchlib.py', 'dispatch-screen.py', 'home.html', 'machine.json', 'bundle.json.gz',
                         'ext/src/manifest.json', '__pycache__/dispatchlib.pyc',
                         'ext/home.crx', 'ext/state.json', 'home-extension.pem', 'base.json', 'screens/100/look.json'):
                os.makedirs(os.path.dirname(os.path.join(root, name)), exist_ok=True)
                open(os.path.join(root, name), 'w').close()
            screen.forget_old_copies()
            left = sorted(os.path.relpath(os.path.join(d, f), root) for d, _, files in os.walk(root) for f in files)
        self.assertEqual(left, ['base.json', 'ext/home.crx', 'ext/state.json', 'home-extension.pem', 'screens/100/look.json'])

    def test_the_extension_is_packed_from_the_scripts_own_folder(self):
        self.assertTrue(os.path.isfile(os.path.join(screen.HERE, 'ext', 'manifest.json')))
        self.assertEqual(dispatchlib.SCRIPTS, HERE)


if __name__ == '__main__':
    unittest.main()
