"""Tests for cbotlib that need no display: `npm run test:box` (part of `npm test`)."""
import multiprocessing
import os
import tempfile
import time
import unittest

import cbotlib


def hold_for(path, seconds, ready):
    with cbotlib.held_lock(path):
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
        with cbotlib.held_lock(self.path, timeout=5) as held:
            self.assertTrue(held)
            self.assertGreaterEqual(time.time() - start, 0.3)
        p.join()

    def test_gives_up_after_the_timeout(self):
        p = self.other_process_holds(2)
        start = time.time()
        with cbotlib.held_lock(self.path, timeout=0.3) as held:
            self.assertFalse(held)
        self.assertLess(time.time() - start, 1.5)
        p.join()

    def test_free_lock_is_taken_at_once(self):
        with cbotlib.held_lock(self.path, timeout=0) as held:
            self.assertTrue(held)

    def test_dress_lock_is_the_dressing_jobs_lock(self):
        # cbot-screen.py's run_job locks JOBS/<job name>.lock, and dressing jobs are named dress-<n>.
        self.assertEqual(cbotlib.dress_lock(101), cbotlib.JOBS + '/dress-101.lock')


if __name__ == '__main__':
    unittest.main()
