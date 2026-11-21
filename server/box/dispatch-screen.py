#!/usr/bin/env python3
"""dispatch-screen: makes X display :N look like one bot's own computer, and undoes it.

The server (server/src/desk.ts) runs it from where the release put it, beside the other box scripts,
with one command per action:

  base                 the one-time machine setup, again whenever these scripts change
  dress N FLAGS LOOK   dress screen N (FLAGS: letters r=restart Chrome, x=reset windows, or -)
  undress N BOT        stop what we run on screen N

Each answers one JSON object on stdout and exits 0: {"done": RESULT} when the work is finished, or
{"job": ID, "pid": PID, "result": FILE} when it goes on in a job of its own, which writes RESULT to
FILE when it ends. RESULT is {"ok": true|false, "error": ..., "warnings": [...], ...}. Anything else
(a traceback on stderr and a non-zero exit) is a bug in these scripts, and the server says so.
"""
import base64
import gzip
import hashlib
import io
import json
import os
import shutil
import struct
import subprocess
import sys
import time
import traceback
import urllib.request
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import dispatchlib  # noqa: E402
from dispatchlib import ROOT, JOBS, EXT, LOGS  # noqa: E402

POLICY_DIRS = ('/etc/opt/chrome/policies/managed', '/etc/chromium/policies/managed')
POLICY_NAME = 'dispatch.json'
# The GTK settings of the bots' account, whose apps (terminals, file manager) open on the screens.
GTK_SETTINGS = dispatchlib.ACCOUNT_HOME + '/.config/gtk-3.0/settings.ini'


class Fatal(Exception):
    """The screen would be unusable; the caller should hear about it."""


def log(*parts):
    os.makedirs(LOGS, exist_ok=True)
    with open(LOGS + '/screen.log', 'a') as f:
        f.write('%s [%d] %s\n' % (time.strftime('%F %T'), os.getpid(), ' '.join(str(p) for p in parts)))


# ---------------------------------------------------------------- jobs

def answer(obj):
    """The one JSON line the server reads (see the docstring above)."""
    sys.stdout.write(json.dumps(obj) + '\n')


def start_job(name, argv):
    """Start `name` as a detached job. Returns the answer that tells the server where to find its result."""
    os.makedirs(JOBS, exist_ok=True)
    now = time.time()
    for old in os.listdir(JOBS):
        full = os.path.join(JOBS, old)
        try:
            if old.endswith('.json') and now - os.path.getmtime(full) > 3600:
                os.unlink(full)
        except OSError:
            pass
    job = '%s-%d-%d' % (name, int(now * 1000), os.getpid())
    # In a scope of its own, so a restart of the server doesn't cut a dressing short. It stays root:
    # setting up writes Chrome's policies under /etc, and dressing starts units in a bot's slice.
    pid = dispatchlib.spawn([sys.executable, os.path.abspath(__file__), '_job', job, name] + argv, dict(os.environ), 'jobs',
                            'dispatch-job-%s.scope' % job, dispatchlib.MACHINE_SLICE, cwd='/', account=False)
    return {'job': job, 'pid': pid, 'result': job_result(job)}


def job_result(job):
    return '%s/%s.json' % (JOBS, job)


def run_job(job, name, argv):
    """Body of a detached job: one at a time per name, result written where the caller looks for it."""
    result = {'ok': True, 'warnings': []}
    started = time.time()
    try:
        with dispatchlib.held_lock('%s/%s.lock' % (JOBS, name)):
            if name == 'base':
                result.update(do_base(result['warnings']))
            elif name.startswith('dress-'):
                result.update(do_dress(int(argv[0]), argv[1], argv[2], result['warnings']))
            else:
                raise Fatal('unknown job %s' % name)
    except Fatal as e:
        result.update(ok=False, error=str(e))
    except Exception as e:  # a bug or an odd machine: a failure the server reports with its trace
        trace = traceback.format_exc()
        log('job %s crashed:\n%s' % (job, trace))
        result.update(ok=False, error='%s: %s' % (type(e).__name__, e), crashed=True, trace=trace[-4000:])
    result['seconds'] = round(time.time() - started, 2)
    log('job %s finished: ok=%s %.1fs warnings=%s %s' % (job, result['ok'], result['seconds'], result['warnings'],
                                                      result.get('error', '')))
    dispatchlib.write_atomic(job_result(job), json.dumps(result))


