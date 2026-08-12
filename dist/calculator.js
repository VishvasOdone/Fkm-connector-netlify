/**
 * calculator.ts — Route C, Variant C3 implementation
 * ──────────────────────────────────────────────────
 * Production sheets to MRP, no browser (RPC + in-process spreadsheet evaluation).
 *
 * 1. Reads the base snapshot/data and the revision log over Odoo JSON-RPC
 *    (chained via parent_revision_id).
 * 2. Extracts UPDATE_CELL commands for the input cells and replays them.
 * 3. Rebuilds the o-spreadsheet cell graph and evaluates every formula
 *    in-process into a render model (src/render/model.ts).
 * 4. Emits the .xlsx from that model and scans the print sheets for
 *    unexpected formula errors.
 */
import ExcelJS from 'exceljs';
import { OdooClient } from './odooRpc.js';
import { getLogger, errText } from './logger.js';
import { colLetter } from './spreadsheet/refs.js';
import { buildRenderModel } from './render/model.js';
import { loadFigureImages } from './render/images.js';
import { renderModelToXlsx } from './render/xlsx.js';
const logger = getLogger('calculator');
/** Known error values to validate against. */
const ERROR_VALUES = new Set([
    '#REF!',
    '#VALUE!',
    '#DIV/0!',
    '#NAME?',
    '#N/A',
    '#NULL!',
    '#NUM!',
    '#BAD_EXPR',
]);
/**
 * Route C, Variant C3 main entry point. Returns the generated workbook bytes.
 */
export async function getCalculatorState(orderId, spreadsheetId, client) {
    logger.info(`[C3 Engine] Processing order ${orderId}, spreadsheet ${spreadsheetId}`);
    const odoo = client ?? (await OdooClient.create());
    // Step 1: read base snapshot/data and revision log.
    const { baseData, revisions } = await fetchSpreadsheetDataAndRevisions(odoo, spreadsheetId);
    // Step 2: extract UPDATE_CELL inputs (static inputs only).
    const inputValues = extractInputCellValues(baseData, revisions);
    logger.info(`Resolved ${inputValues.size} input cell updates from base data & revisions.`);
    // Step 3: build the workbook containing only the print sheets.
    const tmplData = await fetchDynamicQuotationTemplate(odoo, orderId);
    let xlsxBytes;
    if (tmplData && (tmplData.sheets?.length ?? 0) > 0) {
        logger.info('Overlaying order spreadsheet instance cell updates onto base quotation template structure.');
        const combined = overlaySpreadsheetInstance(tmplData, baseData);
        xlsxBytes = await buildXlsx(combined, inputValues, odoo);
    }
    else {
        xlsxBytes = await buildXlsx(baseData, inputValues, odoo);
    }
    // Step 4: validate the generated print sheets for unexpected formula errors.
    await validateXlsxOutput(xlsxBytes);
    return xlsxBytes;
}
/** Fetch base snapshot/data and revision log from Odoo over RPC. */
export async function fetchSpreadsheetDataAndRevisions(odoo, spreadsheetId) {
    const records = await odoo.call('sale.order.spreadsheet', 'read', [[spreadsheetId], ['spreadsheet_snapshot', 'spreadsheet_data', 'spreadsheet_binary_data']]);
    if (!records || !records.length) {
        throw new Error(`Spreadsheet record ${spreadsheetId} not found in Odoo.`);
    }
    const rec = records[0];
    const rawVal = rec.spreadsheet_snapshot ||
        rec.spreadsheet_data ||
        rec.spreadsheet_binary_data;
    let baseData = {};
    if (rawVal) {
        try {
            baseData = parseSpreadsheetPayload(rawVal);
        }
        catch (e) {
            logger.warning(`Could not parse spreadsheet JSON: ${errText(e)}`);
        }
    }
    // Fetch revisions and order them by parent_revision_id.
    let revisions = [];
    try {
        const revRecords = await odoo.call('spreadsheet.revision', 'search_read', [
            [
                ['res_model', '=', 'sale.order.spreadsheet'],
                ['res_id', '=', spreadsheetId],
            ],
            ['commands', 'revision_uuid', 'parent_revision_id'],
        ]);
        if (revRecords && revRecords.length) {
            revisions = chainRevisions(revRecords);
            logger.info(`Retrieved and ordered ${revisions.length} revisions for spreadsheet ${spreadsheetId}`);
        }
    }
    catch (e) {
        logger.warning(`Revision log search skipped or restricted (requires base.group_system): ${errText(e)}`);
    }
    return { baseData, revisions };
}
/** Decode a spreadsheet payload that may be raw JSON or base64-wrapped JSON. */
function parseSpreadsheetPayload(rawVal) {
    let text = Buffer.isBuffer(rawVal) ? rawVal.toString('utf-8') : rawVal;
    const trimmed = text.trim();
    if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) {
        try {
            text = Buffer.from(text, 'base64').toString('utf-8');
        }
        catch {
            // Leave as-is; JSON.parse will surface the problem.
        }
    }
    return JSON.parse(text);
}
/**
 * Dynamically fetch the base Quotation Template spreadsheet data from Odoo RPC
 * without requiring static files.
 */
