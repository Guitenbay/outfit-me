// Grants are deliberately memory-only: reload/restart requires a fresh user gesture.
const sessions = new Map();
const origins = {
  jd: ['https://www.jd.com/*', 'https://search.jd.com/*', 'https://item.jd.com/*'],
  taobao: ['https://www.taobao.com/*', 'https://s.taobao.com/*', 'https://s.m.taobao.com/*', 'https://item.taobao.com/*', 'https://www.tmall.com/*', 'https://detail.tmall.com/*']
};
// Classification is diagnostic only; platformFor remains the authorization gate.
function classifyUrl(raw, routingDepth = 0) {
  let platform = null;
  try {
    const u = new URL(raw);
    const routes = {'www.jd.com':['/','/index.html'], 'search.jd.com':['/Search'], 'item.jd.com':null,
      'www.taobao.com':['/','/wow/z/tbhome/pcsem/alimama'], 's.taobao.com':['/search'], 's.m.taobao.com':['/h5'],
      'item.taobao.com':['/item.htm'], 'www.tmall.com':['/'], 'detail.tmall.com':['/item.htm']};
    const actionKeys = new Set(['action','act','method','command','cmd','operation','op','buy','buynow','addtocart','checkout','pay','submit']);
    const routingKeys = new Set(['redirect','redirecturl','redirecturi','return','returnurl','returnuri','next','nexturl','url','target','targeturl','destination','dest','callback','callbackurl']);
    // Recognize platform families for display only, never to expand allowed hosts.
    platform = u.hostname === 'jd.com' || u.hostname.endsWith('.jd.com') ? 'jd' :
      ['taobao.com','tmall.com'].some(host => u.hostname === host || u.hostname.endsWith('.' + host)) ? 'taobao' : null;
    if (!platform) return {platform:null, reason:{code:'unsupported_site'}};
    if (u.protocol !== 'https:' || u.username || u.password || u.port || u.hash || !Object.hasOwn(routes, u.hostname)) return {platform, reason:{code:'restricted_route'}};
    if (!(routes[u.hostname] === null ? /^\/[0-9]+\.html$/.test(u.pathname) : routes[u.hostname].includes(u.pathname))) return {platform, reason:{code:'restricted_route'}};
    for (const [k,v] of u.searchParams) {
      const key = k.toLowerCase().replace(/[_-]/g, '');
      if (actionKeys.has(key) || (routingKeys.has(key) && /^(?:[a-zA-Z][a-zA-Z0-9+.-]*:|[/.?])/.test(v) &&
          (routingDepth >= 3 || classifyUrl(new URL(v, u).href, routingDepth + 1).reason))) {
        // Only short identifier-like names can leave the worker; never values or URLs.
        const parameter = /^[a-zA-Z][a-zA-Z0-9_]{0,31}$/.test(k) ? k : undefined;
        return {platform, reason:{code:'restricted_query_param', ...(parameter ? {parameter} : {})}};
      }
    }
    return {platform, reason:null};
  } catch (_) { return {platform:null, reason:{code:'unavailable'}}; }
}
function platformFor(raw) {
  const result = classifyUrl(raw);
  return result.reason ? null : result.platform;
}
function classifyTab(tab) {
  if (!tab || !Number.isInteger(tab.id)) return {state:'unavailable', platform:null, reason:{code:'unavailable'}};
  const result = classifyUrl(tab.url);
  if (tab.pendingUrl || tab.status === 'loading') return {state:'loading', platform:result.platform, reason:{code:'loading'}};
  if (!tab.url || tab.status !== 'complete') return {state:'unavailable', platform:result.platform, reason:{code:'unavailable'}};
  return {state:result.reason?.code === 'unavailable' ? 'unavailable' : result.reason ? 'blocked' : 'ready', ...result};
}
function live(s, command) {
  if (sessions.get(s.platform) !== s || s.revoked) throw new Error('grant_revoked');
  if (command && (command.client_id !== s.clientId || command.platform !== s.platform || !Number.isFinite(command.expires_at) || Date.now() >= command.expires_at)) throw new Error('expired_or_wrong_grant');
}
async function bridge(s, path, body) {
  const response = await fetch(`http://127.0.0.1:${s.port}${path}`, {
    method: body === undefined ? 'GET' : 'POST', signal: AbortSignal.timeout(5000),
    headers: {'Authorization': `Bearer ${s.token}`, 'Content-Type':'application/json', 'X-Extension-Client':s.clientId},
    ...(body === undefined ? {} : {body: JSON.stringify(body)})
  });
  if (!response.ok) throw new Error(`bridge_http_${response.status}`);
  return response.json();
}
function detachReason(error) {
  const reason = error?.message;
  if (['selected_tab_left_public_shopping_scope', 'navigation_timeout_unknown_state'].includes(reason)) return reason;
  if (reason === 'expired_or_wrong_grant') return 'command_expired';
  return 'bridge_connection_failed';
}
async function detach(s, reason = 'user_detached') {
  if (!s || sessions.get(s.platform) !== s) return;
  invalidateCart(s, reason);
  sessions.delete(s.platform); s.revoked = true;
  for (const cancel of s.cancel) cancel();
  clearInterval(s.heartbeat);
  try { await bridge(s, '/v1/detach', {reason}); } catch (_) {}
}
async function currentTab(s, command) {
  live(s, command);
  const tab = await chrome.tabs.get(s.tabId);
  live(s, command);
  if (platformFor(tab.url) !== s.platform || (tab.pendingUrl && platformFor(tab.pendingUrl) !== s.platform)) {
    void detach(s, 'selected_tab_left_public_shopping_scope'); throw new Error('selected_tab_left_public_shopping_scope');
  }
  return tab;
}
// Read only the active selection. Status never enumerates or exposes grant tabs/URLs.
async function popupStatus() {
  const platforms = Object.fromEntries(['jd','taobao'].map(platform =>
    [platform, {connected: sessions.has(platform)}]));
  let current = {...classifyTab(null), matchesGrant:false};
  try {
    const [tab] = await chrome.tabs.query({active:true, currentWindow:true});
    current = {...classifyTab(tab), matchesGrant:false};
    if (current.state === 'ready') {
      current.matchesGrant = sessions.get(current.platform)?.tabId === tab.id;
      current.tabId = tab.id;
    }
  } catch (_) { current = {...classifyTab(null), state:'query_failed', matchesGrant:false}; }
  const s = sessions.get('taobao');
  return {platforms, current, ...(s?.cart && current.platform === 'taobao' && current.matchesGrant ? {cart:cartView(s)} : {})};
}
async function attach(message) {
  let tab;
  try { tab = await chrome.tabs.get(message.tabId); } catch (_) {}
  const current = classifyTab(tab);
  if (current.state !== 'ready') throw Object.assign(new Error(current.state === 'loading' ? 'navigation_in_progress' : 'page_invalid'), {current});
  const platform = current.platform;
  if (!Number.isInteger(message.port) || message.port < 1024 || message.port > 65535 || typeof message.token !== 'string' || message.token.length < 32) throw new Error('invalid_bridge_config');
  if (!(await chrome.permissions.contains({origins: origins[platform]}))) throw new Error('请在弹窗中授予此平台公开购物站点权限');
  // The popup serializes user requests. Never replace the other platform.
  await detach(sessions.get(platform));
  const s = {platform, tabId:tab.id, port:message.port, token:message.token, clientId:crypto.randomUUID(), cancel:new Set(), busy:false};
  try {
    const response = await bridge(s, '/v1/attach', {platform, client_id:s.clientId, url:tab.url, title:tab.title || ''});
    if (response?.success !== true) throw new Error('bridge_rejected');
    s.allowCart = response.allow_add_to_cart === true && platform === 'taobao';
    s.epoch = 0;
  } catch (error) {
    const code = error.message === 'bridge_http_401' ? 'bridge_unauthorized' :
      /^bridge_http_4[0-9]{2}$/.test(error.message) || error.message === 'bridge_rejected' ? 'bridge_rejected' : 'bridge_unavailable';
    throw new Error(code);
  }
  sessions.set(platform, s);
  let beating = false;
  s.heartbeat = setInterval(async () => {
    if (beating) return;
    beating = true;
    try { await currentTab(s); await bridge(s, '/v1/heartbeat', {}); }
    catch (error) { void detach(s, detachReason(error)); }
    finally { beating = false; }
  }, 2000);
  void poll(s);
}
async function poll(s) {
  while (sessions.get(s.platform) === s) {
    try {
      await currentTab(s);
      const {command} = await bridge(s, '/v1/commands/next');
      if (command) await runCommand(s, command);
    } catch (error) { await detach(s, detachReason(error)); break; }
    await new Promise(resolve => setTimeout(resolve, 300));
  }
}
function waitForNextLoad(s, command) {
  let resolve, reject, done = false, armed = false;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  const cleanup = () => { clearTimeout(timer); chrome.tabs.onUpdated.removeListener(listener); s.cancel.delete(cancel); };
  const finish = error => { if (done) return; done = true; cleanup(); error ? reject(error) : resolve(); };
  const check = async () => {
    if (!armed || done) return;
    try { const tab = await currentTab(s, command); if (tab.status === 'complete' && !tab.pendingUrl) finish(); }
    catch (error) { finish(error); }
  };
  const listener = (id) => { if (id === s.tabId) void check(); };
  const cancel = () => finish(new Error('navigation_cancelled'));
  const timer = setTimeout(() => finish(new Error('navigation_timeout_unknown_state')), Math.max(1, command.expires_at - Date.now()));
  chrome.tabs.onUpdated.addListener(listener); s.cancel.add(cancel);
  // Attach rejection handler immediately, even if tabs.update takes time or fails.
  promise.catch(() => {});
  return {promise, cancel, checkCurrent: () => { armed = true; return check(); }};
}
async function inject(s, command) {
  const tab = await currentTab(s, command);
  if (tab.status !== 'complete' || tab.pendingUrl) throw new Error('navigation_in_progress');
  live(s, command);
  const [{result}] = await chrome.scripting.executeScript({target:{tabId:s.tabId}, func:pageOperation,
    args:[command.operation, command.payload || {}, {platform:s.platform, expires_at:command.expires_at, url:tab.url}]});
  live(s, command);
  if (!result || result.__bridgeError || platformFor(result.url) !== s.platform) throw new Error(result?.__bridgeError || 'invalid_page_result');
  return result;
}
const CART_LIFETIME_MS = 60000, CART_STATUS_MS = 300000;
function cartRecords(s) {
  const records = s.cartRecords || (s.cartRecords = new Map());
  for (const [id,c] of records) if (Date.now() >= c.expires_at + CART_STATUS_MS) records.delete(id);
  return records;
}
function invalidateCart(s, reason) {
  if (s.cart && ['pending_confirmation','consumed'].includes(s.cart.status)) {
    s.cart.status = s.cart.status === 'consumed' ? 'unknown' : 'cancelled';
    s.cart.reason = reason;
  }
}
function cartView(s, popup = false, c = s.cart) {
  if (!c) return {status:'not_found'};
  if (Date.now() >= c.expires_at && c.status === 'pending_confirmation') { c.status='expired'; c.reason='confirmation_expired'; }
  if (Date.now() >= c.expires_at + CART_STATUS_MS) { if(s.cart===c) delete s.cart; return {status:'not_found'}; }
  return {request_id:c.request_id, status:c.status, reason:c.reason || '', expires_at:c.expires_at,
    selection:c.selection, ...(popup && c.status === 'pending_confirmation' ? {review_hash:c.review_hash} : {})};
}
function cartRequestId(request_id) {
  if (typeof request_id !== 'string' || request_id.length < 16 || request_id.length > 64 || /[^A-Za-z0-9_-]/.test(request_id)) throw new Error('invalid_request_id');
}
function cartExpected(payload) {
  cartRequestId(payload?.request_id);
  const u = new URL(payload.expected_product_url), ids = u.searchParams.getAll('id');
  if (platformFor(u.href) !== 'taobao' || !['item.taobao.com','detail.tmall.com'].includes(u.hostname) || u.pathname !== '/item.htm' || ids.length !== 1 || !/^[0-9]+$/.test(ids[0]) || payload.expected_item_id !== ids[0]) throw new Error('single_matching_numeric_item_id_required');
  const clean = x => typeof x === 'string' ? x.replace(/\s+/g,' ').trim() : '';
  if (!clean(payload.color) || !clean(payload.size) || payload.color.length > 100 || payload.size.length > 100) throw new Error('exact_color_size_required');
  if (!Number.isInteger(payload.quantity) || payload.quantity < 1 || payload.quantity > 10) throw new Error('quantity_must_be_integer_1_to_10');
  return {product_url:u.href, item_id:ids[0], color:clean(payload.color), size:clean(payload.size), quantity:payload.quantity};
}
async function cartInject(s, mode, payload, expires_at, command) {
  const tab = await currentTab(s, command);
  if (tab.status !== 'complete' || tab.pendingUrl || Date.now() >= expires_at) throw new Error('page_or_deadline_invalid');
  if (mode === 'commit' && (s.cart?.status !== 'consumed' || s.cart.epoch !== s.epoch || s.cart.nonce !== payload.nonce)) throw new Error('review_invalidated');
  live(s, command);
  const [{result}] = await chrome.scripting.executeScript({target:{tabId:s.tabId}, func:cartPageOperation,
    args:[mode, payload, {url:tab.url, expires_at}]});
  live(s, command);
  if (!result || result.__bridgeError) throw new Error(result?.__bridgeError || 'missing_cart_result');
  return result;
}
async function prepareCart(s, payload) {
  if (s.platform !== 'taobao' || s.allowCart !== true) throw new Error('ALLOW_ADD_TO_CART_disabled');
  const expected = cartExpected(payload);
  cartView(s);
  const records = cartRecords(s), previous = records.get(payload.request_id);
  if (previous) {
    if (JSON.stringify(previous.expected) !== JSON.stringify(expected)) throw new Error('request_id_conflict');
    return cartView(s, false, previous);
  }
  if (records.size >= 16) throw new Error('cart_status_capacity_wait_for_expiry');
  if (s.cart && ['pending_confirmation','consumed'].includes(s.cart.status)) throw new Error('cart_intent_busy');
  const epoch = s.epoch, expires_at = Date.now() + CART_LIFETIME_MS, nonce = crypto.randomUUID();
  let selection;
  try { selection = await cartInject(s, 'review', {expected, nonce}, expires_at); }
  catch (error) { return {request_id:payload.request_id, status:'not_supported', reason:String(error.message)}; }
  live(s);
  if (s.epoch !== epoch) throw new Error('document_changed');
  const binding = JSON.stringify({selection, tabId:s.tabId, clientId:s.clientId, epoch, request_id:payload.request_id, expires_at});
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(binding));
  live(s);
  if (s.epoch !== epoch) throw new Error('document_changed');
  s.cart = {request_id:payload.request_id, expected, selection, nonce, epoch, expires_at,
    review_hash:[...new Uint8Array(bytes)].map(x=>x.toString(16).padStart(2,'0')).join(''), status:'pending_confirmation'};
  records.set(payload.request_id, s.cart);
  return cartView(s);
}
async function selectVariant(s, payload) {
  // Bounded variant switch only: no cart intent, no checkout, exactly one chip click.
  if (s.platform !== 'taobao' || s.allowCart !== true) throw new Error('ALLOW_ADD_TO_CART_disabled');
  if (s.cart && ['pending_confirmation','consumed'].includes(s.cart.status)) throw new Error('cart_intent_busy_finish_or_wait_for_expiry');
  const dimension = payload?.dimension, label = payload?.label;
  if (!['color','size'].includes(dimension) || typeof label !== 'string' || !label.trim() || label.length > 100) throw new Error('invalid_variant_selection');
  const epoch = s.epoch;
  const result = await cartInject(s, 'select', {dimension, label: label.replace(/\s+/g,' ').trim()}, Date.now() + CART_LIFETIME_MS);
  if (s.epoch !== epoch) throw new Error('document_changed_verify_selection');
  return result;
}
async function confirmCart(message, {s = sessions.get('taobao'), command, ownsBusy = false} = {}) {
  if (!s || s.platform !== 'taobao' || s.allowCart !== true) throw new Error('cart_not_enabled');
  live(s, command);
  cartRequestId(message?.request_id);
  if (typeof message.review_hash !== 'string' || message.review_hash.length !== 64 || /[^0-9a-f]/.test(message.review_hash)) throw new Error('invalid_review_hash');
  const c = cartRecords(s).get(message.request_id);
  if (!c || c.review_hash !== message.review_hash) throw new Error('review_mismatch');
  const view = cartView(s, false, c);
  if (c.status !== 'pending_confirmation') return view;
  if (s.cart !== c) { c.status='cancelled'; c.reason='review_no_longer_active'; return cartView(s, false, c); }
  // Consume synchronously BEFORE any await: popup and internal commands share one shot.
  c.status = 'consumed';
  if ((s.busy && !ownsBusy) || (ownsBusy && !s.busy) || s.epoch !== c.epoch) { c.status='cancelled'; c.reason='page_busy_or_changed'; return cartView(s, false, c); }
  if (!ownsBusy) s.busy = true;
  try {
    // Only the trusted internal command skips active selection; the grant still gates it.
    if (!command) {
      const [tab] = await chrome.tabs.query({active:true, currentWindow:true});
      live(s);
      if (tab?.id !== s.tabId) throw new Error('reviewed_tab_changed');
    }
    live(s, command);
    if (s.epoch !== c.epoch || c.status !== 'consumed') throw new Error('reviewed_tab_changed');
    const expires_at = command ? Math.min(c.expires_at, command.expires_at) : c.expires_at;
    const result = await cartInject(s, 'commit', {nonce:c.nonce, selection:c.selection, expected:c.expected}, expires_at, command);
    live(s, command);
    if (s.epoch !== c.epoch || c.status !== 'consumed') throw new Error('document_changed');
    c.status = result.status === 'attempted_unverified' ? 'attempted_unverified' : result.status === 'rejected' ? 'rejected' : 'unknown';
    c.reason = result.reason || 'server_cart_result_not_verified';
  } catch (_) { c.status='unknown'; c.reason='outcome_not_verified_do_not_retry'; }
  finally { if (!ownsBusy) s.busy=false; }
  return cartView(s, false, c);
}
async function runCommand(s, command) {
  live(s, command);
  const supported = new Set(['navigate','snapshot','extract_product_basic','list_elements','element_metadata','scroll','prepare_add_to_cart','get_add_to_cart_status','review_add_to_cart','confirm_add_to_cart','select_variant']);
  let response, ownsBusy = false;
  try {
    if (!supported.has(command.operation)) throw new Error('unsafe_or_unsupported_operation');
    if (s.busy) throw new Error('page_busy');
    s.busy = true; ownsBusy = true;
    await bridge(s, '/v1/claim', {request_id:command.request_id});
    await currentTab(s, command);
    let result;
    if (command.operation === 'prepare_add_to_cart') result = await prepareCart(s, command.payload);
    else if (command.operation === 'select_variant') result = await selectVariant(s, command.payload);
    else if (['get_add_to_cart_status','review_add_to_cart'].includes(command.operation)) {
      if (s.platform !== 'taobao' || s.allowCart !== true) throw new Error('ALLOW_ADD_TO_CART_disabled');
      cartRequestId(command.payload?.request_id);
      const record = cartRecords(s).get(command.payload.request_id);
      result = record ? cartView(s, command.operation === 'review_add_to_cart', record) : {status:'not_found'};
    } else if (command.operation === 'confirm_add_to_cart') {
      // Internal only: the Python server obtains native Agent approval before dispatch.
      result = await confirmCart(command.payload, {s, command, ownsBusy});
    } else if (command.operation === 'navigate') {
      invalidateCart(s, 'navigation'); s.epoch = (s.epoch || 0) + 1;
      if (platformFor(command.payload?.url) !== s.platform) throw new Error('destination_not_allowed');
      const load = waitForNextLoad(s, command);
      try {
        live(s, command);
        await chrome.tabs.update(s.tabId, {url:command.payload.url});
        await load.checkCurrent();
        await load.promise;
        result = await inject(s, {...command, operation:'page_state', payload:{}});
      } finally { load.cancel(); }
    } else result = await inject(s, command);
    response = {request_id:command.request_id, ok:true, result};
  } catch (error) { response = {request_id:command.request_id, ok:false, error:String(error.message || error)}; }
  finally { if (ownsBusy) s.busy=false; }
  live(s, command); // No late response, no routing through a replacement grant.
  await bridge(s, '/v1/results', response);
}
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id || sender.url !== chrome.runtime.getURL('popup.html')) return false;
  (async () => {
    try {
      if (message.type === 'popup_status') {
        const status = await popupStatus(), s = sessions.get('taobao');
        sendResponse({success:true, ...status, ...(status.cart ? {cart:cartView(s, true)} : {})});
        return;
      }
      if (message.type === 'confirm_add_to_cart') { sendResponse({success:true, cart:await confirmCart(message)}); return; }
      if (message.type === 'cancel_add_to_cart') {
        const s = sessions.get('taobao');
        if (s?.cart?.request_id === message.request_id && s.cart.review_hash === message.review_hash) invalidateCart(s, 'user_cancelled');
        sendResponse({success:true}); return;
      }
      if (message.type === 'attach') await attach(message);
      else if (message.type === 'detach' && ['jd','taobao'].includes(message.platform)) await detach(sessions.get(message.platform));
      else throw new Error('unknown_message');
      sendResponse({success:true});
    } catch (error) { sendResponse({success:false, error:String(error.message || error), ...(error.current ? {current:error.current} : {})}); }
  })();
  return true;
});
chrome.tabs.onRemoved.addListener(id => { for (const s of sessions.values()) if (s.tabId === id) void detach(s, 'tab_closed'); });
chrome.tabs.onUpdated.addListener((id, info) => {
  if (info.url || info.status === 'loading') for (const s of sessions.values()) if (s.tabId === id) {
    s.epoch = (s.epoch || 0) + 1; invalidateCart(s, 'navigation_or_reload');
  }
  if (!info.url) return;
  for (const s of sessions.values()) if (s.tabId === id && platformFor(info.url) !== s.platform) void detach(s, 'selected_tab_left_public_shopping_scope');
});