# ---------------------------------------------------------------- one-time machine setup

def home_alive():
    return dispatchlib.unit_active(dispatchlib.HOME_UNIT)


def start_home(restart=False):
    """The home screen server, as dispatch-home.service (journalctl -u dispatch-home says how it went).
    It stays root: it starts the apps a bot's home screen asks for, as the bots' account, in the bot's
    slice, which only root may do."""
    if restart:
        dispatchlib.stop_units(dispatchlib.HOME_UNIT)
    elif home_alive():
        return True
    env = dispatchlib.base_env(99, account=False)
    for key in ('DISPLAY', 'GTK_THEME'):
        env.pop(key, None)
    try:
        dispatchlib.start_service(dispatchlib.HOME_UNIT, dispatchlib.MACHINE_SLICE, [sys.executable, os.path.join(HERE, 'dispatch-home.py')], env,
                                  cwd='/', account=False)
    except RuntimeError as e:
        log(str(e))
        return False
    end = time.time() + 8
    while time.time() < end:
        try:
            urllib.request.urlopen(dispatchlib.HOME_URL + '/health', timeout=1).read()
            return True
        except Exception:
            time.sleep(0.2)
    return False


def gtk_works():
    code, _ = dispatchlib.run([sys.executable, '-c',
                         "import gi; gi.require_version('Gtk','3.0'); gi.require_version('GdkPixbuf','2.0'); "
                         "from gi.repository import Gtk, Gdk, GdkPixbuf; import cairo"],
                        env={k: v for k, v in dispatchlib.base_env(99, account=False).items() if k != 'DISPLAY'}, timeout=20)
    return code == 0


# What the scripts run on a screen, all installed by scripts/provision.sh. Setup only says when one is
# missing; installing packages is provisioning's job, not something a dressing should do.
TOOLS = ('wmctrl', 'xdotool', 'xprop', 'xdpyinfo', 'xsetroot', 'dbus-daemon', 'openssl')


def missing_tools():
    return [tool for tool in TOOLS if not shutil.which(tool)]


def _varint(value):
    out = bytearray()
    while True:
        byte = value & 0x7F
        value >>= 7
        out.append(byte | (0x80 if value else 0))
        if not value:
            return bytes(out)


def _field(number, data):
    return _varint((number << 3) | 2) + _varint(len(data)) + data


