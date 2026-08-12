import 'dotenv/config';
export const ODOO_URL = process.env.ODOO_URL ?? 'https://your-odoo-instance.odoo.com';
export const ODOO_DB = process.env.ODOO_DB ?? 'your-db-name';
export const ODOO_API_USER = process.env.ODOO_API_USER ?? 'api-user@example.com';
export const ODOO_API_KEY = process.env.ODOO_API_KEY ?? 'your-api-key';
/**
 * The single recipient of the production-sheet message. Matched on email
 * rather than id, because partner ids do not survive a move to another
 * database while the address does.
 */
export const MRP_NOTIFY_EMAIL = process.env.MRP_NOTIFY_EMAIL ?? 'e.scholten@fkm-lichtstraten.nl';
export const PORT = parseInt(process.env.PORT ?? '8000', 10);
//# sourceMappingURL=config.js.map