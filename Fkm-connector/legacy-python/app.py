import logging
import base64
import asyncio
from fastapi import FastAPI, Request, BackgroundTasks
from pydantic import BaseModel
from typing import Optional, Any

from config import WEBHOOK_SECRET, POLLING_INTERVAL_SECONDS
from odoo_rpc import OdooClient
from calculator import get_calculator_state

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = FastAPI()

class WebhookPayload(BaseModel):
    _model: str
    _id: int
    _action: Optional[str] = None
    display_name: Optional[str] = None
    name: Optional[str] = None
    partner_id: Optional[Any] = None
    spreadsheet_id: Optional[Any] = None

def process_order(order_id: int, order_name: str, spreadsheet_id: Any):
    logger.info(f"[C3 Worker] Processing order {order_id} ({order_name})")
    odoo = OdooClient()

    # 1. Fetch order state and spreadsheet_id
    try:
        order_data = odoo.call('sale.order', 'read', [order_id], ['state', 'spreadsheet_id'])
        if not order_data:
            logger.warning(f"Order {order_id} not found.")
            return

        state = order_data[0].get('state')
        if state != 'sale':
            logger.info(f"Skipping order {order_id} because state is '{state}' (must be confirmed 'sale').")
            return

        if not spreadsheet_id:
            spreadsheet_id = order_data[0].get('spreadsheet_id')

    except Exception as e:
        logger.error(f"Failed to fetch order info for {order_id}: {e}")
        return

    # Handle relational tuple [id, name]
    if isinstance(spreadsheet_id, (list, tuple)):
        spreadsheet_id = spreadsheet_id[0]

    # 2. Lazy calculator edge case: spreadsheet was never opened
    if not spreadsheet_id:
        logger.warning(f"Calculator for order {order_id} was never opened.")
        odoo.flag_empty_calculator(order_id)
        return

    # 3. Fetch calculator state via C3 engine (RPC + openpyxl + LibreOffice/ReportLab)
    try:
        xlsx_bytes = get_calculator_state(order_id, spreadsheet_id)
    except Exception as e:
        logger.error(f"Failed to generate calculator attachments for order {order_id}: {e}")
        try:
            odoo.call('sale.order', 'message_post', [order_id], {
                'body': f'Automatic generation of production sheets failed: {str(e)}',
                'subtype_xmlid': 'mail.mt_note',
            })
        except Exception:
            pass
        return

    # 4. Push results back to Odoo chatter & attach files
    try:
        mrp_partner_ids = odoo.get_mrp_partner_ids()

        xlsx_att_id = odoo.call('ir.attachment', 'create', [{
            'name': f'{order_name} - productie.xlsx',
            'datas': base64.b64encode(xlsx_bytes).decode(),
            'res_model': 'sale.order', 'res_id': order_id,
            'mimetype': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        }])
        if isinstance(xlsx_att_id, list):
            xlsx_att_id = xlsx_att_id[0]

        odoo.call('sale.order', 'message_post', [order_id], **{
            'subject': f'Productie-bladen {order_name}',
            'body': 'Volledige Excel-bestand in bijlage.',
            'partner_ids': mrp_partner_ids,
            'attachment_ids': [xlsx_att_id],
            'subtype_xmlid': 'mail.mt_comment',
        })

        logger.info(f"Successfully generated & attached production sheets for order {order_id}.")

    except Exception as e:
        logger.error(f"Failed to push results to Odoo for order {order_id}: {e}")

@app.post("/webhook")
async def handle_webhook(payload: dict, background_tasks: BackgroundTasks):
    logger.info(f"Received webhook: {payload}")
    if payload.get('_model') != 'sale.order':
        return {"status": "ignored", "reason": "Not a sale.order"}

    # Ignore non-sale states if state is provided in payload
    if payload.get('state') and payload.get('state') != 'sale':
        return {"status": "ignored", "reason": f"Order state '{payload.get('state')}' is not 'sale'"}

    order_id = payload.get('_id') or payload.get('id')
    if not order_id:
        return {"status": "error", "reason": "Missing _id"}

    order_name = payload.get('display_name') or payload.get('name') or f"SO{order_id}"
    spreadsheet_id = payload.get('spreadsheet_id')

    # Fire and forget processing
    background_tasks.add_task(process_order, order_id, order_name, spreadsheet_id)
    return {"status": "processing_started"}

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
