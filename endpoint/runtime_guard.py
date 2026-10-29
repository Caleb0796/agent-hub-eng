"""Local duplicate-run guard. No network, credentials, model calls, or cryptographic keys.

This records ownership of one conversation across a native worker's separate tool calls.
It never grants execution permission. Stale runs are not automatically taken over.
"""
import argparse
import fcntl
import json
import os
import re
import stat
import time
import uuid
from pathlib import Path

VERSION = "0.1.0"


class RuntimeGuard:
    def __init__(self, directory, clock=time.time):
        self.root = Path(directory).expanduser()
        self.root.mkdir(mode=0o700, parents=True, exist_ok=True)
        info = self.root.lstat()
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
            raise ValueError("Guard directory must be private and owned by this user")
        self.clock = clock

    def run(self, command, data):
        identifier = data["conversationId"]
        if str(uuid.UUID(identifier)) != identifier:
            raise ValueError("Invalid conversation ID")
        holder = str(uuid.uuid4()) if command == "claim" else data["holder"]
        policy = data["policyHash"]
        if not re.fullmatch(r"[A-Za-z0-9_.:-]{1,120}", holder) or not re.fullmatch(r"[a-f0-9]{64}", policy):
            raise ValueError("Invalid runtime identity")
        lock = os.open(self.root / ".guard.lock", os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
        with os.fdopen(lock, "r+") as mutex:
            fcntl.flock(mutex, fcntl.LOCK_EX)
            target = self.root / (identifier + ".json")
            now = int(self.clock())
            if not target.exists() and command == "claim":
                expiry = data["expiresAt"]
                if isinstance(expiry, bool) or not isinstance(expiry, int) or expiry <= now or expiry > now + 2100:
                    raise ValueError("Invalid bounded runtime expiry")
                entry = {"holder": holder, "policy_hash": policy, "expires_at": min(expiry, now + 1800), "complete": False}
                fd = os.open(target, os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_NOFOLLOW, 0o600)
                with os.fdopen(fd, "w") as output:
                    json.dump(entry, output); output.flush(); os.fsync(output.fileno())
                return {"status": "claimed", "holder": holder, "execution_permission_granted": False}
            fd = os.open(target, os.O_RDWR | os.O_NOFOLLOW)
            with os.fdopen(fd, "r+") as stored:
                info = os.fstat(stored.fileno())
                if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
                    raise ValueError("Guard state must be private")
                entry = json.load(stored)
                if entry["policy_hash"] != policy:
                    raise ValueError("Conversation policy changed")
                if entry["complete"]:
                    status = "complete"
                elif entry["expires_at"] <= now:
                    status = "stale"
                elif command == "claim" or entry["holder"] != holder:
                    status = "busy"
                else:
                    status = "owned"
                    if command == "finish":
                        entry["complete"] = True
                        stored.seek(0); json.dump(entry, stored); stored.truncate()
                        stored.flush(); os.fsync(stored.fileno())
                        status = "complete"
                return {"status": status, "execution_permission_granted": False}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--state", required=True)
    parser.add_argument("command", choices=["claim", "check", "finish"])
    args = parser.parse_args()
    import sys
    raw = sys.stdin.buffer.read(4097)
    if len(raw) > 4096:
        raise ValueError("Input too large")
    result = RuntimeGuard(args.state).run(args.command, json.loads(raw))
    print(json.dumps(result, separators=(",", ":")))


if __name__ == "__main__":
    main()
