/**
 * Structured search query parser supporting:
 *   tag:<name>  folder:<name>  status:<name>  has:tasks  has:cards
 *   "exact phrase"  -negation  freeTerms...
 * Produces safe FTS5 MATCH clauses guaranteed not to throw syntax errors.
 */

const FTS_RESERVED = new Set(['AND', 'OR', 'NOT', 'NEAR']);

function sanitizeFtsToken(token) {
  const cleaned = String(token || '')
    .replace(/["'():*^{}[\]\\/|+~-]/g, ' ')
    .trim();
  if (!cleaned) return null;
  const words = cleaned.split(/\s+/).filter((w) => w && !FTS_RESERVED.has(w.toUpperCase()));
  return words.length ? words : null;
}

export function parseSearchQuery(rawQuery) {
  const raw = String(rawQuery ?? '').trim();
  const filters = {
    tags: [],
    folders: [],
    status: null,
    hasTasks: false,
    hasCards: false
  };
  const freeTerms = [];
  const ftsClauses = [];

  if (!raw) {
    return { ftsMatch: null, filters, freeTerms };
  }

  const tokens = raw.match(/"[^"]*"|\S+/g) || [];
  for (const tok of tokens) {
    if (tok.startsWith('"') && tok.endsWith('"') && tok.length > 2) {
      const inner = tok.slice(1, -1).replace(/"/g, ' ').trim();
      if (inner) {
        freeTerms.push(inner);
        ftsClauses.push(`"${inner}"`);
      }
      continue;
    }

    const lower = tok.toLowerCase();
    if (lower.startsWith('tag:') && tok.length > 4) {
      filters.tags.push(tok.slice(4).trim());
      continue;
    }
    if (lower.startsWith('folder:') && tok.length > 7) {
      filters.folders.push(tok.slice(7).trim());
      continue;
    }
    if (lower.startsWith('status:') && tok.length > 7) {
      filters.status = tok.slice(7).trim().toLowerCase();
      continue;
    }
    if (lower === 'has:tasks') {
      filters.hasTasks = true;
      continue;
    }
    if (lower === 'has:cards') {
      filters.hasCards = true;
      continue;
    }

    if (tok.startsWith('-') && tok.length > 1) {
      const words = sanitizeFtsToken(tok.slice(1));
      if (words) {
        for (const w of words) {
          ftsClauses.push(`NOT ${w}`);
        }
      }
      continue;
    }

    const words = sanitizeFtsToken(tok);
    if (words) {
      for (const w of words) {
        freeTerms.push(w);
        ftsClauses.push(`${w}*`);
      }
    }
  }

  // FTS5 cannot start with NOT without a positive term
  const hasPositive = ftsClauses.some((c) => !c.startsWith('NOT '));
  const ftsMatch = hasPositive ? ftsClauses.join(' ') : null;

  return { ftsMatch, filters, freeTerms };
}
