import { ODOO_URL, ODOO_DB, ODOO_API_USER, ODOO_API_KEY } from './config.js';
import { getLogger, errText } from './logger.js';
const logger = getLogger('odooRpc');
let requestId = 0;
/**
 * Odoo JSON-RPC call over `fetch`.
 *
 * JSON-RPC is used instead of XML-RPC because it needs no native or CommonJS
 * dependency, which keeps the service bundleable for serverless targets while
 * behaving identically on a normal server.
 */
async function jsonRpc(service, method, args) {
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
    const payload = (await res.json());
    if (payload.error) {
        // Odoo nests the useful text under error.data; fall back to the outer message.
        const data = payload.error.data;
        const detail = data?.message || payload.error.message;
        const name = data?.name ? `${data.name}: ` : '';
        throw new Error(`${name}${detail}`.trim());
    }
    return payload.result;
}
/**
 * Client for Odoo's external API.
 *
 * Authentication is asynchronous, so construction goes through
 * `OdooClient.create()` instead of a constructor.
 */
export class OdooClient {
    db;
    uid;
    password;
    mrpPartnerIds = null;
    constructor(db, uid, password) {
        this.db = db;
        this.uid = uid;
        this.password = password;
    }
    static async create() {
        let uid;
        try {
            uid = await jsonRpc('common', 'login', [ODOO_DB, ODOO_API_USER, ODOO_API_KEY]);
            if (!uid) {
                throw new Error('Authentication to Odoo failed.');
            }
        }
        catch (e) {
            logger.error(`Failed to connect to Odoo: ${errText(e)}`);
            throw e;
        }
        return new OdooClient(ODOO_DB, uid, ODOO_API_KEY);
    }
    /**
     * `execute_kw` wrapper. `args` are the positional arguments of the model
     * method, `kwargs` the keyword arguments.
     */
    async call(model, method, args = [], kwargs = {}) {
        return jsonRpc('object', 'execute_kw', [
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
    async getMrpPartnerIds() {
        if (this.mrpPartnerIds === null) {
            try {
                const groupXml = await this.call('ir.model.data', 'search_read', [
                    [
                        ['module', '=', 'mrp'],
                        ['name', '=', 'group_mrp_user'],
                    ],
                ], { fields: ['res_id'] });
                if (groupXml && groupXml.length) {
                    const groupId = groupXml[0].res_id;
                    const users = await this.call('res.users', 'search_read', [[['groups_id', 'in', [groupId]]]], { fields: ['partner_id'] });
                    this.mrpPartnerIds = users
                        .filter((u) => Boolean(u.partner_id))
                        .map((u) => u.partner_id[0]);
                }
                else {
                    this.mrpPartnerIds = [];
                }
            }
            catch (e) {
                logger.error(`Error fetching MRP partners: ${errText(e)}`);
                this.mrpPartnerIds = [];
            }
        }
        return this.mrpPartnerIds;
    }
    /** Post a chatter note explaining that the calculator was never opened. */
    async flagEmptyCalculator(orderId) {
        await this.call('sale.order', 'message_post', [orderId], {
            body: 'Production sheets could not be generated because the Quote Calculator was never opened for this order.',
            subtype_xmlid: 'mail.mt_note',
        });
    }
}
//# sourceMappingURL=odooRpc.js.map