/**
 * Renderer-neutral view of the generated workbook: every cell evaluated, with
 * the styles, merges and dimensions the emitter needs.
 */
import {
  buildBook,
  buildRanges,
  rangeLookup,
  RangeEntry,
  SpreadsheetJson,
} from '../spreadsheet/book.js';
import { cellValue } from '../spreadsheet/evaluator.js';
import { colLetter, parseRcKey, rcKey, RC } from '../spreadsheet/refs.js';
import { Value } from '../spreadsheet/values.js';
import { getLogger } from '../logger.js';

const logger = getLogger('render');

export interface CellStyle {
  bold: boolean;
  italic: boolean;
  fontSize: number;
  textColor: string | null;
  fillColor: string | null;
  align: 'left' | 'center' | 'right';
  verticalAlign: 'top' | 'middle' | 'bottom';
  wrap: boolean;
}

/** One drawn cell edge. `color` is a bare 6-digit hex, or null for black. */
export interface BorderEdge {
  style: 'thin' | 'medium' | 'thick' | 'dashed' | 'dotted' | 'double' | 'hair';
  color: string | null;
}

export type BorderSide = 'top' | 'left' | 'bottom' | 'right';

export type CellBorders = Partial<Record<BorderSide, BorderEdge>>;

export interface RenderCell {
  row: number;
  col: number;
  value: Value;
  style: CellStyle;
  /** Excel number-format string from the workbook's format table, if any. */
  numFmt: string | null;
  /** Cell edges from the workbook's border table; null when undrawn. */
  borders: CellBorders | null;
}

export interface RenderSheet {
  name: string;
  /** Keyed by `rcKey(row, col)`. */
  cells: Map<string, RenderCell>;
  merges: string[];
  /** 1-based column index -> width in o-spreadsheet pixels. */
  colWidths: Map<number, number>;
  /** 1-based row index -> height in o-spreadsheet pixels. */
  rowHeights: Map<number, number>;
  maxRow: number;
  maxCol: number;
}

export interface RenderModel {
  sheets: RenderSheet[];
}

const DEFAULT_STYLE: CellStyle = {
  bold: false,
  italic: false,
  fontSize: 10,
  textColor: null,
  fillColor: null,
  align: 'left',
  verticalAlign: 'bottom',
  wrap: false,
};

/**
 * Thrown when the workbook has no print sheet, so there is nothing to send.
 * `processOrder` treats this as "skip the order", not as a failure.
 */
export class NoPrintSheetsError extends Error {
  constructor(readonly sheetNames: string[]) {
    super(
      `No sheet name starts with 'Afdrukpagina'; nothing to send. Sheets found: ${
        sheetNames.length ? sheetNames.join(', ') : '(none)'
      }`,
    );
    this.name = 'NoPrintSheetsError';
  }
}

/**
 * Print sheets are every sheet whose name starts with 'Afdrukpagina',
 * matched case-insensitively and ignoring surrounding whitespace — so
 * 'Afdrukpagina 1', 'afdrukpagina 2' and 'AFDRUKPAGINA 3' all qualify.
 * Returns an empty list when none match; there is no fallback.
 */
export function resolvePrintSheets(sheetNames: string[]): string[] {
  return sheetNames.filter((name) => name.trim().toLowerCase().startsWith('afdrukpagina'));
}

