import 'dotenv/config';
export const ODOO_URL = process.env.ODOO_URL ?? 'https://your-odoo-instance.odoo.com';
export const ODOO_DB = process.env.ODOO_DB ?? 'your-db-name';
export const ODOO_API_USER = process.env.ODOO_API_USER ?? 'api-user@example.com';
export const ODOO_API_KEY = process.env.ODOO_API_KEY ?? 'your-api-key';
export const PORT = parseInt(process.env.PORT ?? '8000', 10);
//# sourceMappingURL=config.js.map