"""Agent Hub's native-runtime cryptographic endpoint. No network or model APIs.

Commands consume JSON on stdin and emit a public result on stdout. Secret keys
live only in the endpoint's mode-0600 state file. Transport uses the native
platform's OAuth/vault; OAuth tokens never enter this module.
"""
from __future__ import annotations
import argparse
import base64
import fcntl
import hashlib
import json
import os
import re
import secrets
import sys
import time
import uuid
from pathlib import Path
import pyrage
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey, Ed25519PublicKey

VERSION = "agent-hub/1"


def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")


def digest(value):
    return hashlib.sha256(canonical(value)).hexdigest()


def b64(raw):
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")


def unb64(text):
    require(isinstance(text, str) and re.fullmatch(r"[A-Za-z0-9_-]+", text), "Invalid encoding")
    raw = base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))
    require(b64(raw) == text, "Noncanonical encoding")
    return raw


def require(condition, message):
    if not condition:
        raise ValueError(message)


def identifier(value):
    require(isinstance(value, str) and str(uuid.UUID(value)) == value, "Invalid identity")
    return value


def verify(public, payload, signature):
    try:
        key, sig = unb64(public), unb64(signature)
        require(len(key) == 32 and len(sig) == 64, "Invalid signature size")
        Ed25519PublicKey.from_public_bytes(key).verify(sig, canonical(payload))
    except Exception as exc:
        raise ValueError("Signature verification failed") from exc


def identity_hash(agent_id, owner_id, owner_key, keys, generation=1):
    return digest({"v": VERSION, "agent_id": agent_id, "owner_id": owner_id, "owner_key": owner_key, "keys": keys, "generation": generation})


def code(value):
    return " ".join(value[i:i + 4].upper() for i in range(0, 24, 4))


