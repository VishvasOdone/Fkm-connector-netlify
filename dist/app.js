/**
 * Express entry point, used for local development and container hosts.
 * Netlify uses netlify/functions/*.mts instead; both share `processOrder`.
 */
import express from 'express';
import { PORT } from './config.js';
import { decideWebhook, processOrder } from './processOrder.js';
import { getLogger, errText } from './logger.js';
import { OdooClient } from './odooRpc.js';
const logger = getLogger('app');
export const app = express();
app.use(express.json({ limit: '10mb' }));
// Enable CORS for external testing clients (e.g. Netlify test app)
app.use((_req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
    res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    if (_req.method === 'OPTIONS') {
        res.sendStatus(200);
        return;
    }
    next();
});
/** Health check & Odoo RPC Connection verification. */
app.get(['/', '/health', '/api/status'], async (_req, res) => {
    let odooConnected = false;
    let odooError = null;
    try {
        await OdooClient.create();
        odooConnected = true;
    }
    catch (e) {
        odooError = errText(e);
    }
    res.json({
        status: 'ok',
        service: 'fkm-connector',
        endpoints: {
            webhook: 'POST /webhook',
            controller: 'POST /api/process-order',
            health: 'GET /api/status'
        },
        odoo: {
            connected: odooConnected,
            error: odooError
        }
    });
});
/**
 * Controller Route: Synchronous Order Processing Flow.
 * Awaits full calculation, Excel rendering, and Odoo attachment posting.
 */
app.post(['/api/process-order', '/process'], async (req, res) => {
    const body = (req.body ?? {});
    const orderId = (body.orderId ?? body.order_id ?? body.id ?? body._id);
    if (!orderId || isNaN(Number(orderId))) {
        res.status(400).json({
            status: 'error',
            reason: 'Missing or invalid orderId in request body (e.g. { "orderId": 123 })'
        });
        return;
    }
    const numericOrderId = Number(orderId);
    const orderName = (body.orderName ?? body.name ?? body.display_name ?? `SO${numericOrderId}`);
    const spreadsheetId = body.spreadsheetId ?? body.spreadsheet_id;
    logger.info(`[Controller API] Triggering full order processing flow for Order ID: ${numericOrderId} (${orderName})`);
    try {
        await processOrder(numericOrderId, orderName, spreadsheetId);
        res.json({
            status: 'success',
            orderId: numericOrderId,
            orderName,
            message: `Full order processing flow executed for order ${numericOrderId} (${orderName}).`,
            timestamp: new Date().toISOString()
        });
    }
    catch (e) {
        logger.error(`[Controller API] Error processing order ${numericOrderId}: ${errText(e)}`);
        res.status(500).json({
            status: 'error',
            orderId: numericOrderId,
            reason: errText(e)
        });
    }
});
/** GET /webhook info handler for browser requests */
app.get('/webhook', (_req, res) => {
    res.json({
        status: 'ok',
        service: 'fkm-connector',
        endpoint: 'POST /webhook',
        message: 'The /webhook endpoint accepts HTTP POST requests from Odoo. To test manually via browser UI or API, use POST /api/process-order or visit the Netlify Test Hub UI.',
        controller_endpoint: 'POST /api/process-order'
    });
});
app.post('/webhook', (req, res) => {
    const payload = (req.body ?? {});
    logger.info(`Received webhook: ${JSON.stringify(payload)}`);
    const decision = decideWebhook(payload);
    if (decision.action === 'ignored') {
        res.json({ status: 'ignored', reason: decision.reason });
        return;
    }
    if (decision.action === 'error') {
        res.json({ status: 'error', reason: decision.reason });
        return;
    }
    // Fire and forget processing, after the response has been sent.
    res.json({ status: 'processing_started' });
    setImmediate(() => {
        processOrder(decision.orderId, decision.orderName, decision.spreadsheetId).catch((e) => {
            logger.error(`Unhandled error while processing order ${decision.orderId}: ${errText(e)}`);
        });
    });
});
const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
    app.listen(PORT, '0.0.0.0', () => {
        logger.info(`Listening on http://0.0.0.0:${PORT}`);
    });
}
//# sourceMappingURL=app.js.map