import asyncio
import time
from dataclasses import replace

import pytest

from jd_taobao_mcp.config import Settings
from jd_taobao_mcp.extension_bridge import ExtensionBridge, ExtensionBridgeController
from jd_taobao_mcp.safety import SafetyError, ensure_extension_allowed_url


def setup():
    settings = replace(Settings.from_env(), extension_bridge_token='test-only-' * 4, allow_state_changing_actions=False)
    bridge = ExtensionBridge(settings)
    bridge.start = lambda: None  # Never bind the user's live bridge port.
    for platform, url in [('jd', 'https://www.jd.com/index.html'), ('taobao', 'https://www.taobao.com/')]:
        bridge.dispatch('/v1/attach', '', dict(platform=platform, client_id=platform * 16, url=url))
    return bridge


def test_dual_attach_disconnect_and_expiry():
    b = setup()
    b.dispatch('/v1/detach', 'jd' * 16, {})
    assert b.live('jd') is None
    assert b.live('taobao')
    b.grants['taobao']['seen'] -= 21
    with pytest.raises(ValueError):
        b.dispatch('/v1/heartbeat', 'taobao' * 16, {})
    assert b.live('taobao') is None


@pytest.mark.parametrize('reason', [
    'selected_tab_left_public_shopping_scope', 'navigation_timeout_unknown_state',
    'command_expired', 'tab_closed', 'bridge_connection_failed', 'user_detached',
])
def test_revocation_preserves_bounded_reason_and_cleans_pending(reason):
    async def scenario():
        b = setup()
        task = asyncio.create_task(b.request('taobao', 'navigate', {}, 1))
        await asyncio.sleep(.01)
        b.dispatch('/v1/detach', 'taobao' * 16, {'reason': reason})
        with pytest.raises(RuntimeError, match=f'^{reason}$'):
            await task
        assert not b.pending
        status = await ExtensionBridgeController(b.settings, 'taobao', b).status()
        assert status['last_revoke_reason'] == reason
        assert b.live('jd')
    asyncio.run(scenario())


def test_unknown_detach_reason_is_not_echoed():
    b = setup()
    b.dispatch('/v1/detach', 'jd' * 16, {'reason': 'arbitrary private page text'})
    assert b.last_revoke_reason['jd'] == 'grant_revoked'


def test_polling_renews_lease_without_heartbeat(monkeypatch):
    import jd_taobao_mcp.extension_bridge as module
    clock = [100.0]
    monkeypatch.setattr(module.time, 'monotonic', lambda: clock[0])
    b = setup()
    grant = b.grants['taobao']
    for _ in range(200):
        clock[0] += .3
        assert b.dispatch('/v1/commands/next', 'taobao' * 16) == {'command': None}
    assert b.live('taobao') is grant
    assert 'taobao' not in b.last_revoke_reason


def test_expiry_is_terminal_until_explicit_attach(monkeypatch):
    import jd_taobao_mcp.extension_bridge as module
    clock = [100.0]
    monkeypatch.setattr(module.time, 'monotonic', lambda: clock[0])
    b = setup()
    clock[0] += b.HEARTBEAT_SECONDS
    for path, body in [('/v1/heartbeat', {}), ('/v1/commands/next', None),
                       ('/v1/results', {'request_id': 'old', 'ok': True, 'result': {}})]:
        with pytest.raises(ValueError, match='tab_not_authorized'):
            b.dispatch(path, 'taobao' * 16, body)
        assert b.live('taobao') is None
        assert b.last_revoke_reason['taobao'] == 'heartbeat_expired'
    status = asyncio.run(ExtensionBridgeController(b.settings, 'taobao', b).status())
    assert status['state'] != 'attached'
    b.dispatch('/v1/attach', '', dict(platform='taobao', client_id='new-explicit-grant',
                                   url='https://www.taobao.com/'))
    assert b.live('taobao')['client_id'] == 'new-explicit-grant'
    assert 'taobao' not in b.last_revoke_reason