def build_extension(warnings):
    """Pack the new-tab extension as a signed CRX3 with a key that never leaves this computer.

    The key is Dispatch's, so it stays root's, in the scripts' state folder; a computer set up again makes
    a new one, and Chrome takes the new extension from the policy.
    """
    src = os.path.join(HERE, 'ext')
    key = os.path.join(ROOT, 'home-extension.pem')
    os.makedirs(os.path.dirname(key), exist_ok=True)
    state_path = EXT + '/state.json'
    state = dispatchlib.read_json(state_path) or {}
    if not shutil.which('openssl'):
        warnings.append('openssl is missing, so the home screen extension cannot be packed')
        return state
    if not os.path.exists(key):
        code, out = dispatchlib.run(['openssl', 'genrsa', '-out', key, '2048'], timeout=60)
        if code != 0:
            warnings.append('could not create the extension key: %s' % out.strip()[:120])
            return state
        os.chmod(key, 0o600)
    der = subprocess.run(['openssl', 'rsa', '-in', key, '-pubout', '-outform', 'DER'], stdin=subprocess.DEVNULL,
                         stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=30).stdout
    if not der:
        warnings.append('could not read the extension key')
        return state
    digest = hashlib.sha256(der).digest()
    ext_id = ''.join(chr(97 + (b >> 4)) + chr(97 + (b & 15)) for b in digest[:16])
    names = sorted(os.listdir(src))
    # The pages name the home screen server as __HOME_URL__; the port comes from machine.json, so a
    # change there repacks the extension too.
    home_url = dispatchlib.HOME_URL.encode()
    content = hashlib.sha256(home_url + b'\0')
    for name in names:
        content.update(name.encode() + b'\0' + open(os.path.join(src, name), 'rb').read() + b'\0')
    src_hash = content.hexdigest()
    if state.get('hash') == src_hash and state.get('id') == ext_id and os.path.exists(EXT + '/home.crx'):
        return state
    build = int(state.get('build') or 0) + 1
    version = '1.0.%d' % build
    packed = io.BytesIO()
    with zipfile.ZipFile(packed, 'w', zipfile.ZIP_DEFLATED) as z:
        for name in names:
            data = open(os.path.join(src, name), 'rb').read().replace(b'__HOME_URL__', home_url)
            if name == 'manifest.json':
                manifest = json.loads(data.decode('utf-8'))
                manifest['version'] = version
                data = json.dumps(manifest, indent=2).encode('utf-8')
            z.writestr(zipfile.ZipInfo(name, (2024, 1, 1, 0, 0, 0)), data)
    archive = packed.getvalue()
    signed_data = _field(1, digest[:16])
    to_sign = b'CRX3 SignedData\x00' + struct.pack('<I', len(signed_data)) + signed_data + archive
    signature = subprocess.run(['openssl', 'dgst', '-sha256', '-sign', key], input=to_sign, stdout=subprocess.PIPE,
                               stderr=subprocess.DEVNULL, timeout=30).stdout
    if not signature:
        warnings.append('could not sign the home screen extension')
        return state
    header = _field(2, _field(1, der) + _field(2, signature)) + _field(10000, signed_data)
    dispatchlib.write_atomic(EXT + '/home.crx', b'Cr24' + struct.pack('<II', 3, len(header)) + header + archive)
    dispatchlib.write_atomic(EXT + '/updates.xml', (
        "<?xml version='1.0' encoding='UTF-8'?>\n"
        "<gupdate xmlns='http://www.google.com/update2/response' protocol='2.0'>\n"
        "  <app appid='%s'>\n    <updatecheck codebase='%s/ext/home.crx' version='%s' />\n  </app>\n</gupdate>\n"
        % (ext_id, dispatchlib.HOME_URL, version)))
    state = {'id': ext_id, 'hash': src_hash, 'build': build, 'version': version}
    dispatchlib.write_json(state_path, state)
    log('packed extension', ext_id, version)
    return state


def write_policy(ext_id, warnings):
    """Machine-wide: every Chrome on this computer gets the home screen extension."""
    policy = {
        'ExtensionInstallForcelist': ['%s;%s/ext/updates.xml' % (ext_id, dispatchlib.HOME_URL)],
        'NTPFooterExtensionAttributionEnabled': False,
        'NTPFooterManagementNoticeEnabled': False,
        'CommandLineFlagSecurityWarningsEnabled': False,
        # 1 = DevTools may attach everywhere. Without it Chrome refuses to let a DevTools client
        # (the bot's browser driver) talk to a tab that shows a policy-installed extension page,
        # which is exactly what the home screen is: the tab accepts the connection and never answers.
        'DeveloperToolsAvailability': 1,
    }
    text = json.dumps(policy, indent=2) + '\n'
    wrote = []
    for folder in POLICY_DIRS:
        if folder != POLICY_DIRS[0] and not os.path.isdir(os.path.dirname(os.path.dirname(folder))):
            continue
        path = os.path.join(folder, POLICY_NAME)
        try:
            if dispatchlib.read_text(path) != text:
                dispatchlib.write_atomic(path, text)
            wrote.append(path)
        except OSError as e:
            warnings.append('could not write Chrome policy %s: %s' % (path, e))
    return wrote


