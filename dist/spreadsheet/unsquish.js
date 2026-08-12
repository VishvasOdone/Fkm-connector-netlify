/**
 * o-spreadsheet (Odoo 19.1+) "squished" cell decoder.
 *
 * Cells in a sheet are stored column-major, and every cell after the first only
 * records how it differs from the previous one: `N` numeric deltas, `S` string
 * replacements and `R` reference shifts. Feeding the keys in `sortedKeys` order
 * through a single `St` rebuilds each cell's real token list.
 */
import { refRc } from './refs.js';
import { tokenize } from './tokenizer.js';
import { toNum } from './values.js';
export function newState() {
    return {
        base: null,
        nslot: [],
        sslot: [],
        rslot: [],
        nbase: [],
        sbase: [],
        napp: [],
        sprev: [],
        rapp: [],
        prev: null,
        strategy: null,
        fails: [],
    };
}
function slots(toks) {
    const nums = [];
    const strs = [];
    const refs = [];
    toks.forEach((t, idx) => {
        if (t[0] === 'num')
            nums.push(idx);
        else if (t[0] === 'str')
            strs.push(idx);
        else if (t[0] === 'ref' || t[0] === 'rng')
            refs.push(idx);
    });
    return [nums, strs, refs];
}
function tokDep(t) {
    if (t[0] === 'ref') {
        const [sheet, a] = t[1];
        return { s: sheet, r1: a[0], c1: a[1], r2: a[0], c2: a[1] };
    }
    const [sheet, a, b] = t[1];
    return { s: sheet, r1: a[0], c1: a[1], r2: b[0], c2: b[1] };
}
function depTok(d) {
    if (d.r1 === d.r2 && d.c1 === d.c2) {
        return ['ref', [d.s, [d.r1, d.c1]]];
    }
    return ['rng', [d.s, [d.r1, d.c1], [d.r2, d.c2]]];
}
/** Parse an absolute reference string from an `R` delta, e.g. "'Sheet'!A1:B2". */
function parseXc(input) {
    let sheet = null;
    let s = input;
    if (s.startsWith("'")) {
        const end = s.indexOf("'", 1);
        if (end < 0)
            return null;
        sheet = s.slice(1, end);
        if (end + 1 >= s.length || s[end + 1] !== '!')
            return null;
        s = s.slice(end + 2);
    }
    else if (s.includes('!')) {
        const idx = s.indexOf('!');
        sheet = s.slice(0, idx);
        s = s.slice(idx + 1);
    }
    const p = s.split(':');
    const a = refRc(p[0]);
    if (a === null)
        return null;
    const b = p.length > 1 ? refRc(p[1]) : a;
    if (b === null)
        return null;
    return { s: sheet, r1: a[0], c1: a[1], r2: b[0], c2: b[1] };
}
/** Start a fresh base formula; subsequent squished cells are deltas against it. */
export function stNewFormula(st, content) {
    const toks = tokenize(content.slice(1));
    if (toks === null) {
        st.base = null;
        return false;
    }
    st.base = toks;
    [st.nslot, st.sslot, st.rslot] = slots(toks);
    st.nbase = st.nslot.map((i) => toks[i][1]);
    st.sbase = st.sslot.map((i) => toks[i][1]);
    st.napp = [...st.nbase];
    st.sprev = [...st.sbase];
    st.rapp = st.rslot.map((i) => tokDep(toks[i]));
    st.prev = null;
    return true;
}
/** Apply a squish delta to the running base and produce a concrete token list. */
export function stUnsquish(st, sq) {
    if (st.base === null)
        return null;
    // --- numeric slots ---
    let nums;
    const N = sq.N;
    if (N !== undefined && N !== null && N.length > 0) {
        nums = [];
        let idx = 0;
        for (const part of N.split('|')) {
            if (idx >= st.napp.length)
                break;
            if (part === '=') {
                nums.push(st.napp[idx]);
            }
            else {
                // Mirrors the Python: the leading character is dropped before parsing.
                const d = toNum(part.slice(1));
                if (d === null)
                    return null;
                st.napp[idx] = (st.napp[idx] || 0) + d;
                nums.push(st.napp[idx]);
            }
            idx += 1;
        }
        while (nums.length < st.nbase.length)
            nums.push(st.nbase[nums.length]);
    }
    else {
        nums = [...st.nbase];
    }
    // --- string slots ---
    let strs;
    const S = sq.S;
    if (S !== undefined && S !== null && S.length > 0) {
        strs = [];
        let idx = 0;
        for (const part of S) {
            while (idx >= st.sprev.length)
                st.sprev.push(part);
            if (part === '=') {
                strs.push(st.sprev[idx]);
            }
            else {
                st.sprev[idx] = part;
                strs.push(part);
            }
            idx += 1;
        }
        while (strs.length < st.sbase.length)
            strs.push(st.sbase[strs.length]);
    }
    else {
        strs = [...st.sbase];
    }
    // --- reference slots ---
    let deps;
    const R = sq.R;
    if (R !== undefined && R !== null) {
        const parts = Array.isArray(R) ? R : R.split('|');
        deps = [];
        let idx = 0;
        for (const rs of parts) {
            if (idx >= st.rapp.length)
                break;
            const cur = st.rapp[idx];
            if (rs === '=') {
                deps.push({ ...cur });
            }
            else if (rs.length > 2 && (rs[0] === '+' || rs[0] === '-') && (rs[1] === 'R' || rs[1] === 'C')) {
                const parsed = toNum(rs.slice(2));
                if (parsed === null)
                    return null;
                const off = Math.trunc(parsed) * (rs[0] === '+' ? 1 : -1);
                const upd = { ...cur };
                if (rs[1] === 'R') {
                    upd.r1 = upd.r2 = cur.r1 + off;
                }
                else {
                    upd.c1 = upd.c2 = cur.c1 + off;
                }
                st.rapp[idx] = upd;
                deps.push({ ...upd });
            }
            else {
                const d = parseXc(rs);
                if (d === null)
                    return null;
                st.rapp[idx] = d;
                deps.push({ ...d });
            }
            idx += 1;
        }
        while (deps.length < st.rslot.length)
            deps.push({ ...st.rapp[deps.length] });
    }
    else {
        deps = st.rapp.map((d) => ({ ...d }));
    }
    // --- splice the resolved values back into the base token list ---
    const toks = [...st.base];
    st.nslot.forEach((i, k) => {
        if (k < nums.length)
            toks[i] = ['num', nums[k]];
    });
    st.sslot.forEach((i, k) => {
        if (k < strs.length)
            toks[i] = ['str', strs[k]];
    });
    st.rslot.forEach((i, k) => {
        if (k < deps.length)
            toks[i] = depTok(deps[k]);
    });
    return toks;
}
/** Feed one raw cell payload, in column-major key order, and get its resolved form. */
export function stFeed(st, key, content) {
    if (content === null || content === undefined || content === '')
        return null;
    if (typeof content === 'string') {
        if (content.startsWith('=')) {
            st.strategy = 'NEW_FORMULA';
            if (stNewFormula(st, content)) {
                return { k: 'F', toks: [...st.base] };
            }
            // Not a formula the tokenizer accepts — usually a label the user typed
            // with a leading '=' ("=invulbaar veld"). Render it as the text it is;
            // `fails` is reserved for cells that end up with no value at all.
            return { k: 'L', v: content.slice(1) };
        }
        st.strategy = 'NOT_A_FORMULA';
        return { k: 'L', v: content };
    }
    if (typeof content === 'object') {
        const obj = content;
        const hasDelta = (obj.N !== undefined && obj.N !== null) ||
            (obj.S !== undefined && obj.S !== null) ||
            (obj.R !== undefined && obj.R !== null);
        if (hasDelta) {
            const prev = st.strategy;
            if (!prev || prev === 'NEW_FORMULA') {
                st.strategy = 'FIRST_OFFSET';
                st.prev = { ...obj };
            }
            else {
                st.strategy = 'COMBINE_OFFSET';
                if (st.prev === null) {
                    st.fails.push(key);
                    return null;
                }
                for (const k of ['N', 'S', 'R']) {
                    if (obj[k] !== undefined && obj[k] !== null)
                        st.prev[k] = obj[k];
                }
            }
            const toks = stUnsquish(st, st.prev);
            if (toks === null) {
                st.fails.push(key);
                return null;
            }
            return { k: 'F', toks };
        }
        if (obj.value !== undefined && obj.value !== null) {
            return { k: 'L', v: obj.value };
        }
        if (obj.content !== undefined && obj.content !== null) {
            const cVal = obj.content;
            if (typeof cVal === 'string' && cVal.startsWith('=')) {
                return stFeed(st, key, cVal);
            }
            return { k: 'L', v: cVal };
        }
    }
    st.strategy = 'NO_CHANGE';
    return null;
}
//# sourceMappingURL=unsquish.js.map