// Explicit legacy and observed modern Taobao/Tmall adapters; no model-supplied selectors.
// Isolated-world state retains actual nodes; no selectors/scripts supplied by the model.
function cartPageOperation(mode, payload, guard) {
  let attempted = false;
  try {
    const clean = x => String(x || '').replace(/\s+/g,' ').trim();
    const u = new URL(location.href), ids = u.searchParams.getAll('id');
    if (!guard || !Number.isFinite(guard.expires_at) || Date.now() >= guard.expires_at || location.href !== guard.url || u.protocol !== 'https:' || u.username || u.password || u.port || u.hash ||
        !['item.taobao.com','detail.tmall.com'].includes(u.hostname) || u.pathname !== '/item.htm' || ids.length !== 1 || !/^[0-9]+$/.test(ids[0])) throw new Error('unsupported_product_url');
    const bad = new Set(['action','act','method','command','cmd','operation','op','buy','buynow','addtocart','checkout','pay','submit','redirect','redirecturl','redirecturi','return','returnurl','returnuri','next','nexturl','url','target','targeturl','destination','dest','callback','callbackurl']);
    if ([...u.searchParams].some(([k])=>bad.has(k.toLowerCase().replace(/[_-]/g,'')))) throw new Error('unsupported_product_query');
    if (/滑块|安全验证|异常访问|访问过于频繁|请完成验证|请先验证|人机验证|captcha|登录后|请先登录/i.test(document.body?.innerText || '')) throw new Error('manual_verification_required');
    const visible = el => el?.isConnected && (()=>{const r=el.getBoundingClientRect(), s=getComputedStyle(el);return s.display!=='none' && s.visibility!=='hidden' && r.width>=2 && r.height>=2;})();
    const one = (root, selector) => { const found=[...root.querySelectorAll(selector)].filter(visible); if(found.length!==1) throw new Error('unsupported_or_ambiguous_DOM:'+selector); return found[0]; };
    const legacy = [...document.querySelectorAll('.tb-skin')].filter(visible);
    let root, quantityNode, titleNode, title, button;
    const nodes = [], options = [], variantEvidence = [];
    const layout = legacy.length ? 'legacy' : 'modern';
    const dimensionFor = label => ['颜色分类','颜色'].includes(label) ? 'color' : ['尺码','尺寸'].includes(label) ? 'size' : null;
    if (mode === 'select') {
      // Bounded variant switch: clicks only the one visible option chip whose canonical
      // label matches exactly, inside the already recognized SKU panel. No other clicks.
      const target = clean(payload.label), dimension = payload.dimension;
      if (!['color','size'].includes(dimension) || !target || target.length > 100) throw new Error('invalid_variant_selection');
      const family = (el, prefix) => String(el.getAttribute('class') || '').split(/\s+/).some(token => token.startsWith(prefix+'--'));
      const canonical = raw => dimension === 'color'
        ? raw.replace(/\s+(?:万人加购|多人加购|\d+(?:\.\d+)?万?\+?人加购)$/, '')
        : raw.replace(/\s+建议\s*\d+(?:\.\d+)?\s*[-~—至]\s*\d+(?:\.\d+)?\s*斤$/, '');
      let group, chips;
      if (layout === 'modern') {
        for (const candidate of [...document.querySelectorAll('[class*="skuItem--"]')].filter(el => visible(el) && family(el,'skuItem'))) {
          const labelNode = candidate.querySelector('[class*="ItemLabel--"]');
          if (labelNode && dimensionFor(clean(labelNode.innerText)) === dimension) { group = candidate; break; }
        }
        if (group) chips = [...group.querySelectorAll('[class*="valueItem--"]')].filter(el => visible(el) && family(el,'valueItem'));
      } else {
        if (legacy.length !== 1) throw new Error('ambiguous_product_panel');
        for (const candidate of [...legacy[0].querySelectorAll('ul[data-property]')].filter(visible)) {
          if (dimensionFor(clean(candidate.getAttribute('data-property'))) === dimension) { group = candidate; break; }
        }
        if (group) chips = [...group.querySelectorAll('li[data-value]')].filter(visible);
      }
      if (!group || !chips) throw new Error('variant_group_not_found');
      const wanted = canonical(target);
      const matches = chips.filter(el => canonical(clean(el.innerText)) === wanted);
      if (matches.length !== 1) throw new Error('exact_variant_option_required');
      const chip = matches[0];
      if (family(chip,'isDisabled') || chip.getAttribute('aria-disabled') === 'true' || chip.disabled === true || chip.classList.contains('tb-out-of-stock')) throw new Error('selected_option_unavailable');
      if (family(chip,'isSelected') || chip.getAttribute('aria-selected') === 'true') return {status:'already_selected', dimension, label:target};
      // The single click this operation performs: the exact matching variant chip.
      chip.click();
      return {status:'selected', dimension, label:target};
    }
    if (layout === 'legacy') {
      if (legacy.length !== 1) throw new Error('ambiguous_product_panel');
      root = legacy[0]; nodes.push(root);
      const groups = [...root.querySelectorAll('ul[data-property]')].filter(visible);
      if (groups.length !== 2) throw new Error('unsupported_variant_groups_manual_add_required');
      for (const group of groups) {
        const label=clean(group.getAttribute('data-property')), dimension=dimensionFor(label);
        if (!dimension || options.some(o=>o.dimension===dimension)) throw new Error('unsupported_variant_labels');
        const selected=one(group, 'li.tb-selected[data-value]'), id=selected.getAttribute('data-value');
        if (!/^[0-9]+:[0-9]+$/.test(id || '')) throw new Error('missing_stable_option_id');
        const optionText=clean(selected.innerText), title=clean(selected.getAttribute('title'));
        if (!optionText || optionText.length>100 || (title && title!==optionText) || selected.getAttribute('aria-disabled')==='true' || selected.classList.contains('tb-out-of-stock')) throw new Error('missing_or_ambiguous_selected_label');
        if ([...group.querySelectorAll('li[data-value]')].filter(el=>el.getAttribute('data-value')===id).length!==1) throw new Error('duplicate_option_identity');
        nodes.push(group, selected); options.push({dimension, group:label, id, label:optionText});
      }
      quantityNode=one(root, 'input.tb-text[name="quantity"]');
      titleNode=one(document, '.tb-title h3'); title=clean(titleNode.innerText);
      button=one(root, '#J_LinkBasket');
    } else {
      // Observed live tbpcDetail layout. Generated hash suffixes are not stable selectors.
      root=one(document, '#tbpcDetail_SkuPanelRightWrap'); nodes.push(root);
      const family=(el, prefix)=>String(el.getAttribute('class') || '').split(/\s+/).some(token=>token.startsWith(prefix+'--'));
      const groups=[...document.querySelectorAll('[class*="skuItem--"]')].filter(el=>visible(el) && family(el,'skuItem'));
      if(groups.length!==2) throw new Error('exact_color_and_size_groups_required');
      for(const group of groups) {
        const labelNode=one(group,'[class*="ItemLabel--"]'), label=clean(labelNode.innerText), dimension=dimensionFor(label);
        if(!dimension || options.some(o=>o.dimension===dimension)) throw new Error('unsupported_variant_labels');
        const values=[...group.querySelectorAll('[class*="valueItem--"]')].filter(el=>visible(el) && family(el,'valueItem'));
        if(!values.length || values.length>80) throw new Error('ambiguous_variant_options');
        const evidence=values.map(el=>{
          const raw=clean(el.innerText);
          // Remove only the specific auxiliary text observed in the current product controls.
          const canonical=dimension==='color' ? raw.replace(/\s+(?:万人加购|多人加购|\d+(?:\.\d+)?万?\+?人加购)$/, '') : raw.replace(/\s+建议\s*\d+(?:\.\d+)?\s*[-~—至]\s*\d+(?:\.\d+)?\s*斤$/, '');
          if(!canonical || canonical.length>100 || raw.length>200) throw new Error('ambiguous_option_label');
          return {label:canonical,raw,classes:clean(el.getAttribute('class')),selected:family(el,'isSelected') || el.getAttribute('aria-selected')==='true',
            disabled:family(el,'isDisabled') || el.getAttribute('aria-disabled')==='true' || el.disabled===true};
        });
        if(new Set(evidence.map(x=>x.label)).size!==evidence.length) throw new Error('duplicate_option_identity');
        const indexes=evidence.flatMap((x,i)=>x.selected ? [i] : []);
        if(indexes.length!==1) throw new Error('manual_color_size_selection_required');
        const index=indexes[0], selected=evidence[index], selectedNode=values[index];
        if(selected.disabled) throw new Error('selected_option_unavailable');
        // No invented merchant SKU ID: exact labels plus actual nodes are the identity.
        options.push({dimension,group:label,id:null,label:selected.label});
        variantEvidence.push({dimension,group:label,values:evidence});
        nodes.push(group,labelNode,selectedNode);
      }
      quantityNode=one(document,'input[class*="countValue--"]');
      if(!family(quantityNode,'countValue') || !quantityNode.closest('[class*="countWrapper--"]')) throw new Error('product_quantity_control_required');
      titleNode=document.documentElement; title=clean(document.title);
      const foot=one(root,'#tbpcDetail_SkuPanelFoot');
      const actions=one(foot,'[class*="Actions--"]');
      const candidates=[...actions.querySelectorAll('button')].filter(el=>visible(el) && family(el,'btn') && family(el,'leftBtn') && ['加入购物车','加入购物袋'].includes(clean(el.innerText)));
      if(candidates.length!==1) throw new Error('unique_cart_button_required');
      button=candidates[0]; nodes.push(foot,actions);
    }
    options.sort((a,b)=>a.dimension.localeCompare(b.dimension));
    if (!/^(?:[1-9]|10)$/.test(quantityNode.value) || quantityNode.disabled || quantityNode.readOnly) throw new Error('manual_quantity_1_to_10_required');
    const quantity=Number(quantityNode.value);
    if(!title || title.length>500) throw new Error('product_title_unavailable');
    const buttonLabel=clean(button.innerText), href=button.getAttribute('href');
    // A modern button defaults to type=submit even outside forms. Never permit an associated form.
    const validType=button.tagName!=='BUTTON' || button.type==='button' || (layout==='modern' && button.type==='submit' && button.form===null);
    if(!['加入购物车','加入购物袋'].includes(buttonLabel) || !['A','BUTTON'].includes(button.tagName) ||
        (href!==null && href!=='' && href!=='#') || !validType || button.form ||
        button.closest('form') || ['onclick','formaction','form','target','download'].some(key=>button.getAttribute(key)!==null) || button.disabled || button.getAttribute('aria-disabled')==='true') throw new Error('unsupported_cart_control');
    nodes.push(quantityNode, button);
    const expected=payload.expected;
    const color=options.find(o=>o.dimension==='color').label, size=options.find(o=>o.dimension==='size').label;
    const expectedUrl=new URL(expected.product_url);
    if(expectedUrl.hostname!==u.hostname || expected.item_id!==ids[0] || expected.color!==color || expected.size!==size || expected.quantity!==quantity) throw new Error('expected_selection_mismatch_manual_selection_required');
    const state=globalThis.__commerceCartState || (globalThis.__commerceCartState={document_id:crypto.randomUUID(),review:null});
    const selection={url:location.href, document_id:state.document_id, layout, item_id:ids[0], title, color, size, quantity, options, variant_evidence:variantEvidence, price:null, button:{id:button.id,label:buttonLabel,tag:button.tagName,href,type:button.type || ''}};
    // Identity that actually determines the cart action; excludes volatile promo/sales text.
    const decision={layout, item_id:ids[0], color, size, quantity, options:options.map(o=>[o.dimension,o.label]),
      button:[buttonLabel,button.tagName,button.type||'',href===null?'':href], document_id:state.document_id};
    if(mode==='review') { state.review={nonce:payload.nonce,selection:JSON.stringify(selection),decision:JSON.stringify(decision),nodes,used:false}; return selection; }
    if(mode!=='commit') throw new Error('unsupported_cart_mode');
    const review=state.review;
    if(!review || review.used || review.nonce!==payload.nonce) throw new Error('missing_or_consumed_review');
    review.used=true;
    if(review.decision!==JSON.stringify(decision)) throw new Error('cart_decision_changed');
    if(review.nodes.length!==nodes.length || nodes.some((node,i)=>node!==review.nodes[i])) throw new Error('cart_control_node_changed');
    // No await between the COMPLETE evidence comparison, final URL/deadline check and click.
    if(location.href!==guard.url || Date.now()>=guard.expires_at) throw new Error('page_or_deadline_changed');
    attempted=true; button.click();
    return {status:'attempted_unverified',reason:'server_cart_result_not_verified'};
  } catch(error) {
    if(mode==='commit') return {status:attempted?'unknown':'rejected',reason:attempted?'outcome_not_verified_do_not_retry':String(error.message)};
    return {__bridgeError:String(error.message)};
  }
}

