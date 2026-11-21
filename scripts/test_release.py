"""release.sh's switch to a new release, and its way back when the new one doesn't answer, run in a
folder of its own (DISPATCH_ROOT) with systemctl, curl, docker, journalctl, sleep and the build
standing in for the real ones. Releases come built (from a release's tarball, with a manifest naming
the speech image by digest) or as source (deploy.sh, DISPATCH_REF), which release.sh builds first.
Standard library and jq only:

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
SPEECH = "ghcr.io/chriscorbell/dispatch-speech@sha256:"

# The build: records how it was called and lays the source out as built (with node/).
BUILD = """#!/usr/bin/env bash
echo "build $*" >>"$CALLS"
out="${*: -1}"
cp -a "$(cd "$(dirname "$0")/.." && pwd)" "$out"
mkdir -p "$out/node/bin" && echo '#!/bin/sh' >"$out/node/bin/node" && chmod +x "$out/node/bin/node"
"""

# The stand-ins log each call to $CALLS. curl answers the health check unless the release `current`
# points at is listed in $BROKEN. Starting a release listed in $MIGRATES rewrites the database, as a new schema would.
# Images built here are there already; one named by digest is there once pulled.
SHIMS = {
    "systemctl": """echo "systemctl $*" >>"$CALLS"
cur="$(readlink "$DISPATCH_ROOT/srv/dispatch/current" 2>/dev/null)"
if [ "$1" = restart ] && grep -qx "${cur#releases/}" "$MIGRATES"; then
  echo "schema of ${cur#releases/}" >"$DB"; rm -f "$DB-wal"
