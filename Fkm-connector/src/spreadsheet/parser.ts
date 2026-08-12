import { RC } from './refs.js';
import { Tok } from './tokenizer.js';

export type Node =
  | { t: 'lit'; v: number | string | boolean }
  /** An omitted argument (`ROUNDUP(A1/B1,)`) or an empty formula body. */
  | { t: 'blank' }
  | { t: 'ref'; sheet: string | null; rc: RC }
  | { t: 'rng'; sheet: string | null; a: RC; b: RC }
  | { t: 'neg'; n: Node }
  | { t: 'pct'; n: Node }
  | { t: 'bin'; op: string; l: Node; r: Node }
  | { t: 'call'; name: string; args: Node[] };

interface Cursor {
  toks: Tok[];
  i: number;
}

const NO_TOK: [null, null] = [null, null];

function peek(cur: Cursor): Tok | [null, null] {
  return cur.i < cur.toks.length ? cur.toks[cur.i] : NO_TOK;
}

function next(cur: Cursor): Tok | [null, null] {
  const t = peek(cur);
  cur.i += 1;
  return t;
}

/** Parse a full token list into an AST; null when the token list is not a valid expression. */
export function parse(toks: Tok[]): Node | null {
  // A cell holding just "=" is empty, not broken.
  if (!toks.length) return { t: 'blank' };

  const cur: Cursor = { toks, i: 0 };
  const node = pCmp(cur);
  if (node === null || cur.i !== toks.length) return null;
  return node;
}

function binary(cur: Cursor, sub: (c: Cursor) => Node | null, ops: string[]): Node | null {
  let left = sub(cur);
  if (left === null) return null;

  for (;;) {
    const [k, v] = peek(cur);
    if (k !== 'op' || !ops.includes(v as string)) return left;
    next(cur);
    const right = sub(cur);
    if (right === null) return null;
    left = { t: 'bin', op: v as string, l: left, r: right };
  }
}

// Precedence climbing, loosest binding first.
const pCmp = (cur: Cursor) => binary(cur, pCat, ['=', '<>', '<', '<=', '>', '>=']);
const pCat = (cur: Cursor) => binary(cur, pAdd, ['&']);
const pAdd = (cur: Cursor) => binary(cur, pMul, ['+', '-']);
const pMul = (cur: Cursor) => binary(cur, pPow, ['*', '/']);
const pPow = (cur: Cursor) => binary(cur, pUn, ['^']);

function pUn(cur: Cursor): Node | null {
  const [k, v] = peek(cur);
  if (k === 'op' && (v === '+' || v === '-')) {
    next(cur);
    const node = pUn(cur);
    if (node === null) return null;
    return v === '-' ? { t: 'neg', n: node } : node;
  }
  return pPost(cur);
}

function pPost(cur: Cursor): Node | null {
  let node = pAtom(cur);
  if (node === null) return null;
  for (;;) {
    const [k, v] = peek(cur);
    if (k === 'op' && v === '%') {
      next(cur);
      node = { t: 'pct', n: node };
    } else {
      return node;
    }
  }
}

function pAtom(cur: Cursor): Node | null {
  const tok = next(cur);
  const [k, v] = tok;

  if (k === 'num' || k === 'str' || k === 'bool' || k === 'err') {
    return { t: 'lit', v: v as number | string | boolean };
  }
  if (k === 'ref') {
    const [sheet, rc] = v as [string | null, RC];
    return { t: 'ref', sheet, rc };
  }
  if (k === 'rng') {
    const [sheet, a, b] = v as [string | null, RC, RC];
    return { t: 'rng', sheet, a, b };
  }
  if (k === 'lp') {
    const node = pCmp(cur);
    if (node === null || next(cur)[0] !== 'rp') return null;
    return node;
  }
  if (k === 'fn') {
    if (next(cur)[0] !== 'lp') return null;
    const args: Node[] = [];
    if (peek(cur)[0] === 'rp') {
      next(cur);
      return { t: 'call', name: v as string, args };
    }
    for (;;) {
      // An argument may be omitted entirely: ROUNDUP(A1/B1,) or OR(,A1>0).
      const ak = peek(cur)[0];
      if (ak === 'cm' || ak === 'rp') {
        args.push({ t: 'blank' });
      } else {
        const a = pCmp(cur);
        if (a === null) return null;
        args.push(a);
      }
      const nk = next(cur)[0];
      if (nk === 'rp') return { t: 'call', name: v as string, args };
      if (nk !== 'cm') return null;
    }
  }

  return null;
}
