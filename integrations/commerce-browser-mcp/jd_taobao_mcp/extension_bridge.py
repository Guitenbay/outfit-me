from __future__ import annotations

import asyncio
import hmac
import json
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any
from urllib.parse import urlparse

from .config import Settings
from .safety import SafetyError, ensure_extension_allowed_url, extension_platform, page_requires_user_verification


class ExtensionBridge:
    """One loopback transport, two independent, ephemeral explicit grants."""

    HEARTBEAT_SECONDS = 20
    MAX_PENDING = 8

    def __init__(self, settings: Settings):
        self.settings = settings
        self.server = None
        self.lock = threading.RLock()
        self.grants: dict[str, dict] = {}
        self.pending: dict[str, dict] = {}
        self.last_revoke_reason: dict[str, str] = {}

    def revoke(self, platform, reason='grant_revoked'):
        with self.lock:
            grant = self.grants.pop(platform, None)
            if grant:
                grant['revoke_reason'] = reason
                self.last_revoke_reason[platform] = reason
                for key, entry in list(self.pending.items()):
                    if entry['command']['client_id'] == grant['client_id']:
                        del self.pending[key]

    def live(self, platform):
        with self.lock:
            grant = self.grants.get(platform)
            if grant and time.monotonic() - grant['seen'] >= self.HEARTBEAT_SECONDS:
                self.revoke(platform, 'heartbeat_expired')
                grant = None
            return grant

    def dispatch(self, path, client, body=None):
        with self.lock:
            now = time.monotonic()
            for key, entry in list(self.pending.items()):
                if entry['deadline'] <= now:
                    del self.pending[key]
            if path == '/v1/attach':
                url = str(body.get('url', ''))
                platform = extension_platform(url)
                if body.get('platform') != platform or not isinstance(body.get('client_id'), str) or not 16 <= len(body['client_id']) <= 128:
                    raise ValueError('invalid_grant')
                self.revoke(platform, 'grant_replaced')
                self.last_revoke_reason.pop(platform, None)
                self.grants[platform] = dict(client_id=body['client_id'], url=url, title=str(body.get('title', ''))[:500], seen=now)
                return {'success': True, 'allow_add_to_cart': self.settings.allow_add_to_cart and platform == 'taobao'}
            platform = next((p for p in list(self.grants) if (g := self.live(p)) and hmac.compare_digest(g['client_id'], client)), None)
            if platform is None:
                raise ValueError('tab_not_authorized')
            grant = self.grants[platform]
            grant['seen'] = now
            if path == '/v1/detach':
                # Never echo arbitrary extension text, URLs or credentials as diagnostics.
                reason = body.get('reason')
                allowed = {'selected_tab_left_public_shopping_scope', 'navigation_timeout_unknown_state',
                           'command_expired', 'tab_closed', 'bridge_connection_failed', 'user_detached'}
                self.revoke(platform, reason if isinstance(reason, str) and reason in allowed else 'grant_revoked')
                return {'success': True}
            if path == '/v1/heartbeat':
                return {'success': True}
            if path == '/v1/commands/next':
                for entry in self.pending.values():
                    if entry['command']['client_id'] == client and not entry['sent']:
                        entry['sent'] = True
                        return {'command': entry['command']}
                return {'command': None}
            if path in {'/v1/claim', '/v1/results'}:
                entry = self.pending.get(str(body.get('request_id', '')))
                if not entry or entry['command']['client_id'] != client or not entry['sent']:
                    raise ValueError('expired_or_unknown_command')
                if path == '/v1/claim':
                    if entry['claimed']:
                        raise ValueError('already_claimed')
                    entry['claimed'] = True
                    return {'success': True}
                if not entry['claimed'] or entry['result'] is not None:
                    raise ValueError('unexpected_result')
                result = body.get('result')
                if isinstance(result, dict) and result.get('url'):
                    if extension_platform(result['url']) != platform:
                        raise SafetyError('wrong_platform')
                    grant.update(url=result['url'], title=str(result.get('title', ''))[:500])
                entry['result'] = body
                return {'success': True}
            raise ValueError('unknown_endpoint')

    def start(self):
        with self.lock:
            if self.server:
                return
            owner = self

            class Handler(BaseHTTPRequestHandler):
                def do_GET(self):
                    self.handle_request(False)

                def do_POST(self):
                    self.handle_request(True)

                def handle_request(self, post):
                    expected = ('Bearer ' + owner.settings.extension_bridge_token).encode()
                    supplied = self.headers.get('Authorization', '').encode()
                    if not hmac.compare_digest(expected, supplied):
                        self.reply(401, {'error': 'unauthorized'})
                        return
                    try:
                        body = None
                        if post:
                            length = int(self.headers.get('Content-Length', '0'))
                            if not 0 < length <= 1_000_000:
                                raise ValueError('invalid_body_size')
                            self.connection.settimeout(5)
                            body = json.loads(self.rfile.read(length))
                            if not isinstance(body, dict):
                                raise ValueError('invalid_body')
                        path = urlparse(self.path).path
                        if (not post) != (path == '/v1/commands/next'):
                            raise ValueError('invalid_method')
                        result = owner.dispatch(path, self.headers.get('X-Extension-Client', ''), body)
                        self.reply(200, result)
                    except (ValueError, SafetyError, TypeError, OSError):
                        self.reply(409, {'error': 'invalid_or_expired_request'})

                def reply(self, status, value):
                    data = json.dumps(value, ensure_ascii=False).encode()
                    self.send_response(status)
                    self.send_header('Content-Type', 'application/json')
                    self.send_header('Content-Length', str(len(data)))
                    self.end_headers()
                    self.wfile.write(data)

                def log_message(self, *args):
                    pass

            # IPv4 loopback is also used by the extension; never bind a wildcard.
            self.server = ThreadingHTTPServer(('127.0.0.1', self.settings.extension_bridge_port), Handler)
            self.server.daemon_threads = True
            threading.Thread(target=self.server.serve_forever, daemon=True).start()

    async def stop(self):
        with self.lock:
            for platform in list(self.grants):
                self.revoke(platform)
            server, self.server = self.server, None
        if server:
            await asyncio.to_thread(server.shutdown)
            server.server_close()

    async def request(self, platform, operation, payload, timeout):
        self.start()
        request_id = uuid.uuid4().hex
        with self.lock:
            grant = self.live(platform)
            if not grant:
                raise RuntimeError(f'{platform}: 请在扩展中重新授权目标标签页。')
            if len(self.pending) >= self.MAX_PENDING:
                raise RuntimeError('bridge_busy')
            command = dict(request_id=request_id, client_id=grant['client_id'], platform=platform,
                           operation=operation, payload=payload, expires_at=int((time.time() + timeout) * 1000))
            entry = dict(command=command, deadline=time.monotonic() + timeout, sent=False, claimed=False, result=None)
            self.pending[request_id] = entry
        try:
            while True:
                with self.lock:
                    if self.live(platform) is not grant:
                        raise RuntimeError(grant.get('revoke_reason', 'grant_revoked'))
                    if time.monotonic() >= entry['deadline']:
                        raise TimeoutError(f'command_timeout: {operation}')
                    if self.pending.get(request_id) is not entry:
                        raise RuntimeError('command_expired')
                    result = entry['result']
                if result is not None:
                    if not result.get('ok'):
                        raise RuntimeError(str(result.get('error', 'extension_error')))
                    if not isinstance(result.get('result'), dict):
                        raise RuntimeError('invalid_result')
                    return result['result']
                await asyncio.sleep(0.025)
        finally:
            with self.lock:
                self.pending.pop(request_id, None)


