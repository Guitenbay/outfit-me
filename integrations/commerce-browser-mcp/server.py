from __future__ import annotations

import sys
import os
from pathlib import Path
from typing import Any

from dotenv import load_dotenv

PROJECT_ROOT = Path(__file__).resolve().parent
load_dotenv(PROJECT_ROOT / ".env")

playwright_browsers_path = os.getenv("PLAYWRIGHT_BROWSERS_PATH", "").strip()
if playwright_browsers_path:
    browsers_path = Path(playwright_browsers_path)
    if not browsers_path.is_absolute():
        os.environ["PLAYWRIGHT_BROWSERS_PATH"] = str(PROJECT_ROOT / browsers_path)

from mcp.server.fastmcp import FastMCP
from pydantic import StrictInt, StrictStr

from jd_taobao_mcp.config import Settings
from jd_taobao_mcp.service import ShoppingBrowserService

settings = Settings.from_env()
service = ShoppingBrowserService(settings)

mcp = FastMCP(
    "JD-Taobao-Browser",
    instructions=(
        "用于在用户本机可见浏览器中浏览京东、淘宝和天猫，并提取页面与商品数据。"
        "必须让用户自己完成扫码、密码、验证码和安全验证。"
        "默认只读：不得购买、结算、支付、关注、收藏、删除或修改账户信息。"
        "仅 ALLOW_ADD_TO_CART 开启时可 prepare_add_to_cart；用户须手选精确颜色尺码数量，"
        "prepare 只准备，confirm_add_to_cart 在 Agent 内通过宿主原生确认后直接操作网页，"
        "无需再次打开扩展确认；也可选用扩展弹窗确认。同一请求最多尝试一次，"
        "工具调用许可不是具体商品确认，不重试未知结果。"
        "优先使用 search_products 和 get_product_detail；只有页面结构变化时才使用通用点击工具。"
        "商品详情输出有硬约束：必须包含 product_url、product_parameters、good_reviews、bad_reviews "
        "及对应 status 字段；good_reviews 目标最多 5 条，bad_reviews 目标最多 2 条；"
        "缺失或不足时必须用空数组或不足目标条数和 status.reason 说明原因。"
        "不要高频、大规模采集。元素 ref 在页面变化后会失效，点击或导航后应重新调用 list_page_elements。"
    ),
)


@mcp.tool()
async def browser_start() -> dict[str, Any]:
    """启动浏览器后端；extension 模式等待用户在扩展中授权当前标签页。"""
    return await service.taobao_browser.start()


@mcp.tool()
async def browser_status() -> dict[str, Any]:
    """查看浏览器或已授权标签页的连接状态。"""
    return {
        "jd": await service.jd_browser.status(),
        "taobao": await service.taobao_browser.status(),
    }


@mcp.tool()
async def open_login(platform: str) -> dict[str, Any]:
    """打开京东或淘宝登录页，由用户在浏览器窗口中手动登录。

    Args:
        platform: jd 或 taobao。
    """
    platform = platform.strip().lower()
    return await service._browser_for_platform(platform).open_login(platform)


@mcp.tool()
async def check_login(platform: str) -> dict[str, Any]:
    """根据页面与 Cookie 名称判断京东或淘宝是否可能已登录，不返回 Cookie 值。

    Args:
        platform: jd 或 taobao。
    """
    platform = platform.strip().lower()
    return await service._browser_for_platform(platform).check_login(platform)


@mcp.tool()
async def open_url(url: str) -> dict[str, Any]:
    """打开京东、淘宝或天猫 URL。其他域名会被拒绝。"""
    from jd_taobao_mcp.service import platform_from_url

    platform = platform_from_url(url)
    return await service._browser_for_platform(platform).navigate(url)


