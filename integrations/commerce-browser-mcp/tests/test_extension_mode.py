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


def test_status_does_not_start_chrome(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("BROWSER_MODE", "extension")
    monkeypatch.setenv("EXTENSION_BRIDGE_TOKEN", "d" * 32)
    settings = Settings.from_env()
    controller = ExtensionBridgeController(settings)
    status = asyncio.run(controller.status())
    assert status["state"] == "not_connected"
    assert status["mode"] == "extension"
