/**
 * In-memory formula evaluator. Values are resolved lazily and memoised; a
 * `busy` set breaks reference cycles with #CYCLE instead of recursing forever.
 */
import { RC, cellKey, colLetter, rcKey } from './refs.js';
import { Node, parse } from './parser.js';
import { FeedResult } from './unsquish.js';
import {
  Value,
  Scalar,
  E_CYC,
  E_DIV,
  E_EXPR,
  E_NA,
  E_NAME,
  E_NUM,
  E_REF,
  E_VAL,
  asNum,
  asText,
  compare,
  doRound,
  flatten,
  isErr,
  toNum,
  truthy,
} from './values.js';

export type GridCell = Exclude<FeedResult, null>;
export type Grid = Map<string, GridCell>;

export interface Book {
  sheets: Map<string, Grid>;
  cache: Map<string, Value>;
  busy: Set<string>;
  /**
   * Function names the evaluator does not implement. One missing function
   * poisons every cell downstream of it with #NAME?, so callers log this.
   */
  unknownFns?: Set<string>;
}

export function cellValue(book: Book, sheet: string, rc: RC): Value {
  const ck = cellKey(sheet, rc);
  if (book.cache.has(ck)) return book.cache.get(ck) as Value;
  if (book.busy.has(ck)) return E_CYC;

  const grid = book.sheets.get(sheet);
  if (grid === undefined) return E_REF;

  const cell = grid.get(rcKey(rc));
  if (cell === undefined) return null;

  if (cell.k === 'L') {
    const n = toNum(cell.v);
    const out: Value = n !== null ? n : cell.v;
    book.cache.set(ck, out);
    return out;
  }

  book.busy.add(ck);
  const ast = parse(cell.toks);
  const res: Value = ast === null ? E_EXPR : ev(book, ast, sheet);
  book.busy.delete(ck);
  // A formula never displays as blank: one whose value is an empty reference
  // ("='Gegevens invulblad'!B6" with B6 empty) evaluates to 0, as in Odoo.
  const out: Value = res === null ? 0 : res;
  book.cache.set(ck, out);
  return out;
}

export function ev(book: Book, node: Node, sheet: string): Value {
  switch (node.t) {
    case 'lit':
      return node.v;

    case 'blank':
      return null;

    case 'ref':
      return cellValue(book, node.sheet !== null ? node.sheet : sheet, node.rc);

    case 'rng': {
      const sh = node.sheet !== null ? node.sheet : sheet;
      const out: Value[] = [];
      for (let r = Math.min(node.a[0], node.b[0]); r <= Math.max(node.a[0], node.b[0]); r++) {
        for (let c = Math.min(node.a[1], node.b[1]); c <= Math.max(node.a[1], node.b[1]); c++) {
          out.push(cellValue(book, sh, [r, c]));
        }
      }
      return out;
    }

    case 'neg': {
      const v = ev(book, node.n, sheet);
      if (isErr(v)) return v;
      const x = asNum(v);
      return x === null ? E_VAL : -x;
    }

    case 'pct': {
      const v = ev(book, node.n, sheet);
      if (isErr(v)) return v;
      const x = asNum(v);
      return x === null ? E_VAL : x / 100.0;
    }

    case 'bin':
      return evBin(book, node, sheet);

    case 'call':
      return evCall(book, node, sheet);

    default:
      return E_EXPR;
  }
}

function evBin(book: Book, node: Extract<Node, { t: 'bin' }>, sheet: string): Value {
  const op = node.op;
  const a = ev(book, node.l, sheet);
  if (isErr(a)) return a;
  const b = ev(book, node.r, sheet);
  if (isErr(b)) return b;

  if (Array.isArray(a) || Array.isArray(b)) return E_VAL;

  if (op === '&') return asText(a) + asText(b);
  if (['=', '<>', '<', '<=', '>', '>='].includes(op)) return compare(op, a, b);

  const x = asNum(a);
  const y = asNum(b);
  if (x === null || y === null) return E_VAL;

  switch (op) {
    case '+':
      return x + y;
    case '-':
      return x - y;
    case '*':
      return x * y;
    case '/':
      return y === 0 ? E_DIV : x / y;
    case '^':
      return Math.pow(x, y);
    default:
      return E_EXPR;
  }
}

/** A range keeping its shape, which INDEX and MATCH need. Values are row-major. */
interface Shaped {
  rows: number;
  cols: number;
  vals: Value[];
}

