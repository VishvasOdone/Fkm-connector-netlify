/**
 * Odoo webhook endpoint on Netlify.
 *
 * Declared as a background function: Netlify answers the caller with an empty
 * 202 immediately and lets this run for up to 15 minutes. That is what makes
 * the fire-and-forget worker viable on a serverless host — a normal function
 * would be frozen the moment it returned.
 *
 * Because the response is fixed at 202, the JSON status bodies the Express
 * route returns are log-only here. Odoo does not read them.
 */
import type { Config } from '@netlify/functions';

import { decideWebhook, processOrder } from '../../dist/processOrder.js';
import { getLogger, errText } from '../../dist/logger.js';

const logger = getLogger('netlify:webhook');

export default async (req: Request): Promise<void> => {
  let payload: Record<string, unknown> = {};

  try {
    payload = (await req.json()) as Record<string, unknown>;
  } catch (e) {
    logger.error(`Could not parse webhook body: ${errText(e)}`);
    return;
  }

  logger.info(`Received webhook: ${JSON.stringify(payload)}`);

  const decision = decideWebhook(payload);

  if (decision.action !== 'process') {
    logger.info(`${decision.action}: ${decision.reason}`);
    return;
  }

  // Awaited, not fired and forgotten: the background function must stay alive
  // until the work is done.
  try {
    await processOrder(
      decision.orderId as number,
      decision.orderName as string,
      decision.spreadsheetId,
    );
  } catch (e) {
    logger.error(`Unhandled error while processing order ${decision.orderId}: ${errText(e)}`);
  }
};

export const config: Config = {
  background: true,
  path: '/webhook',
};
