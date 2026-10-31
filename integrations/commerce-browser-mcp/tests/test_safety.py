from __future__ import annotations

import pytest

from jd_taobao_mcp.safety import SafetyError, ensure_extension_allowed_url


@pytest.mark.parametrize('url', [
    'https://www.jd.com/?a=1791970336267&unknown_tracking=any%20value',
    'https://www.jd.com/index.html?a=abc&a=&from=buy&source=checkout&return=campaign',
    'https://search.jd.com/Search?keyword=gym&new_param=one&new_param=two',
    'https://item.jd.com/1.html?tracking=https%3A%2F%2Fcart.jd.com%2F',
    'https://www.taobao.com/?tab=all',
    'https://www.taobao.com/wow/z/tbhome/pcsem/alimama',
    # Synthetic search/tracking values only; none of these ordinary keys are actions.
    'https://www.taobao.com/wow/z/tbhome/pcsem/alimama?refpid=test&keyword=shirt&bc_fl_src=test&channelSrp=test&msclkid=test&clk1=test&upsId=test',
    'https://www.taobao.com/wow/z/tbhome/pcsem/alimama?keyword=shirt&keyword=coat&refpid=&refpid=test&source=buy',
    'https://s.taobao.com/search?page=1&q=Reebok%20Nano%20X5&tab=all',
    'https://s.m.taobao.com/h5?q=gym&tab=other',
    'https://item.taobao.com/item.htm?id=1&tab=&extra=anything',
    'https://www.tmall.com/?campaign=new',
    'https://detail.tmall.com/item.htm?id=1&returnUrl=%2Fitem.htm%3Fid%3D2',
    'https://www.jd.com:443/?redirect=https%3A%2F%2Fs.taobao.com%2Fsearch%3Fq%3Dgym',
])
def test_extension_allows_ordinary_parameters_on_exact_public_routes(url: str) -> None:
    assert ensure_extension_allowed_url(url) == url


@pytest.mark.parametrize('url', [
    'https://cart.taobao.com/cart.htm',
    'https://trade.taobao.com/order/list.htm',
    'https://cashier.jd.com/payment',
    'https://www.jd.com/address/list',
    'https://passport.jd.com/',
    'https://s.taobao.com/order?tab=all',
    'https://www.taobao.com/wow/z/tbhome/pcsem/unknown',
    'https://www.taobao.com/wow/z/tbhome/pcsem/alimama/',
    'https://www.taobao.com/wow/z/tbhome/pcsem/alimama;extra',
    'https://www.tmall.com/wow/z/tbhome/pcsem/alimama',
    'https://www.taobao.com/wow/z/tbhome/pcsem/alimama?action=buy',
    'https://www.taobao.com/wow/z/tbhome/pcsem/alimama?keyword=shirt&ACTION=',
    'https://www.taobao.com/wow/z/tbhome/pcsem/alimama?next=https%3A%2F%2Fcart.taobao.com%2Fcart.htm',
    'https://www.taobao.com/wow/z/tbhome/pcsem/alimama?next=https%3A%2F%2Fevil.test%2F',
    'https://www.taobao.com/wow/z/tbhome/pcsem/alimama?next=%3Faction%3Dbuy',
    'https://www.jd.com/?action=buy',
    'https://item.jd.com/1.html?ACTION=buy',
    'https://s.taobao.com/search?add_to_cart=1',
    'https://www.jd.com/?action=',
    'https://www.jd.com/?redirect=https%3A%2F%2Fcart.jd.com%2F',
    'https://www.jd.com/?return_url=%2Forder',
    'https://www.jd.com/?next=https%3A%2F%2Fevil.test%2F',
    'https://www.jd.com/?redirect=javascript%3Aalert(1)',
    'https://www.jd.com/?redirect=%2F%3Faction%3Dbuy',
    'http://www.jd.com/',
    'https://www.jd.com.evil.test/',
    'https://www.jd.com:444/',
    'https://user:password@www.jd.com/',
    'https://www.jd.com/#cart',
])
def test_extension_blocks_sensitive_routes_actions_and_unsafe_urls(url: str) -> None:
    with pytest.raises(SafetyError):
        ensure_extension_allowed_url(url)
