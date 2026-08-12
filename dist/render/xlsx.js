/** ExcelJS emitter: turns the shared render model into .xlsx bytes. */
import ExcelJS from 'exceljs';
/** o-spreadsheet's defaults for a column and row that carry no explicit size. */
const DEFAULT_COL_PX = 96;
const DEFAULT_ROW_PX = 23;
/** ExcelJS rejects these in worksheet names; openpyxl behaved the same way. */
function safeSheetName(name) {
    let out = name.replace(/[*?:\\/[\]]/g, '_');
    if (out.length > 31)
        out = out.slice(0, 31);
    return out || 'Sheet';
}
function argb(hex) {
    return `FF${hex}`;
}
function round2(n) {
    return Math.round(n * 100) / 100;
}
/**
 * o-spreadsheet's border style names are the Excel ones, so they pass straight
 * through. An edge with no colour is black, as it is in the o-spreadsheet UI.
 */
function toBorder(borders) {
    const out = {};
    for (const side of ['top', 'left', 'bottom', 'right']) {
        const edge = borders[side];
        if (!edge)
            continue;
        out[side] = {
            style: edge.style,
            color: { argb: argb(edge.color ?? '000000') },
        };
    }
    return out;
}
/** ExcelJS accepts scalars only; anything else is written as its text form. */
function toCellValue(val) {
    if (val === null)
        return null;
    if (typeof val === 'number' || typeof val === 'string' || typeof val === 'boolean')
        return val;
    return String(val);
}
/**
 * Anchor an image the way o-spreadsheet positions it: on a cell plus a pixel
 * offset into that cell.
 *
 * ExcelJS takes a fractional `col`/`row` and turns the fraction into the
 * drawing's offset within the cell, so the offset is expressed as a fraction of
 * the anchor cell's own size. A figure may sit slightly above or left of its
 * anchor (o-spreadsheet writes offsets like -1), which cannot be represented,
 * so the anchor is clamped to the sheet's top-left corner.
 */
function anchor(sheet, figCol, figRow, offsetX, offsetY) {
    // colWidths / rowHeights are keyed 1-based; figure coordinates are 0-based.
    const colPx = sheet.colWidths.get(figCol + 1) ?? DEFAULT_COL_PX;
    const rowPx = sheet.rowHeights.get(figRow + 1) ?? DEFAULT_ROW_PX;
    const col = figCol + offsetX / colPx;
    const row = figRow + offsetY / rowPx;
    return { col: Math.max(0, col), row: Math.max(0, row) };
}
function addImages(wb, ws, sheet, images) {
    for (const fig of sheet.figures) {
        const image = images.get(fig.path);
        // A figure whose image could not be resolved leaves its space empty;
        // render/images.ts has already logged why.
        if (!image)
            continue;
        const imageId = wb.addImage({ buffer: image.buffer, extension: image.extension });
        // o-spreadsheet and Excel both measure at 96 DPI, so the figure's pixel
        // size carries over unchanged. `oneCell` keeps the image pinned to its
        // anchor when row heights shift.
        ws.addImage(imageId, {
            tl: anchor(sheet, fig.col, fig.row, fig.offsetX, fig.offsetY),
            ext: { width: fig.width, height: fig.height },
            editAs: 'oneCell',
        });
    }
}
function addSheet(wb, sheet, images) {
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
        }
        catch {
            // Overlapping or already-merged ranges are skipped, as in the original.
        }
    }
    for (const [cIdx, size] of sheet.colWidths) {
        ws.getColumn(cIdx).width = round2(size * 0.14);
    }
    for (const [rIdx, size] of sheet.rowHeights) {
        ws.getRow(rIdx).height = round2(size * 0.75);
    }
    // Images go on last, so the anchor maths sees the final row and column sizes.
    addImages(wb, ws, sheet, images);
}
export async function renderModelToXlsx(model, images = new Map()) {
    const wb = new ExcelJS.Workbook();
    for (const sheet of model.sheets) {
        addSheet(wb, sheet, images);
    }
    wb.calcProperties.fullCalcOnLoad = false;
    const buffer = await wb.xlsx.writeBuffer();
    return Buffer.from(buffer);
}
//# sourceMappingURL=xlsx.js.map