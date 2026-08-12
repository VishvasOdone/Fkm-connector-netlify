import { ODOO_URL, ODOO_DB, ODOO_API_USER, ODOO_API_KEY } from './config.js';
import { getLogger, errText } from './logger.js';

const logger = getLogger('odooRpc');

interface JsonRpcResponse<T> {
  jsonrpc: string;
  id: number | null;
  result?: T;
  error?: {
    code: number;
    message: string;
    data?: { name?: string; message?: string; debug?: string; arguments?: unknown[] };
  };
}

let requestId = 0;

/**
 * Odoo JSON-RPC call over `fetch`.
 *
 * JSON-RPC is used instead of XML-RPC because it needs no native or CommonJS
 * dependency, which keeps the service bundleable for serverless targets while
 * behaving identically on a normal server.
 */
async function jsonRpc<T>(service: string, method: string, args: unknown[]): Promise<T> {
  const base = ODOO_URL.endsWith('/') ? ODOO_URL.slice(0, -1) : ODOO_URL;
  const url = `${base}/jsonrpc`;

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      method: 'call',
      params: { service, method, args },
      id: (requestId += 1),
    }),
  });

  if (!res.ok) {
    throw new Error(`${res.status} ${res.statusText}`);
  }

  const payload = (await res.json()) as JsonRpcResponse<T>;

  if (payload.error) {
    // Odoo nests the useful text under error.data; fall back to the outer message.
    const data = payload.error.data;
    const detail = data?.message || payload.error.message;
    const name = data?.name ? `${data.name}: ` : '';
    throw new Error(`${name}${detail}`.trim());
  }

  return payload.result as T;
}

/**
 * Client for Odoo's external API.
 *
 * Authentication is asynchronous, so construction goes through
 * `OdooClient.create()` instead of a constructor.
 */
export class OdooClient {
  private mrpPartnerIds: number[] | null = null;

  private constructor(
    private readonly db: string,
    private readonly uid: number,
    private readonly password: string,
  ) {}

  static async create(): Promise<OdooClient> {
    let uid: number;
    try {
      uid = await jsonRpc<number>('common', 'login', [ODOO_DB, ODOO_API_USER, ODOO_API_KEY]);
      if (!uid) {
        throw new Error('Authentication to Odoo failed.');
      }
    } catch (e) {
      logger.error(`Failed to connect to Odoo: ${errText(e)}`);
      throw e;
    }

    return new OdooClient(ODOO_DB, uid, ODOO_API_KEY);
  }

  /**
   * `execute_kw` wrapper. `args` are the positional arguments of the model
   * method, `kwargs` the keyword arguments.
   */
  async call<T = any>(
    model: string,
    method: string,
    args: unknown[] = [],
    kwargs: Record<string, unknown> = {},
  ): Promise<T> {
    return jsonRpc<T>('object', 'execute_kw', [
      this.db,
      this.uid,
      this.password,
      model,
      method,
      args,
      kwargs,
    ]);
  }

  /** Partner ids of every user in `mrp.group_mrp_user` (memoised per client). */
  async getMrpPartnerIds(): Promise<number[]> {
    if (this.mrpPartnerIds === null) {
      try {
        const groupXml = await this.call<Array<{ res_id: number }>>(
          'ir.model.data',
          'search_read',
          [
            [
              ['module', '=', 'mrp'],
              ['name', '=', 'group_mrp_user'],
            ],
          ],
          { fields: ['res_id'] },
        );
        if (groupXml && groupXml.length) {
          const groupId = groupXml[0].res_id;
          const users = await this.call<Array<{ partner_id: [number, string] | false }>>(
            'res.users',
            'search_read',
            [[['groups_id', 'in', [groupId]]]],
            { fields: ['partner_id'] },
          );
          this.mrpPartnerIds = users
            .filter((u) => Boolean(u.partner_id))
            .map((u) => (u.partner_id as [number, string])[0]);
        } else {
          this.mrpPartnerIds = [];
        }
      } catch (e) {
        logger.error(`Error fetching MRP partners: ${errText(e)}`);
        this.mrpPartnerIds = [];
      }
    }

    return this.mrpPartnerIds;
  }

  /** Post a chatter note explaining that the calculator was never opened. */
  async flagEmptyCalculator(orderId: number): Promise<void> {
    await this.call('sale.order', 'message_post', [orderId], {
      body: 'Production sheets could not be generated because the Quote Calculator was never opened for this order.',
      subtype_xmlid: 'mail.mt_note',
    });
  }
}