def write_gtk_settings(warnings):
    """Machine-wide (for this user): GTK apps start light instead of dark."""
    wanted = {
        'gtk-theme-name': dispatchlib.light_theme(),
        'gtk-icon-theme-name': dispatchlib.icon_theme(),
        'gtk-application-prefer-dark-theme': '0',
    }
    try:
        lines = (dispatchlib.read_text(GTK_SETTINGS) or '[Settings]\n').splitlines()
        if not os.path.exists(GTK_SETTINGS + '.before-dispatch') and os.path.exists(GTK_SETTINGS):
            shutil.copy2(GTK_SETTINGS, GTK_SETTINGS + '.before-dispatch')
        out, seen = [], set()
        for line in lines:
            key = line.split('=', 1)[0].strip()
            if key in wanted:
                out.append('%s=%s' % (key, wanted[key]))
                seen.add(key)
            else:
                out.append(line)
        if not any(l.strip() == '[Settings]' for l in out):
            out.insert(0, '[Settings]')
        out += ['%s=%s' % (k, v) for k, v in wanted.items() if k not in seen]
        text = '\n'.join(out) + '\n'
        if dispatchlib.read_text(GTK_SETTINGS) != text:
            dispatchlib.write_owned(GTK_SETTINGS, text)
    except OSError as e:
        warnings.append('could not write %s: %s' % (GTK_SETTINGS, e))


# What earlier versions copied into ROOT to run from there. The scripts now run from the release.
OLD_COPIES = ('dispatchlib.py', 'dispatch-screen.py', 'dispatch-shell.py', 'dispatch-home.py', 'home.html', 'machine.json',
              'bundle.json.gz', 'ext/src', '__pycache__')


def forget_old_copies():
    if os.path.realpath(ROOT) == os.path.realpath(HERE):
        return
    for name in OLD_COPIES:
        path = os.path.join(ROOT, name)
        if os.path.isdir(path) and not os.path.islink(path):
            shutil.rmtree(path, ignore_errors=True)
        elif os.path.lexists(path):
            os.unlink(path)


def do_base(warnings):
    forget_old_copies()
    os.makedirs(ROOT + '/screens', exist_ok=True)
    os.makedirs(LOGS, exist_ok=True)
    dispatchlib.makedirs_owned(dispatchlib.PROFILES)
    dispatchlib.makedirs_owned(dispatchlib.LIBRARY)
    missing = missing_tools()
    if missing:
        warnings.append('missing on this computer (scripts/provision.sh installs them): %s' % ' '.join(missing))
    shell_ok = gtk_works()
    if not shell_ok:
        warnings.append('GTK for Python is not available, so screens get a plain colour and no dock')
    state = build_extension(warnings)
    policy_files = write_policy(state['id'], warnings) if state.get('id') else []
    write_gtk_settings(warnings)
    if not start_home(restart=True):
        warnings.append('the home screen server did not start (journalctl -u %s says why)' % dispatchlib.HOME_UNIT)
    # Desktop pieces that are already up run the old code, from where it was; bring them back on this.
    for unit in dispatchlib.active_units('dispatch-shell-*.service'):
        n = unit[len('dispatch-shell-'):-len('.service')]
        dispatchlib.stop_units(unit)
        if shell_ok and n.isdigit() and dispatchlib.look_for(int(n)):
            start_shell(int(n))
    dispatchlib.write_json(ROOT + '/base.json', {'code': dispatchlib.code_version(), 'shell': shell_ok,
                                                 'extension': state.get('id'), 'policy': policy_files, 'at': int(time.time())})
    return {'policy': policy_files, 'extension': state.get('id'), 'shell': shell_ok}


def base_current():
    """Whether the one-time setup ran for these very scripts (this release's, as they are now)."""
    return (dispatchlib.read_json(ROOT + '/base.json') or {}).get('code') == dispatchlib.code_version()


# ---------------------------------------------------------------- dressing a screen

def start_shell(n):
    """Screen n's wallpaper and dock, as dispatch-shell-<n>.service in the slice of the screen's bot. It
    stays root, as Dispatch's own piece: what the dock opens goes through systemd (launch_app), as the
    bots' account, which only root may ask for. It needs no session bus, and the screen's bus answers
    the bots' account alone."""
    dispatchlib.start_service(dispatchlib.shell_unit(n), dispatchlib.screen_slice(n), [sys.executable, os.path.join(HERE, 'dispatch-shell.py'), str(n)],
                              dispatchlib.base_env(n, account=False), account=False)


