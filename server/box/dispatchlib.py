"""Shared helpers for the Dispatch desk scripts (dispatch-screen.py, dispatch-home.py, dispatch-shell.py).

Everything here is per X display: display :N is "screen N". What we start for a screen runs as a
systemd unit, outside the server's own (server/src/units.ts has the layout), so a restart of the
server leaves it running and systemd knows where it is:

  dispatch-chrome-<bot>.service          the bot's Chrome, in the bot's slice
  dispatch-shell-<n>.service             screen n's wallpaper and dock, in the slice of its bot
  dispatch-term|files|app-<n>-<ms>.scope a terminal, file manager or app opened on screen n
  dispatch-termbus-<n>.service           the small bus screen n's terminals use
  dispatch-home.service                  the home screen server, one for the machine
  dispatch-job-<job>.scope               a dressing or setup job (dispatch-screen.py)
"""
import configparser
import contextlib
import fcntl
import json
import os
import pwd
import re
import shlex
import shutil
import signal
import subprocess
import time
import urllib.request

# Where things live on the computer, and the port and display numbers: machine.json beside this file,
# which server/src/machine.ts reads too (desk.ts installs it here with the scripts).
with open(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'machine.json'), encoding='utf-8') as _f:
    MACHINE = json.load(_f)

ROOT = MACHINE['boxRoot']
SCREENS = ROOT + '/screens'
JOBS = ROOT + '/jobs'
EXT = ROOT + '/ext'
LOGS = MACHINE['logs']
RUN = MACHINE['run']


def bots_account(environ=None, getpwnam=pwd.getpwnam):
    """The account every bot runs as, as server/src/account.ts finds it: DISPATCH_USER, which must be
    set (root only when it says root, never because it is missing); its home from the passwd database,
    or DISPATCH_HOME when that is set (tests). Returns (name, uid, gid, home)."""
    environ = os.environ if environ is None else environ
    name = (environ.get('DISPATCH_USER') or '').strip()
    if not name:
        raise SystemExit("DISPATCH_USER isn't set. It names the account the bots run as, in /etc/dispatch/env;"
                         ' set DISPATCH_USER=root there to run them as root.')
    try:
        pw = getpwnam(name)
    except KeyError:
        raise SystemExit('DISPATCH_USER is %s, and this machine has no account by that name' % name)
    home = (environ.get('DISPATCH_HOME') or '').strip()
    return (name, pw.pw_uid, pw.pw_gid, os.path.abspath(home) if home else pw.pw_dir)


ACCOUNT, ACCOUNT_UID, ACCOUNT_GID, ACCOUNT_HOME = bots_account()
# The bots' own files, in their account's home (machine.json's botsDir): Chrome profiles and Libraries.
BOTS_ROOT = ACCOUNT_HOME + '/' + MACHINE['botsDir']
PROFILES = BOTS_ROOT + '/profiles'
LIBRARY = BOTS_ROOT + '/files'
HOME_PORT = MACHINE['homePort']
HOME_URL = 'http://127.0.0.1:%d' % HOME_PORT
BROWSER_CLASS = 'DispatchBrowser'
SCREEN_FLAG = '--dispatch-screen'
SHELL_CLASS = 'DispatchShell'
DESKTOP_CLASSES = ('xfce4-panel', 'xfdesktop', 'dispatch-shell', 'dispatchshell')
APP_DIRS = (
    '/usr/share/applications',
    '/usr/local/share/applications',
    os.path.expanduser('~/.local/share/applications'),
    '/var/lib/snapd/desktop/applications',
    '/var/lib/flatpak/exports/share/applications',
)


# ---------------------------------------------------------------- small file helpers

def read_text(path, default=None):
    try:
        with open(path, 'r', encoding='utf-8', errors='replace') as f:
            return f.read()
    except OSError:
        return default


def read_json(path, default=None):
    try:
        with open(path, 'r', encoding='utf-8') as f:
            return json.load(f)
    except (OSError, ValueError):
        return default


@contextlib.contextmanager
def held_lock(path, timeout=None):
    """An exclusive lock on the file at `path`, shared with every process on the machine. Waits for it
    for up to `timeout` seconds (forever when None). Yields True while it is held, or False when the
    wait ran out and the caller goes on without it."""
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, 'w') as f:
        end = None if timeout is None else time.time() + timeout
        held = False
        while True:
            try:
                fcntl.flock(f, fcntl.LOCK_EX | (0 if end is None else fcntl.LOCK_NB))
                held = True
                break
            except BlockingIOError:
                if time.time() >= end:
                    break
                time.sleep(0.1)
        try:
            yield held
        finally:
            if held:
                fcntl.flock(f, fcntl.LOCK_UN)


def dress_lock(n):
    """The lock a dressing job for display :n holds while it runs (dispatch-screen.py run_job)."""
    return '%s/dress-%d.lock' % (JOBS, n)


def write_atomic(path, data, mode=0o644):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = '%s.tmp%d' % (path, os.getpid())
    with open(tmp, 'wb') as f:
        f.write(data if isinstance(data, bytes) else data.encode('utf-8'))
    os.chmod(tmp, mode)
    os.replace(tmp, path)


def write_json(path, obj):
    write_atomic(path, json.dumps(obj, indent=1, sort_keys=True))


# ---------------------------------------------------------------- the bots' account

def hands_over():
    """Whether what these scripts make for the bots must go to the bots' account: the scripts run as
    root (the server starts them) and the account isn't root."""
    return os.getuid() == 0 and ACCOUNT_UID != 0


def own(path):
    """Give a file or folder these scripts made for the bots to their account."""
    if hands_over():
        os.lchown(path, ACCOUNT_UID, ACCOUNT_GID)


def makedirs_owned(path, mode=0o755):
    """os.makedirs, with every folder it makes given to the bots' account."""
    missing = []
    p = os.path.abspath(path)
    while not os.path.isdir(p) and p != os.path.dirname(p):
        missing.append(p)
        p = os.path.dirname(p)
    os.makedirs(path, mode=mode, exist_ok=True)
    for d in reversed(missing):
        own(d)


