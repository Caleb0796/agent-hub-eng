export interface Mention {
  name: string;
  start: number;
  end: number;
}

const asciiWord = /[A-Za-z0-9_]/;

/**
 * Finds "@name" for the given names, which may contain spaces or Chinese. At each "@" the longest
 * name wins, so "@caleb的 Duet" is never read as "@caleb". Names only match as whole words:
 * "@Bobby" is not "@Bob", and "bob@caleb.com" mentions nobody.
 */
export function findMentions(text: string, names: string[]): Mention[] {
  const longestFirst = [...new Set(names)]
    .filter(Boolean)
    .sort((a, b) => b.length - a.length)
    .map((name) => ({ name, lower: name.toLowerCase() }));
  const lowerText = text.toLowerCase();
  const found: Mention[] = [];
  for (let at = text.indexOf('@'); at !== -1; at = text.indexOf('@', at + 1)) {
    if (at > 0 && asciiWord.test(text[at - 1])) continue;
    const hit = longestFirst.find(({ name, lower }) => {
      if (!lowerText.startsWith(lower, at + 1)) return false;
      const next = text[at + 1 + lower.length];
      return !(next && asciiWord.test(next) && asciiWord.test(name[name.length - 1]));
    });
    if (hit) found.push({ name: hit.name, start: at, end: at + 1 + hit.name.length });
  }
  return found;
}