def ensure_shell(n, stamp, warnings):
    if not (dispatchlib.read_json(ROOT + '/base.json') or {}).get('shell'):
        return False
    state_path = dispatchlib.screen_dir(n) + '/shell.json'
    if not dispatchlib.unit_active(dispatchlib.shell_unit(n)):
        try:
            os.unlink(state_path)
        except OSError:
            pass
        try:
            start_shell(n)
        except RuntimeError as e:
            warnings.append(str(e))
            return False
    end = time.time() + 12
    while time.time() < end:
        state = dispatchlib.read_json(state_path) or {}
        if state.get('stamp') == stamp and dispatchlib.alive(state.get('pid')):
            return True
        time.sleep(0.15)
    warnings.append('the wallpaper and dock did not come up on screen %d (journalctl -u %s says why)' % (n, dispatchlib.shell_unit(n)))
    return False


def close_windows(n):
    """Close every app window on the screen. The desktop pieces stay."""
    env = dispatchlib.base_env(n)

    def targets():
        return [w for w in dispatchlib.windows(n) if not dispatchlib.is_desktop_piece(w)]

    wins = targets()
    for w in wins:
        if shutil.which('wmctrl'):
            dispatchlib.run(['wmctrl', '-i', '-c', w['id']], env=env, timeout=5)
    end = time.time() + 2.5
    while wins and time.time() < end:
        time.sleep(0.25)
        wins = targets()
    protected = {os.getpid(), os.getppid(), 1}
    for w in wins:      # did not close when asked nicely
        pid = w['pid']
        if pid > 1 and pid not in protected and dispatchlib.display_number(dispatchlib.environ_of(pid).get('DISPLAY')) == n:
            dispatchlib.stop_pids([pid], grace=1.5)
        else:
            dispatchlib.run(['xdotool', 'windowkill', str(int(w['id'], 16))], env=env, timeout=5)
    return len(targets())


def read_look(look_b64):
    """The look the server sends: gzipped JSON in base64, which fits in one argument."""
    return json.loads(gzip.decompress(base64.b64decode(look_b64)).decode('utf-8'))


def do_dress(n, flags, look_b64, warnings):
    look = read_look(look_b64)
    stamp = look['stamp']
    bot = look['bot']
    restart, reset = 'r' in flags, 'x' in flags
    folder = dispatchlib.screen_dir(n)
    timings = {}
    t = time.time()

    def lap(name):
        nonlocal t
        timings[name] = round(time.time() - t, 2)
        t = time.time()

    if not reset and not restart and screen_ok(n, stamp, bot['id']):
        return {'already': True}
    size = dispatchlib.geometry(n)
    if not size:
        raise Fatal('screen %d does not answer (X display :%d is not running)' % (n, n))
    dispatchlib.screen_folder(n)
    previous = dispatchlib.look_for(n)
    if previous and (previous.get('bot') or {}).get('id') not in (None, bot['id']):
        dispatchlib.stop_browser(previous['bot']['id'])
    try:
        os.unlink(folder + '/stamp.json')
    except OSError:
        pass
    dispatchlib.write_json(folder + '/look.json', look)
    env = dispatchlib.screen_env(n)
    colors = look.get('colors') or {}
    if shutil.which('xsetroot'):
        dispatchlib.run(['xsetroot', '-solid', colors.get('wash', '#eef0f3')], env=env, timeout=5)
    lap('prepare')
    shell = ensure_shell(n, stamp, warnings)
    lap('shell')
    if not start_home():
        warnings.append('the home screen server is not running (journalctl -u %s says why)' % dispatchlib.HOME_UNIT)
    if reset:
        dispatchlib.stop_browser(bot['id'])
        left = close_windows(n)
        if left:
            warnings.append('%d window(s) on screen %d would not close' % (left, n))
        lap('reset')
    try:
        chrome = dispatchlib.start_browser(n, bot['id'], colors.get('accent'), restart=restart and not reset, log=log)
    except RuntimeError as e:
        raise Fatal(str(e))
    warnings.extend(chrome['warnings'])
    lap('chrome')
    dispatchlib.write_json(folder + '/stamp.json', {'stamp': stamp, 'code': dispatchlib.code_version(), 'shell': shell,
                                                    'at': int(time.time())})
    return {'timings': timings, 'size': list(size), 'chromeStarted': chrome['started']}


