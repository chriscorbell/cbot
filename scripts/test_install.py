"""The installer's release check (install.sh's newest_release, older and fetch_signed), against a
repository made here with keys made here. Standard library, git and ssh-keygen only:

    python3 -m unittest discover -s scripts -p 'test_*.py'
"""
import os
import shutil
import subprocess
import tempfile
import unittest

INSTALL = os.path.join(os.path.dirname(os.path.abspath(__file__)), "install.sh")

# install.sh without its last line (main), with die saying why on stderr, and the keys made here in
# place of Dispatch's.
PRELUDE = """
set -euo pipefail
source <(sed '$d' "$INSTALL")
die() { echo "$*" >&2; exit 1; }
info() { :; }
release_signers() { cat "$SIGNERS"; }
"""


@unittest.skipUnless(shutil.which("git") and shutil.which("ssh-keygen"), "needs git and ssh-keygen")
class ReleaseCheckTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.dir = tempfile.mkdtemp(prefix="dispatch-install-")
        # Nobody's own git settings or ssh-agent take part.
        cls.env = dict(os.environ, GIT_CONFIG_GLOBAL=os.devnull, GIT_CONFIG_NOSYSTEM="1", SSH_AUTH_SOCK="",
                       INSTALL=INSTALL, SIGNERS=os.path.join(cls.dir, "signers"))
        for key in ("release", "stranger"):
            cls.run_ok(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-C", "", "-f", os.path.join(cls.dir, key)])
        with open(os.path.join(cls.dir, "release.pub")) as f:
            kind, blob = f.read().split()[:2]
        with open(cls.env["SIGNERS"], "w") as f:
            f.write(f'dispatch namespaces="git" {kind} {blob}\n')

        cls.repo = os.path.join(cls.dir, "origin")
        cls.git("init", "-q", "-b", "main", cls.repo, cwd=cls.dir)
        cls.commits = {}
        for n in range(3):
            with open(os.path.join(cls.repo, "README"), "w") as f:
                f.write(f"release {n}\n")
            cls.git("add", "README")
            cls.git("commit", "-q", "-m", f"commit {n}")
            cls.commits[n] = cls.git("rev-parse", "HEAD").strip()
        cls.tag("v0.9.0", cls.commits[0], "release")
        cls.tag("v0.10.0", cls.commits[1], "release")
        cls.tag("v2.0.0-rc1", cls.commits[2], "release")
        cls.tag("latest", cls.commits[2], "release")
        cls.git("tag", "v0.11.0", cls.commits[2])
        cls.git("tag", "-a", "-m", "unsigned", "v0.12.0", cls.commits[2])
        cls.tag("v0.13.0", cls.commits[2], "stranger")
        # v0.10.0's signed tag under a newer name: its text still says v0.10.0.
        cls.git("update-ref", "refs/tags/v0.14.0", cls.git("rev-parse", "refs/tags/v0.10.0").strip())

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.dir, ignore_errors=True)

    @classmethod
    def run_ok(cls, args, cwd=None):
        return subprocess.run(args, cwd=cwd, env=cls.env, check=True, capture_output=True, text=True).stdout

    @classmethod
    def git(cls, *args, cwd=None):
        return cls.run_ok(["git", "-c", "user.name=Tester", "-c", "user.email=tester@example.com", *args], cwd=cwd or cls.repo)

    @classmethod
    def tag(cls, name, commit, key):
        cls.git("-c", "gpg.format=ssh", "-c", f"user.signingKey={os.path.join(cls.dir, key)}",
                "tag", "-s", "-m", f"Dispatch {name}", name, commit)

    def bash(self, script, *args):
        return subprocess.run(["bash", "-c", PRELUDE + script, "test", *args], env=self.env, capture_output=True, text=True)

    def fetch(self, tag):
        into = tempfile.mkdtemp(dir=self.dir)
        return self.bash('fetch_signed "$1" "$2" "$3"; echo "$sha"', self.repo, tag, into)

    def test_the_newest_release_is_the_highest_version_number(self):
        r = self.bash('newest_release "$1"', self.repo)
        self.assertEqual(r.returncode, 0, r.stderr)
        # v0.14.0 is the highest; whether it's really a release is for fetch_signed.
        self.assertEqual(r.stdout.strip(), "v0.14.0")
        empty = os.path.join(self.dir, "empty")
        self.git("init", "-q", empty, cwd=self.dir)
        self.assertEqual(self.bash('newest_release "$1"', empty).stdout, "")
        self.assertNotEqual(self.bash('newest_release "$1"', os.path.join(self.dir, "missing")).returncode, 0)

    def test_older_compares_version_numbers(self):
        def older(a, b):
            return self.bash('older "$1" "$2"', a, b).returncode == 0
        self.assertTrue(older("v0.9.0", "v0.10.0"))
        self.assertFalse(older("v0.10.0", "v0.9.0"))
        self.assertFalse(older("v1.0.0", "v1.0.0"))
        self.assertTrue(older("v1.9.9", "v2.0.0"))

    @unittest.skipIf(os.path.exists("/etc/dispatch/source"), "this machine has Dispatch installed")
    def test_a_fresh_machine_runs_no_version(self):
        r = self.bash('had="$(installed_version)"; echo "[$had]"')
        self.assertEqual((r.returncode, r.stdout.strip()), (0, "[]"), r.stderr)

    def test_a_signed_release_gives_its_commit(self):
        r = self.fetch("v0.10.0")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(r.stdout.strip(), self.commits[1])

    def test_a_plain_tag_is_refused(self):
        r = self.fetch("v0.11.0")
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("isn't signed (it's a plain tag)", r.stderr)

    def test_an_unsigned_tag_is_refused(self):
        r = self.fetch("v0.12.0")
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("isn't signed with a Dispatch release key", r.stderr)

    def test_a_tag_signed_with_another_key_is_refused(self):
        r = self.fetch("v0.13.0")
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("isn't signed with a Dispatch release key", r.stderr)

    def test_a_signed_tag_under_another_name_is_refused(self):
        r = self.fetch("v0.14.0")
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("is the signed tag of v0.10.0", r.stderr)


if __name__ == "__main__":
    unittest.main()
