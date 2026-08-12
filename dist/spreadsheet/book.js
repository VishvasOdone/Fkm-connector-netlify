/**
 * Builds an evaluable `Book` from the o-spreadsheet JSON delivered by Odoo,
 * plus the range lookup used to resolve per-cell style / format ids.
 */
import { keyPositions, rcKey, refRc, sortedKeys } from './refs.js';
import { newState, stFeed } from './unsquish.js';
export function buildBook(data) {
    const sheets = new Map();
    const rawSheets = new Map();
    const order = [];
    const fails = new Map();
    for (const sh of data.sheets ?? []) {
        const name = sh.name ?? '';
        const cells = sh.cells ?? {};
        const grid = new Map();
        const st = newState();
        // Column-major order matters: squished cells are deltas on their predecessor.
        for (const key of sortedKeys(cells)) {
            const res = stFeed(st, key, cells[key]);
            if (res === null)
                continue;
            for (const rc of keyPositions(key)) {
                grid.set(rcKey(rc), res);
            }
        }
        sheets.set(name, grid);
        rawSheets.set(name, sh);
        order.push(name);
        if (st.fails.length)
            fails.set(name, st.fails);
    }
    const book = { sheets, cache: new Map(), busy: new Set(), unknownFns: new Set() };
    return { book, rawSheets, order, fails };
}
/** Turn a {"A1:B2": styleId} map into ordered rectangles for lookup. */
export function buildRanges(m) {
    const out = [];
    if (!m || typeof m !== 'object')
        return out;
    for (const k of Object.keys(m)) {
        const parts = k.split(':');
        const a = refRc(parts[0]);
        if (a === null)
            continue;
        let b = parts.length > 1 ? refRc(parts[1]) : a;
        if (b === null)
            b = a;
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
export function rangeLookup(ranges, rc) {
    let hit = null;
    const [r, c] = rc;
    for (const it of ranges) {
        if (it[0] <= r && r <= it[2] && it[1] <= c && c <= it[3])
            hit = it[4];
    }
    return hit;
}
//# sourceMappingURL=book.js.map