from __future__ import annotations

import asyncio
from dataclasses import replace

import pytest

from jd_taobao_mcp.config import Settings
from jd_taobao_mcp.extension_bridge import ExtensionBridgeController
from jd_taobao_mcp.service import ShoppingBrowserService


def test_extension_mode_requires_strong_token(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("BROWSER_MODE", "extension")
    monkeypatch.setenv("EXTENSION_BRIDGE_TOKEN", "short")
    with pytest.raises(ValueError, match="32"):
        Settings.from_env()


def test_bridge_host_must_be_loopback(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("BROWSER_MODE", "extension")
    monkeypatch.setenv("EXTENSION_BRIDGE_TOKEN", "a" * 32)
    monkeypatch.setenv("EXTENSION_BRIDGE_HOST", "0.0.0.0")
    with pytest.raises(ValueError, match="回环"):
        Settings.from_env()


def test_extension_mode_uses_independent_controllers_and_no_profile_access(
    monkeypatch: pytest.MonkeyPatch, tmp_path
) -> None:
    monkeypatch.setenv("BROWSER_MODE", "extension")
    monkeypatch.setenv("EXTENSION_BRIDGE_TOKEN", "b" * 32)
    monkeypatch.setenv("BROWSER_PROFILE_DIR", str(tmp_path / "must-not-exist"))
    settings = Settings.from_env()
    service = ShoppingBrowserService(settings)
    assert service.jd_browser is not service.taobao_browser
    assert service.jd_browser.bridge is service.taobao_browser.bridge
    assert isinstance(service.browser, ExtensionBridgeController)
    assert not settings.profile_dir.exists()


def test_extension_mode_rejects_state_changing_override(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("BROWSER_MODE", "extension")
    monkeypatch.setenv("EXTENSION_BRIDGE_TOKEN", "c" * 32)
    settings = replace(Settings.from_env(), allow_state_changing_actions=True)
    with pytest.raises(ValueError, match="不允许"):
        ExtensionBridgeController(settings)


def test_persistent_remains_default(monkeypatch: pytest.MonkeyPatch) -> None:
    from jd_taobao_mcp.browser import BrowserController
    monkeypatch.delenv('BROWSER_MODE', raising=False)
    settings = Settings.from_env()
    assert settings.browser_mode == 'persistent'
    service = ShoppingBrowserService(settings)
    assert isinstance(service.jd_browser, BrowserController)
    assert isinstance(service.taobao_browser, BrowserController)
    assert service.jd_browser is not service.taobao_browser


def test_cart_default_off_and_platform_gates(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv('ALLOW_ADD_TO_CART', raising=False)
    monkeypatch.setenv('BROWSER_MODE', 'extension')
    monkeypatch.setenv('EXTENSION_BRIDGE_TOKEN', 'e' * 32)
    settings = Settings.from_env()
    assert settings.allow_add_to_cart is False
    service = ShoppingBrowserService(settings)
    args = ('synthetic_request_0001', 'https://item.taobao.com/item.htm?id=123', '123', '白色', 'M', 1)
    with pytest.raises(ValueError, match='disabled'):
        asyncio.run(service.prepare_add_to_cart(*args))
    with pytest.raises(ValueError, match='extension_mode'):
        asyncio.run(ShoppingBrowserService(replace(settings, browser_mode='persistent', allow_add_to_cart=True)).prepare_add_to_cart(*args))
    controller = ExtensionBridgeController(replace(settings, allow_add_to_cart=True), 'jd')
    with pytest.raises(Exception, match='JD_remains_read_only'):
        asyncio.run(controller.prepare_add_to_cart(*args))


def test_cart_validation_without_bridge(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv('BROWSER_MODE', 'extension')
    monkeypatch.setenv('EXTENSION_BRIDGE_TOKEN', 'f' * 32)
    controller = ExtensionBridgeController(replace(Settings.from_env(), allow_add_to_cart=True))
    for quantity in (True, '1', 1.5, 0, 11):
        with pytest.raises(ValueError, match='quantity'):
            asyncio.run(controller.prepare_add_to_cart('synthetic_request_0001', 'https://item.taobao.com/item.htm?id=123', '123', '白色', 'M', quantity))
    with pytest.raises(ValueError, match='numeric_item_id'):
        asyncio.run(controller.prepare_add_to_cart('synthetic_request_0001', 'https://item.taobao.com/item.htm?id=123&id=123', '123', '白色', 'M', 1))
    assert controller.bridge.server is None


def test_internal_cart_review_and_confirm_forward_only_bound_parameters(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv('BROWSER_MODE', 'extension')
    monkeypatch.setenv('EXTENSION_BRIDGE_TOKEN', 'g' * 32)
    service = ShoppingBrowserService(replace(Settings.from_env(), allow_add_to_cart=True))
    controller = service.taobao_browser
    calls = []

    async def request(platform, operation, payload, timeout):
        calls.append((platform, operation, payload, timeout))
        return {'request_id': payload['request_id'], 'status': 'pending_confirmation'}

    monkeypatch.setattr(controller.bridge, 'request', request)
    request_id, review_hash = 'synthetic_request_0001', 'abcdef01' * 8

    async def exercise():
        await service.get_add_to_cart_review(request_id)
        await service.confirm_add_to_cart(request_id, review_hash)
        await service.get_add_to_cart_status(request_id)

    asyncio.run(exercise())
    assert calls == [
        ('taobao', 'review_add_to_cart', {'request_id': request_id}, service.settings.action_timeout_ms / 1000),
        ('taobao', 'confirm_add_to_cart', {'request_id': request_id, 'review_hash': review_hash}, service.settings.action_timeout_ms / 1000),
        ('taobao', 'get_add_to_cart_status', {'request_id': request_id}, service.settings.action_timeout_ms / 1000),
    ]
    assert controller.bridge.server is None


def test_internal_cart_validation_and_gates_without_transport(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from jd_taobao_mcp.safety import SafetyError

    monkeypatch.setenv('BROWSER_MODE', 'extension')
    monkeypatch.setenv('EXTENSION_BRIDGE_TOKEN', 'h' * 32)
    settings = replace(Settings.from_env(), allow_add_to_cart=True)
    service = ShoppingBrowserService(settings)
    controller = service.taobao_browser
    request_id, review_hash = 'synthetic_request_0001', 'abcdef01' * 8

    async def forbidden(*args, **kwargs):
        raise AssertionError('validation must not reach the transport')

    monkeypatch.setattr(controller.bridge, 'request', forbidden)
    for invalid_id in ('short', request_id + '\n', '非' * 16, None, 123):
        with pytest.raises(ValueError, match='request_id'):
            asyncio.run(service.get_add_to_cart_review(invalid_id))
        with pytest.raises(ValueError, match='request_id'):
            asyncio.run(service.confirm_add_to_cart(invalid_id, review_hash))
    for invalid_hash in (None, True, 64, '', 'a' * 63, 'a' * 65, 'A' * 64, 'g' * 64, 'a' * 64 + '\n', 'ａ' * 64):
        with pytest.raises(ValueError, match='64_lowercase_hex'):
            asyncio.run(service.confirm_add_to_cart(request_id, invalid_hash))
    for gated_settings, reason in (
        (replace(settings, allow_add_to_cart=False), 'disabled'),
        (replace(settings, browser_mode='persistent'), 'extension_mode'),
    ):
        gated = ShoppingBrowserService(gated_settings)
        for method, args in (
            ('get_add_to_cart_review', (request_id,)),
            ('confirm_add_to_cart', (request_id, review_hash)),
        ):
            with pytest.raises(ValueError, match=reason):
                asyncio.run(getattr(gated, method)(*args))
    for gated_controller, reason in (
        (ExtensionBridgeController(replace(settings, allow_add_to_cart=False)), 'disabled'),
        (ExtensionBridgeController(settings, 'jd'), 'JD_remains_read_only'),
    ):
        with pytest.raises(SafetyError, match=reason):
            asyncio.run(gated_controller.get_add_to_cart_review(request_id))
        with pytest.raises(SafetyError, match=reason):
            asyncio.run(gated_controller.confirm_add_to_cart(request_id, review_hash))
        assert gated_controller.bridge.server is None
    assert controller.bridge.server is None


def test_bridge_has_no_direct_confirmation_endpoint(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv('BROWSER_MODE', 'extension')
    monkeypatch.setenv('EXTENSION_BRIDGE_TOKEN', 'i' * 32)
    bridge = ExtensionBridgeController(replace(Settings.from_env(), allow_add_to_cart=True)).bridge
    client = 'synthetic_client_0001'
    bridge.dispatch('/v1/attach', '', {
        'platform': 'taobao', 'client_id': client, 'url': 'https://item.taobao.com/item.htm?id=123',
    })
    with pytest.raises(ValueError, match='unknown_endpoint'):
        bridge.dispatch('/v1/confirm_add_to_cart', client, {
            'request_id': 'synthetic_request_0001', 'review_hash': 'a' * 64, 'approved': True,
        })
    assert not bridge.pending
    assert bridge.server is None


def test_status_does_not_start_chrome(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("BROWSER_MODE", "extension")
    monkeypatch.setenv("EXTENSION_BRIDGE_TOKEN", "d" * 32)
    settings = Settings.from_env()
    controller = ExtensionBridgeController(settings)
    status = asyncio.run(controller.status())
    assert status["state"] == "not_connected"
    assert status["mode"] == "extension"