@mcp.tool()
async def search_products(
    platform: str,
    keyword: str,
    max_results: int = 20,
    min_price: float | None = None,
    max_price: float | None = None,
    sort: str = "default",
    include_details: bool = True,
) -> dict[str, Any]:
    """搜索京东或淘宝商品并返回结构化列表；默认逐个补详情硬约束字段。

    Args:
        platform: jd 或 taobao。
        keyword: 商品关键词。
        max_results: 最多返回数量；受环境变量上限约束。
        min_price: 可选最低价格，本地过滤。
        max_price: 可选最高价格，本地过滤。
        sort: default、price_asc 或 price_desc；排序在提取结果上本地完成。
        include_details: 默认 true。逐个打开结果商品页，并强制每个商品返回
            product_url、product_parameters、最多 5 条 good_reviews、最多 2 条 bad_reviews 及对应 status 字段。
    """
    return await service.search_products(
        platform=platform,
        keyword=keyword,
        max_results=max_results,
        min_price=min_price,
        max_price=max_price,
        sort=sort,
        include_details=include_details,
    )


@mcp.tool()
async def get_product_detail(url: str) -> dict[str, Any]:
    """打开商品页并提取详情；硬约束返回产品链接、产品参数、最多 5 条好评、最多 2 条差评及 status。"""
    return await service.get_product_detail(url)


@mcp.tool(annotations={"readOnlyHint": False, "destructiveHint": True, "idempotentHint": True, "openWorldHint": True})
async def prepare_add_to_cart(
    request_id: StrictStr, expected_product_url: StrictStr, expected_item_id: StrictStr,
    color: StrictStr, size: StrictStr, quantity: StrictInt,
) -> dict[str, Any]:
    """准备淘宝/天猫单次加购，立即返回待人工确认；不会自动选择 SKU 或点击。

    默认关闭，仅 extension 模式。request_id 为 16–64 位 ASCII 唯一标识，重试必须复用；
    URL 必须为单个数字 id 的商品页且与 expected_item_id 相同。颜色、尺码和 1–10 整数数量
    必须与用户手动选择的 DOM 证据完全一致。不支持的页面 fail closed。
    准备后调用 confirm_add_to_cart 在 Agent 内原生确认，或使用 Chrome 扩展弹窗确认，
    才尝试一次；两种确认方式二选一，不要求重复点击。未核验结果不得重试。
    """
    return await service.prepare_add_to_cart(
        request_id, expected_product_url, expected_item_id, color, size, quantity
    )


@mcp.tool(annotations={"readOnlyHint": False, "destructiveHint": True, "idempotentHint": True, "openWorldHint": True})
async def confirm_add_to_cart(request_id: StrictStr) -> dict[str, Any]:
    """在 Agent 内获得用户确认后，直接单次操作网页加入购物车。

    必须先 prepare_add_to_cart。无须 Chrome 扩展弹窗二次确认。
    根据准备阶段锁定的不可伪造 review_hash 在已授权网页上执行单次点击加购。
    返回 attempted_unverified 仍不代表平台确认成功。
    """
    review = await service.get_add_to_cart_review(request_id)
    if review.get("status") != "pending_confirmation":
        return review
    try:
        return await service.confirm_add_to_cart(request_id, review["review_hash"])
    except Exception as exc:
        return {
            "request_id": request_id,
            "status": "unknown",
            "reason": f"confirmation_execution_result_unknown_do_not_retry: {exc}"
        }


@mcp.tool(annotations={"readOnlyHint": False, "destructiveHint": False, "idempotentHint": True, "openWorldHint": True})
async def select_product_variant(dimension: StrictStr, label: StrictStr) -> dict[str, Any]:
    """在当前已授权淘宝/天猫商品页切换颜色或尺码，只点击名称完全匹配的唯一选项。

    仅作用于已识别的商品规格面板；不选择数量、不加入购物车、不购买。
    dimension 为 color 或 size。文本必须与页面选项完全一致（已识别的加购热度、
    尺码建议后缀会被忽略）。缺失、多个匹配或禁用选项时停止，不做模糊匹配。
    """
    return await service.select_variant(dimension.strip(), label)