def write_owned(path, data, mode=0o644):
    """write_atomic for a file of the bots' (in a Chrome profile, say), which their account must be able
    to change."""
    makedirs_owned(os.path.dirname(path))
    write_atomic(path, data, mode)
    own(path)


def as_account(argv):
    """A command line that runs as the bots' account. setpriv keeps the environment it is given, so HOME
    and USER come from base_env."""
    if not hands_over():
        return list(argv)
    return ['setpriv', '--reuid=%d' % ACCOUNT_UID, '--regid=%d' % ACCOUNT_GID, '--init-groups', '--'] + list(argv)


def screen_dir(n):
    return '%s/%d' % (SCREENS, int(n))


def screen_folder(n):
    """screen_dir(n), made if it isn't there. It belongs to the bots' account: their terminals' bus puts
    its socket there and keeps its settings there, and their terminals run the scripts written there."""
    folder = screen_dir(n)
    os.makedirs(folder, exist_ok=True)
    own(folder)
    return folder


def look_for(n):
    """What screen n is dressed as right now, or None."""
    return read_json(screen_dir(n) + '/look.json')


def run(argv, env=None, timeout=10, input_bytes=None):
    """Run a short command; never raises. Returns (exit code, combined output)."""
    try:
        p = subprocess.run(argv, env=env, timeout=timeout, input=input_bytes,
                           stdin=None if input_bytes is not None else subprocess.DEVNULL,
                           stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
        return p.returncode, p.stdout.decode('utf-8', 'replace')
    except subprocess.TimeoutExpired:
        return 124, 'timed out: %s' % ' '.join(argv[:3])
    except OSError as e:
        return 127, str(e)


# ---------------------------------------------------------------- processes

def all_pids():
    return [int(d) for d in os.listdir('/proc') if d.isdigit()]


def cmdline(pid):
    try:
        with open('/proc/%d/cmdline' % pid, 'rb') as f:
            raw = f.read()
    except OSError:
        return []
    args = [a.decode('utf-8', 'replace') for a in raw.split(b'\0') if a]
    # Chrome rewrites its own title into one string with spaces between the arguments.
    if len(args) == 1 and ' --' in args[0]:
        args = args[0].split(' ')
    return args


def environ_of(pid):
    try:
        with open('/proc/%d/environ' % pid, 'rb') as f:
            raw = f.read()
    except OSError:
        return {}
    env = {}
    for item in raw.split(b'\0'):
        if b'=' in item:
            k, v = item.split(b'=', 1)
            env[k.decode('utf-8', 'replace')] = v.decode('utf-8', 'replace')
    return env


def comm(pid):
    return (read_text('/proc/%d/comm' % pid, '') or '').strip()


def ppid(pid):
    stat = read_text('/proc/%d/stat' % pid)
    if not stat:
        return 0
    try:
        return int(stat.rsplit(')', 1)[1].split()[1])
    except (IndexError, ValueError):
        return 0


def alive(pid):
    if not pid:
        return False
    stat = read_text('/proc/%d/stat' % int(pid))
    if not stat:
        return False
    try:
        return stat.rsplit(')', 1)[1].split()[0] != 'Z'
    except IndexError:
        return False


def display_number(value):
    m = re.match(r'^[^:]*:(\d+)', value or '')
    return int(m.group(1)) if m else None


def display_procs(n, names):
    """Pids of processes called one of `names` that run on display :n."""
    found = []
    for pid in all_pids():
        if comm(pid) in names and display_number(environ_of(pid).get('DISPLAY')) == int(n):
            found.append(pid)
    return found


def stop_pids(pids, grace=4.0):
    pids = [p for p in pids if alive(p)]
    for p in pids:
        try:
            os.kill(p, signal.SIGTERM)
        except OSError:
            pass
    end = time.time() + grace
    while time.time() < end and any(alive(p) for p in pids):
        time.sleep(0.15)
    for p in pids:
        if alive(p):
            try:
                os.kill(p, signal.SIGKILL)
            except OSError:
                pass


# ---------------------------------------------------------------- systemd

# The slices (server/src/units.ts): a display's pieces, and the machine-wide ones like the home server.
DISPLAYS_SLICE = 'dispatch-displays.slice'
MACHINE_SLICE = 'dispatch.slice'
HOME_UNIT = 'dispatch-home.service'


def unit_key(bot_id):
    """A bot id as part of a unit name, escaped as systemd-escape does it (units.ts unitKey): a slice's
    name is a path, and `-` in it would make a slice inside a slice."""
    return ''.join(c if (c.isascii() and (c.isalnum() or c == '_')) or (c == '.' and i > 0) else '\\x%02x' % ord(c)
                   for i, c in enumerate(bot_id))


def bot_slice(bot_id):
    return 'dispatch-bot-%s.slice' % unit_key(bot_id)


def chrome_unit(bot_id):
    return 'dispatch-chrome-%s.service' % unit_key(bot_id)


def shell_unit(n):
    return 'dispatch-shell-%d.service' % int(n)


def termbus_unit(n):
    return 'dispatch-termbus-%d.service' % int(n)


def screen_slice(n):
    """Where what runs on screen n goes: the slice of the bot the screen is dressed for, so it counts
    against that bot's memory, or the displays' own when the screen wears no bot's look."""
    bot_id = ((look_for(n) or {}).get('bot') or {}).get('id')
    return bot_slice(bot_id) if bot_id else DISPLAYS_SLICE


def systemctl(*args, timeout=60):
    return run(['systemctl'] + list(args), timeout=timeout)


def unit_active(unit):
    return systemctl('is-active', '--quiet', unit, timeout=15)[0] == 0


def unit_main_pid(unit):
    code, out = systemctl('show', '-p', 'MainPID', '--value', unit, timeout=15)
    out = out.strip()
    return int(out) if code == 0 and out.isdigit() and int(out) > 1 else None


def active_units(pattern):
    """Names of the running units that match a glob, such as dispatch-chrome-*."""
    code, out = systemctl('list-units', '--plain', '--no-legend', '--state=active', pattern, timeout=15)
    return [line.split()[0] for line in out.splitlines() if line.strip()] if code == 0 else []


def stop_units(*units):
    """Stop units (globs allowed) and wait for them; ones that aren't there count as stopped."""
    if units:
        systemctl('stop', *units, timeout=120)


def service_argv(unit, slice_, argv, env, cwd=None, account=True):
    """systemd-run for a long-lived program as a service of its own: its environment, its folder, its
    slice, and the bots' account unless `account` is False (Dispatch's own pieces, which stay root).
    Its output goes to the journal (journalctl -u <unit>), and once it stops it is forgotten."""
    out = ['systemd-run', '--quiet', '--collect', '--unit=' + unit, '--slice=' + slice_,
           '--property=TimeoutStopSec=10', '--working-directory=' + (cwd or env.get('HOME') or '/')]
    if account and hands_over():
        out += ['--uid=%d' % ACCOUNT_UID, '--gid=%d' % ACCOUNT_GID]
    out += ['--setenv=%s=%s' % (k, v) for k, v in sorted(env.items())]
    return out + ['--'] + list(argv)


def start_service(unit, slice_, argv, env, cwd=None, account=True):
    code, out = run(service_argv(unit, slice_, argv, env, cwd, account), timeout=30)
    if code != 0:
        raise RuntimeError('could not start %s: %s' % (unit, out.strip()[-200:]))


def scope_argv(unit, slice_, argv, account=True):
    """systemd-run --scope: the program runs as this process's child, exec'd in place (same pid), in a
    scope of its own in the slice, so it outlives the script that starts it and the server's restarts.
    It runs as the bots' account unless `account` is False."""
    return (['systemd-run', '--scope', '--quiet', '--collect', '--unit=' + unit, '--slice=' + slice_, '--']
            + (as_account(argv) if account else list(argv)))


# ---------------------------------------------------------------- look and feel of things we start

def light_theme():
    for name in ('Arc-Lighter', 'Arc', 'Adwaita'):
        if os.path.isdir('/usr/share/themes/%s/gtk-3.0' % name):
            return name
    return 'Adwaita'


def icon_theme():
    for name in ('Papirus', 'Papirus-Light', 'elementary-xfce', 'Adwaita'):
        if os.path.isdir('/usr/share/icons/%s' % name):
            return name
    return 'hicolor'


def display_bus(n):
    """The session bus of display :n that the server starts with it (deploy/dispatch-bus@.service)."""
    return '%s/display-%d/bus' % (RUN, int(n))


def session_bus(n):
    """D-Bus session bus for screen n.

    A display the server runs has its own session bus at a fixed address. Another display that runs a
    desktop session (panel, settings daemon) keeps that session's bus. A bare display gets its own small
    bus, so single-instance apps (file manager, terminal) started there open on that display instead of
    joining an instance on another screen.
    """
    if os.path.exists(display_bus(n)):
        return 'unix:path=' + display_bus(n)
    for pid in display_procs(n, ('xfce4-panel', 'xfsettingsd', 'xfdesktop', 'xfce4-session')):
        address = environ_of(pid).get('DBUS_SESSION_BUS_ADDRESS')
        if address:
            return address
    return private_bus(n)


def private_bus(n):
    """A small bus that belongs to screen n alone, with its own settings store. Terminals always use it,
    so they can look light without changing the terminal settings of the main desktop. It runs as
    dispatch-termbus-<n>.service at a fixed address beside the screen's other state."""
    state_path = screen_dir(n) + '/bus.json'
    socket = screen_dir(n) + '/termbus'
    address = 'unix:path=' + socket
    unit = termbus_unit(n)
    state = read_json(state_path) or {}
    if state.get('made') == BUS_MADE and unit_active(unit) and os.path.exists(socket):
        return address
    daemon = shutil.which('dbus-daemon')
    if not daemon:
        return None
    stop_units(unit)
    env = base_env(n)
    # Services this bus starts (the Xfce settings store) keep their files in the screen's own folder,
    # so what we set for this screen never changes the settings of the main desktop.
    screen_folder(n)
    env['XDG_CONFIG_HOME'] = screen_dir(n) + '/config'
    makedirs_owned(env['XDG_CONFIG_HOME'])
    try:
        os.unlink(socket)
    except OSError:
        pass
    try:
        start_service(unit, DISPLAYS_SLICE, [daemon, '--session', '--nofork', '--nopidfile', '--address=' + address], env)
    except RuntimeError:
        return None
    end = time.time() + 5
    while not os.path.exists(socket) and time.time() < end:
        time.sleep(0.05)
    if not os.path.exists(socket):
        return None
    write_json(state_path, {'address': address, 'made': BUS_MADE})
    _light_terminal(dict(base_env(n), DBUS_SESSION_BUS_ADDRESS=address))
    return address


BUS_MADE = 3
_TERMINAL_LOOK = (
    ('/background-mode', 'string', 'TERMINAL_BACKGROUND_SOLID'),
    ('/color-use-theme', 'bool', 'false'),
    ('/color-background', 'string', '#FBFBFD'),
    ('/color-foreground', 'string', '#2A2E37'),
    ('/color-cursor', 'string', '#2A2E37'),
    ('/color-palette', 'string', '#2e3440;#c7243a;#2f8f46;#a66f00;#2a6fdb;#8a4fd3;#16857a;#8b93a1;'
                                 '#5b6372;#e0364d;#3aa657;#c98a00;#3d86f5;#a36bf0;#1fa293;#c5cad3'),
    ('/font-use-system', 'bool', 'false'),
    ('/font-name', 'string', 'DejaVu Sans Mono 11'),
    ('/misc-menubar-default', 'bool', 'false'),
    ('/scrolling-bar', 'string', 'TERMINAL_SCROLLBAR_NONE'),
    ('/misc-show-unsafe-paste-dialog', 'bool', 'false'),
)


def _light_terminal(env):
    """A light, plain terminal for a screen that has its own settings store."""
    if not shutil.which('xfconf-query') or not shutil.which('xfce4-terminal'):
        return
    # The bus is the bots' account's, and a session bus answers its own account only.
    for prop, kind, value in _TERMINAL_LOOK:
        run(as_account(['xfconf-query', '-c', 'xfce4-terminal', '-p', prop, '-n', '-t', kind, '-s', value]), env=env, timeout=8)


def base_env(n, account=True):
    """Environment for what runs on screen n: as the bots' account (their home, their runtime folder),
    or with `account` False as these scripts themselves (root), for Dispatch's own pieces."""
    env = {
        'PATH': os.environ.get('PATH') or '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
        'HOME': ACCOUNT_HOME if account else (os.environ.get('HOME') or '/root'),
        'USER': ACCOUNT if account else (os.environ.get('USER') or 'root'),
        'LANG': os.environ.get('LANG') or 'C.UTF-8',
        'TZ': os.environ.get('TZ') or 'UTC',
        'DISPLAY': ':%d' % int(n),
        'GTK_THEME': light_theme(),
        'XDG_CURRENT_DESKTOP': 'XFCE',
        'NO_AT_BRIDGE': '1',
        # The scripts started this way (the dock, the home screen server) find the same account.
        'DISPATCH_USER': ACCOUNT,
    }
    if os.environ.get('DISPATCH_HOME'):
        env['DISPATCH_HOME'] = os.environ['DISPATCH_HOME']
    runtime = '/run/user/%d' % (ACCOUNT_UID if account else os.getuid())
    if os.path.isdir(runtime):
        env['XDG_RUNTIME_DIR'] = runtime
    return env


def screen_env(n):
    """Environment for anything we start on screen n."""
    env = base_env(n)
    bus = session_bus(n)
    if bus:
        env['DBUS_SESSION_BUS_ADDRESS'] = bus
    return env


def spawn(argv, env, log_name, unit, slice_, cwd=None, account=True):
    """Start a long-lived program in a scope of its own (scope_argv), its output in LOGS/<log_name>.log,
    as the bots' account unless `account` is False. Returns its pid."""
    os.makedirs(LOGS, exist_ok=True)
    for child in list(_children):          # reap what has exited since last time
        if child.poll() is not None:
            _children.remove(child)
    path = '%s/%s.log' % (LOGS, log_name)
    try:
        if os.path.getsize(path) > 4 * 1024 * 1024:
            os.replace(path, path + '.1')
    except OSError:
        pass
    log = open(path, 'ab')
    try:
        p = subprocess.Popen(scope_argv(unit, slice_, argv, account), env=env, cwd=cwd or env.get('HOME') or '/',
                             stdin=subprocess.DEVNULL, stdout=log, stderr=log, start_new_session=True, close_fds=True)
    finally:
        log.close()
    _children.append(p)
    return p.pid


def spawn_on_screen(n, kind, argv, env, cwd=None):
    """A terminal, file manager or app on screen n, in the slice of the screen's bot (screen_slice).
    `kind` names its scope (dispatch-<kind>-<n>-<ms>.scope) and its log, so undressing finds it."""
    unit = 'dispatch-%s-%d-%d.scope' % (kind, int(n), int(time.time() * 1000))
    return spawn(argv, env, '%s-%d' % (kind, int(n)), unit, screen_slice(n), cwd=cwd)


def screen_scopes(n):
    """Globs for every scope spawn_on_screen started on screen n."""
    return ['dispatch-%s-%d-*.scope' % (kind, int(n)) for kind in ('term', 'files', 'app')]


_children = []


# ---------------------------------------------------------------- windows

def geometry(n):
    """(width, height) of display :n, or None when the display does not answer."""
    env = base_env(n)
    code, out = run(['xdotool', 'getdisplaygeometry'], env=env, timeout=6)
    m = re.match(r'^\s*(\d+)\s+(\d+)', out)
    if code == 0 and m:
        return int(m.group(1)), int(m.group(2))
    code, out = run(['xdpyinfo'], env=env, timeout=6)
    m = re.search(r'dimensions:\s+(\d+)x(\d+)', out)
    if code == 0 and m:
        return int(m.group(1)), int(m.group(2))
    return None


def windows(n):
    """Top-level windows the window manager knows on display :n."""
    env = base_env(n)
    found = []
    if shutil.which('wmctrl'):
        code, out = run(['wmctrl', '-lpGx'], env=env, timeout=6)
        if code == 0:
            for line in out.splitlines():
                parts = line.split(None, 9)
                if len(parts) < 8:
                    continue
                try:
                    found.append({
                        'id': parts[0], 'pid': int(parts[2]),
                        'x': int(parts[3]), 'y': int(parts[4]), 'w': int(parts[5]), 'h': int(parts[6]),
                        'cls': parts[7], 'title': parts[9] if len(parts) > 9 else '',
                    })
                except ValueError:
                    continue
            return found
    if shutil.which('xprop'):
        code, out = run(['xprop', '-root', '_NET_CLIENT_LIST'], env=env, timeout=6)
        for wid in re.findall(r'0x[0-9a-fA-F]+', out if code == 0 else ''):
            code, info = run(['xprop', '-id', wid, 'WM_CLASS', '_NET_WM_PID', 'WM_NAME'], env=env, timeout=6)
            cls = '.'.join(re.findall(r'"([^"]*)"', (re.search(r'WM_CLASS.*', info) or re.match('', '')).group(0)))
            pid = re.search(r'_NET_WM_PID\(CARDINAL\) = (\d+)', info)
            found.append({'id': wid, 'pid': int(pid.group(1)) if pid else 0, 'x': 0, 'y': 0, 'w': 0, 'h': 0,
                          'cls': cls, 'title': ''})
    return found


def is_desktop_piece(win):
    cls = win['cls'].lower()
    return any(part in cls for part in DESKTOP_CLASSES)


def is_browser_window(win):
    cls = win['cls'].lower()
    if 'chrom' in cls or BROWSER_CLASS.lower() in cls:
        return True
    name = os.path.basename((cmdline(win['pid']) or [''])[0]) if win['pid'] else ''
    return 'chrome' in name or 'chromium' in name


def activate_window(n, wid):
    env = base_env(n)
    if shutil.which('wmctrl'):
        run(['wmctrl', '-i', '-a', wid], env=env, timeout=6)
    else:
        run(['xdotool', 'windowactivate', str(int(wid, 16))], env=env, timeout=6)


def maximize_window(n, wid):
    env = base_env(n)
    if shutil.which('wmctrl'):
        run(['wmctrl', '-i', '-r', wid, '-b', 'remove,hidden'], env=env, timeout=6)
        run(['wmctrl', '-i', '-r', wid, '-b', 'add,maximized_vert,maximized_horz'], env=env, timeout=6)
    else:
        dec = str(int(wid, 16))
        run(['xdotool', 'windowmove', dec, '0', '0', 'windowsize', dec, '100%', '100%'], env=env, timeout=6)


# ---------------------------------------------------------------- the XFCE panel

def _xfconf(env, *args):
    return run(['xfconf-query'] + list(args), env=env, timeout=8)


def hide_panel_strips(n):
    """A panel set to 'always hide' leaves a thin strip at the screen edge that slides the panel back
    in when the pointer touches it. Unmap those strips so the panel stays out of sight."""
    env = base_env(n)
    count = 0
    for w in windows(n):
        if 'xfce4-panel' in w['cls'].lower() and min(w['w'], w['h']) <= 4 and w['x'] > -5000 and w['y'] > -5000:
            run(['xdotool', 'windowunmap', str(int(w['id'], 16))], env=env, timeout=6)
            count += 1
    return count


def _panels_on_screen(n, size):
    out = []
    for w in windows(n):
        if 'xfce4-panel' not in w['cls'].lower() or min(w['w'], w['h']) <= 4:
            continue
        if w['x'] < size[0] and w['y'] < size[1] and w['x'] + w['w'] > 0 and w['y'] + w['h'] > 0:
            out.append(w)
    return out


def hide_panels(n, env, size, warnings):
    """Hide (never kill) the XFCE panels of the desktop session on screen n. Returns True if there are any."""
    if not display_procs(n, ('xfce4-panel',)):
        return False
    if not shutil.which('xfconf-query'):
        warnings.append('xfconf-query is missing, so the panel on screen %d stays visible' % n)
        return True
    code, out = _xfconf(env, '-c', 'xfce4-panel', '-l')
    ids = sorted(set(re.findall(r'^/panels/panel-(\d+)/', out, re.M)), key=int) if code == 0 else []
    saved_path = screen_dir(n) + '/panel.json'
    saved = read_json(saved_path)
    current = {}
    for pid_ in ids:
        c, v = _xfconf(env, '-c', 'xfce4-panel', '-p', '/panels/panel-%s/autohide-behavior' % pid_)
        current[pid_] = v.strip() if c == 0 and v.strip().isdigit() else None
    if saved is None:
        write_json(saved_path, current)
    for pid_ in ids:
        if current[pid_] != '2':
            _xfconf(env, '-c', 'xfce4-panel', '-p', '/panels/panel-%s/autohide-behavior' % pid_, '-n', '-t', 'uint', '-s', '2')
    end = time.time() + 4
    left = _panels_on_screen(n, size)
    while left and time.time() < end:
        time.sleep(0.3)
        left = _panels_on_screen(n, size)
    for w in left:                      # a panel that ignored the setting: take its window off the screen
        run(['xdotool', 'windowunmap', str(int(w['id'], 16))], env=env, timeout=6)
    hide_panel_strips(n)
    if _panels_on_screen(n, size):
        warnings.append('the panel on screen %d could not be hidden' % n)
    return True


def restore_panels(n, env):
    """Undo hide_panels: put the autohide settings back and let the panel redraw itself."""
    saved_path = screen_dir(n) + '/panel.json'
    saved = read_json(saved_path)
    if saved is None or not display_procs(n, ('xfce4-panel',)):
        return
    for pid_, value in saved.items():
        prop = '/panels/panel-%s/autohide-behavior' % pid_
        if value is None:
            _xfconf(env, '-c', 'xfce4-panel', '-p', prop, '-r')
        else:
            _xfconf(env, '-c', 'xfce4-panel', '-p', prop, '-n', '-t', 'uint', '-s', str(value))
    run(['xfce4-panel', '-r'], env=env, timeout=10)
    try:
        os.unlink(saved_path)
    except OSError:
        pass


# ---------------------------------------------------------------- installed apps

_apps_cache = {'at': 0.0, 'apps': []}
_NOISE = re.compile(
    r'^(xfce4?-|exo-|thunar-(bulk|settings|volman)|yad|debian-|python\d|org\.freedesktop\.|im-config|gcr-|'
    r'software-properties|display-im|gnome-(keyring|session)|xfwm4|xfdesktop|panel-|ibus|fcitx|org\.gnome\.(Settings|seahorse)|'
    r'pavucontrol|nm-|bluetooth|lstopo|hwloc|system-config|update-manager|ubuntu-|snap-|htop|vim|gvim|info|x11vnc|vncviewer|'
    r'xdg-desktop-portal|geoclue|org\.gtk\.|gtk3-|gtk4-|qv4l2|qvidcap|rofi|compton|picom)', re.I)
_KEEP = re.compile(r'^(xfce4-terminal|xfce4-screenshooter|xfce4-taskmanager|exo-file-manager|thunar)$', re.I)


def _parse_desktop(path):
    parser = configparser.RawConfigParser(strict=False, interpolation=None)
    parser.optionxform = str
    try:
        parser.read(path, encoding='utf-8')
        entry = dict(parser.items('Desktop Entry'))
    except (configparser.Error, OSError, UnicodeDecodeError):
        return None
    return entry


def _exec_argv(exec_line):
    try:
        parts = shlex.split(exec_line)
    except ValueError:
        return []
    out = []
    for part in parts:
        if re.fullmatch(r'%[a-zA-Z]', part):
            continue
        out.append(re.sub(r'%[a-zA-Z]', '', part).replace('%%', '%'))
    return out


def _is_browser(argv):
    name = os.path.basename(argv[0]).lower() if argv else ''
    return 'chrome' in name or 'chromium' in name


def list_apps():
    """Apps a person would expect in a launcher, read from the .desktop files on this computer."""
    now = time.time()
    if now - _apps_cache['at'] < 20 and _apps_cache['apps']:
        return _apps_cache['apps']
    apps, seen_bin, seen_name = [], set(), set()
    for folder in APP_DIRS:
        try:
            names = sorted(os.listdir(folder))
        except OSError:
            continue
        for fname in names:
            if not fname.endswith('.desktop'):
                continue
            app_id = fname[:-len('.desktop')]
            entry = _parse_desktop(os.path.join(folder, fname))
            if not entry or entry.get('Type', 'Application') != 'Application':
                continue
            if entry.get('NoDisplay', '').lower() == 'true' or entry.get('Hidden', '').lower() == 'true':
                continue
            if entry.get('Terminal', '').lower() == 'true':
                continue
            cats = [c for c in entry.get('Categories', '').split(';') if c]
            if any(c in ('Settings', 'DesktopSettings', 'X-XFCE-SettingsDialog', 'Screensaver') for c in cats):
                continue
            if _NOISE.match(app_id) and not _KEEP.match(app_id):
                continue
            argv = _exec_argv(entry.get('Exec', ''))
            if not argv:
                continue
            binary = shutil.which(argv[0]) or argv[0]
            real = os.path.realpath(binary)
            if not os.path.exists(real) or real in seen_bin:
                continue
            seen_bin.add(real)
            base = os.path.basename(argv[0]).lower()
            name = entry.get('Name', app_id)
            kind, rank = 'app', 5
            if _is_browser(argv):
                kind, rank, name = 'browser', 0, 'Chrome' if 'chrome' in base else 'Browser'
            elif base in ('thunar', 'nautilus', 'nemo', 'pcmanfm', 'caja', 'dolphin'):
                rank, name = 1, 'Files'
            elif 'terminal' in base or base in ('xterm', 'konsole', 'alacritty', 'kitty'):
                rank, name = 2, 'Terminal'
            if name.strip().lower() in seen_name:        # the same app listed twice under two ids
                continue
            seen_name.add(name.strip().lower())
            apps.append({'id': app_id, 'name': name, 'kind': kind, 'rank': rank, 'icon': entry.get('Icon', ''),
                         'argv': argv, 'cwd': entry.get('Path') or None})
    apps.sort(key=lambda a: (a['rank'], a['name'].lower()))
    _apps_cache['at'] = now
    _apps_cache['apps'] = apps[:12]
    return _apps_cache['apps']


def find_app(app_id):
    for app in list_apps():
        if app['id'] == app_id:
            return app
    return None


# ---------------------------------------------------------------- terminal, files, apps

def open_terminal(n, command=None, title=None):
    """Open a terminal window on screen n. With a command, run it and keep the window open afterwards."""
    env = base_env(n)
    bus = private_bus(n) or session_bus(n)
    if bus:
        env['DBUS_SESSION_BUS_ADDRESS'] = bus
    title = (title or 'Terminal').replace('\n', ' ')[:120]
    script = None
    if command is not None:
        screen_folder(n)
        folder = screen_dir(n) + '/term'
        makedirs_owned(folder)
        for old in os.listdir(folder):
            full = os.path.join(folder, old)
            try:
                if time.time() - os.path.getmtime(full) > 86400:
                    os.unlink(full)
            except OSError:
                pass
        script = '%s/run-%d-%d.sh' % (folder, int(time.time()), os.getpid())
        write_owned(script, '#!/bin/bash\ncd "$HOME" 2>/dev/null\n%s\n' % command, 0o700)
    keep = None
    if script:
        # The window stays open after the command ends, with one plain line saying how it went.
        keep = ('bash -l %s; code=$?; echo; if [ "$code" -eq 0 ]; then msg="Finished. You can close this window."; '
                'else msg="Stopped with code $code. You can close this window."; fi; '
                'printf "\\033[2m%%s\\033[0m\\n" "$msg"; exec sleep infinity' % shlex.quote(script))
    xfce = shutil.which('xfce4-terminal')
    if xfce:
        argv = [xfce, '--disable-server', '--title', title, '--geometry', '104x28']
        if keep:
            argv += ['--dynamic-title-mode=none', '-e', 'bash -c %s' % shlex.quote(keep)]
    elif shutil.which('xterm'):
        argv = ['xterm', '-T', title, '-geometry', '104x28', '-fa', 'Monospace', '-fs', '11']
        if keep:
            argv += ['-e', 'bash', '-c', keep]
    elif shutil.which('x-terminal-emulator'):
        argv = ['x-terminal-emulator', '-T', title]
        if keep:
            argv += ['-e', 'bash -c %s' % shlex.quote(keep)]
    else:
        raise RuntimeError('no terminal program on this computer')
    pid = spawn_on_screen(n, 'term', argv, env)
    settle_window(n, pid)
    return pid


def settle_window(n, pid, wait=4.0):
    """Put a freshly opened window where a person expects it: fully on the screen, in the middle."""
    size = geometry(n)
    if not size or not shutil.which('wmctrl'):
        return
    end = time.time() + wait
    while time.time() < end:
        mine = [w for w in windows(n) if w['pid'] == pid]
        if mine:
            win = mine[-1]
            w = min(win['w'], size[0] - 120)
            h = min(win['h'], size[1] - 170)
            x = max(0, (size[0] - w) // 2)
            y = max(24, (size[1] - h) // 2 - 30)
            run(['wmctrl', '-i', '-r', win['id'], '-e', '0,%d,%d,%d,%d' % (x, y, w, h)], env=base_env(n), timeout=5)
            return
        if not alive(pid):
            return
        time.sleep(0.15)


def open_files(n):
    env = screen_env(n)
    start = LIBRARY if os.path.isdir(LIBRARY) else env['HOME']
    for name in ('thunar', 'nautilus', 'nemo', 'pcmanfm', 'caja'):
        if shutil.which(name):
            return spawn_on_screen(n, 'files', [name, start], env)
    if shutil.which('xdg-open'):
        return spawn_on_screen(n, 'files', ['xdg-open', start], env)
    raise RuntimeError('no file manager on this computer')


def launch_app(n, app_id):
    """Start an app (by .desktop id, or 'browser' / 'terminal' / 'files') on screen n."""
    if app_id == 'browser':
        return open_browser(n)
    if app_id == 'terminal':
        return open_terminal(n)
    if app_id == 'files':
        return open_files(n)
    app = find_app(app_id)
    if not app:
        raise RuntimeError('unknown app %s' % app_id)
    if app['kind'] == 'browser':
        return open_browser(n)
    if app['rank'] == 1:
        return open_files(n)
    if app['rank'] == 2:
        return open_terminal(n)
    return spawn_on_screen(n, 'app', app['argv'], screen_env(n), cwd=app['cwd'])


# ---------------------------------------------------------------- Chrome

def chrome_bin():
    """The real Chrome, not a wrapper script that pins someone else's profile or DevTools port."""
    for path in ('/opt/google/chrome/google-chrome', '/usr/bin/google-chrome-stable', '/opt/google/chrome/chrome',
                 '/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium'):
        if os.access(path, os.X_OK):
            return path
    return shutil.which('google-chrome-stable') or shutil.which('google-chrome') or shutil.which('chromium')


def profile_dir(bot_id):
    return '%s/%s' % (PROFILES, bot_id)


def _marked_screen(args):
    for a in args:
        if a.startswith(SCREEN_FLAG + '='):
            return display_number(':' + a.split('=', 1)[1])
    return None


def x_display_of(pid, candidates=None):
    """Which display a program has a window on. Chrome wipes its own environment, so DISPLAY cannot be read from it."""
    if candidates is None:
        candidates = []
        try:
            candidates = sorted(int(name[1:]) for name in os.listdir('/tmp/.X11-unix') if name[1:].isdigit())
        except OSError:
            pass
    for n in candidates:
        if any(w['pid'] == pid for w in windows(n)):
            return n
    return None


def _browser_of(unit):
    """(main pid, display) of the Chrome a running unit holds, or None."""
    pid = unit_main_pid(unit)
    return (pid, _marked_screen(cmdline(pid))) if pid else None


def our_browser(bot_id):
    """[(pid, display)] of the Chrome we run for this bot (its unit, dispatch-chrome-<bot>.service)."""
    unit = chrome_unit(bot_id)
    found = _browser_of(unit) if unit_active(unit) else None
    return [found] if found else []


def chrome_units():
    """[(unit, pid, display)] of every bot's Chrome that runs."""
    found = []
    for unit in active_units('dispatch-chrome-*.service'):
        browser = _browser_of(unit)
        if browser:
            found.append((unit,) + browser)
    return found


def stop_browser(bot_id):
    """Stop the Chrome we run for this bot, every process of it. Never touches any other Chrome.
    Returns whether it was running."""
    unit = chrome_unit(bot_id)
    if not unit_active(unit):
        return False
    stop_units(unit)
    return True


def cdp_port(n):
    return MACHINE['cdpPortBase'] + int(n)


def cdp(n, path, method='GET', timeout=3):
    req = urllib.request.Request('http://127.0.0.1:%d%s' % (cdp_port(n), path), method=method)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode('utf-8') or 'null')


def extension_id():
    return (read_json(EXT + '/state.json') or {}).get('id')


def _signed32(value):
    return value - (1 << 32) if value >= (1 << 31) else value


def chrome_sandbox_flags():
    """Chrome keeps its sandbox: it runs as the bots' account. Only root, which Chrome won't run
    sandboxed, gets --no-sandbox (a machine set up by hand whose bots are root)."""
    return ['--no-sandbox'] if ACCOUNT_UID == 0 else []


def prepare_profile(bot_id, accent=None):
    """Make the profile start clean: no stale locks, no 'restore pages' prompt, light look, home on start."""
    folder = profile_dir(bot_id)
    makedirs_owned(folder + '/Default')
    for name in os.listdir(folder):
        if name.startswith('Singleton'):
            try:
                os.unlink(os.path.join(folder, name))
            except OSError:
                pass
    prefs_path = folder + '/Default/Preferences'
    raw = read_text(prefs_path)
    prefs = {}
    if raw:
        try:
            prefs = json.loads(raw)
        except ValueError:
            # Leave a file we cannot parse alone, apart from the two flags that cause the restore prompt.
            fixed = re.sub(r'"exit_type":"[A-Za-z]*"', '"exit_type":"Normal"', raw)
            fixed = fixed.replace('"exited_cleanly":false', '"exited_cleanly":true')
            if fixed != raw:
                write_owned(prefs_path, fixed, 0o600)
            return
    if not isinstance(prefs, dict):
        prefs = {}

    def section(*keys):
        node = prefs
        for k in keys:
            if not isinstance(node.get(k), dict):
                node[k] = {}
            node = node[k]
        return node

    profile = section('profile')
    profile['exit_type'] = 'Normal'
    profile['exited_cleanly'] = True
    section('session')['restore_on_startup'] = 5          # open the new tab page (our home screen)
    browser = section('browser')
    browser['has_seen_welcome_page'] = True
    theme = section('browser', 'theme')
    theme['color_scheme2'] = 1                              # light, whatever the system theme says
    if accent and re.fullmatch(r'#[0-9a-fA-F]{6}', accent):
        theme['user_color2'] = _signed32(0xFF000000 | int(accent[1:], 16))
        theme['color_variant2'] = 1
        section('extensions', 'theme')['id'] = 'user_color_theme_id'
    section('bookmark_bar')['show_on_all_tabs'] = False
    promo = section('signin', 'avatar_button_promo_dict')   # no 'Sign in to Chrome?' nudge in the toolbar
    promo['AvatarButtonSigninPromoShownCount'] = max(100, int(promo.get('AvatarButtonSigninPromoShownCount') or 0))
    promo.setdefault('AvatarButtonSigninPromoLastShownTime', str(int((time.time() + 11644473600) * 1000000)))
    write_owned(prefs_path, json.dumps(prefs, separators=(',', ':')), 0o600)


def browser_windows(n, pid=None):
    wins = [w for w in windows(n) if not is_desktop_piece(w) and is_browser_window(w)]
    if pid:
        mine = [w for w in wins if w['pid'] == pid or BROWSER_CLASS.lower() in w['cls'].lower()]
        return mine
    return wins


def start_browser(n, bot_id, accent=None, restart=False, log=None):
    """Make sure this bot's Chrome runs on screen n, maximized, showing the home screen.

    Returns a dict {started, pid, warnings}. Raises RuntimeError when Chrome cannot be brought up.
    """
    warnings = []
    say = log or (lambda *_: None)
    n = int(n)
    binary = chrome_bin()
    if not binary:
        raise RuntimeError('Chrome is not installed on this computer')
    running = our_browser(bot_id)
    wrong_place = [pid for pid, disp in running if disp != n]
    if running and (restart or wrong_place):
        say('stopping Chrome for %s (restart=%s, on other screen=%s)' % (bot_id, restart, bool(wrong_place)))
        stop_browser(bot_id)
        running = []
    # A Chrome of ours left on this screen for a bot that no longer lives here would fight over the DevTools port.
    for unit, pid, disp in chrome_units():
        if disp == n and unit != chrome_unit(bot_id):
            say('stopping stale Chrome %d (%s) on screen %d' % (pid, unit, n))
            stop_units(unit)
    started = False
    if not running:
        prepare_profile(bot_id, accent)
        env = screen_env(n)
        argv = [binary] + chrome_sandbox_flags() + [
            '--no-first-run', '--no-default-browser-check', '--hide-crash-restore-bubble',
            '--password-store=basic', '--disable-dev-shm-usage',
            '--remote-debugging-port=%d' % cdp_port(n),
            '--user-data-dir=%s' % profile_dir(bot_id),
            '--class=%s' % BROWSER_CLASS,
            '--start-maximized',
            '%s=%d' % (SCREEN_FLAG, n),     # ours: lets us tell later which screen this Chrome is on
        ]
        # In the bot's slice, under its memory limit, outside the server's control group.
        start_service(chrome_unit(bot_id), bot_slice(bot_id), argv, env)
        started = True
    # Wait until DevTools answers; that is when the browser is really up.
    deadline = time.time() + (40 if started else 6)
    up = False
    while time.time() < deadline:
        try:
            cdp(n, '/json/version', timeout=2)
            up = True
            break
        except Exception:
            if started and not our_browser(bot_id) and time.time() > deadline - 34:
                break
            time.sleep(0.4)
    mains = our_browser(bot_id)
    if not mains:
        raise RuntimeError('Chrome did not start on screen %d (journalctl -u %s says why)' % (n, chrome_unit(bot_id)))
    pid = mains[0][0]
    if not up:
        warnings.append('Chrome is running on screen %d but DevTools port %d does not answer' % (n, cdp_port(n)))
    if started and up:
        _show_home(n, bot_id, warnings, say)
    # Maximized window, whatever the profile remembered.
    end = time.time() + (10 if started else 1)
    wins = browser_windows(n, pid)
    while not wins and time.time() < end:
        time.sleep(0.4)
        wins = browser_windows(n, pid)
    for w in wins:
        maximize_window(n, w['id'])
    if started and not wins:
        warnings.append('Chrome started on screen %d but no window showed up yet' % n)
    return {'started': started, 'pid': pid, 'warnings': warnings}


def _show_home(n, bot_id, warnings, say):
    """On a brand new profile the first tab opens before the home extension is installed; swap it."""
    ext = extension_id()
    if not ext:
        return
    ext_dir = '%s/Default/Extensions/%s' % (profile_dir(bot_id), ext)
    end = time.time() + 30
    while time.time() < end and not os.path.isdir(ext_dir):
        time.sleep(0.5)
    if not os.path.isdir(ext_dir):
        warnings.append('the home screen extension did not install in Chrome on screen %d' % n)
        return
    # A tab opened before the extension arrived shows Chrome's own new tab page. Our page is titled "Home".
    try:
        end = time.time() + 5
        while time.time() < end:
            time.sleep(0.5)
            pages = [t for t in cdp(n, '/json/list') if t.get('type') == 'page']
            plain = [t for t in pages
                     if t.get('url', '').startswith(('chrome://newtab', 'chrome://new-tab-page', 'about:blank'))
                     and t.get('title') != 'Home']
            if not plain:
                if pages:
                    return
                continue
            say('swapping %d plain new tab(s) for the home screen' % len(plain))
            cdp(n, '/json/new?chrome://newtab/', method='PUT')
            for t in plain:
                try:
                    urllib.request.urlopen('http://127.0.0.1:%d/json/close/%s' % (cdp_port(n), t['id']), timeout=3).read()
                except Exception:
                    pass
            time.sleep(1.0)
    except Exception as e:
        warnings.append('could not switch Chrome on screen %d to the home screen: %s' % (n, e))


def open_browser(n):
    """Dock / launcher action: bring the browser of screen n to the front, starting ours if it should run."""
    look = look_for(n) or {}
    bot_id = (look.get('bot') or {}).get('id')
    if look.get('manageChrome') and bot_id:
        mains = [pid for pid, disp in our_browser(bot_id) if disp == int(n)]
        if mains:
            wins = browser_windows(n, mains[0])
            if wins:
                activate_window(n, wins[-1]['id'])
                return mains[0]
            # Running without a window: ask it for one. This second Chrome hands the request to the
            # running one and exits.
            run([chrome_bin(), '--user-data-dir=%s' % profile_dir(bot_id), '--class=%s' % BROWSER_CLASS, '--new-window'],
                env=screen_env(n), timeout=20)
            return mains[0]
        return start_browser(n, bot_id, (look.get('colors') or {}).get('accent'))['pid']
    # Someone else's browser lives here: only ever raise it, never start or stop one.
    wins = browser_windows(n)
    if wins:
        activate_window(n, wins[-1]['id'])
        return wins[-1]['pid']
    return 0