function normaliseColor(color: unknown): string | null {
  if (!color) return null;
  const hex = String(color).replace(/^#/, '').toUpperCase();
  if (/^[0-9A-F]{8}$/.test(hex)) return hex.slice(2);
  if (/^[0-9A-F]{6}$/.test(hex)) return hex;
  return null;
}

function readStyle(raw: Record<string, unknown> | undefined): CellStyle {
  if (!raw) return { ...DEFAULT_STYLE };

  const align = raw.align === 'center' || raw.align === 'right' ? raw.align : 'left';
  let vertical: CellStyle['verticalAlign'] = 'bottom';
  if (raw.verticalAlign === 'middle' || raw.verticalAlign === 'top') {
    vertical = raw.verticalAlign;
  }

  return {
    bold: Boolean(raw.bold),
    italic: Boolean(raw.italic),
    fontSize: typeof raw.fontSize === 'number' ? raw.fontSize : 10,
    textColor: normaliseColor(raw.textColor),
    fillColor: normaliseColor(raw.fillColor),
    align,
    verticalAlign: vertical,
    wrap: raw.wrapping === 'wrap',
  };
}

const BORDER_STYLES = new Set(['thin', 'medium', 'thick', 'dashed', 'dotted', 'double', 'hair']);

/** o-spreadsheet writes `{style, color}`; older payloads use `["thin", "#000"]`. */
function readBorderEdge(raw: unknown): BorderEdge | null {
  if (!raw) return null;

  let style: unknown;
  let color: unknown = null;
  if (Array.isArray(raw)) {
    [style, color] = raw as unknown[];
  } else if (typeof raw === 'string') {
    style = raw;
  } else if (typeof raw === 'object') {
    const obj = raw as Record<string, unknown>;
    style = obj.style;
    color = obj.color;
  } else {
    return null;
  }

  const name = typeof style === 'string' ? style.toLowerCase() : 'thin';
  return {
    style: (BORDER_STYLES.has(name) ? name : 'thin') as BorderEdge['style'],
    color: normaliseColor(color),
  };
}

function readBorders(raw: unknown): CellBorders | null {
  if (!raw || typeof raw !== 'object') return null;

  const obj = raw as Record<string, unknown>;
  const out: CellBorders = {};
  let drawn = false;
  for (const side of ['top', 'left', 'bottom', 'right'] as const) {
    const edge = readBorderEdge(obj[side]);
    if (edge) {
      out[side] = edge;
      drawn = true;
    }
  }
  return drawn ? out : null;
}

/**
 * Guard against a pathological range map painting a whole sheet. The print
 * sheets need a few thousand positions; anything beyond this is a data problem,
 * not a table.
 */
const MAX_MATERIALISED_CELLS = 60000;

/**
 * Every position covered by `ranges`, for the rectangles `keep` accepts.
 *
 * The rectangles only say *where* to look — the effective style or border at
 * each position still comes from `rangeLookup`, so overlapping rectangles keep
 * their last-one-wins precedence.
 */
function rangePositions(
  ranges: RangeEntry[],
  keep: (payload: number) => boolean,
  into: Map<string, RC>,
): void {
  for (const [rowMin, colMin, rowMax, colMax, payload] of ranges) {
    if (!keep(payload)) continue;
    for (let r = rowMin; r <= rowMax; r++) {
      for (let c = colMin; c <= colMax; c++) {
        if (into.size >= MAX_MATERIALISED_CELLS) return;
        into.set(rcKey([r, c]), [r, c]);
      }
    }
  }
}

export interface InputValue {
  sheet: string;
  ref: string;
  value: unknown;
}

/** Strip a leading '=' / '+' the way the original overlay did. */
function coerceOverlayValue(value: unknown): Value | null {
  let val: unknown = value;
  if (val === null || val === undefined) return null;

  if (typeof val === 'object' && !Array.isArray(val)) {
    const obj = val as Record<string, unknown>;
    if (obj.value !== undefined && obj.value !== null) {
      val = obj.value;
    } else if (Array.isArray(obj.S) && obj.S.length) {
      val = (obj.S as unknown[])[0];
    } else {
      val = obj.content;
    }
  }

  if (typeof val === 'string' && (val.startsWith('=') || val.startsWith('+') || val.startsWith('-'))) {
    val = val.replace(/^[+=]+/, '');
  }

  if (val === null || val === undefined) return null;
  if (typeof val === 'number' || typeof val === 'string' || typeof val === 'boolean') return val;
  return String(val);
}

/**
 * Evaluate the spreadsheet, overlay replayed inputs, and keep only the print
 * sheets.
 */
export function buildRenderModel(
  baseData: SpreadsheetJson,
  inputValues: Map<string, InputValue>,
): RenderModel {
  const { book, fails } = buildBook(baseData);
  const wbStyles = (baseData.styles ?? {}) as Record<string, Record<string, unknown>>;
  const wbFormats = (baseData.formats ?? {}) as Record<string, string>;

  for (const [sname, keys] of fails) {
    logger.warning(
      `${keys.length} cell(s) on '${sname}' could not be decoded and will be blank: ${keys
        .slice(0, 10)
        .join(', ')}`,
    );
  }

  // Style / format rectangles for every sheet, so a formula can pick up the
  // format of a cell on another sheet.
  const styleRanges = new Map<string, RangeEntry[]>();
  const formatRanges = new Map<string, RangeEntry[]>();
  const borderRanges = new Map<string, RangeEntry[]>();
  for (const sheetInfo of baseData.sheets ?? []) {
    const sName = sheetInfo.name ?? 'Sheet';
    styleRanges.set(sName, buildRanges(sheetInfo.styles as Record<string, number>));
    formatRanges.set(sName, buildRanges(sheetInfo.formats as Record<string, number>));
    borderRanges.set(sName, buildRanges(sheetInfo.borders as Record<string, number>));
  }

  // The workbook's shared border table, decoded once per id.
  const wbBorders = (baseData.borders ?? {}) as Record<string, unknown>;
  const borderCache = new Map<number, CellBorders | null>();
  const borderById = (id: number): CellBorders | null => {
    if (!borderCache.has(id)) borderCache.set(id, readBorders(wbBorders[String(id)]));
    return borderCache.get(id) ?? null;
  };

  const bordersAt = (sName: string, rc: RC): CellBorders | null => {
    const bid = rangeLookup(borderRanges.get(sName) ?? [], rc);
    return bid === null ? null : borderById(bid);
  };

  /**
   * A style is worth materialising on an *empty* cell only if it paints
   * something. Font colour and size on a blank cell draw nothing, and the
   * sheets carry font-only rectangles spanning tens of thousands of cells.
   */
  const styleFills = (id: number): boolean => Boolean(normaliseColor(wbStyles[String(id)]?.fillColor));

  const ownFormat = (sName: string, rc: RC): string | null => {
    const ranges = formatRanges.get(sName);
    if (!ranges) return null;
    const fid = rangeLookup(ranges, rc);
    return fid !== null ? wbFormats[String(fid)] ?? null : null;
  };

  /**
   * A cell that is nothing but a reference takes the format of the cell it
   * points at, the way o-spreadsheet does: `='Gegevens invulblad'!B3` prints
   * as a date when B3 is one, instead of showing the raw serial (46219).
   *
   * Deliberately limited to a bare reference. Following references inside a
   * larger expression would drag a date format onto ordinary numbers — an `IF`
   * that happens to mention a dated cell would print 1800 as a date.
   * The depth cap also stops a reference cycle.
   */
  const resolveFormat = (sName: string, rc: RC, depth = 0): string | null => {
    const own = ownFormat(sName, rc);
    if (own) return own;
    if (depth >= 3) return null;

    const cell = book.sheets.get(sName)?.get(rcKey(rc));
    if (!cell || cell.k !== 'F' || cell.toks.length !== 1) return null;

    const tok = cell.toks[0];
    if (tok[0] !== 'ref') return null;
    const [refSheet, target] = tok[1] as [string | null, RC];
    return resolveFormat(refSheet ?? sName, target, depth + 1);
  };

  const styleAt = (sName: string, rc: RC): CellStyle => {
    const sid = rangeLookup(styleRanges.get(sName) ?? [], rc);
    return readStyle(sid !== null ? wbStyles[String(sid)] : undefined);
  };

  const sheets: RenderSheet[] = [];
  const byName = new Map<string, RenderSheet>();

  const makeSheet = (name: string): RenderSheet => {
    const sheet: RenderSheet = {
      name,
      cells: new Map(),
      merges: [],
      colWidths: new Map(),
      rowHeights: new Map(),
      maxRow: 0,
      maxCol: 0,
    };
    sheets.push(sheet);
    byName.set(name.trim().toLowerCase(), sheet);
    return sheet;
  };

  const sheetsData = baseData.sheets ?? [];
  if (!sheetsData.length) {
    for (const sname of ['Gegevens invulblad', 'Afdrukpagina 1', 'Afdrukpagina 2', 'Odoo feed']) {
      makeSheet(sname);
    }
  } else {
    for (const sheetInfo of sheetsData) {
      const sName = sheetInfo.name ?? 'Sheet';
      const sheet = makeSheet(sName);

      const grid = book.sheets.get(sName);

      // The table is mostly drawn on cells that hold no content: a bordered or
      // shaded empty cell has no grid entry, so the positions to emit are the
      // grid plus everything the border and fill rectangles cover.
      const positions = new Map<string, RC>();
      if (grid) {
        for (const gridKey of grid.keys()) positions.set(gridKey, parseRcKey(gridKey));
      }
      const contentCells = positions.size;
      rangePositions(borderRanges.get(sName) ?? [], () => true, positions);
      rangePositions(styleRanges.get(sName) ?? [], styleFills, positions);

      if (positions.size >= MAX_MATERIALISED_CELLS) {
        logger.warning(
          `Sheet '${sName}' hit the ${MAX_MATERIALISED_CELLS}-cell cap; some borders or fills are omitted.`,
        );
      } else if (positions.size > contentCells) {
        logger.info(
          `Sheet '${sName}': ${contentCells} cell(s) with content, ${
            positions.size - contentCells
          } empty cell(s) carrying borders or fills.`,
        );
      }

      for (const [key, rc] of positions) {
        const [r, c] = rc;
        // Only a grid cell can have a value; the rest exist purely to be drawn.
        const val = grid?.has(key) ? cellValue(book, sName, rc) : null;

        sheet.cells.set(key, {
          row: r,
          col: c,
          value: val,
          style: styleAt(sName, rc),
          numFmt: resolveFormat(sName, rc),
          borders: bordersAt(sName, rc),
        });
        if (r > sheet.maxRow) sheet.maxRow = r;
        if (c > sheet.maxCol) sheet.maxCol = c;
      }

      sheet.merges = [...(sheetInfo.merges ?? [])];

      for (const [colIdxStr, colInfo] of Object.entries(sheetInfo.cols ?? {})) {
        const cIdx = parseInt(colIdxStr, 10) + 1;
        const sz = (colInfo as { size?: number })?.size;
        if (Number.isFinite(cIdx) && sz) sheet.colWidths.set(cIdx, sz);
      }

      for (const [rowIdxStr, rowInfo] of Object.entries(sheetInfo.rows ?? {})) {
        const rIdx = parseInt(rowIdxStr, 10) + 1;
        const sz = (rowInfo as { size?: number })?.size;
        if (Number.isFinite(rIdx) && sz) sheet.rowHeights.set(rIdx, sz);
      }
    }
  }

  // Overlay replayed input cell updates from the revision log.
  for (const { sheet: sName, ref, value } of inputValues.values()) {
    const normName = sName.trim().toLowerCase();
    let sheet = byName.get(normName);
    if (!sheet) sheet = makeSheet(sName);

    const targetRef = ref.includes(':') ? ref.split(':')[0] : ref;
    const rc = refToRc(targetRef);
    if (rc === null) continue;

    const val = coerceOverlayValue(value);
    if (val === null) continue;

    const existing = sheet.cells.get(rcKey(rc));
    sheet.cells.set(rcKey(rc), {
      row: rc[0],
      col: rc[1],
      value: val,
      // A replayed input may land on a cell the base data never carried, so
      // its style, format and borders come from the sheet's rectangles.
      style: existing ? existing.style : styleAt(sName, rc),
      numFmt: existing ? existing.numFmt : ownFormat(sName, rc),
      borders: existing ? existing.borders : bordersAt(sName, rc),
    });
    if (rc[0] > sheet.maxRow) sheet.maxRow = rc[0];
    if (rc[1] > sheet.maxCol) sheet.maxCol = rc[1];
  }

  // A single unimplemented function turns every dependent cell into #NAME?,
  // so it must not fail silently.
  if (book.unknownFns && book.unknownFns.size) {
    logger.warning(
      `Unimplemented spreadsheet function(s) -> #NAME?: ${[...book.unknownFns].sort().join(', ')}`,
    );
  }

  // Keep only the print sheets.
  const allNames = sheets.map((s) => s.name);
  const resolved = resolvePrintSheets(allNames);
  if (!resolved.length) {
    throw new NoPrintSheetsError(allNames);
  }

  const keep = new Set(resolved);
  logger.info(`Filtering sheets to keep only print sheets: ${JSON.stringify(resolved)}`);

  return { sheets: sheets.filter((s) => keep.has(s.name)) };
}

/** "B12" -> [12, 2]; tolerant of the `$` markers Odoo sometimes emits. */
function refToRc(ref: string): RC | null {
  const m = /^\$?([A-Za-z]{1,3})\$?(\d+)$/.exec(ref);
  if (!m) return null;
  let col = 0;
  for (const ch of m[1]) col = col * 26 + (ch.toUpperCase().charCodeAt(0) - 64);
  return [parseInt(m[2], 10), col];
}

export { colLetter };
