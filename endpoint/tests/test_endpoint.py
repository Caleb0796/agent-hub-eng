import copy
import os
import secrets
import tempfile
import unittest
import uuid
from pathlib import Path
import pyrage
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from endpoint.agent_hub import Endpoint, VERSION, b64, canonical, digest, unb64


def owner(name):
    private = Ed25519PrivateKey.generate()
    return {"id": str(uuid.uuid4()), "name": name, "private": private,
            "public": b64(private.public_key().public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw))}


def approve(person, payload):
    return {"owner_id": person["id"], "signature": b64(person["private"].sign(canonical(payload)))}


class EndpointTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.now = 1_800_000_000
        self.alice, self.bob = owner("阿丽丝"), owner("Bob")
        self.a, self.b = Endpoint(Path(self.temp.name)/"dot", lambda:self.now), Endpoint(Path(self.temp.name)/"muse", lambda:self.now)
        people = []
        for endpoint, human, platform in [(self.a,self.alice,"dot"),(self.b,self.bob,"muse")]:
            challenge = {"v":VERSION,"agent_id":str(uuid.uuid4()),"owner_id":human["id"],"owner_key":human["public"],"nonce":b64(secrets.token_bytes(32)),"expires_at":self.now+900}
            endpoint.prepare(challenge)
            s = endpoint.state
            claim = {"v":VERSION,"kind":"owner-claim","agent_id":s["agent_id"],"owner_id":human["id"],"owner_key":human["public"],"endpoint_keys":s["keys"],"registration_nonce":s["nonce"],"fingerprint":s["fingerprint"],"generation":1}
            endpoint.claim({"payload":claim,"signature":approve(human,claim)["signature"]})
            people.append({"owner_id":human["id"],"owner_name":human["name"],"owner_key":human["public"],"agent_id":s["agent_id"],"agent_name":platform,"platform":platform,"keys":s["keys"],"generation":1,"fingerprint":s["fingerprint"]})
        descriptor = {"v":VERSION,"kind":"pairing","id":str(uuid.uuid4()),"nonce":b64(secrets.token_bytes(32)),"participants":people,"expires_at":self.now+86400}
        self.pair = {"descriptor":descriptor,"fingerprint":digest(descriptor),"approvals":[approve(self.alice,descriptor),approve(self.bob,descriptor)]}
        self.a.pair(self.pair);self.b.pair(self.pair)
        policy = {"v":VERSION,"kind":"conversation-grant","id":str(uuid.uuid4()),"pairing_id":descriptor["id"],"pairing_hash":digest(descriptor),"nonce":b64(secrets.token_bytes(32)),"initiator_agent_id":people[0]["agent_id"],"participants":people,"scope":"public-qa","duration_seconds":600,"max_messages":40,"max_plaintext_chars":2000,"start_rule":"first-recipient-delivery","receipt_grace_seconds":300,"expires_at":self.now+1800,"created_at":self.now}
        self.view = {"policy":policy,"policy_hash":digest(policy),"approvals":[approve(self.alice,policy),approve(self.bob,policy)],"status":"ready","conversation_closed":False,"started_at":None,"deadline":None,"close_reason":None}
        self.a.preflight(self.view,b64(secrets.token_bytes(32)));self.b.preflight(self.view,b64(secrets.token_bytes(32)))

    def tearDown(self):
        self.temp.cleanup()

    def round_trip(self):
        first = self.a.seal(self.view,"如果建一间海边图书馆，你会先选什么书？","opening-message")
        self.a.sent(self.view["policy"]["id"],{"status":"accepted","message_id":first["envelope"]["payload"]["id"]})
        self.view.update({"status":"active","started_at":self.now,"deadline":self.now+600})
        opened = self.b.open(self.view,first["envelope"])
        reply = self.b.seal(self.view,"我会选海洋故事和地图。你希望它每天几点开门？","reply-message",opened["message_id"])
        self.b.sent(self.view["policy"]["id"],{"status":"accepted","message_id":reply["envelope"]["payload"]["id"]})
        answer = self.a.open(self.view,reply["envelope"])
        return first,opened,reply,answer

    def test_real_age_round_trip_digest_match_and_wrong_key_rejection(self):
        first,opened,reply,answer = self.round_trip()
        self.assertIn("海边图书馆",opened["text"]);self.assertIn("地图",answer["text"])
        a,b=self.a.manifest(self.view["policy"]["id"]),self.b.manifest(self.view["policy"]["id"])
        self.assertEqual(a["sent"],b["received"]);self.assertEqual(b["sent"],a["received"])
        self.assertNotIn("海边图书馆",canonical(first).decode());self.assertNotIn("plaintext_sha256",canonical(opened["receipt"]).decode())
        with self.assertRaises(pyrage.DecryptError):pyrage.decrypt(unb64(first["envelope"]["payload"]["ciphertext"]),[pyrage.x25519.Identity.generate()])

    def test_duplicate_does_not_emit_plaintext_or_create_second_message(self):
        first,opened,_,_=self.round_trip()
        duplicate=self.b.open(self.view,first["envelope"])
        self.assertTrue(duplicate["duplicate"]);self.assertNotIn("text",duplicate)
        replay=self.a.seal(self.view,"如果建一间海边图书馆，你会先选什么书？","opening-message")
        self.assertEqual(first,replay)
        with self.assertRaisesRegex(ValueError,"Idempotency"):self.a.seal(self.view,"different text","opening-message")

    def test_wrong_owner_or_changed_pairing_cannot_replace_pinned_identity(self):
        changed=copy.deepcopy(self.pair);changed["descriptor"]["participants"][0]["owner_key"]=self.bob["public"]
        with self.assertRaisesRegex(ValueError,"Own identity changed"):self.a.pair(changed)
        changed=copy.deepcopy(self.pair);changed["approvals"]=[changed["approvals"][0],changed["approvals"][0]]
        with self.assertRaisesRegex(ValueError,"distinct owner"):self.a.pair(changed)

    def test_changed_grant_or_wrong_route_is_rejected(self):
        first,_,_,_=self.round_trip()
        changed=copy.deepcopy(self.view);changed["policy"]["max_messages"]=64
        with self.assertRaisesRegex(ValueError,"Signature"):self.a.seal(changed,"question","tampered-grant")
        changed=copy.deepcopy(first["envelope"]);changed["payload"]["to"]=self.a.state["agent_id"]
        with self.assertRaisesRegex(ValueError,"Wrong route"):self.b.open(self.view,changed)

    def test_deadline_cannot_be_extended_and_survives_process_reload(self):
        self.round_trip()
        changed=copy.deepcopy(self.view);changed["started_at"]+=30;changed["deadline"]+=30
        with self.assertRaisesRegex(ValueError,"clock cannot"):self.a.seal(changed,"question","extended-clock",self.a.state["grants"][self.view["policy"]["id"]]["last_received_id"])
        self.now+=600
        reloaded=Endpoint(self.a.directory,lambda:self.now)
        with self.assertRaisesRegex(ValueError,"deadline"):reloaded.seal(self.view,"late","late-message",reloaded.state["grants"][self.view["policy"]["id"]]["last_received_id"])

    def test_only_closed_receipt_processing_after_deadline_and_private_state_permissions(self):
        first=self.a.seal(self.view,"A final public question","final-before-end")
        self.a.sent(self.view["policy"]["id"],{"status":"accepted","message_id":first["envelope"]["payload"]["id"]})
        self.view.update({"status":"expired","started_at":self.now,"deadline":self.now+600,"conversation_closed":True,"close_reason":"deadline_reached"});self.now+=601
        opened=self.b.open(self.view,first["envelope"])
        self.assertFalse(opened["reply_allowed"])
        with self.assertRaisesRegex(ValueError,"not open"):self.b.seal(self.view,"reply","forbidden-reply",opened["message_id"])
        self.assertEqual(os.stat(self.a.path).st_mode&0o777,0o600)
        self.assertEqual(os.stat(self.a.directory).st_mode&0o777,0o700)


if __name__=="__main__":unittest.main()
