import copy, json, time
import pytest
from endpoint import Endpoint, fingerprint

def pair(tmp_path):
    a,b=Endpoint(tmp_path/'a','dot'),Endpoint(tmp_path/'b','duet')
    a.pin(b.state['public'],fingerprint(b.state['public']))
    b.pin(a.state['public'],fingerprint(a.state['public']))
    return a,b

def test_roundtrip_persistence_and_owner_archive(tmp_path):
    a,b=pair(tmp_path)
    m=a.seal('合成机密：海底书店测试','run',idempotency_key='x')
    assert '海底' not in json.dumps(m,ensure_ascii=False)
    assert b.open(m,'run')['text']=='合成机密：海底书店测试'
    with pytest.raises(ValueError,match='Replay'): Endpoint(tmp_path/'b','duet').open(m,'run')
    assert a.open(m,'run',archive=True)['text']==b.open(m,'run',archive=True)['text']
    assert a.seal('合成机密：海底书店测试','run',idempotency_key='x')==m
    with pytest.raises(ValueError,match='Idempotency'):a.seal('changed','run',idempotency_key='x')

def test_tamper_and_wrong_context(tmp_path):
    a,b=pair(tmp_path); m=a.seal('synthetic-secret','run')
    for field,value in [('to','dot'),('run','other'),('seq',999),('ciphertext',m['payload']['ciphertext'][:-4]+'AAAA')]:
        x=copy.deepcopy(m);x['payload'][field]=value
        with pytest.raises(Exception):b.open(x,'run')
    rogue=Endpoint(tmp_path/'rogue','duet'); rogue.pin(a.state['public'],fingerprint(a.state['public']))
    with pytest.raises(Exception):rogue.open(m,'run')

def test_key_substitution_and_expiry(tmp_path,monkeypatch):
    a,b=pair(tmp_path); rogue=Endpoint(tmp_path/'rogue','duet')
    with pytest.raises(ValueError,match='Fingerprint'):a.pin(rogue.state['public'],fingerprint(b.state['public']))
    with pytest.raises(ValueError,match='Key change'):a.pin(rogue.state['public'],fingerprint(rogue.state['public']))
    m=a.seal('test','run');monkeypatch.setattr(time,'time',lambda:m['payload']['expires']+1)
    with pytest.raises(ValueError,match='expired'):b.open(m,'run')

def test_no_unpaired_send_and_private_file_mode(tmp_path):
    a=Endpoint(tmp_path,'dot')
    assert a.path.stat().st_mode & 0o777==0o600
    with pytest.raises(ValueError,match='verify'):a.seal('x','run')

def test_dot_muse_and_explicit_peer_routing(tmp_path):
    dot=Endpoint(tmp_path/'dot','dot'); muse=Endpoint(tmp_path/'muse','muse'); duet=Endpoint(tmp_path/'duet','duet')
    dot.pin(muse.state['public'],fingerprint(muse.state['public']))
    muse.pin(dot.state['public'],fingerprint(dot.state['public']))
    env=dot.seal('dot-to-muse','new-run',to='muse',idempotency_key='muse-1')
    assert env['payload']['to']=='muse'
    assert muse.open(env,'new-run')['text']=='dot-to-muse'
    dot.pin(duet.state['public'],fingerprint(duet.state['public']))
    with pytest.raises(ValueError):dot.seal('ambiguous','new-run')
    with pytest.raises(ValueError,match='Idempotency'):dot.seal('dot-to-muse','new-run',to='duet',idempotency_key='muse-1')
    with pytest.raises(ValueError,match='recipient'):duet.open(env,'new-run')