function pageOperation(operation, payload, guard) {
  try {
    // Repeat the strict URL policy inside the isolated world, not just in worker/Python.
    const u = new URL(location.href);
    const routes = {'www.jd.com':['/','/index.html'], 'search.jd.com':['/Search'], 'item.jd.com':null, 'www.taobao.com':['/','/wow/z/tbhome/pcsem/alimama'], 's.taobao.com':['/search'], 's.m.taobao.com':['/h5'], 'item.taobao.com':['/item.htm'], 'www.tmall.com':['/'], 'detail.tmall.com':['/item.htm']};
    const actionKeys = new Set(['action','act','method','command','cmd','operation','op','buy','buynow','addtocart','checkout','pay','submit']);
    const routingKeys = new Set(['redirect','redirecturl','redirecturi','return','returnurl','returnuri','next','nexturl','url','target','targeturl','destination','dest','callback','callbackurl']);
    const platform = u.hostname.endsWith('.jd.com') ? 'jd' : 'taobao';
    // Self-contained: executeScript serializes this function without worker helpers.
    const publicUrl = (url, depth = 0) => {
      if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash ||
          !Object.hasOwn(routes, url.hostname) || !(routes[url.hostname] === null ? /^\/[0-9]+\.html$/.test(url.pathname) : routes[url.hostname].includes(url.pathname))) return false;
      return [...url.searchParams].every(([k,v]) => {
        const key = k.toLowerCase().replace(/[_-]/g, '');
        return !actionKeys.has(key) && !(routingKeys.has(key) && /^(?:[a-zA-Z][a-zA-Z0-9+.-]*:|[/.?])/.test(v) &&
          (depth >= 3 || !publicUrl(new URL(v, url), depth + 1)));
      });
    };
    const queryOk = publicUrl(u);
    if (!guard || !Number.isFinite(guard.expires_at) || Date.now() >= guard.expires_at || guard.url !== location.href || platform !== guard.platform || u.protocol !== 'https:' || u.username || u.password || u.port || u.hash || !(u.hostname in routes) || !(routes[u.hostname] === null ? /^\/[0-9]+\.html$/.test(u.pathname) : routes[u.hostname].includes(u.pathname)) || !queryOk) throw new Error('page_scope_or_deadline_invalid');
    if (['click','type_text','go_back'].includes(operation)) throw new Error('unsafe_operation_disabled');
    const text = document.body?.innerText || '';
    const verification = /滑块|安全验证|异常访问|访问过于频繁|请完成验证|请先验证|拖动下方滑块|拖动到最右边|验证失败|点击框体重试|captcha|人机验证|drag.*verify|verification failed/i.test(text.slice(0,5000));
    if (verification && !['snapshot','page_state'].includes(operation)) throw new Error('manual_verification_required');
    const page = () => ({success:true, url:location.href, title:document.title, requires_user_verification:verification});
    const clean = value => String(value || '').replace(/\s+/g,' ').trim();
    const visible = el => { const r=el.getBoundingClientRect(), s=getComputedStyle(el); return s.visibility !== 'hidden' && s.display !== 'none' && r.width >= 2 && r.height >= 2; };
    const state = globalThis.__commerceMcpState || (globalThis.__commerceMcpState = {generation:crypto.randomUUID(), refs:new Map(), list:'', url:location.href});
    if (state.url !== location.href) { state.refs.clear(); state.url=location.href; state.list=''; }
    if (operation === 'page_state') return page();
    if (operation === 'snapshot') return {...page(), text:text.slice(0,Math.max(1000,Math.min(Number(payload.max_chars)||18000,100000))), links:[...document.querySelectorAll('a[href]')].filter(visible).slice(0,120).map(a=>({text:clean(a.innerText).slice(0,200), href:a.href}))};
    if (operation === 'extract_product_basic') {
      const parameters=[];
      for (const el of document.querySelectorAll('.attributes-list li,.tb-attributes li,[class*="Parameter"] li,[class*="parameter"] li,.Ptable-item dl,.p-parameter-list li')) {
        if (!visible(el)) continue;
        const m=clean(el.innerText).match(/^([^:：]{1,80})[:：]\s*(.+)$/);
        if(m) parameters.push({name:m[1],value:m[2].slice(0,500)});
        if(parameters.length>=80) break;
      }
      return {...page(), product_url:location.href, product_parameters:parameters, good_reviews:[], bad_reviews:[], page_text_excerpt:text.slice(0,10000)};
    }
    const fingerprint = el => JSON.stringify([el.tagName, el.href, el.type, el.name, el.getAttribute('aria-label'), el.getAttribute('title'), clean(el.innerText)]);
    if (operation === 'list_elements') {
      state.refs.clear(); state.list=crypto.randomUUID();
      const elements=[];
      for (const el of document.querySelectorAll('a[href],button,input,textarea,select,[role="button"]')) {
        if(!visible(el)) continue;
        const ref=`${state.generation}:${state.list}:${elements.length}`;
        state.refs.set(ref,{el, fingerprint:fingerprint(el)});
        elements.push({ref, tag:el.tagName.toLowerCase(), text:clean(el.innerText).slice(0,240), href:el.href||'', actions:[]});
        if(elements.length>=Math.max(1,Math.min(Number(payload.limit)||80,200))) break;
      }
      let product_controls;
      if (platform === 'taobao' && ['item.taobao.com','detail.tmall.com'].includes(u.hostname) && u.pathname === '/item.htm' && !verification) {
        // Bounded product-only diagnostics: never include account fields, arbitrary attributes or input text.
        const meta = el => ({tag:el.tagName.toLowerCase(), id:String(el.id || '').slice(0,100), classes:String(el.getAttribute('class') || '').slice(0,300),
          role:el.getAttribute('role'), selected:el.getAttribute('aria-selected'), checked:el.getAttribute('aria-checked'), disabled:el.disabled === true || el.getAttribute('aria-disabled') === 'true'});
        const ancestry = el => { const rows=[]; for(let node=el?.parentElement; node && node!==document.body && rows.length<4; node=node.parentElement) rows.push(meta(node)); return rows; };
        const groups = [...document.querySelectorAll('[class*="skuItem--"],.tb-skin ul[data-property]')].filter(visible).slice(0,8).map(group => ({...meta(group),
          label:clean(group.getAttribute('data-property') || group.querySelector('[class*="ItemLabel--"]')?.innerText).slice(0,100),
          options:[...group.querySelectorAll('[class*="valueItem--"],[class*="valueItemImgWrap--"],li[data-value]')].filter(visible).slice(0,40).map(option => ({...meta(option),
            text:clean(option.innerText).slice(0,100), title:clean(option.getAttribute('title')).slice(0,100),
            option_id:/^[0-9]+:[0-9]+$/.test(option.getAttribute('data-value') || '') ? option.getAttribute('data-value') : null}))}));
        const buttons = [...document.querySelectorAll('button,[role="button"],a')].filter(el=>visible(el) && ['加入购物车','加入购物袋'].includes(clean(el.innerText))).slice(0,4).map(el=>({...meta(el),text:clean(el.innerText),type:el.type || '',
          has_navigation:!!el.getAttribute('href') && el.getAttribute('href') !== '#', in_form:!!el.closest('form'), ancestors:ancestry(el)}));
        const quantities = [...document.querySelectorAll('input')].filter(el=>visible(el) && ['text','number',''].includes(el.type || '') &&
          (el.name === 'quantity' || /(?:^|\s)(?:quantity|quantityInput|quantitySelector|countInput|countWrapper|count)--[\w-]+(?:\s|$)/i.test([el.getAttribute('class'),...ancestry(el).map(x=>x.classes)].join(' ')))).slice(0,4).map(el=>({...meta(el),type:el.type || '',
            readonly:el.readOnly === true, min:el.getAttribute('min'), max:el.getAttribute('max'), step:el.getAttribute('step'),
            quantity:/^(?:[1-9]|10)$/.test(el.value) ? Number(el.value) : null, ancestors:ancestry(el)}));
        product_controls = {item_id:/^[0-9]+$/.test(u.searchParams.get('id') || '') ? u.searchParams.get('id') : null, groups, buttons, quantities};
      }
      return {...page(), elements, count:elements.length, ...(product_controls ? {product_controls} : {}), note:'只读元素；通用 DOM 点击和输入已禁用。'};
    }
    if(operation === 'element_metadata') {
      const entry=state.refs.get(payload.ref);
      if(!entry || !entry.el.isConnected || !visible(entry.el) || entry.fingerprint!==fingerprint(entry.el)) throw new Error('stale_element_ref');
      return {...page(), metadata:{text:clean(entry.el.innerText),href:entry.el.href||''}};
    }
    if(operation === 'scroll') { if(!['up','down'].includes(payload.direction)) throw new Error('invalid_direction'); state.refs.clear(); scrollBy(0,(payload.direction==='up'?-1:1)*Math.max(100,Math.min(Number(payload.amount)||900,5000))); return page(); }
    throw new Error('unsupported_operation');
  } catch(error) { return {__bridgeError:String(error.message||error),url:location.href}; }
}
