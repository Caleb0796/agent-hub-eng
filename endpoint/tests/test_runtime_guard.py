import multiprocessing
import os
import tempfile
import unittest
import uuid
from pathlib import Path
from endpoint.runtime_guard import RuntimeGuard


def claim_in_worker(directory, data, queue):
    queue.put(RuntimeGuard(directory, lambda: 1800000000).run("claim", data)["status"])


class RuntimeGuardTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name) / "runtime"
        self.now = 1800000000
        self.data = {"conversationId": str(uuid.uuid4()), "holder": "run-one", "policyHash": "a" * 64, "expiresAt": self.now + 1200}
        self.guard = RuntimeGuard(self.root, lambda: self.now)

    def tearDown(self):
        self.temp.cleanup()

    def test_ownership_survives_process_commands_and_never_grants_permission(self):
        claimed = self.guard.run("claim", self.data)
        self.assertEqual(claimed["status"], "claimed")
        self.assertFalse(claimed["execution_permission_granted"])
        self.data["holder"] = claimed["holder"]
        other = {**self.data, "holder": "run-two"}
        self.assertEqual(self.guard.run("claim", other)["status"], "busy")
        self.assertEqual(self.guard.run("finish", other)["status"], "busy")
        self.assertEqual(RuntimeGuard(self.root, lambda: self.now).run("check", self.data)["status"], "owned")
        self.assertEqual(self.guard.run("finish", self.data)["status"], "complete")
        self.assertEqual(self.guard.run("claim", other)["status"], "complete")
        self.assertEqual(os.stat(self.root).st_mode & 0o777, 0o700)
        self.assertEqual(os.stat(self.root / (self.data["conversationId"] + ".json")).st_mode & 0o777, 0o600)

    def test_stale_or_changed_policy_cannot_take_over_or_extend(self):
        self.guard.run("claim", self.data)
        self.now += 1200
        self.assertEqual(self.guard.run("claim", {**self.data, "holder": "new-run", "expiresAt": self.now + 1200})["status"], "stale")
        with self.assertRaises(ValueError):
            self.guard.run("check", {**self.data, "policyHash": "b" * 64})

    def test_rejects_symlinks_and_unbounded_expiry(self):
        target = self.root / (self.data["conversationId"] + ".json")
        target.symlink_to(self.root / "absent")
        with self.assertRaises(OSError):
            self.guard.run("claim", self.data)
        target.unlink()
        with self.assertRaises(ValueError):
            self.guard.run("claim", {**self.data, "expiresAt": self.now + 99999})

    def test_concurrent_workers_cannot_both_claim(self):
        context = multiprocessing.get_context("spawn")
        queue = context.Queue()
        workers = [context.Process(target=claim_in_worker, args=(self.root, {**self.data, "holder": "run-" + str(n)}, queue)) for n in range(2)]
        for worker in workers: worker.start()
        for worker in workers:
            worker.join(10)
            self.assertEqual(worker.exitcode, 0)
        self.assertEqual(sorted(queue.get(timeout=2) for _ in workers), ["busy", "claimed"])
