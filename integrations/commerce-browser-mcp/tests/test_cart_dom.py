"""Offline real-DOM regressions for the observed tbpcDetail controls.

Uses a fresh headless browser, an intercepted synthetic product document, and no
user profile or merchant network. This does not prove server-side cart success.
"""
from pathlib import Path
import os
import unittest

try:
    from playwright.sync_api import sync_playwright
except ImportError:
    sync_playwright = None

ROOT = Path(__file__).resolve().parents[1]
URL = 'https://detail.tmall.com/item.htm?id=123&skuId=456'
# Sanitized structural fixture derived from authorized product-control diagnostics.
HTML = '''<!doctype html><html><head><meta charset="utf-8"><title>Synthetic modern jacket</title>
<style>div,span,button,input { min-width:12px; min-height:12px; } .isDisabled--fixture { color:gray; }</style></head>
<body><div id="tbpcDetail_SkuPanelRightWrap" class="rightWrap--fixture">
<div class="skuItem--fixture"><span class="ItemLabel--fixture">颜色</span>
<div class="valueItem--fixture isSelected--fixture hasImg--fixture"><span>深海蓝</span> <span>万人加购</span></div>
<div class="valueItem--fixture">浅卡其</div><div class="valueItem--fixture isDisabled--fixture">米砂</div></div>
<div class="skuItem--fixture"><span class="ItemLabel--fixture">尺码</span>
<div class="valueItem--fixture">S 建议100-115斤</div><div class="valueItem--fixture isSelected--fixture">M 建议116-135斤</div>
<div class="valueItem--fixture">L 建议136-150斤</div></div>
<div class="root--fixture"><div class="content--fixture"><div class="countWrapper--fixture">
<div class="countValueWrapper--fixture"><input class="countValue--fixture" value="1"></div></div></div></div>
<div id="tbpcDetail_SkuPanelFoot" class="foot--fixture"><div class="Actions--fixture"><div class="leftButtons--fixture">
<button class="btn--fixture leftBtn--fixture primaryBtn--fixture">加入购物车</button>
<button class="btn--fixture rightBtn--fixture">立即购买</button></div></div></div>
</div><script>window.cartClicks=0; window.buyClicks=0;
document.querySelector('.leftBtn--fixture').addEventListener('click',()=>window.cartClicks++);
document.querySelector('.rightBtn--fixture').addEventListener('click',()=>window.buyClicks++);
// Emulate the platform: clicking a value chip selects it within its group.
for (const group of document.querySelectorAll('.skuItem--fixture')) {
  const chips=[...group.querySelectorAll('.valueItem--fixture')];
  for (const chip of chips) chip.addEventListener('click',()=>{
    if (chip.classList.contains('isDisabled--fixture')) return;
    chips.forEach(c=>c.classList.remove('isSelected--fixture'));
    chip.classList.add('isSelected--fixture');
  });
}</script></body></html>'''


