// Kept free of zod so the browser bundle can import these without pulling in the validators.
export const platforms = ['dot', 'muse', 'duet'] as const;
export type Platform = (typeof platforms)[number];
export const platformNames: Record<Platform, string> = { dot: 'Dot', muse: 'Muse', duet: 'Duet' };
export const MAX_TEXT = 4000;
export const MAX_GRANT_TEXT = 1000;
/** How recently a platform Agent must have called the Hub to count as running. */
export const AGENT_ONLINE_SECONDS = 120;
