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
      'www.taobao.com':['/'], 's.taobao.com':['/search'], 's.m.taobao.com':['/h5'],
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
  return {platforms, current};
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
async function runCommand(s, command) {
  live(s, command);
  const supported = new Set(['navigate','snapshot','extract_product_basic','list_elements','element_metadata','scroll']);
  let response;
  try {
    if (!supported.has(command.operation)) throw new Error('unsafe_or_unsupported_operation');
    await bridge(s, '/v1/claim', {request_id:command.request_id});
    await currentTab(s, command);
    let result;
    if (command.operation === 'navigate') {
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
  live(s, command); // No late response, no routing through a replacement grant.
  await bridge(s, '/v1/results', response);
}
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id || sender.url !== chrome.runtime.getURL('popup.html')) return false;
  (async () => {
    try {
      if (message.type === 'popup_status') {
        sendResponse({success:true, ...await popupStatus()});
        return;
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
  if (!info.url) return;
  for (const s of sessions.values()) if (s.tabId === id && platformFor(info.url) !== s.platform) void detach(s, 'selected_tab_left_public_shopping_scope');
});

function pageOperation(operation, payload, guard) {
  try {
    // Repeat the strict URL policy inside the isolated world, not just in worker/Python.
    const u = new URL(location.href);
    const routes = {'www.jd.com':['/','/index.html'], 'search.jd.com':['/Search'], 'item.jd.com':null, 'www.taobao.com':['/'], 's.taobao.com':['/search'], 's.m.taobao.com':['/h5'], 'item.taobao.com':['/item.htm'], 'www.tmall.com':['/'], 'detail.tmall.com':['/item.htm']};
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
      return {...page(), elements, count:elements.length, note:'只读元素；DOM 点击和输入已禁用。'};
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
