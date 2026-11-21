"""install-units.sh: the bots' units and the account they run as, written into a folder of its own
(DISPATCH_ROOT) with visudo standing in for the real one. Standard library only:

    python3 -m unittest discover -s scripts -p 'test_*.py'
"""
import os
import shutil
import subprocess
import tempfile
import unittest

UNITS = os.path.join(os.path.dirname(os.path.abspath(__file__)), "install-units.sh")
SERVICES = ("dispatch-bus@.service", "dispatch-gateway@.service", "dispatch-wm@.service", "dispatch-xvnc@.service")


@unittest.skipUnless(shutil.which("getent"), "needs getent")
class UnitsTest(unittest.TestCase):
    def setUp(self):
        self.root = tempfile.mkdtemp(prefix="dispatch-units-")
        self.addCleanup(shutil.rmtree, self.root)
        bin_dir = os.path.join(self.root, "bin")
        os.makedirs(bin_dir)
        # visudo -cqf <file>: refuses when $REFUSE is set, as it would a broken rule.
        with open(os.path.join(bin_dir, "visudo"), "w") as f:
            f.write('#!/bin/sh\n[ -z "$REFUSE" ]\n')
        os.chmod(os.path.join(bin_dir, "visudo"), 0o755)
        self.me = subprocess.run(["id", "-un"], check=True, capture_output=True, text=True).stdout.strip()
        self.home = subprocess.run(["getent", "passwd", self.me], check=True, capture_output=True, text=True).stdout.split(":")[5]
        self.env = {k: v for k, v in os.environ.items() if k != "DISPATCH_USER"}
        self.env.update(DISPATCH_ROOT=self.root, PATH=f"{bin_dir}:{os.environ['PATH']}")

    def path(self, *parts):
        return os.path.join(self.root, *parts)

    def install(self, **env):
        return subprocess.run(["bash", UNITS], env=dict(self.env, **env), capture_output=True, text=True)

    def read(self, *parts):
        with open(self.path(*parts)) as f:
            return f.read()

    def test_every_bot_service_runs_as_the_account_with_its_home(self):
        r = self.install(DISPATCH_USER=self.me)
        self.assertEqual(r.returncode, 0, r.stderr)
        for name in SERVICES:
            self.assertTrue(os.path.exists(self.path("etc/systemd/system", name)))
            conf = self.read("etc/systemd/system", name + ".d", "account.conf")
            self.assertIn(f"User={self.me}\n", conf)
            self.assertIn(f"Environment=HOME={self.home} USER={self.me}", conf)
        self.assertFalse(os.path.exists(self.path("etc/systemd/system", "dispatch-display@.target.d")))

    def test_the_account_comes_from_the_settings_when_the_environment_has_none(self):
        os.makedirs(self.path("etc/dispatch"))
        with open(self.path("etc/dispatch/env"), "w") as f:
            f.write(f'TZ=UTC\nDISPATCH_USER="{self.me}"\n')
        r = self.install()
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn(f"User={self.me}\n", self.read("etc/systemd/system", SERVICES[0] + ".d", "account.conf"))

    def test_an_ordinary_account_may_sudo_once_visudo_has_read_the_rule(self):
        if os.getuid() == 0:
            self.skipTest("the tests' own account is root")
        r = self.install(DISPATCH_USER=self.me)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertTrue(self.read("etc/sudoers.d/dispatch").endswith(f"{self.me} ALL=(ALL:ALL) NOPASSWD: ALL\n"))
        self.assertEqual(os.stat(self.path("etc/sudoers.d/dispatch")).st_mode & 0o777, 0o440)

    def test_a_rule_visudo_refuses_never_goes_in(self):
        if os.getuid() == 0:
            self.skipTest("the tests' own account is root")
        r = self.install(DISPATCH_USER=self.me, REFUSE="1")
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("visudo refused", r.stderr)
        self.assertEqual(os.listdir(self.path("etc/sudoers.d")), [])

    def test_bots_that_are_root_get_no_sudo_rule(self):
        os.makedirs(self.path("etc/sudoers.d"))
        with open(self.path("etc/sudoers.d/dispatch"), "w") as f:
            f.write("an old rule\n")
        r = self.install(DISPATCH_USER="root")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("User=root\n", self.read("etc/systemd/system", SERVICES[0] + ".d", "account.conf"))
        self.assertFalse(os.path.exists(self.path("etc/sudoers.d/dispatch")))

    def test_an_account_the_machine_lacks_stops_it(self):
        r = self.install(DISPATCH_USER="nobody-here")
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("no account by that name", r.stderr)


if __name__ == "__main__":
    unittest.main()