def _validate_cart_request_id(request_id):
    if (not isinstance(request_id, str) or not 16 <= len(request_id) <= 64
            or not request_id.isascii() or not all(c.isalnum() or c in '-_' for c in request_id)):
        raise ValueError('request_id_must_be_16_to_64_ASCII_identifier_characters')


class ExtensionBridgeController:
    def __init__(self, settings: Settings, platform='taobao', bridge=None):
        if settings.allow_state_changing_actions:
            raise ValueError('extension 模式不允许启用 ALLOW_STATE_CHANGING_ACTIONS')
        if platform not in {'jd', 'taobao'}:
            raise ValueError('invalid_platform')
        self.settings, self.platform = settings, platform
        self.bridge = bridge or ExtensionBridge(settings)
        self.lock = asyncio.Lock()

    async def start(self):
        self.bridge.start()
        return await self.status()

    async def status(self):
        with self.bridge.lock:
            grant = self.bridge.live(self.platform)
            return dict(success=True, mode='extension', platform=self.platform,
                        running=self.bridge.server is not None,
                        state='attached' if grant else ('awaiting_user_selection' if self.bridge.server else 'not_connected'),
                        current_url=grant['url'] if grant else '', title=grant['title'] if grant else '',
                        last_revoke_reason=self.bridge.last_revoke_reason.get(self.platform, ''))

    async def close(self):
        self.bridge.revoke(self.platform)
        return dict(success=True, platform=self.platform, state='detached', message='已撤销此平台授权；没有关闭标签页。')

    async def _request(self, operation, payload, timeout=None):
        async with self.lock:
            return await self.bridge.request(self.platform, operation, payload, timeout or self.settings.action_timeout_ms / 1000)

    def _cart_enabled(self):
        if not self.settings.allow_add_to_cart:
            raise SafetyError('ALLOW_ADD_TO_CART_disabled')
        if self.platform != 'taobao':
            raise SafetyError('JD_remains_read_only')

    async def prepare_add_to_cart(self, request_id, expected_product_url, expected_item_id, color, size, quantity):
        self._cart_enabled()
        _validate_cart_request_id(request_id)
        if extension_platform(expected_product_url) != 'taobao':
            raise SafetyError('Taobao_Tmall_product_required')
        url = urlparse(expected_product_url)
        from urllib.parse import parse_qs
        ids = parse_qs(url.query, keep_blank_values=True).get('id', [])
        if (url.hostname not in {'item.taobao.com', 'detail.tmall.com'} or url.path != '/item.htm'
                or len(ids) != 1 or not ids[0].isascii() or not ids[0].isdigit()
                or not isinstance(expected_item_id, str) or ids[0] != expected_item_id):
            raise ValueError('single_matching_numeric_item_id_required')
        if type(quantity) is not int or not 1 <= quantity <= 10:
            raise ValueError('quantity_must_be_integer_1_to_10')
        for label in (color, size):
            if not isinstance(label, str) or not label.strip() or len(label) > 100:
                raise ValueError('exact_nonempty_color_and_size_required')
        return await self._request('prepare_add_to_cart', {
            'request_id': request_id, 'expected_product_url': expected_product_url,
            'expected_item_id': expected_item_id, 'color': ' '.join(color.split()),
            'size': ' '.join(size.split()), 'quantity': quantity,
        })

    async def get_add_to_cart_status(self, request_id):
        self._cart_enabled()
        _validate_cart_request_id(request_id)
        return await self._request('get_add_to_cart_status', {'request_id': request_id})

    async def get_add_to_cart_review(self, request_id):
        """Internal snapshot review for native Agent elicitation, not an MCP tool."""
        self._cart_enabled()
        _validate_cart_request_id(request_id)
        return await self._request('review_add_to_cart', {'request_id': request_id})

    async def confirm_add_to_cart(self, request_id, review_hash):
        """Internal execution; caller must first obtain native user approval."""
        self._cart_enabled()
        _validate_cart_request_id(request_id)
        if (not isinstance(review_hash, str) or len(review_hash) != 64
                or any(c not in '0123456789abcdef' for c in review_hash)):
            raise ValueError('review_hash_must_be_64_lowercase_hex_characters')
        return await self._request('confirm_add_to_cart', {
            'request_id': request_id, 'review_hash': review_hash,
        })

    async def select_variant(self, dimension, label):
        """Bounded variant switch inside the recognized SKU panel; one chip click."""
        self._cart_enabled()
        if dimension not in ('color', 'size'):
            raise ValueError('dimension_must_be_color_or_size')
        if not isinstance(label, str) or not label.strip() or len(label) > 100:
            raise ValueError('exact_variant_label_required')
        return await self._request('select_variant', {
            'dimension': dimension, 'label': ' '.join(label.split()),
        })

    async def navigate(self, url):
        if extension_platform(url) != self.platform:
            raise SafetyError('wrong_platform')
        return await self._request('navigate', {'url': url}, self.settings.navigation_timeout_ms / 1000)

    async def snapshot(self, max_chars=None):
        result = await self._request('snapshot', {'max_chars': max_chars or self.settings.max_page_text_chars})
        result['requires_user_verification'] = page_requires_user_verification(str(result.get('text', '')), str(result.get('url', '')))
        return result

    async def extract_current_page(self):
        return await self._request('extract_product_basic', {})

    async def list_elements(self, limit=80):
        return await self._request('list_elements', {'limit': max(1, min(limit, 200))})

    async def click(self, ref):
        raise SafetyError('extension 模式禁止 DOM 点击；请使用已验证的商品/搜索 URL 导航或手动操作。')

    async def type_text(self, ref, text, press_enter=False):
        raise SafetyError('extension 模式禁止 DOM 输入/提交；请使用搜索 URL 或手动输入。')

    async def scroll(self, direction='down', amount=900):
        if direction not in {'up', 'down'}:
            raise ValueError('invalid_direction')
        return await self._request('scroll', {'direction': direction, 'amount': max(100, min(amount, 5000))})

    async def go_back(self):
        raise SafetyError('无法预先验证浏览器历史目标；请使用明确的安全 URL 或手动返回。')

    async def open_login(self, platform):
        return dict(success=False, requires_user_verification=True, message='请手动打开登录页并完成登录，然后回到商品/搜索页重新授权。')

    async def check_login(self, platform):
        snapshot = await self.snapshot(10000)
        text = snapshot.get('text', '')
        return dict(platform=self.platform, likely_logged_in=('退出' in text), current_url=snapshot.get('url', ''),
                    requires_user_verification=snapshot['requires_user_verification'], message='仅根据可见文本判断；不读取 Cookie。')

    async def screenshot(self, full_page=False):
        raise RuntimeError('extension 模式不提供截图。')
