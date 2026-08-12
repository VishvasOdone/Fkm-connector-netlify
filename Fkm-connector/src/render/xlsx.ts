/** ExcelJS emitter: turns the shared render model into .xlsx bytes. */
import ExcelJS from 'exceljs';

import { CellBorders, RenderModel, RenderSheet } from './model.js';
import { Value } from '../spreadsheet/values.js';

/** ExcelJS rejects these in worksheet names; openpyxl behaved the same way. */
function safeSheetName(name: string): string {
  let out = name.replace(/[*?:\\/[\]]/g, '_');
  if (out.length > 31) out = out.slice(0, 31);
  return out || 'Sheet';
}

function argb(hex: string): string {
  return `FF${hex}`;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * o-spreadsheet's border style names are the Excel ones, so they pass straight
 * through. An edge with no colour is black, as it is in the o-spreadsheet UI.
 */
function toBorder(borders: CellBorders): Partial<ExcelJS.Borders> {
  const out: Partial<ExcelJS.Borders> = {};
  for (const side of ['top', 'left', 'bottom', 'right'] as const) {
    const edge = borders[side];
    if (!edge) continue;
    out[side] = {
      style: edge.style,
      color: { argb: argb(edge.color ?? '000000') },
    };
  }
  return out;
}

/** ExcelJS accepts scalars only; anything else is written as its text form. */
function toCellValue(val: Value): string | number | boolean | null {
  if (val === null) return null;
  if (typeof val === 'number' || typeof val === 'string' || typeof val === 'boolean') return val;
  return String(val);
}

function addSheet(wb: ExcelJS.Workbook, sheet: RenderSheet): void {
  // Fit each sheet to one page wide so printing does not slice columns across
  // pages; height is left to spill as needed.
  const ws = wb.addWorksheet(safeSheetName(sheet.name), {
    pageSetup: {
      fitToPage: true,
      fitToWidth: 1,
      fitToHeight: 0,
      orientation: 'portrait',
      margins: { left: 0.4, right: 0.4, top: 0.5, bottom: 0.5, header: 0.2, footer: 0.2 },
    },
  });

  for (const { row, col, value, style, numFmt, borders } of sheet.cells.values()) {
    const cell = ws.getCell(row, col);

    const empty = value === null || value === undefined || value === '';
    if (!empty) {
      cell.value = toCellValue(value);
    }

    // o-spreadsheet stores Excel-compatible format strings ("0.00", "0%", …),
    // so they can be passed through as-is. An empty cell is left unformatted:
    // a date format on a blank cell makes viewers render it as 12/30/1899.
    if (numFmt && !empty) {
      cell.numFmt = numFmt;
    }

    cell.font = {
      name: 'Calibri',
      size: style.fontSize,
      bold: style.bold,
      italic: style.italic,
      ...(style.textColor ? { color: { argb: argb(style.textColor) } } : {}),
    };

    if (style.fillColor) {
      cell.fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: argb(style.fillColor) },
        bgColor: { argb: argb(style.fillColor) },
      };
    }

    cell.alignment = {
      horizontal: style.align,
      vertical: style.verticalAlign,
      wrapText: style.wrap,
    };

    if (borders) {
      cell.border = toBorder(borders);
    }
  }

  for (const m of sheet.merges) {
    try {
      ws.mergeCells(m);
    } catch {
      // Overlapping or already-merged ranges are skipped, as in the original.
    }
  }

  for (const [cIdx, size] of sheet.colWidths) {
    ws.getColumn(cIdx).width = round2(size * 0.14);
  }

  for (const [rIdx, size] of sheet.rowHeights) {
    ws.getRow(rIdx).height = round2(size * 0.75);
  }
}

export async function renderModelToXlsx(model: RenderModel): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();

  for (const sheet of model.sheets) {
    addSheet(wb, sheet);
  }

  wb.calcProperties.fullCalcOnLoad = false;

  const buffer = await wb.xlsx.writeBuffer();
  return Buffer.from(buffer as ArrayBuffer);
}
