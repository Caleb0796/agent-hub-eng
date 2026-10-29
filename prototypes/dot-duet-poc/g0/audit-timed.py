"""Verify ciphertext-only relay evidence against native endpoint digest manifests."""
import argparse,base64,hashlib,json,re
from datetime import datetime
from pathlib import Path
import pyrage
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey

def canonical(x):return json.dumps(x,sort_keys=True,separators=(',',':'),ensure_ascii=False).encode()
def check(x,s):
    if not x:raise ValueError(s)
def stamp(s):return datetime.fromisoformat(s.replace('Z','+00:00')).timestamp()
def index(entries):
    out={}
    for e in entries:
        check(e['id'] not in out,'Duplicate manifest message')
        check(re.fullmatch('[0-9a-f]{64}',e['sha256']) is not None,'Invalid digest')
        out[e['id']]=e['sha256']
    return out

def audit(relay,manifests):
    check(relay['participants']==['dot','muse'],'Wrong participant pair')
    c=relay['conversation'];start,end=stamp(c['started_at']),stamp(c['deadline'])
    check(end-start==600,'Window is not exactly 600 seconds')
    msgs=relay['messages'];check(2<=len(msgs)<=relay['max_messages']<=64,'Unexpected message count')
    maps={}
    for role in ('dot','muse'):
        m=manifests[role];reg=relay['registrations'][role]
        check(m['role']==role and m['run_id']==relay['run_id'],'Manifest identity/run mismatch')
        check(m['fingerprint']==hashlib.sha256(canonical(reg['public'])).hexdigest(),'Native public fingerprint mismatch')
        check(m['packet_format']=='json-n-t' and m['nonce_validation_ok'] is True,'Nonce-bearing packet validation missing')
        maps[role]={'sent':index(m['sent']),'received':index(m['received'])}
        check(set(maps[role]['sent'])=={x['id'] for x in msgs if x['from']==role},'Sender manifest incomplete or contains unaccepted messages')
        check(set(maps[role]['received'])=={x['id'] for x in msgs if x['to']==role},'Receiver manifest incomplete')
    dummy=pyrage.x25519.Identity.generate();last=None;last_seq={};digests=set();results=[]
    for sequence,m in enumerate(msgs,1):
        env=m['envelope'];p=env['payload'];a,b=p['from'],p['to']
        check(m['sequence']==sequence and m['id']==p['id'] and m['from']==a and m['to']==b,'Envelope metadata mismatch')
        check(a in ('dot','muse') and b!=a and b in ('dot','muse'),'Wrong route')
        check(p['run']==relay['run_id'] and start<=stamp(m['at'])<end,'Message outside authorized window')
        check(p['expires']>stamp(m['at']),'Expired message accepted')
        check(p['seq']>last_seq.get(a,0),'Sender sequence replay')
        if last:check(last['from']!=a and p['reply_to']==last['id'],'Alternation or reply chain mismatch')
        else:check(a=='dot' and p['reply_to'] is None,'Unexpected opening message')
        pub=relay['registrations'][a]['public']
        Ed25519PublicKey.from_public_bytes(base64.b64decode(pub['sign'],validate=True)).verify(base64.b64decode(env['signature'],validate=True),canonical(p))
        raw=base64.b64decode(p['ciphertext'],validate=True);check(raw.startswith(b'age-encryption.org/v1\n'),'Invalid age envelope')
        try:pyrage.decrypt(raw,[dummy])
        except pyrage.DecryptError:pass
        else:raise ValueError('Unrelated identity decrypted ciphertext')
        digest=maps[a]['sent'][p['id']];check(digest==maps[b]['received'][p['id']],'Native plaintext-package digests differ')
        check(digest not in digests,'Repeated complete packet digest')
        digests.add(digest);last_seq[a]=p['seq'];last=m
        results.append({'id':p['id'],'from':a,'to':b,'at':m['at'],'ciphertext_sha256':hashlib.sha256(raw).hexdigest(),'ciphertext_bytes':len(raw),'native_digest_match':True,'signature_valid':True,'wrong_key_rejected':True})
    serialized=json.dumps(relay,ensure_ascii=False)
    check(not any(x in serialized for x in ['AGE-SECRET-KEY-','age_private','sign_private']),'Private-key marker in relay')
    check(not any(x in serialized for x in ['"n":','"t":','"text":']),'Plaintext packet field in relay')
    return {'run_id':relay['run_id'],'native_encrypted_conversation_verified':True,'window_seconds':600,'started_at':c['started_at'],'deadline':c['deadline'],'message_count':len(msgs),'counts':{r:sum(x['from']==r for x in msgs) for r in ('dot','muse')},'all_native_digests_match':True,'all_signatures_valid':True,'all_wrong_key_decryptions_rejected':True,'relay_private_key_and_packet_marker_scan':'passed','messages':results,'limits':'Verification uses owner-visible native digest manifests and ciphertext metadata, never endpoint private keys or Q&A plaintext. Does not attest semantic answer quality, hidden provider behavior, production security, or forward secrecy.'}

if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--relay',required=True);p.add_argument('--manifests',required=True);p.add_argument('--out',required=True);a=p.parse_args()
    r=audit(json.loads(Path(a.relay).read_text()),json.loads(Path(a.manifests).read_text()));Path(a.out).write_text(json.dumps(r,ensure_ascii=False,indent=2)+'\n');print(json.dumps({k:r[k] for k in ['native_encrypted_conversation_verified','message_count','counts','window_seconds']}))
