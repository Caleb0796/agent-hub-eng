export function eventReceiverMatches(
  receiver: { agent_id: string; name: string; pairing_id?: string | null },
  agentId: string,
  pairingId: string,
  eventName: string,
): boolean {
  return (
    receiver.agent_id === agentId &&
    receiver.name === eventName &&
    (receiver.pairing_id === null || receiver.pairing_id === pairingId)
  );
}
