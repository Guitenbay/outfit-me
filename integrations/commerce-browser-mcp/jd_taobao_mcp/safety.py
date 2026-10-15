from __future__ import annotations

import re
from dataclasses import dataclass
from urllib.parse import urlparse


_ALLOWED_ROOT_DOMAINS = (
    "jd.com",
    "360buy.com",
    "taobao.com",
    "tmall.com",
)

_BLOCKED_SCHEMES = {"file", "ftp", "data", "javascript", "chrome", "edge"}

# MCP 的模型参数不能替代真实用户确认，因此默认直接阻止可能产生账户或交易状态变化的动作。
_STATE_CHANGING_PATTERNS = (
    r"立即购买",
    r"购买",
    r"加入购物车",
    r"购物车",
    r"提交订单",
    r"确认订单",
    r"去结算",
    r"结算",
    r"支付",
    r"付款",
    r"确认收货",
    r"申请退款",
    r"退款",
    r"退货",
    r"充值",
    r"转账",
    r"开通白条",
    r"借款",
    r"收藏",
    r"关注店铺",
    r"关注",
    r"取消关注",
    r"删除",
    r"注销",
    r"退出登录",
    r"修改密码",
    r"新增地址",
    r"修改地址",
    r"保存地址",
    r"提交评价",
    r"发布评价",
    r"领券",
    r"领取优惠券",
)
_STATE_CHANGING_RE = re.compile("|".join(_STATE_CHANGING_PATTERNS), re.I)

_SENSITIVE_INPUT_RE = re.compile(
    r"密码|验证码|短信码|动态码|安全码|支付密码|银行卡|身份证|CVV|CVC|OTP",
    re.I,
)

_VERIFICATION_RE = re.compile(
    r"滑块|安全验证|异常访问|访问过于频繁|请完成验证|请先验证|输入验证码|获取验证码|验证码错误|captcha|人机验证|拖动.*验证",
    re.I,
)


_VERIFICATION_RE = re.compile(
    r"滑块|安全验证|异常访问|访问过于频繁|请完成验证|请先验证|"
    r"拖动下方滑块|拖动到最右边|验证失败|点击框体重试|"
    r"captcha|人机验证|drag.*verify|verification failed",
    re.I,
)


class SafetyError(RuntimeError):
    """Raised when an action violates the MCP server safety boundary."""


@dataclass(frozen=True, slots=True)
class ElementSafetyMetadata:
    text: str = ""
    aria_label: str = ""
    title: str = ""
    value: str = ""
    href: str = ""
    input_type: str = ""
    placeholder: str = ""
    name: str = ""

    def combined_text(self) -> str:
        return " ".join(
            part
            for part in (
                self.text,
                self.aria_label,
                self.title,
                self.value,
                self.href,
                self.placeholder,
                self.name,
            )
            if part
        )


def _host_matches(host: str, root: str) -> bool:
    host = host.lower().rstrip(".")
    return host == root or host.endswith("." + root)


def is_allowed_url(url: str) -> bool:
    try:
        parsed = urlparse(url)
    except ValueError:
        return False
    if parsed.scheme.lower() in _BLOCKED_SCHEMES:
        return False
    if parsed.scheme.lower() not in {"http", "https"}:
        return False
    host = (parsed.hostname or "").lower()
    return any(_host_matches(host, root) for root in _ALLOWED_ROOT_DOMAINS)


def ensure_allowed_url(url: str) -> str:
    if not is_allowed_url(url):
        raise SafetyError(
            "仅允许访问京东、淘宝和天猫域名；不允许 file://、本地地址或任意第三方网站。"
        )
    return url


_EXTENSION_BLOCKED_PATH_RE = re.compile(
    r"/(?:cart|checkout|cashier|pay(?:ment)?|order(?:s)?|address|refund|after-sale)(?:/|$)",
    re.I,
)


def ensure_extension_allowed_url(url: str, *, _routing_depth: int = 0) -> str:
    from urllib.parse import parse_qsl, urljoin
    try:
        parsed = urlparse(url)
        routes = {
            'www.jd.com': {'/', '/index.html'}, 'search.jd.com': {'/Search'},
            'item.jd.com': None,
            'www.taobao.com': {'/'}, 's.taobao.com': {'/search'},
            's.m.taobao.com': {'/h5'}, 'item.taobao.com': {'/item.htm'},
            'www.tmall.com': {'/'}, 'detail.tmall.com': {'/item.htm'},
        }
        host = parsed.hostname or ''
        path_ok = host in routes and (bool(re.fullmatch(r'/[0-9]+\.html', parsed.path)) if routes[host] is None else parsed.path in routes[host])
        # Ordinary parameters are open-ended; only explicit execution/routing keys
        # have special meaning here. Do not inspect search/tracking values as actions.
        action_keys = {'action', 'act', 'method', 'command', 'cmd', 'operation', 'op',
                       'buy', 'buynow', 'addtocart', 'checkout', 'pay', 'submit'}
        routing_keys = {'redirect', 'redirecturl', 'redirecturi', 'return', 'returnurl',
                        'returnuri', 'next', 'nexturl', 'url', 'target', 'targeturl',
                        'destination', 'dest', 'callback', 'callbackurl'}
        query_ok = True
        for key, value in parse_qsl(parsed.query, keep_blank_values=True):
            key = key.lower().replace('_', '').replace('-', '')
            if key in action_keys:
                query_ok = False
                break
            if key in routing_keys and re.match(r'^(?:[a-zA-Z][a-zA-Z0-9+.-]*:|[/.?])', value):
                if _routing_depth >= 3:
                    query_ok = False
                    break
                ensure_extension_allowed_url(urljoin(url, value), _routing_depth=_routing_depth + 1)
        if parsed.scheme != 'https' or parsed.username or parsed.password or parsed.port not in {None, 443} or parsed.fragment or not path_ok or not query_ok:
            raise ValueError('outside_public_shopping_routes')
    except (ValueError, TypeError):
        raise SafetyError('扩展仅允许公开商品、搜索和首页；账户、登录、订单、购物车、支付及未知路由必须手动访问。') from None
    return url


def extension_platform(url: str) -> str:
    ensure_extension_allowed_url(url)
    return 'jd' if (urlparse(url).hostname or '').endswith('.jd.com') else 'taobao'


def ensure_click_allowed(
    metadata: ElementSafetyMetadata,
    *,
    allow_state_changing_actions: bool,
) -> None:
    if allow_state_changing_actions:
        return
    combined = metadata.combined_text()
    if _STATE_CHANGING_RE.search(combined):
        raise SafetyError(
            "该元素可能引发购买、结算、支付、购物车、关注、删除或其他账户状态变化，"
            "当前服务器按只读模式阻止了此次点击。"
        )


def ensure_typing_allowed(metadata: ElementSafetyMetadata) -> None:
    if metadata.input_type.lower() == "password":
        raise SafetyError("禁止通过 MCP 向密码框输入内容，请在浏览器窗口中手动完成登录。")
    if _SENSITIVE_INPUT_RE.search(metadata.combined_text()):
        raise SafetyError(
            "禁止通过 MCP 输入密码、验证码、银行卡、身份证或其他敏感认证信息；"
            "请在浏览器窗口中手动输入。"
        )


def page_requires_user_verification(text: str, url: str = "") -> bool:
    return bool(_VERIFICATION_RE.search(f"{url}\n{text[:5000]}"))