@mcp.tool(annotations={"readOnlyHint": True, "destructiveHint": False, "idempotentHint": True, "openWorldHint": True})
async def get_add_to_cart_status(request_id: str) -> dict[str, Any]:
    """只读查询单次加购意图；attempted_unverified/unknown 均不代表服务器加购成功，不自动重试。"""
    return await service.get_add_to_cart_status(request_id)


@mcp.tool()
async def page_snapshot(max_chars: int | None = None, platform: str | None = None) -> dict[str, Any]:
    """获取指定平台快照；省略 platform 使用最近选择的平台（默认淘宝）。"""
    browser = service._browser_for_platform(platform) if platform else service.browser
    return await browser.snapshot(max_chars=max_chars)


@mcp.tool()
async def extract_current_page(platform: str | None = None) -> dict[str, Any]:
    """对指定平台或最近选择的页面执行快照和商品字段提取。"""
    return await service.extract_current_page(platform)


@mcp.tool()
async def list_page_elements(limit: int = 80, platform: str | None = None) -> dict[str, Any]:
    """列出指定平台或最近选择页面的只读元素及短期 ref。"""
    browser = service._browser_for_platform(platform) if platform else service.browser
    return await browser.list_elements(limit=limit)


@mcp.tool()
async def click_page_element(ref: str) -> dict[str, Any]:
    """点击 list_page_elements 返回的 ref。

    默认阻止购买、结算、支付、购物车、收藏、关注、删除、地址变更等动作。
    """
    return await service.browser.click(ref)


@mcp.tool()
async def type_into_element(
    ref: str, text: str, press_enter: bool = False
) -> dict[str, Any]:
    """向当前页面的普通输入框输入文字，可选择按回车。

    密码、验证码、银行卡、身份证和支付认证字段会被拒绝。
    """
    return await service.browser.type_text(ref, text, press_enter=press_enter)


@mcp.tool()
async def scroll_page(direction: str = "down", amount: int = 900, platform: str | None = None) -> dict[str, Any]:
    """向上或向下滚动指定平台或最近选择页面。"""
    browser = service._browser_for_platform(platform) if platform else service.browser
    return await browser.scroll(direction=direction, amount=amount)


@mcp.tool()
async def go_back() -> dict[str, Any]:
    """返回浏览器历史中的上一页。"""
    return await service.browser.go_back()


@mcp.tool()
async def take_screenshot(full_page: bool = False) -> dict[str, Any]:
    """将当前页面截图保存到本地 artifacts 目录。"""
    return await service.browser.screenshot(full_page=full_page)


@mcp.tool()
async def browser_close(platform: str | None = None) -> dict[str, Any]:
    """断开指定平台；省略 platform 关闭全部。extension 不关闭用户标签页。"""
    if platform is not None:
        return await service._browser_for_platform(platform).close()
    if settings.browser_mode == "extension":
        await service.taobao_browser.bridge.stop()
        return {"success": True, "state": "detached"}
    results = {
        "jd": await service.jd_browser.close(),
        "taobao": await service.taobao_browser.close(),
    }
    return {"success": True, "results": results}


def main() -> None:
    # Start the loopback bridge with the server so a fresh host reconnect is
    # immediately usable; previous sessions' listeners die with their process.
    if settings.browser_mode == "extension":
        try:
            service.taobao_browser.bridge.start()
        except OSError as exc:
            # Port already held (often an orphaned older session): keep serving and
            # let browser_start()/browser_status() surface the conflict honestly.
            print(f"extension bridge not started on port {settings.extension_bridge_port}: {exc}", file=sys.stderr)
    if "--http" in sys.argv:
        mcp.run(transport="streamable-http")
    else:
        mcp.run(transport="stdio")


if __name__ == "__main__":
    main()
