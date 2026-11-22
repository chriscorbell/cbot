"""backup.sh and restore.sh, run in a folder of their own (DISPATCH_ROOT, with DISPATCH_HOME as the
bots' account's home) with systemctl, curl, journalctl and sleep standing in for the real ones, and a
node that stands in for server/dist/backup-db.js by copying the file, which it refuses for one that
doesn't start with "SQLite". Standard library, tar and jq only:

    python3 -m unittest discover -s scripts -p 'test_*.py'
"""
import os
import pwd
import shutil
import stat
import subprocess
import tarfile
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
ME = pwd.getpwuid(os.getuid()).pw_name

SHIMS = {
    "systemctl": 'echo "systemctl $*" >>"$CALLS"',
    "journalctl": ":",
    "sleep": ":",
    "curl": "exit 0",
}
# backup-db.js: <from> <to>, copied whole as "whole <content>".
NODE = """#!/usr/bin/env bash
head -c 6 "$2" | grep -q SQLite || { echo "file is not a database" >&2; exit 1; }
{ printf 'whole '; cat "$2"; } >"$3"
"""


@unittest.skipUnless(shutil.which("jq") and shutil.which("tar"), "needs jq and GNU tar")
class BackupTest(unittest.TestCase):
    def setUp(self):
        self.root = tempfile.mkdtemp(prefix="dispatch-backup-")
        self.addCleanup(shutil.rmtree, self.root)
        bin_dir = self.path("bin")
        os.makedirs(bin_dir)
        for name, body in SHIMS.items():
            self.write(os.path.join(bin_dir, name), f"#!/usr/bin/env bash\n{body}\n", mode=0o755)
        # A release, as backup.sh and restore.sh run from it.
        rel = self.path("srv/dispatch/releases/0123456789ab")
        for f in ("backup.sh", "restore.sh"):
            self.write(os.path.join(rel, "scripts", f), self.read(os.path.join(HERE, f)), mode=0o755)
        self.write(os.path.join(rel, "server/box/machine.json"), self.read(os.path.join(HERE, "../server/box/machine.json")))
        self.write(os.path.join(rel, "node/bin/node"), NODE, mode=0o755)
        self.write(os.path.join(rel, "VERSION"), "v0.3.0\n")
        self.rel = rel
        self.write(self.path("etc/dispatch/env"), f'TZ=UTC\nDISPATCH_USER="{ME}"\n')
        self.data = self.path("var/lib/dispatch")
        self.home = self.path("home/me")
        self.bots = os.path.join(self.home, "dispatch")
        self.calls = self.path("calls")
        self.env = dict(os.environ, DISPATCH_ROOT=self.root, DISPATCH_HOME=self.home, CALLS=self.calls,
                        PATH=f"{bin_dir}:{os.environ['PATH']}")

    def path(self, *parts):
        return os.path.join(self.root, *parts)

    @staticmethod
    def write(path, text, mode=None):
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w") as f:
            f.write(text)
        if mode is not None:
            os.chmod(path, mode)

    @staticmethod
    def read(path):
        with open(path) as f:
            return f.read()

    def machine(self, tag):
        """What Dispatch keeps, every file saying `tag`."""
        files = {
            "dispatch.db": "SQLite db", "dispatch.db-wal": "SQLite wal", "secret": "secret",
            "https/dispatch.crt": "certificate", "dispatch.db.before-update": "SQLite old",
        }
        for name, text in files.items():
            self.write(os.path.join(self.data, name), f"{text} {tag}")
        bots = {
            "engines/a/state.db": "SQLite sessions", "engines/a/state.db-wal": "SQLite log",
            "engines/a/notes.db": "plain notes", "engines/a/memories/MEMORY.md": "memory",
            "engines/a/cache/uv/wheels/numpy.whl": "a package", "engines/a/cache/screenshots/s.png": "a screenshot",
            "files/a/report.md": "report", "files/a/site/profiles/x/Cache/kept": "a Library folder",
            "profiles/a/Default/Cookies": "cookies", "profiles/a/Default/Cache/data_0": "cache",
            "profiles/a/Default/Code Cache/js": "cache", "profiles/a/SingletonLock": "lock",
        }
        for name, text in bots.items():
            self.write(os.path.join(self.bots, name), f"{text} {tag}")

    def backup(self, *args):
        return subprocess.run(["bash", os.path.join(self.rel, "scripts/backup.sh"), *args], env=self.env, capture_output=True, text=True)

    def restore(self, archive, **env):
        open(self.calls, "w").close()
        return subprocess.run(["bash", os.path.join(self.rel, "scripts/restore.sh"), archive], env=dict(self.env, **env),
                              capture_output=True, text=True, stdin=subprocess.DEVNULL)

    def members(self, archive):
        with tarfile.open(archive) as t:
            return {m.name: (t.extractfile(m).read().decode() if m.isfile() else None) for m in t.getmembers()}

    def test_a_backup_holds_the_data_and_the_bots_files_with_databases_copied_whole(self):
        self.machine("one")
        out = self.path("out/b.tar.gz")
        r = self.backup(out)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(stat.S_IMODE(os.stat(out).st_mode), 0o600)
        m = self.members(out)
        self.assertIn(f"account={ME}", m["BACKUP"])
        self.assertIn("version=v0.3.0", m["BACKUP"])
        # Databases through SQLite's backup, and not their logs; the rest as it is.
        self.assertEqual(m["data/dispatch.db"], "whole SQLite db one")
        self.assertEqual(m["bots/engines/a/state.db"], "whole SQLite sessions one")
        self.assertNotIn("data/dispatch.db-wal", m)
        self.assertNotIn("bots/engines/a/state.db-wal", m)
        self.assertEqual(m["bots/engines/a/notes.db"], "plain notes one")
        self.assertIn("as it is", r.stdout)
        self.assertEqual(m["data/secret"], "secret one")
        self.assertEqual(m["data/https/dispatch.crt"], "certificate one")
        self.assertEqual(m["bots/engines/a/memories/MEMORY.md"], "memory one")
        self.assertEqual(m["bots/files/a/report.md"], "report one")
        self.assertEqual(m["bots/profiles/a/Default/Cookies"], "cookies one")
        # Chrome's caches and lock and release.sh's old copy stay out; a Library folder named like them doesn't.
        self.assertFalse([n for n in m if "/Default/Cache" in n or "Code Cache" in n or "Singleton" in n])
        self.assertNotIn("data/dispatch.db.before-update", m)
        self.assertEqual(m["bots/files/a/site/profiles/x/Cache/kept"], "a Library folder one")
        # uv's packages in a Hermes home come again when needed; what else Hermes keeps there stays.
        self.assertFalse([n for n in m if "/cache/uv" in n])
        self.assertEqual(m["bots/engines/a/cache/screenshots/s.png"], "a screenshot one")
        # Nothing by its path on this machine.
        self.assertFalse([n for n in m if not (n == "BACKUP" or n.split("/")[0] in ("data", "bots"))])

    def test_without_dispatch_there_is_nothing_to_back_up(self):
        r = self.backup(self.path("out/b.tar.gz"))
        self.assertNotEqual(r.returncode, 0)
        self.assertFalse(os.path.exists(self.path("out/b.tar.gz")))

    def test_a_restore_puts_the_backup_in_place_and_keeps_what_was_there(self):
        self.machine("one")
        out = self.path("out/b.tar.gz")
        self.assertEqual(self.backup(out).returncode, 0)
        shutil.rmtree(self.data)
        shutil.rmtree(self.bots)
        self.machine("two")
        r = self.restore(out, DISPATCH_YES="1")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(self.read(os.path.join(self.data, "dispatch.db")), "whole SQLite db one")
        self.assertFalse(os.path.exists(os.path.join(self.data, "dispatch.db-wal")))
        self.assertEqual(self.read(os.path.join(self.data, "secret")), "secret one")
        self.assertEqual(self.read(os.path.join(self.bots, "engines/a/state.db")), "whole SQLite sessions one")
        self.assertEqual(self.read(os.path.join(self.bots, "files/a/report.md")), "report one")
        self.assertEqual(stat.S_IMODE(os.stat(self.data).st_mode), 0o700)
        # What was there is beside it.
        aside = [d for d in os.listdir(os.path.dirname(self.data)) if d.startswith("dispatch.before-restore-")]
        self.assertEqual(len(aside), 1)
        self.assertEqual(self.read(os.path.join(os.path.dirname(self.data), aside[0], "secret")), "secret two")
        self.assertTrue([d for d in os.listdir(self.home) if d.startswith("dispatch.before-restore-")])
        # Everything stops before anything moves, and Dispatch starts again after.
        self.assertEqual(self.read(self.calls).splitlines(),
                         ["systemctl stop dispatch.service dispatch.slice", "systemctl start dispatch.service"])

    def test_a_restore_asks_first_and_refuses_what_isnt_a_backup(self):
        self.machine("one")
        out = self.path("out/b.tar.gz")
        self.assertEqual(self.backup(out).returncode, 0)
        r = self.restore(out)
        self.assertNotEqual(r.returncode, 0)
        self.assertEqual(self.read(self.calls), "")
        other = self.path("other.tar.gz")
        with tarfile.open(other, "w:gz") as t:
            t.add(self.data, arcname="data")
        r = self.restore(other, DISPATCH_YES="1")
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("isn't a Dispatch backup", r.stderr)
        self.assertEqual(self.read(self.calls), "")


if __name__ == "__main__":
    unittest.main()
