"""The installer's release check (install.sh's newest_release, older, fetch_signed and fetch_assets),
against a repository and release files made here with keys made here. Standard library, git and
ssh-keygen only:

    python3 -m unittest discover -s scripts -p 'test_*.py'
"""
import json
import os
import shutil
import subprocess
import tempfile
import unittest

# install.sh isn't committed: each run tests a fresh join of its parts, as a build makes it.
BUNDLE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "bundle.sh")

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
                       INSTALL=os.path.join(cls.dir, "bundle", "install.sh"), SIGNERS=os.path.join(cls.dir, "signers"))
        cls.run_ok(["bash", BUNDLE, os.path.join(cls.dir, "bundle")])
        for key in ("release", "stranger"):
            cls.run_ok(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-C", "", "-f", os.path.join(cls.dir, key)])
        with open(os.path.join(cls.dir, "release.pub")) as f:
            kind, blob = f.read().split()[:2]
        with open(cls.env["SIGNERS"], "w") as f:
            f.write(f'dispatch namespaces="git,dispatch-release" {kind} {blob}\n')

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

    @unittest.skipIf(os.path.exists("/srv/dispatch/current"), "this machine has Dispatch installed")
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

    # What GitHub Actions attaches to a release, as publish.sh signs it.

    def release_files(self, tag, commit, key="release", namespace="dispatch-release", listed=None, manifest=None):
        """A release's folder of files: the tarball, manifest.json, SHA256SUMS (of `listed`) and its signature."""
        d = tempfile.mkdtemp(dir=self.dir)
        name = f"dispatch-{tag}-linux-amd64.tar.gz"
        with open(os.path.join(d, name), "wb") as f:
            f.write(f"the build of {tag}\n".encode())
        with open(os.path.join(d, "manifest.json"), "w") as f:
            json.dump({"version": tag, "commit": commit, "speechImage": "ghcr.io/x/dispatch-speech@sha256:" + "0" * 64,
                       **(manifest or {})}, f, indent=2)
        sums = self.run_ok(["sha256sum", *(listed or [name, "manifest.json"])], cwd=d)
        with open(os.path.join(d, "SHA256SUMS"), "w") as f:
            f.write(sums)
        self.run_ok(["ssh-keygen", "-q", "-Y", "sign", "-f", os.path.join(self.dir, key), "-n", namespace, "SHA256SUMS"], cwd=d)
        return d

    def assets(self, folder, tag="v0.10.0", commit=None):
        into = tempfile.mkdtemp(dir=self.dir)
        r = self.bash('fetch_assets "$1" "$2" "$3" "$4"', f"file://{folder}", tag, commit or self.commits[1], into)
        return r, into

    def test_a_signed_build_of_the_signed_commit_is_accepted(self):
        r, into = self.assets(self.release_files("v0.10.0", self.commits[1]))
        self.assertEqual(r.returncode, 0, r.stderr)
        with open(os.path.join(into, "dispatch.tar.gz")) as f:
            self.assertEqual(f.read(), "the build of v0.10.0\n")

    def test_a_tarball_changed_after_signing_is_refused(self):
        d = self.release_files("v0.10.0", self.commits[1])
        with open(os.path.join(d, "dispatch-v0.10.0-linux-amd64.tar.gz"), "ab") as f:
            f.write(b"and something else\n")
        r, _ = self.assets(d)
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("doesn't match its signed checksums", r.stderr)

    def test_checksums_signed_with_another_key_are_refused(self):
        r, _ = self.assets(self.release_files("v0.10.0", self.commits[1], key="stranger"))
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("aren't signed with a Dispatch release key", r.stderr)

    def test_checksums_signed_as_a_tag_are_refused(self):
        # A signature made for git (a tag's) can't stand in for one made for the release's files.
        r, _ = self.assets(self.release_files("v0.10.0", self.commits[1], namespace="git"))
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("aren't signed with a Dispatch release key", r.stderr)

    def test_checksums_that_leave_the_tarball_out_are_refused(self):
        r, _ = self.assets(self.release_files("v0.10.0", self.commits[1], listed=["manifest.json"]))
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("don't list its tarball and manifest", r.stderr)

    def test_a_build_of_another_commit_or_release_is_refused(self):
        r, _ = self.assets(self.release_files("v0.10.0", self.commits[0]))
        self.assertNotEqual(r.returncode, 0)
        self.assertIn(f"is of v0.10.0 at {self.commits[0]}, not of v0.10.0 at {self.commits[1]}", r.stderr)
        r, _ = self.assets(self.release_files("v0.10.0", self.commits[1], manifest={"version": "v0.9.0"}))
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("is of v0.9.0", r.stderr)



class AccountTest(unittest.TestCase):
    """Which account the bots run as (install.sh's choose_account and record_account)."""

    @classmethod
    def setUpClass(cls):
        cls.dir = tempfile.mkdtemp(prefix="dispatch-account-")
        subprocess.run(["bash", BUNDLE, os.path.join(cls.dir, "bundle")], check=True, capture_output=True)
        cls.me = subprocess.run(["id", "-un"], check=True, capture_output=True, text=True).stdout.strip()

    def bash(self, script, *args, **env):
        base = {k: v for k, v in os.environ.items() if k not in ("DISPATCH_USER", "SUDO_USER")}
        return subprocess.run(["bash", "-c", PRELUDE + script, "test", *args], capture_output=True, text=True,
                              env=dict(base, INSTALL=os.path.join(self.dir, "bundle", "install.sh"), SIGNERS=os.devnull, **env))

    def choose(self, env_file, **env):
        return self.bash('choose_account "$1"; echo "$account"', env_file, **env)

    def env_file(self, text=None):
        path = os.path.join(tempfile.mkdtemp(dir=self.dir), "env")
        if text is not None:
            with open(path, "w") as f:
                f.write(text)
        return path

    def test_the_account_that_ran_sudo_is_the_bots(self):
        r = self.choose(self.env_file(), SUDO_USER=self.me)
        self.assertEqual((r.returncode, r.stdout.strip()), (0, self.me), r.stderr)

    def test_dispatch_user_comes_first_then_what_an_earlier_run_chose(self):
        r = self.choose(self.env_file(f"TZ=UTC\nDISPATCH_USER='{self.me}'\n"), SUDO_USER="root")
        self.assertEqual((r.returncode, r.stdout.strip()), (0, self.me), r.stderr)
        r = self.choose(self.env_file("DISPATCH_USER=nobody-here\n"), DISPATCH_USER=self.me)
        self.assertEqual((r.returncode, r.stdout.strip()), (0, self.me), r.stderr)

    def test_root_or_nobody_is_refused(self):
        for env in ({}, {"SUDO_USER": "root"}, {"DISPATCH_USER": "root"}):
            r = self.choose(self.env_file(), **env)
            self.assertNotEqual(r.returncode, 0)
            self.assertIn("from the account the bots should use", r.stderr)

    def test_an_account_the_machine_lacks_is_refused(self):
        r = self.choose(self.env_file(), DISPATCH_USER="nobody-here")
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("no account by that name", r.stderr)

    def test_the_account_is_written_down_once_beside_the_other_settings(self):
        path = self.env_file("MAX_BOTS=4\nDISPATCH_USER=someone-else\nTZ=UTC\n")
        for _ in range(2):
            r = self.bash('account="$2"; record_account "$1"; env_account "$1"', path, self.me)
            self.assertEqual((r.returncode, r.stdout.strip()), (0, self.me), r.stderr)
        with open(path) as f:
            text = f.read()
        self.assertEqual(text.count("DISPATCH_USER="), 1)
        self.assertIn("MAX_BOTS=4", text)
        self.assertIn("TZ=UTC", text)
        self.assertEqual(os.stat(path).st_mode & 0o777, 0o600)


if __name__ == "__main__":
    unittest.main()
