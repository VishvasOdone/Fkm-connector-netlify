import { ODOO_URL, ODOO_DB, ODOO_API_USER, ODOO_API_KEY, MRP_NOTIFY_EMAIL } from './config.js';
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

  /**
   * Partner id of the one person the production sheets are addressed to,
   * resolved from `MRP_NOTIFY_EMAIL` and memoised per client.
   *
   * Returns an empty list when the address matches nobody. The caller still
   * posts the message in that case: losing the recipient must not also lose
   * the attachment.
   */
  async getMrpPartnerIds(): Promise<number[]> {
    if (this.mrpPartnerIds === null) {
      try {
        const partners = await this.call<Array<{ id: number; name: string }>>(
          'res.partner',
          'search_read',
          [[['email', '=ilike', MRP_NOTIFY_EMAIL]], ['id', 'name']],
          { limit: 1 },
        );

        if (partners && partners.length) {
          this.mrpPartnerIds = [partners[0].id];
          logger.info(
            `Production sheets will be sent to ${partners[0].name} <${MRP_NOTIFY_EMAIL}> (partner ${partners[0].id}).`,
          );
        } else {
          this.mrpPartnerIds = [];
          logger.error(
            `No partner has the address ${MRP_NOTIFY_EMAIL}; the message will be posted without a recipient. Set MRP_NOTIFY_EMAIL to the right address.`,
          );
        }
      } catch (e) {
        logger.error(`Error resolving the notification partner: ${errText(e)}`);
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