export async function fetchDynamicQuotationTemplate(odoo, orderId) {
    try {
        const so = await odoo.call('sale.order', 'read', [[orderId], ['sale_order_template_id']]);
        if (!so || !so.length || !so[0].sale_order_template_id)
            return {};
        const tmplId = so[0].sale_order_template_id[0];
        const tmpl = await odoo.call('sale.order.template', 'read', [[tmplId], ['spreadsheet_template_id']]);
        if (!tmpl || !tmpl.length || !tmpl[0].spreadsheet_template_id)
            return {};
        const spTmplId = tmpl[0].spreadsheet_template_id[0];
        const spTmpl = await odoo.call('sale.order.spreadsheet', 'read', [[spTmplId], ['spreadsheet_binary_data', 'spreadsheet_data']]);
        if (!spTmpl || !spTmpl.length)
            return {};
        const rawVal = spTmpl[0].spreadsheet_binary_data || spTmpl[0].spreadsheet_data;
        if (!rawVal)
            return {};
        logger.info(`Dynamically loaded quotation template spreadsheet ${spTmplId} from Odoo RPC.`);
        return parseSpreadsheetPayload(rawVal);
    }
    catch (e) {
        logger.warning(`Could not fetch dynamic quotation template for order ${orderId}: ${errText(e)}`);
        return {};
    }
}
/** Merge order spreadsheet instance cell updates onto the base template structure. */
export function overlaySpreadsheetInstance(tmplData, instanceData) {
    const merged = structuredClone(tmplData);
    const instSheets = new Map();
    for (const s of instanceData.sheets ?? []) {
        const key = (s.id ?? s.name);
        if (key !== undefined)
            instSheets.set(key, s);
    }
    for (const sheetInfo of merged.sheets ?? []) {
        const sKey = (sheetInfo.id ?? sheetInfo.name);
        let instSheet = sKey !== undefined ? instSheets.get(sKey) : undefined;
        if (!instSheet && sheetInfo.name) {
            instSheet = (instanceData.sheets ?? []).find((s) => s.name === sheetInfo.name);
        }
        if (instSheet) {
            if (!sheetInfo.cells)
                sheetInfo.cells = {};
            const tmplCells = sheetInfo.cells;
            const instCells = (instSheet.cells ?? {});
            for (const [cellRef, cellVal] of Object.entries(instCells)) {
                if (cellVal !== null && cellVal !== undefined)
                    tmplCells[cellRef] = cellVal;
            }
            // Figures are replaced wholesale, not merged: the order's own instance is
            // the live set of images, and the user may have moved or deleted the ones
            // the template started with.
            if (Array.isArray(instSheet.figures)) {
                sheetInfo.figures = instSheet.figures;
            }
        }
    }
    return merged;
}
/** Sort revisions in parent-child causal order using parent_revision_id. */
export function chainRevisions(revisions) {
    const revMap = new Map();
    for (const r of revisions) {
        if (r.revision_uuid)
            revMap.set(r.revision_uuid, r);
    }
    // A root has no parent, or a parent that is not part of this revision set.
    const roots = revisions.filter((r) => !r.parent_revision_id || !revMap.has(r.parent_revision_id));
    const ordered = [];
    const visited = new Set();
    const queue = [...roots];
    while (queue.length) {
        const curr = queue.shift();
        const uuid = curr.revision_uuid;
        if (visited.has(uuid))
            continue;
        visited.add(uuid);
        ordered.push(curr);
        for (const r of revisions) {
            if (r.parent_revision_id === uuid)
                queue.push(r);
        }
    }
    // Append any remaining revisions if the chain had breaks.
    for (const r of revisions) {
        if (!visited.has(r.revision_uuid))
            ordered.push(r);
    }
    return ordered;
}
/**
 * Extract base inputs + replayed UPDATE_CELL commands (excluding formulas).
 * Keyed by "sheet CELLREF", last write wins.
 */
