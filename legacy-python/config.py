import os
from dotenv import load_dotenv

load_dotenv()

ODOO_URL = os.getenv("ODOO_URL", "https://your-odoo-instance.odoo.com")
ODOO_DB = os.getenv("ODOO_DB", "your-db-name")
ODOO_API_USER = os.getenv("ODOO_API_USER", "api-user@example.com")
ODOO_API_KEY = os.getenv("ODOO_API_KEY", "your-api-key")

# The ID of the mrp.group_mrp_user to send the message to
MRP_PARTNER_GROUP_ID = os.getenv("MRP_PARTNER_GROUP_ID")

WEBHOOK_SECRET = os.getenv("WEBHOOK_SECRET", "")  # Optional shared secret

POLLING_INTERVAL_SECONDS = int(os.getenv("POLLING_INTERVAL_SECONDS", "300"))
TEMPLATE_PATH = os.getenv("TEMPLATE_PATH", "")
LIBREOFFICE_UNO_HOST = os.getenv("LIBREOFFICE_UNO_HOST", "localhost")
LIBREOFFICE_UNO_PORT = int(os.getenv("LIBREOFFICE_UNO_PORT", "2002"))