function evShaped(book: Book, node: Node, sheet: string): Shaped {
  if (node.t === 'rng') {
    const sh = node.sheet !== null ? node.sheet : sheet;
    const r0 = Math.min(node.a[0], node.b[0]);
    const r1 = Math.max(node.a[0], node.b[0]);
    const c0 = Math.min(node.a[1], node.b[1]);
    const c1 = Math.max(node.a[1], node.b[1]);
    const vals: Value[] = [];
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) vals.push(cellValue(book, sh, [r, c]));
    }
    return { rows: r1 - r0 + 1, cols: c1 - c0 + 1, vals };
  }

  const v = ev(book, node, sheet);
  if (Array.isArray(v)) return { rows: 1, cols: v.length, vals: v };
  return { rows: 1, cols: 1, vals: [v] };
}

/** First scalar of a value, so a stray 1x1 range behaves like the cell itself. */
function scalar(v: Value): Scalar {
  if (!Array.isArray(v)) return v;
  const flat = flatten(v);
  return flat.length && !Array.isArray(flat[0]) ? (flat[0] as Scalar) : null;
}

/** Integer argument with Excel's truncation; a blank argument counts as 0. */
function intArg(v: Value, dflt: number): number {
  const n = asNum(scalar(v));
  return n === null ? dflt : Math.trunc(n);
}