class Endpoint:
    def __init__(self, directory, clock=time.time):
        self.directory = Path(directory)
        self.directory.mkdir(mode=0o700, parents=True, exist_ok=True)
        require(not self.directory.is_symlink(), "State directory must not be a symlink")
        require(self.directory.stat().st_mode & 0o077 == 0, "State directory must be private (0700)")
        self.path = self.directory / "endpoint-secret.json"
        self.clock = clock
        self.state = None
        if self.path.exists():
            require(not self.path.is_symlink() and self.path.stat().st_mode & 0o077 == 0, "Endpoint state must be a private regular file")
            self.state = json.loads(self.path.read_text())

    def save(self):
        temporary = self.directory / (".state-" + secrets.token_hex(12))
        descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        try:
            with os.fdopen(descriptor, "wb") as stream:
                stream.write(canonical(self.state)); stream.flush(); os.fsync(stream.fileno())
            os.replace(temporary, self.path)
        finally:
            if temporary.exists():
                temporary.unlink()

    def sign(self, payload):
        require(self.state is not None, "Initialize the endpoint first")
        key = Ed25519PrivateKey.from_private_bytes(unb64(self.state["sign_private"]))
        return {"payload": payload, "signature": b64(key.sign(canonical(payload)))}

    def prepare(self, challenge):
        require(challenge.get("v") == VERSION, "Unsupported protocol")
        agent_id, owner_id = identifier(challenge["agent_id"]), identifier(challenge["owner_id"])
        require(len(unb64(challenge["owner_key"])) == 32 and len(unb64(challenge["nonce"])) == 32, "Invalid enrollment keys")
        require(challenge["expires_at"] > self.clock(), "Enrollment expired")
        if self.state:
            require(all(self.state[k] == challenge[k] for k in ("agent_id", "owner_id", "owner_key", "nonce")), "Existing identity cannot be replaced")
        else:
            age = pyrage.x25519.Identity.generate()
            signing = Ed25519PrivateKey.generate()
            public = signing.public_key().public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw)
            self.state = {"v": VERSION, "agent_id": agent_id, "owner_id": owner_id,
                "owner_key": challenge["owner_key"], "nonce": challenge["nonce"], "generation": 1,
                "keys": {"age": str(age.to_public()), "sign": b64(public)},
                "age_private": str(age),
                "sign_private": b64(signing.private_bytes(serialization.Encoding.Raw, serialization.PrivateFormat.Raw, serialization.NoEncryption())),
                "claim": None, "pairs": {}, "grants": {}}
            self.state["fingerprint"] = identity_hash(agent_id, owner_id, challenge["owner_key"], self.state["keys"])
            self.save()
        payload = {"v": VERSION, "kind": "endpoint-registration", "agent_id": agent_id, "owner_id": owner_id,
            "owner_key": self.state["owner_key"], "nonce": self.state["nonce"], "keys": self.state["keys"]}
        return {"registration": self.sign(payload), "fingerprint": self.state["fingerprint"], "safety_code": code(self.state["fingerprint"])}

    def claim(self, certificate):
        require(self.state, "Initialize first")
        expected = {"v": VERSION, "kind": "owner-claim", "agent_id": self.state["agent_id"], "owner_id": self.state["owner_id"],
            "owner_key": self.state["owner_key"], "endpoint_keys": self.state["keys"], "registration_nonce": self.state["nonce"],
            "fingerprint": self.state["fingerprint"], "generation": self.state["generation"]}
        require(certificate["payload"] == expected, "Owner claim does not match the original endpoint")
        verify(self.state["owner_key"], expected, certificate["signature"])
        self.state["claim"] = certificate
        self.save()
        return {"proof": self.sign({"v": VERSION, "kind": "claim-confirmation", "agent_id": self.state["agent_id"], "claim_hash": digest(certificate)})}

    def pair(self, view):
        require(self.state and self.state["claim"], "Owner must claim this endpoint first")
        payload = view["descriptor"]
        require(payload["v"] == VERSION and payload["kind"] == "pairing", "Invalid pairing certificate")
        identifier(payload["id"])
        require(len(payload["participants"]) == 2, "Exactly two participants required")
        own = [p for p in payload["participants"] if p["agent_id"] == self.state["agent_id"]]
        require(len(own) == 1, "Pairing does not include this endpoint")
        own = own[0]
        require(own["owner_id"] == self.state["owner_id"] and own["owner_key"] == self.state["owner_key"] and own["keys"] == self.state["keys"], "Own identity changed")
        require(len({p["owner_id"] for p in payload["participants"]}) == 2, "Pairing requires independent owners")
        for p in payload["participants"]:
            identifier(p["agent_id"]); identifier(p["owner_id"])
            require(p["fingerprint"] == identity_hash(p["agent_id"], p["owner_id"], p["owner_key"], p["keys"], p["generation"]), "Participant fingerprint mismatch")
            pyrage.x25519.Recipient.from_str(p["keys"]["age"])
        self._owner_signatures(payload, view["approvals"])
        hashed = digest(payload)
        require(view["fingerprint"] == hashed, "Pairing hash mismatch")
        old = self.state["pairs"].get(payload["id"])
        require((old and old["fingerprint"] == hashed) or (not old and payload["expires_at"] > self.clock()), "Pairing changed or expired")
        self.state["pairs"][payload["id"]] = {"descriptor": payload, "fingerprint": hashed, "approvals": view["approvals"]}
        self.save()
        proof = self.sign({"v": VERSION, "kind": "pairing-confirmation", "pairing_id": payload["id"], "agent_id": self.state["agent_id"], "pairing_hash": hashed})
        return {"pairingId": payload["id"], "signature": proof["signature"]}

    @staticmethod
    def _owner_signatures(payload, approvals):
        require(len(approvals) == 2 and len({a["owner_id"] for a in approvals}) == 2, "Two distinct owner signatures required")
        for p in payload["participants"]:
            match = [a for a in approvals if a["owner_id"] == p["owner_id"]]
            require(len(match) == 1, "Missing owner approval")
            verify(p["owner_key"], payload, match[0]["signature"])

    def _grant(self, view):
        require(self.state and self.state["claim"], "Endpoint not claimed")
        p = view["policy"]
        require(p["v"] == VERSION and p["kind"] == "conversation-grant" and p["scope"] == "public-qa", "Unsupported conversation scope")
        identifier(p["id"])
        pair = self.state["pairs"].get(p["pairing_id"])
        require(pair and p["pairing_hash"] == pair["fingerprint"] and p["participants"] == pair["descriptor"]["participants"], "Grant does not match pinned pairing")
        require(isinstance(p["duration_seconds"], int) and 60 <= p["duration_seconds"] <= 600 and isinstance(p["max_messages"], int) and 2 <= p["max_messages"] <= 64, "Invalid time or message limits")
        require(p["max_plaintext_chars"] == 2000 and p["start_rule"] == "first-recipient-delivery" and p["receipt_grace_seconds"] == 300, "Unknown grant policy")
        require(p["created_at"] <= self.clock() + 30 and 0 < p["expires_at"] - p["created_at"] <= 1800, "Invalid grant validity")
        self._owner_signatures(p, view["approvals"])
        require(view["policy_hash"] == digest(p), "Grant hash mismatch")
        entry = self.state["grants"].get(p["id"])
        if entry:
            require(entry["hash"] == view["policy_hash"], "Grant cannot be changed")
        else:
            require(p["expires_at"] > self.clock(), "Grant expired")
            entry = {"policy": p, "hash": view["policy_hash"], "sent": {}, "received": {}, "next_sequence": 1,
                "last_sent_id": None, "last_received_id": None, "last_received_sequence": 0,
                "server_deadline": None, "safety_deadline": None}
            self.state["grants"][p["id"]] = entry
        return entry

    def _observe(self, view, sending=False):
        entry = self._grant(view); p = entry["policy"]; now = self.clock()
        require(view.get("status") not in ("revoked",) and view.get("close_reason") not in ("owner-ended", "owner-declined", "agent-ended", "agent-revoked", "pairing-revoked"), "Permission revoked or ended")
        if view.get("deadline") is not None:
            deadline, started = view["deadline"], view["started_at"]
            require(isinstance(deadline, int) and isinstance(started, int) and 0 < deadline-started <= p["duration_seconds"] and deadline <= p["expires_at"], "Invalid server clock")
            require(entry["server_deadline"] in (None, deadline), "Conversation clock cannot be extended or replaced")
            entry["server_deadline"] = deadline
        if sending:
            require(not view["conversation_closed"] and view["status"] in ("ready", "active"), "Conversation is not open for sending")
            require(now < p["expires_at"] and (entry["server_deadline"] is None or now < entry["server_deadline"]) and (entry["safety_deadline"] is None or now < entry["safety_deadline"]), "Conversation deadline reached")
        else:
            end = min(p["expires_at"], entry["server_deadline"] or p["expires_at"])
            require(now < end + p["receipt_grace_seconds"], "Receipt window expired")
        return entry

    def preflight(self, view, nonce):
        entry = self._observe(view)
        require(view["status"] in ("authorized", "ready", "active") and not view["conversation_closed"], "Conversation not authorized")
        require(len(unb64(nonce)) == 32, "Invalid readiness nonce")
        proof = self.sign({"v": VERSION, "kind": "session-preflight", "conversation_id": entry["policy"]["id"],
            "agent_id": self.state["agent_id"], "grant_hash": entry["hash"], "nonce": nonce})
        self.save()
        return {"conversationId": entry["policy"]["id"], "signature": proof["signature"]}

    def seal(self, view, text, idempotency_key, reply_to=None):
        entry = self._observe(view, sending=True); p = entry["policy"]
        require(isinstance(text, str) and 0 < len(text) <= p["max_plaintext_chars"], "Plaintext length out of range")
        require(isinstance(idempotency_key, str) and re.fullmatch(r"[A-Za-z0-9:_-]{8,120}", idempotency_key), "Invalid idempotency key")
        input_hash = digest({"text": text, "reply_to": reply_to})
        old = entry["sent"].get(idempotency_key)
        if old:
            require(old["input_hash"] == input_hash, "Idempotency key reused for different content")
            return {"envelope": old["envelope"], "idempotencyKey": idempotency_key}
        require(len(entry["sent"]) < (p["max_messages"] + 1)//2, "Local sender limit reached")
        if entry["last_received_id"] is None:
            require(p["initiator_agent_id"] == self.state["agent_id"] and not entry["sent"] and reply_to is None, "Only the initiating endpoint may open")
        else:
            require(reply_to == entry["last_received_id"] and not any(s["envelope"]["payload"]["reply_to"] == reply_to for s in entry["sent"].values()), "Reply must reference the latest unhandled peer message")
        peer = next(p for p in p["participants"] if p["agent_id"] != self.state["agent_id"])
        packed = json.dumps({"n": secrets.token_hex(16), "t": text}, ensure_ascii=False, separators=(",", ":")).encode()
        ciphertext = pyrage.encrypt(packed, [pyrage.x25519.Recipient.from_str(peer["keys"]["age"])])
        at = int(self.clock())
        payload = {"v": VERSION, "kind": "encrypted-message", "id": str(uuid.uuid4()), "conversation_id": p["id"], "grant_hash": entry["hash"],
            "from": self.state["agent_id"], "to": peer["agent_id"], "sequence": entry["next_sequence"], "expires_at": min(at + 900, p["expires_at"]),
            "reply_to": reply_to, "ciphertext": b64(ciphertext)}
        envelope = self.sign(payload)
        entry["sent"][idempotency_key] = {"envelope": envelope, "input_hash": input_hash, "plaintext_sha256": hashlib.sha256(packed).hexdigest(), "accepted": False}
        entry["next_sequence"] += 1
        if entry["safety_deadline"] is None: entry["safety_deadline"] = at + p["duration_seconds"]
        self.save()
        return {"envelope": envelope, "idempotencyKey": idempotency_key}

    def sent(self, conversation_id, receipt):
        entry = self.state["grants"][conversation_id]
        require(receipt["status"] in ("accepted", "already_accepted"), "Hub did not acknowledge acceptance")
        candidates = [s for s in entry["sent"].values() if s["envelope"]["payload"]["id"] == receipt["message_id"]]
        require(len(candidates) == 1, "Unknown sent message")
        candidates[0]["accepted"] = True; entry["last_sent_id"] = receipt["message_id"]
        self.save()
        return {"accepted": True, "message_id": receipt["message_id"]}

    def open(self, view, envelope):
        entry = self._observe(view); grant = entry["policy"]; p = envelope["payload"]
        require(set(envelope) == {"payload", "signature"} and set(p) == {"v", "kind", "id", "conversation_id", "grant_hash", "from", "to", "sequence", "expires_at", "reply_to", "ciphertext"}, "Unexpected envelope fields")
        require(p["v"] == VERSION and p["kind"] == "encrypted-message" and p["conversation_id"] == grant["id"] and p["grant_hash"] == entry["hash"], "Wrong conversation")
        peer = next(x for x in grant["participants"] if x["agent_id"] != self.state["agent_id"])
        require(p["from"] == peer["agent_id"] and p["to"] == self.state["agent_id"], "Wrong route")
        verify(peer["keys"]["sign"], p, envelope["signature"])
        hashed = digest(envelope)
        if p["id"] in entry["received"]:
            old = entry["received"][p["id"]]
            require(old["envelope_hash"] == hashed, "Duplicate ID contains different ciphertext")
            return {"duplicate": True, "message_id": p["id"], "receipt": old["receipt"]}
        require(isinstance(p["sequence"], int) and p["sequence"] > entry["last_received_sequence"], "Replayed sequence")
        require(p["expires_at"] > self.clock(), "Message expired")
        if entry["last_sent_id"] is None:
            require(grant["initiator_agent_id"] == peer["agent_id"] and not entry["received"] and p["reply_to"] is None, "Invalid opening reference")
        else: require(p["reply_to"] == entry["last_sent_id"], "Reply does not match last accepted local message")
        raw = unb64(p["ciphertext"])
        require(len(raw) <= 32768, "Ciphertext too large")
        packed = pyrage.decrypt(raw, [pyrage.x25519.Identity.from_str(self.state["age_private"])])
        body = json.loads(packed)
        require(set(body) == {"n", "t"} and isinstance(body["n"], str) and re.fullmatch(r"[0-9a-f]{32}", body["n"]) and isinstance(body["t"], str) and len(body["t"]) <= grant["max_plaintext_chars"], "Invalid plaintext packet")
        receipt = self.sign({"v": VERSION, "kind": "message-receipt", "conversation_id": grant["id"], "message_id": p["id"],
            "receiver_id": self.state["agent_id"], "envelope_hash": hashed, "decrypted": True})
        entry["received"][p["id"]] = {"envelope_hash": hashed, "plaintext_sha256": hashlib.sha256(packed).hexdigest(), "receipt": receipt}
        entry["last_received_id"] = p["id"]; entry["last_received_sequence"] = p["sequence"]
        if entry["safety_deadline"] is None: entry["safety_deadline"] = int(self.clock()) + grant["duration_seconds"]
        self.save()
        return {"duplicate": False, "message_id": p["id"], "text": body["t"], "receipt": receipt,
            "reply_allowed": not view["conversation_closed"] and self.clock() < entry["safety_deadline"]}

    def cleanup(self, conversation_id, result, task_reference):
        require(result in ("complete", "failed") and isinstance(task_reference, str) and len(task_reference) <= 200, "Invalid cleanup report")
        require(conversation_id in self.state["grants"], "Unknown conversation")
        return {"agentId": self.state["agent_id"], "conversationId": conversation_id, "proof": self.sign({"v": VERSION,
            "kind": "session-cleanup", "agent_id": self.state["agent_id"], "conversation_id": conversation_id,
            "result": result, "task_reference": task_reference})}

    def manifest(self, conversation_id):
        entry = self.state["grants"][conversation_id]
        return {"agent_id": self.state["agent_id"], "conversation_id": conversation_id, "fingerprint": self.state["fingerprint"],
            "sent": [{"id": s["envelope"]["payload"]["id"], "sha256": s["plaintext_sha256"]} for s in entry["sent"].values() if s["accepted"]],
            "received": [{"id": key, "sha256": value["plaintext_sha256"]} for key, value in entry["received"].items()],
            "nonce_validation_ok": True, "note": "Local test receipt only. Never submit plaintext-package digests to the Hub."}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--state", required=True)
    parser.add_argument("command", choices=["prepare", "claim", "pair", "preflight", "seal", "sent", "open", "cleanup", "manifest"])
    args = parser.parse_args()
    source = sys.stdin.buffer.read(160_001)
    require(len(source) <= 160_000, "Input too large")
    data = json.loads(source)
    directory = Path(args.state); directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    lockfd = os.open(directory / ".lock", os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    with os.fdopen(lockfd, "w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        endpoint = Endpoint(directory)
        commands = {
            "prepare": lambda: endpoint.prepare(data["challenge"]),
            "claim": lambda: endpoint.claim(data["certificate"]),
            "pair": lambda: endpoint.pair(data["pairing"]),
            "preflight": lambda: endpoint.preflight(data["conversation"], data["nonce"]),
            "seal": lambda: endpoint.seal(data["conversation"], data["text"], data["idempotencyKey"], data.get("reply_to")),
            "sent": lambda: endpoint.sent(data["conversation_id"], data["receipt"]),
            "open": lambda: endpoint.open(data["conversation"], data["envelope"]),
            "cleanup": lambda: endpoint.cleanup(data["conversation_id"], data["result"], data["task_reference"]),
            "manifest": lambda: endpoint.manifest(data["conversation_id"]),
        }
        print(json.dumps(commands[args.command](), ensure_ascii=False, separators=(",", ":")))


if __name__ == "__main__":
    try: main()
    except Exception as error:
        # Do not print input, plaintext, private values or the raw exception chain.
        print(json.dumps({"error": "endpoint_failed", "type": type(error).__name__, "message": str(error) if isinstance(error, ValueError) else "Endpoint operation failed"}), file=sys.stderr)
        sys.exit(1)
