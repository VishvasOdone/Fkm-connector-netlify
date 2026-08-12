import xmlrpc.client
import logging
from config import ODOO_URL, ODOO_DB, ODOO_API_USER, ODOO_API_KEY

logger = logging.getLogger(__name__)

class OdooClient:
    def __init__(self):
        self.url = ODOO_URL
        self.db = ODOO_DB
        self.username = ODOO_API_USER
        self.password = ODOO_API_KEY
        
        common = xmlrpc.client.ServerProxy('{}/xmlrpc/2/common'.format(self.url))
        try:
            self.uid = common.authenticate(self.db, self.username, self.password, {})
            if not self.uid:
                raise Exception("Authentication to Odoo failed.")
        except Exception as e:
            logger.error(f"Failed to connect to Odoo: {e}")
            raise
            
        self.models = xmlrpc.client.ServerProxy('{}/xmlrpc/2/object'.format(self.url))
        
        self._mrp_partner_ids = None

    def call(self, model, method, *args, **kwargs):
        return self.models.execute_kw(self.db, self.uid, self.password, model, method, args, kwargs)
        
    def get_mrp_partner_ids(self):
        if self._mrp_partner_ids is None:
            try:
                group_xml = self.call('ir.model.data', 'search_read', [('module', '=', 'mrp'), ('name', '=', 'group_mrp_user')], fields=['res_id'])
                if group_xml:
                    group_id = group_xml[0]['res_id']
                    users = self.call('res.users', 'search_read', [('groups_id', 'in', [group_id])], fields=['partner_id'])
                    self._mrp_partner_ids = [u['partner_id'][0] for u in users if u.get('partner_id')]
                else:
                    self._mrp_partner_ids = []
            except Exception as e:
                logger.error(f"Error fetching MRP partners: {e}")
                self._mrp_partner_ids = []
                
        return self._mrp_partner_ids

    def flag_empty_calculator(self, order_id):
        self.call('sale.order', 'message_post', [order_id], {
            'body': 'Production sheets could not be generated because the Quote Calculator was never opened for this order.',
            'subtype_xmlid': 'mail.mt_note',
        })
