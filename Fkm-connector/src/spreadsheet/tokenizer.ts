import { RC, refRc, isAlpha, isAlnum, isDigit } from './refs.js';
import { toNum } from './values.js';

export type Tok =
  | ['num', number]
  | ['str', string]
  | ['bool', boolean]
  | ['err', string]
  | ['ref', [string | null, RC]]
  | ['rng', [string | null, RC, RC]]
  | ['fn', string]
  | ['lp', string]
  | ['rp', string]
  | ['cm', string]
  | ['op', string];

/**
 * Error literals a stored formula can contain — Odoo writes a bare `#REF`
 * where a referenced cell was deleted, so `=IF(A1="x",'Sheet'!#REF,0)` is a
 * formula the tokenizer must accept. Longest-first so `#REF!` wins over `#REF`.
 */
const ERR_LITERALS = [
  '#DIV/0!',
  '#BAD_EXPR',
  '#VALUE!',
  '#ERROR!',
  '#NAME?',
  '#NULL!',
  '#CYCLE',
  '#NUM!',
  '#REF!',
  '#N/A',
  '#REF',
];

/** Match an error literal at `i`; returns its canonical form and the new index. */
function readErr(src: string, i: number): [string, number] | null {
  const up = src.slice(i, i + 10).toUpperCase();
  for (const lit of ERR_LITERALS) {
    if (up.startsWith(lit)) {
      // Odoo's bare `#REF` means the same thing as Excel's `#REF!`.
      return [lit === '#REF' ? '#REF!' : lit, i + lit.length];
    }
  }
  return null;
}

function readRefChars(src: string, i: number): [string, number] {
  let buf = '';
  const n = src.length;
  while (i < n && (isAlnum(src[i]) || src[i] === '$')) {
    buf += src[i];
    i += 1;
  }
  return [buf, i];
}

/**
 * Turn a formula body (without the leading "=") into tokens.
 * Returns null when anything cannot be tokenised — callers treat that as
 * an unparseable formula rather than raising.
 */
export function tokenize(src: string): Tok[] | null {
  const toks: Tok[] = [];
  let i = 0;
  const n = src.length;

  while (i < n) {
    const c = src[i];

    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
      i += 1;
      continue;
    }

    // Error literal, e.g. the #REF! left behind by a deleted reference.
    if (c === '#') {
      const e = readErr(src, i);
      if (e === null) return null;
      toks.push(['err', e[0]]);
      i = e[1];
      continue;
    }

    // String literal, with "" as the escape for a quote.
    if (c === '"') {
      i += 1;
      let buf = '';
      while (i < n) {
        if (src[i] === '"') {
          if (i + 1 < n && src[i + 1] === '"') {
            buf += '"';
            i += 2;
            continue;
          }
          i += 1;
          break;
        }
        buf += src[i];
        i += 1;
      }
      toks.push(['str', buf]);
      continue;
    }

    // Numeric literal.
    if (isDigit(c) || (c === '.' && i + 1 < n && isDigit(src[i + 1]))) {
      let buf = '';
      while (i < n && (isDigit(src[i]) || src[i] === '.')) {
        buf += src[i];
        i += 1;
      }
      const v = toNum(buf);
      if (v === null) return null;
      toks.push(['num', v]);
      continue;
    }

    // Quoted sheet name: 'Gegevens invulblad'!B4
    if (c === "'") {
      i += 1;
      let sheet = '';
      while (i < n && src[i] !== "'") {
        sheet += src[i];
        i += 1;
      }
      i += 1;
      if (i >= n || src[i] !== '!') return null;
      i += 1;

      // 'Sheet'!#REF — the sheet is irrelevant, the reference itself is broken.
      if (i < n && src[i] === '#') {
        const e = readErr(src, i);
        if (e === null) return null;
        toks.push(['err', e[0]]);
        i = e[1];
        continue;
      }

      let r1: string;
      [r1, i] = readRefChars(src, i);
      const a = refRc(r1);
      if (a === null) return null;

      if (i < n && src[i] === ':') {
        i += 1;
        let r2: string;
        [r2, i] = readRefChars(src, i);
        const b = refRc(r2);
        if (b === null) return null;
        toks.push(['rng', [sheet, a, b]]);
      } else {
        toks.push(['ref', [sheet, a]]);
      }
      continue;
    }

    // Identifier: function name, unquoted sheet ref, boolean, or cell ref.
    if (isAlpha(c) || c === '_' || c === '$') {
      let buf = '';
      while (i < n && (isAlnum(src[i]) || src[i] === '_' || src[i] === '$' || src[i] === '.')) {
        buf += src[i];
        i += 1;
      }

      if (i < n && src[i] === '(') {
        toks.push(['fn', buf.toUpperCase()]);
        continue;
      }

      if (i < n && src[i] === '!') {
        const sheet = buf;
        i += 1;

        if (i < n && src[i] === '#') {
          const e = readErr(src, i);
          if (e === null) return null;
          toks.push(['err', e[0]]);
          i = e[1];
          continue;
        }

        let r1: string;
        [r1, i] = readRefChars(src, i);
        const a = refRc(r1);
        if (a === null) return null;

        if (i < n && src[i] === ':') {
          i += 1;
          let r2: string;
          [r2, i] = readRefChars(src, i);
          const b = refRc(r2);
          if (b === null) return null;
          toks.push(['rng', [sheet, a, b]]);
        } else {
          toks.push(['ref', [sheet, a]]);
        }
        continue;
      }

      const up = buf.toUpperCase();
      if (up === 'TRUE' || up === 'FALSE') {
        toks.push(['bool', up === 'TRUE']);
        continue;
      }

      const a = refRc(buf);
      if (a === null) return null;

      if (i < n && src[i] === ':') {
        i += 1;
        let r2: string;
        [r2, i] = readRefChars(src, i);
        const b = refRc(r2);
        if (b === null) return null;
        toks.push(['rng', [null, a, b]]);
      } else {
        toks.push(['ref', [null, a]]);
      }
      continue;
    }

    if (c === '(') {
      toks.push(['lp', c]);
      i += 1;
      continue;
    }
    if (c === ')') {
      toks.push(['rp', c]);
      i += 1;
      continue;
    }
    if (c === ',' || c === ';') {
      toks.push(['cm', ',']);
      i += 1;
      continue;
    }

    const two = src.slice(i, i + 2);
    if (two === '<=' || two === '>=' || two === '<>') {
      toks.push(['op', two]);
      i += 2;
      continue;
    }
    if ('+-*/^&=<>%'.includes(c)) {
      toks.push(['op', c]);
      i += 1;
      continue;
    }

    return null;
  }

  return toks;
}