def test_successful_navigation_result_renews_lease(monkeypatch):
    import jd_taobao_mcp.extension_bridge as module
    clock = [100.0]
    monkeypatch.setattr(module.time, 'monotonic', lambda: clock[0])

    async def scenario():
        b = setup()
        task = asyncio.create_task(b.request('taobao', 'navigate', {}, 45))
        await asyncio.sleep(0)
        command = b.dispatch('/v1/commands/next', 'taobao' * 16)['command']
        b.dispatch('/v1/claim', 'taobao' * 16, command)
        clock[0] += 19
        result = {'url': 'https://item.taobao.com/item.htm?id=1', 'success': True}
        b.dispatch('/v1/results', 'taobao' * 16,
                   dict(request_id=command['request_id'], ok=True, result=result))
        assert await task == result
        assert b.grants['taobao']['seen'] == clock[0]
        assert (await ExtensionBridgeController(b.settings, 'taobao', b).status())['state'] == 'attached'
        assert not b.pending
    asyncio.run(scenario())


@pytest.mark.parametrize('final_url, allowed', [
    ('https://www.taobao.com/wow/z/tbhome/pcsem/alimama?keyword=shirt', True),
    ('https://item.taobao.com/item.htm?id=1', True),
    ('https://www.taobao.com/wow/z/tbhome/pcsem/unknown', False),
    ('https://cart.taobao.com/cart.htm', False),
    ('https://www.taobao.com/wow/z/tbhome/pcsem/alimama?action=buy', False),
    ('https://www.taobao.com/wow/z/tbhome/pcsem/alimama?next=https%3A%2F%2Fevil.test%2F', False),
])
def test_landing_attach_and_navigation_results_validate_actual_url(final_url, allowed):
    async def scenario():
        b = setup()
        landing = 'https://www.taobao.com/wow/z/tbhome/pcsem/alimama?keyword=shirt'
        b.dispatch('/v1/attach', '', dict(platform='taobao', client_id='landing-test-grant', url=landing))
        task = asyncio.create_task(b.request('taobao', 'navigate', {'url': landing}, 1))
        try:
            await asyncio.sleep(0)
            command = b.dispatch('/v1/commands/next', 'landing-test-grant')['command']
            b.dispatch('/v1/claim', 'landing-test-grant', command)
            body = dict(request_id=command['request_id'], ok=True,
                        result={'url': final_url, 'success': True})
            if allowed:
                b.dispatch('/v1/results', 'landing-test-grant', body)
                assert (await task)['url'] == final_url
                assert b.grants['taobao']['url'] == final_url
            else:
                with pytest.raises(SafetyError):
                    b.dispatch('/v1/results', 'landing-test-grant', body)
                assert b.grants['taobao']['url'] == landing
                assert not task.done()
        finally:
            if not task.done():
                task.cancel()
                with pytest.raises(asyncio.CancelledError):
                    await task
        assert not b.pending
    asyncio.run(scenario())

def test_heartbeat_expiry_and_command_timeout_are_distinct():
    async def scenario():
        b = setup()
        task = asyncio.create_task(b.request('jd', 'navigate', {}, 1))
        await asyncio.sleep(.01)
        b.grants['jd']['seen'] -= 21
        with pytest.raises(RuntimeError, match='^heartbeat_expired$'):
            await task
        assert not b.pending
        with pytest.raises(TimeoutError, match='command_timeout: navigate'):
            await b.request('taobao', 'navigate', {}, .02)
        assert b.live('taobao')
        assert not b.pending
    asyncio.run(scenario())


