import { categoryFromHeader, type Category } from '@/app/projects/tripplanner/_components/placeTypes';

export interface ParsedItem {
  key: string;
  raw: string;
  hint: string | null;          // column header text, sent to Claude
  tip: string | null;           // text after " - " on the same line: saved as the place's note
  guess: Category | null;       // what the header maps to locally, for the preview
}

export interface ParsedList {
  items: ParsedItem[];
  headers: { text: string; category: Category | null; count: number }[];
}

// "Shanghai Tower - go before sunset": the part after a spaced dash (-, – or —) is a tip.
// Needs spaces around the dash so names like "Wan-Chai" or "Tsim Sha Tsui-East" stay whole.
export function splitTip(cell: string): { name: string; tip: string | null } {
  const m = cell.match(/^(.+?)\s+[-–—]\s+(.+)$/);
  if (!m) return { name: cell, tip: null };
  return { name: m[1].trim(), tip: m[2].trim() || null };
}

// Handles both a copy-paste from Google Sheets / Excel (tab-separated columns,
// optional title rows, a header row of categories) and a plain one-per-line list.
export function parsePastedList(text: string): ParsedList {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const hasTabs = lines.some(l => l.includes('\t'));
  const rows = lines.map(l => (hasTabs ? l.split('\t') : [l]).map(c => c.trim()));

  // Header = first row where at least two cells look like category names.
  let headerRow = -1;
  if (hasTabs) {
    headerRow = rows.findIndex(r => r.filter(c => c && categoryFromHeader(c)).length >= 2);
  }

  const headerTexts: string[] = headerRow >= 0 ? rows[headerRow] : [];
  const counts = new Map<number, number>();
  const seen = new Set<string>();
  const items: ParsedItem[] = [];

  rows.forEach((cells, r) => {
    if (headerRow >= 0 && r <= headerRow) return;
    cells.forEach((cell, c) => {
      if (!cell || cell.length < 2) return;
      const { name, tip } = splitTip(cell);
      const dedupeKey = name.toLowerCase().replace(/\s+/g, ' ');
      if (seen.has(dedupeKey)) return;
      seen.add(dedupeKey);
      const hint = headerTexts[c]?.trim() || null;
      items.push({ key: `r${r}c${c}`, raw: name, hint, tip, guess: hint ? categoryFromHeader(hint) : null });
      counts.set(c, (counts.get(c) ?? 0) + 1);
    });
  });

  const headers = headerTexts
    .map((t, c) => ({ text: t.trim(), category: t ? categoryFromHeader(t) : null, count: counts.get(c) ?? 0 }))
    .filter(h => h.text && h.count > 0);

  return { items, headers };
}
