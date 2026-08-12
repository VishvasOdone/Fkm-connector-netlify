/**
 * Value coercion rules of the evaluator. These mirror the Python helpers
 * (`to_num`, `as_num`, `as_text`, `truthy`, `compare`, `do_round`) exactly,
 * including their edge cases — the generated sheets depend on them.
 */

export const ERRS = [
  '#REF!',
  '#NAME?',
  '#VALUE!',
  '#DIV/0!',
  '#CYCLE',
  '#BAD_EXPR',
  '#NUM!',
  '#N/A',
  '#NULL!',
  '#ERROR!',
] as const;
export const E_REF = '#REF!';
export const E_NAME = '#NAME?';
export const E_VAL = '#VALUE!';
export const E_DIV = '#DIV/0!';
export const E_CYC = '#CYCLE';
export const E_EXPR = '#BAD_EXPR';
export const E_NUM = '#NUM!';
export const E_NA = '#N/A';

/** Anything a cell or a formula can evaluate to. A range evaluates to an array. */
export type Scalar = number | string | boolean | null;
export type Value = Scalar | Value[];

export function isErr(v: unknown): v is string {
  return typeof v === 'string' && (ERRS as readonly string[]).includes(v);
}

/**
 * Strict numeric parse: only an optional sign, digits and at most one dot.
 * "1.2.3", "1e3" and "12px" are all rejected (returns null).
 */
export function toNum(s: unknown): number | null {
  if (typeof s !== 'string') {
    if (typeof s === 'number') return s;
    return null;
  }
  const t = s.trim();
  if (!t) return null;
  const body = t[0] === '+' || t[0] === '-' ? t.slice(1) : t;
  if (!body) return null;

  let dots = 0;
  let hasDigit = false;
  for (const ch of body) {
    if (ch === '.') {
      dots += 1;
      if (dots > 1) return null;
    } else if (ch >= '0' && ch <= '9') {
      hasDigit = true;
    } else {
      return null;
    }
  }
  if (!hasDigit) return null;
  return Number(t);
}

/** Numeric view of a value for arithmetic; null when it cannot be a number. */
export function asNum(v: Value): number | null {
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'number') return v;
  if (v === null || v === undefined || v === '') return 0;
  if (typeof v === 'string') return toNum(v);
  return null;
}

/** Text view of a value, used by `&` concatenation and text comparison. */
export function asText(v: Value): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : String(v);
  return String(v);
}

export function truthy(v: Value): boolean {
  if (typeof v === 'boolean') return v;
  if (v === null || v === undefined || v === '') return false;
  const n = asNum(v);
  return n === null ? Boolean(v) : n !== 0;
}

/**
 * Comparison operators. Numbers compare numerically; anything else falls back
 * to case-insensitive text comparison. Booleans never compare numerically.
 */
export function compare(op: string, a: Value, b: Value): boolean {
  const an = typeof a === 'boolean' ? null : asNum(a);
  const bn = typeof b === 'boolean' ? null : asNum(b);

  let x: number | string;
  let y: number | string;
  if (an !== null && bn !== null) {
    x = an;
    y = bn;
  } else {
    x = asText(a).toUpperCase();
    y = asText(b).toUpperCase();
  }

  switch (op) {
    case '=':
      return x === y;
    case '<>':
      return x !== y;
    case '<':
      return x < y;
    case '<=':
      return x <= y;
    case '>':
      return x > y;
    default:
      return x >= y;
  }
}

/**
 * ROUND / ROUNDUP / ROUNDDOWN with the same float-noise snapping the Python
 * version applies before truncating.
 */
export function doRound(kind: 'ROUND' | 'ROUNDUP' | 'ROUNDDOWN', x: number, digits: number): number {
  let f = 1.0;
  for (let i = 0; i < Math.abs(digits); i++) {
    f = digits > 0 ? f * 10.0 : f / 10.0;
  }

  let v = x * f;
  const iv = Math.trunc(v);
  if (Math.abs(v - iv) < 1e-9) {
    v = iv;
  } else {
    const step = v > 0 ? 1.0 : -1.0;
    if (Math.abs(iv + step - v) < 1e-9) v = iv + step;
  }

  let r: number;
  if (kind === 'ROUND') {
    r = Math.trunc(v + (v >= 0 ? 0.5 : -0.5));
  } else if (kind === 'ROUNDUP') {
    r = Math.trunc(v);
    if (v !== r) r += v > 0 ? 1.0 : -1.0;
  } else {
    r = Math.trunc(v);
  }

  return r / f;
}

/** One level of flattening — ranges arrive as nested arrays of scalars. */
export function flatten(vals: Value[]): Value[] {
  const out: Value[] = [];
  for (const v of vals) {
    if (Array.isArray(v)) {
      for (const x of v) out.push(x);
    } else {
      out.push(v);
    }
  }
  return out;
}