function evCall(book: Book, node: Extract<Node, { t: 'call' }>, sheet: string): Value {
  const name = node.name;
  const args = node.args;

  // IF and IFERROR short-circuit, so their arguments are not pre-evaluated.
  if (name === 'IF') {
    if (args.length < 2) return E_EXPR;
    const cond = ev(book, args[0], sheet);
    if (isErr(cond)) return cond;
    if (truthy(cond)) return ev(book, args[1], sheet);
    return args.length >= 3 ? ev(book, args[2], sheet) : false;
  }

  if (name === 'IFERROR') {
    if (!args.length) return E_EXPR;
    const v = ev(book, args[0], sheet);
    if (isErr(v)) return args.length > 1 ? ev(book, args[1], sheet) : '';
    return v;
  }

  // The IS* family inspects an error instead of propagating it.
  if (name === 'ISNUMBER' || name === 'ISTEXT' || name === 'ISBLANK' || name === 'ISERROR' || name === 'ISNA') {
    if (!args.length) return E_VAL;
    const v = scalar(ev(book, args[0], sheet));
    if (name === 'ISNUMBER') return typeof v === 'number';
    if (name === 'ISTEXT') return typeof v === 'string' && !isErr(v);
    if (name === 'ISBLANK') return v === null;
    if (name === 'ISNA') return v === E_NA;
    return isErr(v);
  }

  // INDEX and MATCH need the range's shape, which a flattened value has lost.
  if (name === 'INDEX') {
    if (!args.length) return E_VAL;
    const arr = evShaped(book, args[0], sheet);
    const rv = args.length > 1 ? ev(book, args[1], sheet) : null;
    if (isErr(rv)) return rv;
    const cv = args.length > 2 ? ev(book, args[2], sheet) : null;
    if (isErr(cv)) return cv;

    let rn = intArg(rv, 0);
    let cn = args.length > 2 ? intArg(cv, 0) : 0;
    // A single row or column is addressed by one index that walks it.
    if (args.length <= 2 && (arr.rows === 1 || arr.cols === 1)) {
      if (arr.rows === 1) {
        cn = rn;
        rn = 1;
      } else {
        cn = 1;
      }
    }
    // 0 means "the whole row/column"; only a single cell is ever needed here.
    if (rn === 0) rn = 1;
    if (cn === 0) cn = 1;
    if (rn < 1 || rn > arr.rows || cn < 1 || cn > arr.cols) return E_REF;
    return arr.vals[(rn - 1) * arr.cols + (cn - 1)];
  }

  if (name === 'MATCH') {
    if (args.length < 2) return E_VAL;
    const target = ev(book, args[0], sheet);
    if (isErr(target)) return target;
    const arr = evShaped(book, args[1], sheet);
    let kind = 1;
    if (args.length > 2) {
      const tv = ev(book, args[2], sheet);
      if (isErr(tv)) return tv;
      kind = intArg(tv, 1);
    }

    const tgt = scalar(target);
    let best = 0;
    for (let i = 0; i < arr.vals.length; i++) {
      const v = scalar(arr.vals[i]);
      if (kind === 0) {
        if (compare('=', tgt, v)) return i + 1;
        continue;
      }
      if (v === null || v === '') continue;
      // Approximate match: the last value that is still on the right side.
      if (kind > 0 ? compare('<=', v, tgt) : compare('>=', v, tgt)) best = i + 1;
    }
    return best > 0 ? best : E_NA;
  }

  const vals: Value[] = [];
  for (const a of args) {
    const v = ev(book, a, sheet);
    if (isErr(v)) return v;
    vals.push(v);
  }

  if (name === 'AND' || name === 'OR') {
    let res: boolean | null = null;
    for (const v of flatten(vals)) {
      if (v === null || v === '') continue;
      const b = truthy(v);
      if (res === null) res = b;
      else if (name === 'AND') res = res && b;
      else res = res || b;
    }
    return res === null ? E_VAL : res;
  }

  if (name === 'NOT') {
    return vals.length ? !truthy(vals[0]) : E_VAL;
  }

  if (name === 'ROUNDUP' || name === 'ROUNDDOWN' || name === 'ROUND') {
    if (!vals.length) return E_VAL;
    const x = asNum(vals[0]);
    if (x === null) return E_VAL;
    let d = 0;
    if (vals.length > 1) {
      const dv = asNum(vals[1]);
      if (dv === null) return E_VAL;
      d = Math.trunc(dv);
    }
    return doRound(name, x, d);
  }

  if (['SUM', 'MAX', 'MIN', 'ABS', 'INT', 'PRODUCT', 'AVERAGE', 'COUNT'].includes(name)) {
    const nums: number[] = [];
    for (const v of flatten(vals)) {
      if (v === null || v === '' || typeof v === 'boolean') continue;
      const nv = asNum(v);
      if (nv !== null) nums.push(nv);
    }

    if (name === 'COUNT') return nums.length;
    if (name === 'SUM') return nums.length ? nums.reduce((a, b) => a + b, 0) : 0.0;
    if (name === 'PRODUCT') return nums.reduce((p, v) => p * v, 1.0);
    if (name === 'AVERAGE') return nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : E_DIV;
    if (!nums.length) return 0.0;
    if (name === 'MAX') return Math.max(...nums);
    if (name === 'MIN') return Math.min(...nums);
    if (name === 'ABS') return Math.abs(nums[0]);
    return Math.trunc(nums[0]); // INT
  }

  if (name === 'PI') return Math.PI;

  if (name === 'TODAY') {
    // Excel serial date: whole days since 1899-12-30 (25569 = 1970-01-01).
    const now = new Date();
    return Math.floor(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()) / 86400000) + 25569;
  }

  // Single-argument maths. Angles are in radians, as in Excel and o-spreadsheet.
  const UNARY: Record<string, (x: number) => number> = {
    SQRT: Math.sqrt,
    COS: Math.cos,
    SIN: Math.sin,
    TAN: Math.tan,
    ASIN: Math.asin,
    ACOS: Math.acos,
    ATAN: Math.atan,
    RADIANS: (x) => (x * Math.PI) / 180,
    DEGREES: (x) => (x * 180) / Math.PI,
  };
  if (name in UNARY) {
    if (!vals.length) return E_VAL;
    const x = asNum(scalar(vals[0]));
    if (x === null) return E_VAL;
    const out = (UNARY[name] as (v: number) => number)(x);
    // sqrt of a negative, asin/acos out of [-1,1].
    return Number.isFinite(out) ? out : E_NUM;
  }

  if (name === 'FLOOR' || name === 'CEILING') {
    if (!vals.length) return E_VAL;
    const x = asNum(scalar(vals[0]));
    if (x === null) return E_VAL;
    let sig = 1;
    if (vals.length > 1) {
      const s = asNum(scalar(vals[1]));
      if (s === null) return E_VAL;
      sig = s;
    }
    if (sig === 0) return E_DIV;
    if (x * sig < 0) return E_NUM;
    const q = x / sig;
    // Snap float noise first, so FLOOR(0.29/0.01) is not 28.
    const snapped = Math.abs(q - Math.round(q)) < 1e-9 ? Math.round(q) : q;
    return (name === 'FLOOR' ? Math.floor(snapped) : Math.ceil(snapped)) * sig;
  }

  if (name === 'ADDRESS') {
    if (vals.length < 2) return E_VAL;
    const r = asNum(scalar(vals[0]));
    const c = asNum(scalar(vals[1]));
    if (r === null || c === null) return E_VAL;
    const rr = Math.trunc(r);
    const cc = Math.trunc(c);
    if (rr < 1 || cc < 1) return E_VAL;
    // 1 = $A$1 (default), 2 = A$1, 3 = $A1, 4 = A1.
    let abs = 1;
    if (vals.length > 2) {
      const a = asNum(scalar(vals[2]));
      if (a !== null && a >= 1 && a <= 4) abs = Math.trunc(a);
    }
    const colAbs = abs === 1 || abs === 3 ? '$' : '';
    const rowAbs = abs === 1 || abs === 2 ? '$' : '';
    return `${colAbs}${colLetter(cc)}${rowAbs}${rr}`;
  }

  book.unknownFns?.add(name);
  return E_NAME;
}
