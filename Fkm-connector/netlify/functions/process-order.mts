/**
 * Netlify API Controller function for FKM connector.
 * Allows synchronous execution of processOrder over HTTPS.
 */
import type { Config } from '@netlify/functions';

import { processOrder } from '../../dist/processOrder.js';
import { getLogger, errText } from '../../dist/logger.js';

const logger = getLogger('netlify:controller');

export default async (req: Request): Promise<Response> => {
  // CORS Headers
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json'
  };

  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ status: 'error', reason: 'Method Not Allowed' }), {
      status: 405,
      headers: corsHeaders
    });
  }

  let body: Record<string, unknown> = {};
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch (e) {
    return new Response(JSON.stringify({ status: 'error', reason: 'Invalid JSON payload' }), {
      status: 400,
      headers: corsHeaders
    });
  }

  const orderId = (body.orderId ?? body.order_id ?? body.id ?? body._id) as number | undefined;

  if (!orderId || isNaN(Number(orderId))) {
    return new Response(
      JSON.stringify({ status: 'error', reason: 'Missing or invalid orderId in body (e.g. { "orderId": 123 })' }),
      { status: 400, headers: corsHeaders }
    );
  }

  const numericOrderId = Number(orderId);
  const orderName = (body.orderName ?? body.name ?? body.display_name ?? `SO${numericOrderId}`) as string;
  const spreadsheetId = body.spreadsheetId ?? body.spreadsheet_id;

  logger.info(`[Netlify Controller] Triggering full order processing flow for Order ID: ${numericOrderId} (${orderName})`);

  try {
    await processOrder(numericOrderId, orderName, spreadsheetId);
    return new Response(
      JSON.stringify({
        status: 'success',
        orderId: numericOrderId,
        orderName,
        message: `Full order processing flow executed for order ${numericOrderId} (${orderName}).`,
        timestamp: new Date().toISOString()
      }),
      { status: 200, headers: corsHeaders }
    );
  } catch (e) {
    logger.error(`[Netlify Controller] Error processing order ${numericOrderId}: ${errText(e)}`);
    return new Response(
      JSON.stringify({ status: 'error', orderId: numericOrderId, reason: errText(e) }),
      { status: 500, headers: corsHeaders }
    );
  }
};

export const config: Config = {
  path: '/api/process-order',
};
