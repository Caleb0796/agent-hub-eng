import { safetyCode } from '../shared/crypto';

// Number matching for owner claims: the real code plus two decoys, all generated in the
// browser, so the server cannot plant the Agent's genuine code among the choices.
export function claimChoices(
  realCode: string,
  random: (bytes: Uint8Array<ArrayBuffer>) => Uint8Array = (b) => crypto.getRandomValues(b),
): string[] {
  const choices = [realCode];
  while (choices.length < 3) {
    const hex = Array.from(random(new Uint8Array(12)), (b) => b.toString(16).padStart(2, '0')).join(
      '',
    );
    const decoy = safetyCode(hex);
    if (!choices.includes(decoy)) choices.push(decoy);
  }
  for (let i = choices.length - 1; i > 0; i--) {
    const j = random(new Uint8Array(1))[0] % (i + 1);
    [choices[i], choices[j]] = [choices[j], choices[i]];
  }
  return choices;
}
