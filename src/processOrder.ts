/**
 * The order worker, shared by every entry point (Express server and serverless
 * functions alike). Everything here is transport-agnostic.
 */
import { OdooClient } from './odooRpc.js';
import { getCalculatorState } from './calculator.js';
import { NoPrintSheetsError } from './render/model.js';
import { getLogger, errText } from './logger.js';

const logger = getLogger('app');

/** Odoo relational fields arrive as [id, display_name]; unset ones as `false`. */
export function relId(value: unknown): number | null {
  if (Array.isArray(value)) return (value[0] as number) ?? null;
  if (typeof value === 'number' && value) return value;
  return null;
}

/** Create an ir.attachment on the order and return its id. */
async function createAttachment(
  odoo: OdooClient,
  orderId: number,
  file: { name: string; bytes: Buffer; mimetype: string },
): Promise<number> {
  const created = await odoo.call<number | number[]>('ir.attachment', 'create', [
    [
      {
        name: file.name,
        datas: file.bytes.toString('base64'),
        res_model: 'sale.order',
        res_id: orderId,
        mimetype: file.mimetype,
      },
    ],
  ]);
  return Array.isArray(created) ? created[0] : created;
}

export async function processOrder(
  orderId: number,
  orderName: string,
  spreadsheetIdIn: unknown,
): Promise<void> {
  logger.info(`[C3 Worker] Processing order ${orderId} (${orderName})`);

  let odoo: OdooClient;
  try {
    odoo = await OdooClient.create();
  } catch (e) {
    logger.error(`Failed to connect to Odoo for order ${orderId}: ${errText(e)}`);
    return;
  }

  let spreadsheetId: unknown = spreadsheetIdIn;

  // 1. Fetch order state and spreadsheet_id.
  try {
    const orderData = await odoo.call<Array<Record<string, unknown>>>(
      'sale.order',
      'read',
      [[orderId], ['state', 'spreadsheet_id']],
    );
    if (!orderData || !orderData.length) {
      logger.warning(`Order ${orderId} not found.`);
      return;
    }

    const state = orderData[0].state;
    if (state !== 'sale') {
      logger.info(
        `Skipping order ${orderId} because state is '${state}' (must be confirmed 'sale').`,
      );
      return;
    }

    if (!spreadsheetId) {
      spreadsheetId = orderData[0].spreadsheet_id;
    }
  } catch (e) {
    logger.error(`Failed to fetch order info for ${orderId}: ${errText(e)}`);
    return;
  }

  // Handle relational tuple [id, name].
  const resolvedSpreadsheetId = relId(spreadsheetId);

  // 2. Lazy calculator edge case: the spreadsheet was never opened.
  if (!resolvedSpreadsheetId) {
    logger.warning(`Calculator for order ${orderId} was never opened.`);
    try {
      await odoo.flagEmptyCalculator(orderId);
    } catch (e) {
      logger.error(`Failed to flag empty calculator for order ${orderId}: ${errText(e)}`);
    }
    return;
  }

  // 3. Evaluate the calculator and emit the workbook.
  let xlsxBytes: Buffer;
  try {
    xlsxBytes = await getCalculatorState(orderId, resolvedSpreadsheetId, odoo);
  } catch (e) {
    // No sheet named 'Afdrukpagina…' means there is nothing to send: skip the
    // order quietly instead of reporting a generation failure.
    if (e instanceof NoPrintSheetsError) {
      logger.warning(`Nothing sent for order ${orderId}: ${e.message}`);
      return;
    }

    logger.error(`Failed to generate calculator attachments for order ${orderId}: ${errText(e)}`);
    try {
      await odoo.call('sale.order', 'message_post', [orderId], {
        body: `Automatic generation of production sheets failed: ${errText(e)}`,
        subtype_xmlid: 'mail.mt_note',
      });
    } catch {
      // Best effort only.
    }
    return;
  }

  // 4. Push results back to Odoo chatter & attach the workbook.
  try {
    // One recipient, resolved from MRP_NOTIFY_EMAIL.
    const mrpPartnerIds = await odoo.getMrpPartnerIds();

    const xlsxAttId = await createAttachment(odoo, orderId, {
      name: `${orderName} - productie.xlsx`,
      bytes: xlsxBytes,
      mimetype: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    });

    // Posted as a message, not a log note: `mail.mt_comment` with
    // message_type 'comment' is what the chatter's "Send message" button
    // produces, so the single recipient is notified by email.
    await odoo.call('sale.order', 'message_post', [orderId], {
      subject: `Productie-bladen ${orderName}`,
      body: `Bijgevoegd vindt u het MRP-blad voor ${orderName}.`,
      partner_ids: mrpPartnerIds,
      attachment_ids: [xlsxAttId],
      subtype_xmlid: 'mail.mt_comment',
      message_type: 'comment',
    });

    logger.info(`Successfully generated & attached production sheets for order ${orderId}.`);
  } catch (e) {
    logger.error(`Failed to push results to Odoo for order ${orderId}: ${errText(e)}`);
  }
}

/**
 * Shared webhook payload handling. Returns the decision plus the arguments for
 * `processOrder`, so every transport applies identical filtering.
 */
export interface WebhookDecision {
  action: 'process' | 'ignored' | 'error';
  reason?: string;
  orderId?: number;
  orderName?: string;
  spreadsheetId?: unknown;
}

export function decideWebhook(payload: Record<string, unknown>): WebhookDecision {
  if (payload._model !== 'sale.order') {
    return { action: 'ignored', reason: 'Not a sale.order' };
  }

  // Ignore non-sale states if state is provided in the payload.
  if (payload.state && payload.state !== 'sale') {
    return { action: 'ignored', reason: `Order state '${payload.state}' is not 'sale'` };
  }

  const orderId = (payload._id ?? payload.id) as number | undefined;
  if (!orderId) {
    return { action: 'error', reason: 'Missing _id' };
  }

  return {
    action: 'process',
    orderId,
    orderName: (payload.display_name as string) || (payload.name as string) || `SO${orderId}`,
    spreadsheetId: payload.spreadsheet_id,
  };
}