def test_request_claim_result_cleanup_and_nonblocking():
    async def scenario():
        b = setup()
        task = asyncio.create_task(b.request('jd', 'snapshot', {}, 1))
        await asyncio.sleep(.01)
        command = b.dispatch('/v1/commands/next', 'jd' * 16)['command']
        assert command['platform'] == 'jd'
        with pytest.raises(ValueError):
            b.dispatch('/v1/claim', 'taobao' * 16, command)
        b.dispatch('/v1/claim', 'jd' * 16, command)
        with pytest.raises(ValueError):
            b.dispatch('/v1/claim', 'jd' * 16, command)
        b.dispatch('/v1/results', 'jd' * 16, dict(request_id=command['request_id'], ok=True, result={'url':'https://www.jd.com/'}))
        assert (await task)['url'] == 'https://www.jd.com/'
        assert not b.pending
        with pytest.raises(ValueError):
            b.dispatch('/v1/results', 'jd' * 16, command)
    asyncio.run(scenario())


def test_timeout_cancel_replace_and_bounded_pending():
    async def scenario():
        b=setup()
        with pytest.raises(TimeoutError):
            await b.request('jd','snapshot',{},.02)
        assert not b.pending
        task=asyncio.create_task(b.request('jd','snapshot',{},1))
        await asyncio.sleep(.01)
        task.cancel()
        with pytest.raises(asyncio.CancelledError): await task
        assert not b.pending
        task=asyncio.create_task(b.request('jd','snapshot',{},1))
        await asyncio.sleep(.01)
        b.dispatch('/v1/attach','',dict(platform='jd',client_id='replacement-grant',url='https://www.jd.com/'))
        with pytest.raises(RuntimeError): await task
        assert not b.pending
        b.MAX_PENDING=0
        with pytest.raises(RuntimeError,match='busy'): await b.request('jd','snapshot',{},1)
    asyncio.run(scenario())


def test_http_auth_constant_time_and_invalid_body(monkeypatch):
    import io
    import jd_taobao_mcp.extension_bridge as module
    handlers = []
    class FakeServer:
        def __init__(self, address, handler): handlers.append(handler)
        def serve_forever(self): pass
    monkeypatch.setattr(module, 'ThreadingHTTPServer', FakeServer)
    settings = replace(Settings.from_env(), extension_bridge_token='test-only-' * 4)
    b = ExtensionBridge(settings)
    b.start()
    comparisons = []
    real_compare = module.hmac.compare_digest
    def compare(a, c):
        comparisons.append(True)
        return real_compare(a, c)
    monkeypatch.setattr(module.hmac, 'compare_digest', compare)
    handler = object.__new__(handlers[0])
    replies = []
    handler.reply = lambda status, body: replies.append(status)
    handler.headers = {'Authorization': 'Bearer incorrect'}
    handler.handle_request(False)
    assert replies == [401] and comparisons
    handler.headers = {'Authorization': 'Bearer ' + settings.extension_bridge_token, 'Content-Length': '2'}
    handler.rfile = io.BytesIO(b'[]')
    handler.connection = type('Connection', (), {'settimeout': lambda self, timeout: None})()
    handler.handle_request(True)
    assert replies[-1] == 409


def test_heartbeat_during_navigation_and_action_denial():
    b=setup()
    b.grants['jd']['seen']-=19
    b.dispatch('/v1/heartbeat','jd'*16,{})
    assert b.live('jd')
    c=ExtensionBridgeController(b.settings,'jd',b)
    for operation in [c.click('x'), c.type_text('x','abc'), c.go_back()]:
        with pytest.raises(SafetyError): asyncio.run(operation)


@pytest.mark.parametrize('url',[
    'https://i.taobao.com/my_itaobao','https://passport.jd.com/new/login.aspx',
    'https://www.jd.com/account','https://item.jd.com/1.html?action=buy',
    'http://item.jd.com/1.html','https://user:pass@item.jd.com/1.html',
    'https://www.taobao.com/%61ccount','https://www.taobao.com/?redirect=https://cart.taobao.com/',
])
def test_fail_closed_public_routes(url):
    with pytest.raises(SafetyError): ensure_extension_allowed_url(url)
