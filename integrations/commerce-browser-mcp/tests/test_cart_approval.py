"""Offline native Agent approval tests. No browser, bridge, or real cart actions."""
import importlib.util
import os
from pathlib import Path
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
spec = importlib.util.spec_from_file_location('cart_approval_server', ROOT / 'server.py')
server = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = server
with patch.dict(os.environ, {'BROWSER_MODE': 'extension', 'EXTENSION_BRIDGE_TOKEN': 'synthetic-test-token-' + 'x' * 32,
                             'ALLOW_ADD_TO_CART': 'true', 'ALLOW_STATE_CHANGING_ACTIONS': 'false', 'PYTHON_DOTENV_DISABLED': '1'}):
    spec.loader.exec_module(server)


class NativeApprovalTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.review = {'request_id': 'synthetic_request_0001', 'status': 'pending_confirmation', 'review_hash': 'a' * 64,
                       'selection': {'title': 'Synthetic jacket', 'url': 'https://detail.tmall.com/item.htm?id=123',
                                     'item_id': '123', 'color': '深蓝', 'size': 'M', 'quantity': 1, 'price': None}}
        self.service = SimpleNamespace(get_add_to_cart_review=AsyncMock(return_value=self.review),
                                       confirm_add_to_cart=AsyncMock(return_value={'status': 'attempted_unverified'}))
        self.patch = patch.object(server, 'service', self.service)
        self.patch.start()
        self.addCleanup(self.patch.stop)

    async def test_confirm_dispatches_bound_hash_once(self):
        result = await server.confirm_add_to_cart(self.review['request_id'])
        self.assertEqual(result['status'], 'attempted_unverified')
        self.service.confirm_add_to_cart.assert_awaited_once_with(self.review['request_id'], 'a' * 64)

    async def test_terminal_request_does_not_dispatch(self):
        for status in ('expired', 'cancelled', 'attempted_unverified', 'unknown', 'not_found'):
            self.service.get_add_to_cart_review.return_value = {'status': status}
            self.assertEqual((await server.confirm_add_to_cart(self.review['request_id']))['status'], status)
        self.service.confirm_add_to_cart.assert_not_awaited()

    async def test_execution_response_loss_is_unknown_not_retry(self):
        self.service.confirm_add_to_cart.side_effect = TimeoutError('synthetic transport loss')
        result = await server.confirm_add_to_cart(self.review['request_id'])
        self.assertEqual(result['status'], 'unknown')
        self.service.confirm_add_to_cart.assert_awaited_once()

    async def test_tool_schema_excludes_model_approval_and_internal_hash(self):
        tools = {t.name: t for t in await server.mcp.list_tools()}
        confirm = tools['confirm_add_to_cart']
        self.assertEqual(set(confirm.inputSchema['properties']), {'request_id'})
        self.assertFalse(confirm.annotations.readOnlyHint)
        self.assertFalse(server.service.taobao_browser.bridge.server if hasattr(server.service, 'taobao_browser') else False)


if __name__ == '__main__':
    unittest.main()