@unittest.skipUnless(sync_playwright, 'Playwright is not installed')
class ModernCartDomTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        source = (ROOT / 'chrome-extension/service-worker.js').read_text(encoding='utf-8')
        start = source.index('function cartPageOperation(')
        cls.operation = source[start:source.index('\nfunction pageOperation(', start)]
        cls.playwright = sync_playwright().start()
        executable = os.getenv('CART_TEST_BROWSER')
        if not executable:
            executable = next((str(p) for p in (
                Path('C:/Program Files/Google/Chrome/Application/chrome.exe'),
                Path('C:/Program Files (x86)/Google/Chrome/Application/chrome.exe'),
            ) if p.is_file()), None)
        try:
            cls.browser = cls.playwright.chromium.launch(headless=True, executable_path=executable)
        except Exception as exc:
            cls.playwright.stop()
            raise unittest.SkipTest('Isolated Chromium unavailable; no browser download attempted') from exc

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.playwright.stop()

    def setUp(self):
        self.context = self.browser.new_context(service_workers='block')
        self.requests = []

        def intercept(route):
            self.requests.append(route.request.url)
            if route.request.url == URL and route.request.resource_type == 'document':
                route.fulfill(status=200, content_type='text/html', body=HTML)
            else:
                route.abort()

        self.context.route('**/*', intercept)
        self.page = self.context.new_page()
        self.page.goto(URL)
        self.expected = {'product_url': URL, 'item_id': '123', 'color': '深海蓝', 'size': 'M', 'quantity': 1}
        self.selection = None

    def tearDown(self):
        self.context.close()

    def operation_call(self, mode, **changes):
        payload = {'expected': self.expected, 'nonce': 'fixture-nonce', **changes}
        return self.page.evaluate(
            '(args)=>{const operation=' + self.operation + ';return operation(args.mode,args.payload,{url:location.href,expires_at:Date.now()+60000});}',
            {'mode': mode, 'payload': payload},
        )

    def review(self):
        self.selection = self.operation_call('review')
        self.assertNotIn('__bridgeError', self.selection, self.selection)
        self.assertEqual(self.page.evaluate('window.cartClicks'), 0)
        return self.selection

    def commit(self):
        return self.operation_call('commit', selection=self.selection)

    def assert_no_click(self):
        self.assertEqual(self.page.evaluate('window.cartClicks'), 0)
        self.assertEqual(self.page.evaluate('window.buyClicks'), 0)

    def test_observed_modern_structure_and_single_attempt(self):
        selection = self.review()
        self.assertEqual(selection['layout'], 'modern')
        self.assertEqual((selection['color'], selection['size'], selection['quantity']), ('深海蓝', 'M', 1))
        self.assertTrue(all(x['id'] is None for x in selection['options']))
        self.assertEqual(selection['button']['type'], 'submit')
        self.assertIsNone(selection['price'])
        self.assertEqual(self.commit()['status'], 'attempted_unverified')
        self.assertEqual(self.commit()['status'], 'rejected')
        self.assertEqual(self.page.evaluate('window.cartClicks'), 1)
        self.assertEqual(self.page.evaluate('window.buyClicks'), 0)
        self.assertEqual(self.requests, [URL])

    def test_changed_evidence_and_nodes_reject_without_click(self):
        mutations = {
            'quantity': "document.querySelector('input').value='2'",
            'color': "document.querySelector('.isSelected--fixture').textContent='黑色'",
            'size': "document.querySelectorAll('.isSelected--fixture')[1].textContent='L 建议136-150斤'",
            'disabled': "document.querySelector('.isSelected--fixture').classList.add('isDisabled--fixture')",
            'selection': "document.querySelector('.isSelected--fixture').classList.remove('isSelected--fixture')",
            'duplicate_selection': "document.querySelectorAll('.valueItem--fixture')[1].classList.add('isSelected--fixture')",
            'replaced_button': "let b=document.querySelector('.leftBtn--fixture');b.replaceWith(b.cloneNode(true))",
            'extra_dimension': "let g=document.querySelector('.skuItem--fixture');g.parentElement.appendChild(g.cloneNode(true))",
            'form_owner': "let f=document.createElement('form');f.id='buy-form';document.body.appendChild(f);document.querySelector('.leftBtn--fixture').setAttribute('form','buy-form')",
            'buy_decoy': "document.querySelector('.leftBtn--fixture').textContent='立即购买'",
            'duplicate_label': "document.querySelectorAll('.valueItem--fixture')[1].textContent='深海蓝'",
        }
        for name, script in mutations.items():
            with self.subTest(name=name):
                self.page.reload()
                self.review()
                self.page.evaluate('()=>{' + script + '}')
                self.assertEqual(self.commit()['status'], 'rejected')
                self.assert_no_click()

    def test_missing_or_ambiguous_selection_cannot_prepare(self):
        scripts = [
            "document.querySelector('.isSelected--fixture').classList.remove('isSelected--fixture')",
            "document.querySelector('.isSelected--fixture').classList.add('isDisabled--fixture')",
            "document.querySelectorAll('.valueItem--fixture')[1].textContent='深海蓝'",
            "let b=document.querySelector('.leftBtn--fixture');b.parentElement.appendChild(b.cloneNode(true))",
            "document.querySelector('input').value='1.5'",
            "document.querySelector('.ItemLabel--fixture').textContent='套餐'",
        ]
        for script in scripts:
            with self.subTest(script=script):
                self.page.reload()
                self.page.evaluate('()=>{' + script + '}')
                self.assertIn('__bridgeError', self.operation_call('review'))
                self.assert_no_click()

    def test_volatile_page_refresh_does_not_block_unchanged_cart(self):
        refreshes = {
            # Unselected chip re-render / promo refresh, sales badge, price area churn.
            'unselected_chip': "let c=document.querySelectorAll('.valueItem--fixture')[1];"
                               "c.replaceWith(c.cloneNode(true));",
            'promo_badge': "let b=document.createElement('span');b.textContent='双11直降';"
                           "document.querySelector('.rightWrap--fixture').prepend(b);",
            'sales_text': "let s=document.createElement('div');s.textContent='已售 3000+';"
                          "document.querySelector('.leftButtons--fixture').prepend(s);",
        }
        for name, script in refreshes.items():
            with self.subTest(name=name):
                self.page.reload()
                self.review()
                self.page.evaluate('()=>{' + script + '}')
                self.assertEqual(self.commit()['status'], 'attempted_unverified')
                self.assertEqual(self.page.evaluate('window.cartClicks'), 1)
                self.assertEqual(self.page.evaluate('window.buyClicks'), 0)

    def test_selection_label_refresh_still_blocks(self):
        self.review()
        self.page.evaluate("document.querySelector('.isSelected--fixture').textContent='深海蓝 限量版'")
        self.assertEqual(self.commit()['status'], 'rejected')
        self.assert_no_click()

    def test_select_variant_switches_only_exact_matching_chip(self):
        # Switch the size from M to L via the bounded selector, then the cart action follows it.
        result = self.operation_call('select', dimension='size', label='L 建议136-150斤')
        self.assertEqual(result['status'], 'selected')
        self.assertEqual(result['dimension'], 'size')
        self.assertEqual(result['label'], 'L 建议136-150斤')
        self.assertEqual(self.page.evaluate("document.querySelectorAll('.isSelected--fixture')[1].textContent.trim()"), 'L 建议136-150斤')

    def test_select_variant_rejects_unknown_ambiguous_disabled_and_wrong_group(self):
        cases = {
            'unknown_label': {'dimension': 'color', 'label': '不存在的颜色'},
            'wrong_dimension': {'dimension': 'material', 'label': '棉'},
            'disabled_option': {'dimension': 'color', 'label': '米砂'},
        }
        for name, payload in cases.items():
            with self.subTest(name=name):
                self.page.reload()
                result = self.operation_call('select', **payload)
                self.assertIn('__bridgeError', result, result)
                self.assert_no_click()

    def test_select_variant_does_not_touch_cart_button_or_buy_now(self):
        self.operation_call('select', dimension='color', label='浅卡其')
        self.assert_no_click()
        self.assertEqual(self.page.evaluate("document.querySelectorAll('.valueItem--fixture')[1].classList.contains('isSelected--fixture')"), True)

    def test_unrecognized_suffix_not_silently_discarded(self):
        self.page.evaluate("document.querySelector('.isSelected--fixture').textContent='深海蓝 限量版'")
        self.assertIn('__bridgeError', self.operation_call('review'))
        self.assert_no_click()


if __name__ == '__main__':
    unittest.main()
