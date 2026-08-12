/**
 * Builds an evaluable `Book` from the o-spreadsheet JSON delivered by Odoo,
 * plus the range lookup used to resolve per-cell style / format ids.
 */
import { RC, keyPositions, rcKey, refRc, sortedKeys } from './refs.js';
import { Book, Grid } from './evaluator.js';
import { newState, stFeed } from './unsquish.js';

export interface SheetJson {
  id?: string;
  name?: string;
  cells?: Record<string, unknown>;
  merges?: string[];
  cols?: Record<string, { size?: number } | unknown>;
  rows?: Record<string, { size?: number } | unknown>;
  styles?: Record<string, number>;
  formats?: Record<string, number>;
  /** Range map ("I4:I6" -> border id) into the workbook's `borders` table. */
  borders?: Record<string, number>;
  /** Anchored images and charts; only `tag: "image"` entries are rendered. */
  figures?: unknown[];
  [k: string]: unknown;
}

export interface SpreadsheetJson {
  sheets?: SheetJson[];
  styles?: Record<string, Record<string, unknown>>;
  formats?: Record<string, unknown>;
  /** Shared border definitions, keyed by the ids the sheet range maps use. */
  borders?: Record<string, unknown>;
  [k: string]: unknown;
}

export interface BuiltBook {
  book: Book;
  rawSheets: Map<string, SheetJson>;
  order: string[];
  fails: Map<string, string[]>;
}

export function buildBook(data: SpreadsheetJson): BuiltBook {
  const sheets = new Map<string, Grid>();
  const rawSheets = new Map<string, SheetJson>();
  const order: string[] = [];
  const fails = new Map<string, string[]>();

  for (const sh of data.sheets ?? []) {
    const name = sh.name ?? '';
    const cells = sh.cells ?? {};
    const grid: Grid = new Map();
    const st = newState();

    // Column-major order matters: squished cells are deltas on their predecessor.
    for (const key of sortedKeys(cells)) {
      const res = stFeed(st, key, cells[key]);
      if (res === null) continue;
      for (const rc of keyPositions(key)) {
        grid.set(rcKey(rc), res);
      }
    }

    sheets.set(name, grid);
    rawSheets.set(name, sh);
    order.push(name);
    if (st.fails.length) fails.set(name, st.fails);
  }

  const book: Book = { sheets, cache: new Map(), busy: new Set(), unknownFns: new Set() };
  return { book, rawSheets, order, fails };
}

/** [rowMin, colMin, rowMax, colMax, payload] */
export type RangeEntry = [number, number, number, number, number];

/** Turn a {"A1:B2": styleId} map into ordered rectangles for lookup. */
export function buildRanges(m: Record<string, number> | undefined | null): RangeEntry[] {
  const out: RangeEntry[] = [];
  if (!m || typeof m !== 'object') return out;

  for (const k of Object.keys(m)) {
    const parts = k.split(':');
    const a = refRc(parts[0]);
    if (a === null) continue;
    let b = parts.length > 1 ? refRc(parts[1]) : a;
    if (b === null) b = a;
    out.push([
      Math.min(a[0], b[0]),
      Math.min(a[1], b[1]),
      Math.max(a[0], b[0]),
      Math.max(a[1], b[1]),
      m[k],
    ]);
  }
  return out;
}

/** Last matching rectangle wins, matching the Python lookup. */
export function rangeLookup(ranges: RangeEntry[], rc: RC): number | null {
  let hit: number | null = null;
  const [r, c] = rc;
  for (const it of ranges) {
    if (it[0] <= r && r <= it[2] && it[1] <= c && c <= it[3]) hit = it[4];
  }
  return hit;
}