fi""",
    "journalctl": 'echo "the journal"',
    "sleep": ":",
    "curl": 'cur="$(readlink "$DISPATCH_ROOT/srv/dispatch/current")"; grep -qx "${cur#releases/}" "$BROKEN" && exit 7; exit 0',
    "docker": """case "$1" in
  image) if [ "$2" = inspect ]; then case "$3" in *@sha256:*) grep -qxF "$3" "$PULLED" 2>/dev/null; exit ;; esac; fi; exit 0 ;;
  pull) echo "pull $3" >>"$CALLS"; echo "$3" >>"$PULLED" ;;
  compose) [ "$2" = --env-file ] && [ -f "$3" ] || exit 9
           echo "compose $SPEECH_IMAGE ${3#$DISPATCH_ROOT} ${5#$DISPATCH_ROOT}" >>"$CALLS" ;;
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
        self.broken, self.migrates = (os.path.join(self.root, n) for n in ("broken", "migrates"))
        for f in (self.broken, self.migrates):
            open(f, "w").close()
        os.makedirs(self.path("etc/dispatch"))
        os.makedirs(self.path("srv/dispatch/releases"))
        os.makedirs(self.path("var/lib/dispatch"))
        self.db = self.path("var/lib/dispatch/dispatch.db")
        self.env = dict(os.environ, DISPATCH_ROOT=self.root, CALLS=self.calls, BROKEN=self.broken,
                        MIGRATES=self.migrates, DB=self.db,
                        PULLED=self.path("pulled"), PATH=f"{bin_dir}:{os.environ['PATH']}")

    def path(self, *parts):
        return os.path.join(self.root, *parts)

    def unpack(self, commit, speech="v1", version=None, built=False):
        """A freshly unpacked release, as install.sh or deploy.sh leave it: source, or with built=True
        a release's tarball, whose manifest names its speech image by a digest made from `speech`."""
        rel = self.path("srv/dispatch/releases", f"{commit}.new")
        for d in ("scripts", "deploy", "node/bin" if built else "speech"):
            os.makedirs(os.path.join(rel, d))
        shutil.copy(RELEASE, os.path.join(rel, "scripts", "release.sh"))
        files = [("scripts/provision.sh", ":\n"), ("deploy/dispatch.service", "[Service]\n"),
                 ("deploy/speech.compose.yaml", "services: {}\n"), ("deploy/speech.env", "SPEECH_IP=172.31.250.2\n")]
        if built:
            manifest = {"version": version or "v0.0.0", "commit": commit, "speechImage": self.image(speech)}
            files += [("node/bin/node", "#!/bin/sh\n"), ("manifest.json", json.dumps(manifest))]
        else:
            files += [("speech/Dockerfile", speech), ("scripts/build-release.sh", BUILD)]
        for name, text in files:
            with open(os.path.join(rel, name), "w") as f:
                f.write(text)
        os.chmod(os.path.join(rel, "node/bin/node" if built else "scripts/build-release.sh"), 0o755)
        if version:
            with open(os.path.join(rel, "VERSION"), "w") as f:
                f.write(version + "\n")
        return os.path.join(rel, "scripts", "release.sh")

    def release(self, commit, **kw):
        open(self.calls, "w").close()
        return subprocess.run(["bash", self.unpack(commit, **kw)], env=self.env, capture_output=True, text=True)

    @staticmethod
    def image(speech):
        return SPEECH + speech.encode().hex().ljust(64, "0")[:64]

    def current(self):
        return os.readlink(self.path("srv/dispatch/current"))

    def logged(self):
        with open(self.calls) as f:
            return f.read().splitlines()

    @staticmethod
    def write(path, text):
        with open(path, "w") as f:
            f.write(text)

    @staticmethod
    def read(path):
        with open(path) as f:
            return f.read()

    def test_a_source_tree_is_built_first_and_then_becomes_current(self):
        r = self.release(OLD)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(self.current(), f"releases/{OLD}")
        final = self.path("srv/dispatch/releases", OLD)
        self.assertIn(f"build --commit {OLD} {final}.build", self.logged())
        self.assertTrue(os.access(os.path.join(final, "node/bin/node"), os.X_OK))
        self.assertFalse(os.path.exists(final + ".new") or os.path.exists(final + ".build"))
        # Its speech image is built here and written down for a rollback.
        with open(os.path.join(final, "SPEECH_IMAGE")) as f:
            self.assertRegex(f.read().strip(), r"^dispatch-speech:[0-9a-f]{12}$")
        self.assertIn("systemctl restart dispatch", self.logged())
        self.assertFalse(os.path.exists(self.path("etc/dispatch/last-update")))

    def test_a_built_release_runs_as_it_is_with_the_speech_image_its_manifest_names(self):
        r = self.release(OLD, built=True, speech="v1")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(self.current(), f"releases/{OLD}")
        self.assertFalse([c for c in self.logged() if c.startswith("build ")])
        self.assertIn(f"pull {self.image('v1')}", self.logged())
        self.assertIn(f"compose {self.image('v1')}", " ".join(self.logged()))
        with open(self.path("srv/dispatch/releases", OLD, "SPEECH_IMAGE")) as f:
            self.assertEqual(f.read().strip(), self.image("v1"))

    def test_a_built_release_that_does_not_answer_goes_back_to_the_image_before(self):
        self.assertEqual(self.release(OLD, built=True, speech="v1").returncode, 0)
        with open(self.broken, "w") as f:
            f.write(NEW + "\n")
        r = self.release(NEW, built=True, speech="v2", version="v0.2.0")
        self.assertEqual(r.returncode, 1)
        self.assertEqual(self.current(), f"releases/{OLD}")
        compose = [c.split()[1] for c in self.logged() if c.startswith("compose ")]
        self.assertEqual(compose, [self.image("v2"), self.image("v1")])

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
        self.assertEqual(compose[1].split()[2:], [f"/srv/dispatch/releases/{OLD}/deploy/speech.env",
                                                  f"/srv/dispatch/releases/{OLD}/deploy/speech.compose.yaml"])
        self.assertEqual(self.logged().count("systemctl restart dispatch"), 2)
        with open(self.path("etc/dispatch/last-update")) as f:
            last = json.load(f)
        self.assertEqual({k: last[k] for k in ("result", "from", "to", "version")},
                         {"result": "rolled-back", "from": OLD, "to": NEW, "version": "v0.2.0"})
        # The release that failed stays, so it can be tried again.
        self.assertTrue(os.path.isdir(self.path("srv/dispatch/releases", NEW)))

    def test_going_back_puts_back_the_database_the_new_release_migrated(self):
        self.assertEqual(self.release(OLD).returncode, 0)
        self.write(self.db, "schema of old")
        self.write(self.db + "-wal", "old wal")
        self.write(self.broken, NEW + "\n")
        self.write(self.migrates, NEW + "\n")
        r = self.release(NEW)
        self.assertEqual(r.returncode, 1)
        self.assertEqual(self.current(), f"releases/{OLD}")
        self.assertEqual(self.read(self.db), "schema of old")
        self.assertEqual(self.read(self.db + "-wal"), "old wal")
        # Dispatch is stopped before each copy, so the database and its log agree.
        calls = [c for c in self.logged() if c.startswith("systemctl ") and c.endswith(" dispatch")]
        self.assertEqual(calls, ["systemctl stop dispatch", "systemctl restart dispatch",
                                 "systemctl stop dispatch", "systemctl restart dispatch"])

    def test_a_good_update_keeps_the_copy_from_before_it(self):
        self.assertEqual(self.release(OLD).returncode, 0)
        self.write(self.db, "schema of old")
        self.write(self.migrates, NEW + "\n")
        r = self.release(NEW)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(self.read(self.db), f"schema of {NEW}\n")
        self.assertEqual(self.read(self.db + ".before-update"), "schema of old")
        self.assertFalse(os.path.exists(self.db + ".before-update-wal"))

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
