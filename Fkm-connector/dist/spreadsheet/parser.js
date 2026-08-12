const NO_TOK = [null, null];
function peek(cur) {
    return cur.i < cur.toks.length ? cur.toks[cur.i] : NO_TOK;
}
function next(cur) {
    const t = peek(cur);
    cur.i += 1;
    return t;
}
/** Parse a full token list into an AST; null when the token list is not a valid expression. */
export function parse(toks) {
    // A cell holding just "=" is empty, not broken.
    if (!toks.length)
        return { t: 'blank' };
    const cur = { toks, i: 0 };
    const node = pCmp(cur);
    if (node === null || cur.i !== toks.length)
        return null;
    return node;
}
function binary(cur, sub, ops) {
    let left = sub(cur);
    if (left === null)
        return null;
    for (;;) {
        const [k, v] = peek(cur);
        if (k !== 'op' || !ops.includes(v))
            return left;
        next(cur);
        const right = sub(cur);
        if (right === null)
            return null;
        left = { t: 'bin', op: v, l: left, r: right };
    }
}
// Precedence climbing, loosest binding first.
const pCmp = (cur) => binary(cur, pCat, ['=', '<>', '<', '<=', '>', '>=']);
const pCat = (cur) => binary(cur, pAdd, ['&']);
const pAdd = (cur) => binary(cur, pMul, ['+', '-']);
const pMul = (cur) => binary(cur, pPow, ['*', '/']);
const pPow = (cur) => binary(cur, pUn, ['^']);
function pUn(cur) {
    const [k, v] = peek(cur);
    if (k === 'op' && (v === '+' || v === '-')) {
        next(cur);
        const node = pUn(cur);
        if (node === null)
            return null;
        return v === '-' ? { t: 'neg', n: node } : node;
    }
    return pPost(cur);
}
function pPost(cur) {
    let node = pAtom(cur);
    if (node === null)
        return null;
    for (;;) {
        const [k, v] = peek(cur);
        if (k === 'op' && v === '%') {
            next(cur);
            node = { t: 'pct', n: node };
        }
        else {
            return node;
        }
    }
}
function pAtom(cur) {
    const tok = next(cur);
    const [k, v] = tok;
    if (k === 'num' || k === 'str' || k === 'bool' || k === 'err') {
        return { t: 'lit', v: v };
    }
    if (k === 'ref') {
        const [sheet, rc] = v;
        return { t: 'ref', sheet, rc };
    }
    if (k === 'rng') {
        const [sheet, a, b] = v;
        return { t: 'rng', sheet, a, b };
    }
    if (k === 'lp') {
        const node = pCmp(cur);
        if (node === null || next(cur)[0] !== 'rp')
            return null;
        return node;
    }
    if (k === 'fn') {
        if (next(cur)[0] !== 'lp')
            return null;
        const args = [];
        if (peek(cur)[0] === 'rp') {
            next(cur);
            return { t: 'call', name: v, args };
        }
        for (;;) {
            // An argument may be omitted entirely: ROUNDUP(A1/B1,) or OR(,A1>0).
            const ak = peek(cur)[0];
            if (ak === 'cm' || ak === 'rp') {
                args.push({ t: 'blank' });
            }
            else {
                const a = pCmp(cur);
                if (a === null)
                    return null;
                args.push(a);
            }
            const nk = next(cur)[0];
            if (nk === 'rp')
                return { t: 'call', name: v, args };
            if (nk !== 'cm')
                return null;
        }
    }
    return null;
}
//# sourceMappingURL=parser.js.map