def screen_ok(n, stamp, bot_id):
    """Cheap check that the screen still wears this exact look, dressed by these scripts, and its pieces are alive."""
    folder = dispatchlib.screen_dir(n)
    applied = dispatchlib.read_json(folder + '/stamp.json') or {}
    if applied.get('stamp') != stamp or (dispatchlib.look_for(n) or {}).get('stamp') != stamp:
        return False
    if applied.get('code') != dispatchlib.code_version():
        return False
    if applied.get('shell'):
        state = dispatchlib.read_json(folder + '/shell.json') or {}
        if not dispatchlib.alive(state.get('pid')) or state.get('stamp') != stamp:
            return False
    if not home_alive():
        return False
    if not any(disp == n for _pid, disp in dispatchlib.our_browser(bot_id)):
        return False
    return True


def do_undress(n, bot_id):
    folder = dispatchlib.screen_dir(n)
    look = dispatchlib.look_for(n) or {}
    their = (look.get('bot') or {}).get('id')
    # The bot's Chrome, every process of it: its unit holds them all.
    for owner in {their, bot_id} - {None, ''}:
        dispatchlib.stop_browser(owner)
    # Taking the look away makes the desktop pieces leave and the home server forget this screen.
    for name in ('look.json', 'stamp.json', 'shell.json'):
        try:
            os.unlink('%s/%s' % (folder, name))
        except OSError:
            pass
    # The dock, what was opened on the screen, and its terminals' bus.
    dispatchlib.stop_units(dispatchlib.shell_unit(n), dispatchlib.termbus_unit(n), *dispatchlib.screen_scopes(n))
    try:
        os.unlink(folder + '/bus.json')
    except OSError:
        pass
    if shutil.which('xsetroot') and dispatchlib.geometry(n):
        dispatchlib.run(['xsetroot', '-solid', '#eceef1'], env=dispatchlib.base_env(n), timeout=5)


# ---------------------------------------------------------------- command line

def main(argv):
    cmd = argv[0] if argv else ''
    if cmd == '_job':
        run_job(argv[1], argv[2], argv[3:])
    elif cmd == 'base' and len(argv) == 1:
        if base_current() and start_home():
            answer({'done': {'ok': True, 'already': True, 'warnings': []}})
        else:
            answer(start_job('base', []))
    elif cmd == 'dress' and len(argv) == 4:
        n, flags, look_b64 = int(argv[1]), argv[2].strip('-'), argv[3]
        look = read_look(look_b64)
        if not flags and screen_ok(n, look['stamp'], look['bot']['id']):
            answer({'done': {'ok': True, 'already': True, 'warnings': []}})
        else:
            answer(start_job('dress-%d' % n, [str(n), flags or '-', look_b64]))
    elif cmd == 'undress' and len(argv) in (2, 3):
        # A dressing job for this display may still be running (its caller gave up waiting). Let it
        # finish first, so it can't put back what undressing takes away; after a minute stop it.
        n = int(argv[1])
        with dispatchlib.held_lock(dispatchlib.dress_lock(n), timeout=60) as held:
            if not held:
                log('undress :%d: a dressing job still holds the screen; stopping it' % n)
                dispatchlib.stop_units('dispatch-job-dress-%d-*.scope' % n)
            do_undress(n, argv[2] if len(argv) > 2 else '')
        answer({'done': {'ok': True, 'warnings': []}})
    else:
        sys.stderr.write(__doc__)
        sys.exit(2)


if __name__ == '__main__':
    main(sys.argv[1:])
