/**
 * Health check. Also verifies the Odoo connection, because a background
 * function always answers 202 — this endpoint is the only way to confirm from
 * outside that the environment variables are set and Odoo is reachable.
 */
import type { Config } from '@netlify/functions';

import { OdooClient } from '../../dist/odooRpc.js';
import { errText } from '../../dist/logger.js';

export default async (): Promise<Response> => {
  const required = ['ODOO_URL', 'ODOO_DB', 'ODOO_API_USER', 'ODOO_API_KEY'];
  const missing = required.filter((k) => !process.env[k]);

  let connected = false;
  let error: string | null = null;

  if (missing.length) {
    error = `Missing environment variables: ${missing.join(', ')}`;
  } else {
    try {
      await OdooClient.create();
      connected = true;
    } catch (e) {
      error = errText(e);
    }
  }

  return Response.json(
    {
      status: connected ? 'ok' : 'degraded',
      service: 'fkm-connector',
      runtime: 'netlify-functions',
      endpoints: { webhook: 'POST /webhook', health: 'GET /health' },
      odoo: {
        connected,
        // Host only — never echo the database name, user or key.
        url: process.env.ODOO_URL ? new URL(process.env.ODOO_URL).host : null,
        error,
      },
    },
    { status: connected ? 200 : 503 },
  );
};

export const config: Config = {
  path: '/health',
};
