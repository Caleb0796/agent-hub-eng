import { describe, expect, it } from 'vitest';
import { eventReceiverMatches } from '../src/web/receiving';

describe('receiver configuration belongs to a specific pairing', () => {
  it('does not claim an old-contact subscription covers a new contact', () => {
    const receiver = { agent_id: 'dot', name: 'hub.session.authorized', pairing_id: 'old-pair' };
    expect(eventReceiverMatches(receiver, 'dot', 'new-pair', receiver.name)).toBe(false);
    expect(eventReceiverMatches(receiver, 'dot', 'old-pair', receiver.name)).toBe(true);
  });

  it('only treats an explicit unfiltered subscription as covering any pairing', () => {
    const receiver = { agent_id: 'dot', name: 'hub.session.authorized', pairing_id: null };
    expect(eventReceiverMatches(receiver, 'dot', 'new-pair', receiver.name)).toBe(true);
    expect(
      eventReceiverMatches(
        { ...receiver, pairing_id: undefined },
        'dot',
        'new-pair',
        receiver.name,
      ),
    ).toBe(false);
  });

  it('requires the same endpoint and event type', () => {
    const receiver = { agent_id: 'dot', name: 'hub.request.created', pairing_id: 'pair' };
    expect(eventReceiverMatches(receiver, 'other-dot', 'pair', receiver.name)).toBe(false);
    expect(eventReceiverMatches(receiver, 'dot', 'pair', 'hub.session.authorized')).toBe(false);
  });
});