export function extractInputCellValues(baseData, revisions) {
    const cellValues = new Map();
    const sheetIdToName = new Map();
    const put = (sheet, ref, value) => {
        cellValues.set(`${sheet} ${ref}`, { sheet, ref, value });
    };
    const isFormula = (v) => typeof v === 'string' && (v.startsWith('=') || v.startsWith('+') || v.startsWith('-'));
    for (const sheetInfo of baseData.sheets ?? []) {
        const sName = sheetInfo.name ?? 'Sheet';
        if (sheetInfo.id)
            sheetIdToName.set(sheetInfo.id, sName);
        // Parse base cells.
        for (const [cellRef, cellData] of Object.entries(sheetInfo.cells ?? {})) {
            let val = null;
            if (cellData !== null && typeof cellData === 'object' && !Array.isArray(cellData)) {
                const obj = cellData;
                if (obj.value !== undefined && obj.value !== null) {
                    val = obj.value;
                }
                else {
                    const content = obj.content;
                    val = isFormula(content) ? null : content;
                }
            }
            else {
                val = cellData;
            }
            if (val !== null && val !== undefined) {
                if (isFormula(val))
                    continue;
                put(sName, cellRef.toUpperCase(), val);
            }
        }
    }
    // Replay UPDATE_CELL commands (last write wins).
    for (const rev of revisions) {
        const commandsRaw = rev.commands;
        if (!commandsRaw)
            continue;
        try {
            const cmds = typeof commandsRaw === 'string' ? JSON.parse(commandsRaw) : commandsRaw;
            if (!Array.isArray(cmds))
                continue;
            for (const cmd of cmds) {
                if (!cmd || typeof cmd !== 'object' || cmd.type !== 'UPDATE_CELL')
                    continue;
                const sId = cmd.sheetId;
                const col = cmd.col;
                const row = cmd.row;
                const content = cmd.content;
                const sName = (sId && sheetIdToName.get(sId)) || 'Gegevens invulblad';
                if (col !== undefined && col !== null && row !== undefined && row !== null) {
                    const cellRef = `${colLetter(col + 1)}${row + 1}`;
                    // Revisions update inputs. If they update with a formula, do not copy
                    // the formula structure.
                    if (isFormula(content))
                        continue;
                    put(sName, cellRef.toUpperCase(), content);
                }
            }
        }
        catch (e) {
            logger.debug(`Error parsing revision command: ${errText(e)}`);
        }
    }
    return cellValues;
}
/**
 * Evaluate the spreadsheet into a render model and emit the workbook. The Odoo
 * client is optional: without it the sheets render without their images, which
 * is what the offline fixtures do.
 */
export async function buildXlsx(baseData, inputValues, odoo) {
    const model = buildRenderModel(baseData, inputValues);
    const images = odoo ? await loadFigureImages(odoo, model) : new Map();
    return renderModelToXlsx(model, images);
}
/** Validate that the print sheets do not contain unexpected formula error values. */
export async function validateXlsxOutput(xlsxBytes) {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(xlsxBytes);
    const detectedErrors = [];
    for (const ws of wb.worksheets) {
        ws.eachRow({ includeEmpty: false }, (row) => {
            row.eachCell({ includeEmpty: false }, (cell) => {
                const text = cell.value === null || cell.value === undefined ? '' : String(cell.value);
                if (!ERROR_VALUES.has(text))
                    return;
                // Column P #BAD_EXPR is a known pre-existing template issue; flag others.
                const cellRef = cell.address;
                if (cellRef.startsWith('P') && text === '#BAD_EXPR') {
                    logger.info(`Known template error ignored at ${ws.name}!${cellRef}: ${text}`);
                    return;
                }
                detectedErrors.push(`${ws.name}!${cellRef}: ${text}`);
            });
        });
    }
    if (detectedErrors.length) {
        logger.warning(`Validation detected formula errors (ignored): ${detectedErrors.slice(0, 5).join(', ')}`);
    }
}
//# sourceMappingURL=calculator.js.map