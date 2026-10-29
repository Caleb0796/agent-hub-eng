"""Check a two-message native Dot/Muse experiment without importing endpoint secrets.
Native receipts contain plaintext SHA-256 digests only, never the random plaintext.
This is evidence checking, not an independent cryptographic security audit.
"""
import argparse, base64, hashlib, json, re
from pathlib import Path
import pyrage
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey


def canonical(x): return json.dumps(x,sort_keys=True,separators=(',',':'),ensure_ascii=False).encode()
def check(value, message):
    if not value: raise ValueError(message)


def audit(relay, receipts):
    check(relay['participants']==['dot','muse'],'Unexpected participants')
    check(len(relay['messages'])==2,'Expected exactly one two-message round trip')
    serialized=json.dumps(relay,ensure_ascii=False)
    prohibited=['AGE-SECRET-KEY-','age_private','sign_private','G0-DOT-MUSE-SECRET:','ACK:','|MUSE:']
    check(not any(s in serialized for s in prohibited),'Unexpected endpoint key field or plaintext marker in relay state')
    attacker=pyrage.x25519.Identity.generate()
    results=[]
    for m in relay['messages']:
        env=m['envelope'];p=env['payload'];role=p['from'];peer='muse' if role=='dot' else 'dot'
        check(role in ('dot','muse') and p['to']==peer and p['run']==relay['run_id'],'Routing mismatch')
        reg=relay['registrations'][role]
        check(reg['status']=='claimed','Unclaimed sender')
        fingerprint=hashlib.sha256(canonical(reg['public'])).hexdigest()
        check(fingerprint==receipts[role]['fingerprint'],'Native fingerprint mismatch')
        Ed25519PublicKey.from_public_bytes(base64.b64decode(reg['public']['sign'],validate=True)).verify(base64.b64decode(env['signature'],validate=True),canonical(p))
        raw=base64.b64decode(p['ciphertext'],validate=True)
        check(raw.startswith(b'age-encryption.org/v1\n'),'Not age v1')
        try: pyrage.decrypt(raw,[attacker])
        except pyrage.DecryptError: wrong_key_rejected=True
        else: raise ValueError('Unexpected decryption with an unrelated identity')
        sender,recipient=receipts[role],receipts[peer]
        check(sender['sent_message_id']==recipient['received_message_id']==p['id'],'Receipt/message ID mismatch')
        check(re.fullmatch('[0-9a-f]{64}',sender['sent_plaintext_sha256']) is not None,'Invalid plaintext digest')
        check(sender['sent_plaintext_sha256']==recipient['received_plaintext_sha256'],'Native decrypted digest mismatch')
        results.append({'id':p['id'],'from':role,'to':peer,'ciphertext_sha256':hashlib.sha256(raw).hexdigest(),'ciphertext_bytes':len(raw),'native_plaintext_sha256':sender['sent_plaintext_sha256'],'signature_valid':True,'wrong_key_rejected':wrong_key_rejected})
    first,second=relay['messages']
    check(first['from']=='dot' and second['from']=='muse','Unexpected direction')
    check(second['envelope']['payload']['reply_to']==first['id'],'Reply chain mismatch')
    check(receipts['dot']['ack_matches_local_challenge'] is True,'Native Dot did not verify the acknowledgement against its local challenge')
    return {'run_id':relay['run_id'],'native_roundtrip_verified':True,'messages':results,'ack_digest_matches':True,
            'strict_ack_format_valid':receipts['dot'].get('strict_ack_format_valid'),
            'ack_format_observation':{'leading_ascii_spaces':receipts['dot'].get('ack_leading_ascii_spaces'),'trailing_ascii_spaces':receipts['dot'].get('ack_trailing_ascii_spaces')},
            'relay_secret_and_plaintext_marker_scan':'passed','private_keys_supplied_to_auditor':False,
            'limits':'This checks observed native receipts, signatures and relay data. Application ACK formatting is reported separately and is not silently corrected. It does not prove resistance to compromised endpoints or replace protocol review. Model providers remain trusted plaintext processors; no forward secrecy.'}


if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--relay',required=True);p.add_argument('--receipts',required=True);p.add_argument('--out',required=True);a=p.parse_args()
    result=audit(json.loads(Path(a.relay).read_text()),json.loads(Path(a.receipts).read_text()))
    Path(a.out).write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n')
    print(json.dumps({'native_roundtrip_verified':True,'message_count':len(result['messages']),'report':a.out}))
