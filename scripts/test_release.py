"""release.sh's switch to a new release, and its way back when the new one doesn't answer, run in a
folder of its own (DISPATCH_ROOT) with systemctl, curl, docker, npm, journalctl and sleep standing in
for the real ones. Standard library only:

    python3 -m unittest discover -s scripts -p 'test_*.py'
"""
import json
import os
import shutil
import subprocess
import tempfile
import unittest

RELEASE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "release.sh")
OLD = "0123456789ab"
NEW = "ba9876543210"

# The stand-ins log each call to $CALLS. curl answers the health check unless the release `current`
# points at is listed in $BROKEN.
SHIMS = {
    "systemctl": 'echo "systemctl $*" >>"$CALLS"',
    "journalctl": 'echo "the journal"',
    "npm": 'echo "npm $*" >>"$CALLS"',
    "sleep": ":",
    "curl": 'cur="$(readlink "$DISPATCH_ROOT/srv/dispatch/current")"; grep -qx "${cur#releases/}" "$BROKEN" && exit 7; exit 0',
    "docker": """case "$1" in
  image) [ "$2" = inspect ] && exit 0; exit 0 ;;
  compose) echo "compose $SPEECH_IMAGE ${3#$DISPATCH_ROOT}" >>"$CALLS" ;;
esac""",
}


class ReleaseTest(unittest.TestCase):
    def setUp(self):
        self.root = tempfile.mkdtemp(prefix="dispatch-release-")
        self.addCleanup(shutil.rmtree, self.root)
        bin_dir = os.path.join(self.root, "bin")
        os.makedirs(bin_dir)
        for name, body in SHIMS.items():
            path = os.path.join(bin_dir, name)
            with open(path, "w") as f:
                f.write(f"#!/usr/bin/env bash\n{body}\n")
            os.chmod(path, 0o755)
        self.calls = os.path.join(self.root, "calls")
        self.broken = os.path.join(self.root, "broken")
        open(self.broken, "w").close()
        os.makedirs(self.path("etc/dispatch"))
        os.makedirs(self.path("srv/dispatch/releases"))
        self.env = dict(os.environ, DISPATCH_ROOT=self.root, CALLS=self.calls, BROKEN=self.broken,
                        PATH=f"{bin_dir}:{os.environ['PATH']}")

    def path(self, *parts):
        return os.path.join(self.root, *parts)

    def unpack(self, commit, speech="v1", version=None):
        """A freshly unpacked release, as install.sh or deploy.sh leave it."""
        rel = self.path("srv/dispatch/releases", f"{commit}.new")
        for d in ("scripts", "deploy", "speech"):
            os.makedirs(os.path.join(rel, d))
        shutil.copy(RELEASE, os.path.join(rel, "scripts", "release.sh"))
        for name, text in (("scripts/provision.sh", ":\n"), ("deploy/dispatch.service", "[Service]\n"),
                           ("deploy/speech.compose.yaml", "services: {}\n"), ("speech/Dockerfile", speech)):
            with open(os.path.join(rel, name), "w") as f:
                f.write(text)
        if version:
            with open(os.path.join(rel, "VERSION"), "w") as f:
                f.write(version + "\n")
        return os.path.join(rel, "scripts", "release.sh")

    def release(self, commit, **kw):
        open(self.calls, "w").close()
        return subprocess.run(["bash", self.unpack(commit, **kw)], env=self.env, capture_output=True, text=True)

    def current(self):
        return os.readlink(self.path("srv/dispatch/current"))

    def logged(self):
        with open(self.calls) as f:
            return f.read().splitlines()

    def test_a_release_that_answers_becomes_current(self):
        r = self.release(OLD)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(self.current(), f"releases/{OLD}")
        self.assertTrue(os.path.isdir(self.path("srv/dispatch/releases", OLD)))
        self.assertIn("npm ci --no-audit --no-fund --loglevel=error", self.logged())
        self.assertIn("systemctl restart dispatch", self.logged())
        self.assertFalse(os.path.exists(self.path("etc/dispatch/last-update")))

    def test_a_release_that_does_not_answer_goes_back_to_the_one_before(self):
        self.assertEqual(self.release(OLD, speech="v1").returncode, 0)
        with open(self.broken, "w") as f:
            f.write(NEW + "\n")
        r = self.release(NEW, speech="v2", version="v0.2.0")
        self.assertEqual(r.returncode, 1)
        self.assertIn(f"so it went back to {OLD}", r.stderr)
        self.assertEqual(self.current(), f"releases/{OLD}")
        # The new release's speech image, then the old one's again, from the old release's compose file.
        compose = [c for c in self.logged() if c.startswith("compose ")]
        self.assertEqual(len(compose), 2)
        self.assertNotEqual(compose[0].split()[1], compose[1].split()[1])
        self.assertTrue(compose[1].endswith(f"/srv/dispatch/releases/{OLD}/deploy/speech.compose.yaml"))
        self.assertEqual(self.logged().count("systemctl restart dispatch"), 2)
        with open(self.path("etc/dispatch/last-update")) as f:
            last = json.load(f)
        self.assertEqual({k: last[k] for k in ("result", "from", "to", "version")},
                         {"result": "rolled-back", "from": OLD, "to": NEW, "version": "v0.2.0"})
        # The release that failed stays, so it can be tried again.
        self.assertTrue(os.path.isdir(self.path("srv/dispatch/releases", NEW)))

    def test_the_next_good_release_clears_the_notice(self):
        self.release(OLD)
        with open(self.broken, "w") as f:
            f.write(NEW + "\n")
        self.release(NEW)
        open(self.broken, "w").close()
        r = self.release("cccccccccccc")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertFalse(os.path.exists(self.path("etc/dispatch/last-update")))

    def test_a_first_release_that_does_not_answer_has_nothing_to_go_back_to(self):
        with open(self.broken, "w") as f:
            f.write(OLD + "\n")
        r = self.release(OLD)
        self.assertEqual(r.returncode, 1)
        self.assertIn(f"did not answer within a minute on {OLD}.", r.stderr)
        self.assertFalse(os.path.exists(self.path("etc/dispatch/last-update")))


if __name__ == "__main__":
    unittest.main()
