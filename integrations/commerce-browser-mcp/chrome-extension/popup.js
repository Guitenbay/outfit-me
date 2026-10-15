const statusNode = document.getElementById('status');
const currentNode = document.getElementById('current');
const reasonNode = document.getElementById('attach-reason');
const portNode = document.getElementById('port');
const tokenNode = document.getElementById('token');
const attachButton = document.getElementById('attach');
const refreshButton = document.getElementById('refresh');
const names = {jd:'京东', taobao:'淘宝/天猫'};
const origins = {
  jd:['https://www.jd.com/*','https://search.jd.com/*','https://item.jd.com/*'],
  taobao:['https://www.taobao.com/*','https://s.taobao.com/*','https://s.m.taobao.com/*','https://item.taobao.com/*','https://www.tmall.com/*','https://detail.tmall.com/*']
};
let snapshot, busy = false;
const reasons = {
  loading:'当前标签页正在加载或跳转，请等待完成后刷新状态。',
  unavailable:'无法读取当前标签页。请打开公开购物页面，再从扩展图标重新打开弹窗以授予 activeTab 权限。',
  blocked:'此页面不在公开购物页面白名单内。请手动打开对应平台的公开首页、搜索或商品页，再刷新状态。',
  query_failed:'无法查询当前标签页，请重新打开弹窗或刷新状态。'
};
function selectionReason(current) {
  const platform = names[current?.platform] || '对应平台';
  if (current?.state === 'query_failed') return reasons.query_failed;
  switch (current?.reason?.code) {
    case 'unsupported_site': return '当前站点不是支持的京东、淘宝或天猫站点。请手动打开这些平台的公开购物页面，再刷新状态。';
    case 'restricted_route': return `${platform}当前地址属于受限或未知路由（或地址格式不受支持）。请手动返回公开首页、搜索或商品页，再刷新状态；账户及登录页面不可授权。`;
    case 'restricted_query_param': {
      const parameter = current.reason.parameter;
      const label = typeof parameter === 'string' && /^[a-zA-Z][a-zA-Z0-9_]{0,31}$/.test(parameter) ? `「${parameter}」` : '（名称已隐藏）';
      return `${platform}当前地址包含受限查询参数${label}：显式操作参数或指向非公开购物页面的跳转地址不可授权。普通搜索、分页及跟踪参数不受此限制。请手动返回公开购物页面，再刷新状态。`;
    }
    default: return reasons[current?.state] || '正在读取状态…';
  }
}
const attachErrors = {
  bridge_unavailable:'本地桥接服务不可用。请启动或重启 MCP 桥接服务，核对端口后重试；这不表示当前购物页面无效。',
  bridge_unauthorized:'桥接令牌验证失败。请核对本地桥接服务的令牌后重试，勿分享令牌。',
  bridge_rejected:'桥接服务拒绝授权请求。请确认扩展与桥接服务版本一致，并刷新当前页面状态后重试。',
  invalid_bridge_config:'桥接配置无效。请输入有效端口及至少 32 字符的令牌。'
};
function validConfig() {
  const port = Number(portNode.value);
  return Number.isInteger(port) && port >= 1024 && port <= 65535 && tokenNode.value.trim().length >= 32;
}
function render() {
  for (const platform of ['jd','taobao']) {
    const grant = snapshot?.platforms[platform];
    document.getElementById(`state-${platform}`).textContent = `${names[platform]}：${grant ? grant.connected ? '已连接（已有标签页授权）' : '未连接（尚未授权或已断开）' : '状态未知'}`;
    document.getElementById(`detach-${platform}`).disabled = busy || !grant?.connected;
  }
  const current = snapshot?.current;
  const ready = current?.state === 'ready';
  currentNode.textContent = ready ? `当前标签页：${names[current.platform]}，${current.matchesGrant ? '就是已授权标签页' : '尚未授权此标签页'}。` : `当前标签页：${names[current?.platform] ? names[current.platform] + '，' : ''}${selectionReason(current)}`;
  attachButton.textContent = current?.matchesGrant ? '当前标签页已连接' : ready && snapshot.platforms[current.platform].connected ? `替换${names[current.platform]}授权标签页` : ready ? `授权当前${names[current.platform]}标签页` : '授权当前标签页';
  const reason = busy ? '正在处理，请稍候。' : !ready ? selectionReason(current) : current.matchesGrant ? '无需重复授权。切换标签页不会撤销已有授权。' : !validConfig() ? '请输入 1024–65535 的端口及至少 32 字符的桥接令牌。' : '仅点击按钮才会授权；另一平台的授权保持不变。';
  attachButton.disabled = busy || !ready || current.matchesGrant || !validConfig();
  reasonNode.textContent = reason;
  refreshButton.disabled = busy;
}
async function refresh() {
  snapshot = undefined;
  render();
  try {
    const response = await chrome.runtime.sendMessage({type:'popup_status'});
    if (!response?.success) throw new Error('status_failed');
    snapshot = response;
  } catch (_) {
    statusNode.textContent = '读取扩展状态失败，请重新打开弹窗；若扩展刚更新，请先重新加载扩展。';
  }
  render();
}
attachButton.addEventListener('click', async () => {
  if (attachButton.disabled) return;
  const selected = snapshot.current;
  const port = Number(portNode.value), token = tokenNode.value.trim();
  busy = true;
  render();
  try {
    // Request synchronously in this explicit click handler, before the first await.
    const permission = chrome.permissions.request({origins:origins[selected.platform]});
    if (!await permission) throw new Error('需要此平台购物站点权限以跨子域导航。');
    const response = await chrome.runtime.sendMessage({type:'attach', tabId:selected.tabId, port, token});
    if (!response?.success) throw new Error(response?.current ? selectionReason(response.current) : attachErrors[response?.error] || '扩展未能完成授权，请刷新状态后重试。');
    await chrome.storage.local.set({bridgePort:port, bridgeToken:token});
    statusNode.textContent = `${names[selected.platform]} 已授权，另一个平台授权不受影响。`;
  } catch (error) { statusNode.textContent = `授权未完成：${error.message || error}`; }
  finally { busy = false; await refresh(); }
});
for (const platform of ['jd','taobao']) document.getElementById(`detach-${platform}`).addEventListener('click', async () => {
  if (busy) return;
  busy = true;
  render();
  try {
    const response = await chrome.runtime.sendMessage({type:'detach', platform});
    if (!response?.success) throw new Error('断开失败');
    statusNode.textContent = `${names[platform]} 已断开，标签页保持打开。`;
  } catch (_) { statusNode.textContent = '断开请求失败，请刷新状态后重试。'; }
  finally { busy = false; await refresh(); }
});
refreshButton.addEventListener('click', refresh);
for (const input of [portNode, tokenNode]) input.addEventListener('input', render);
render();
(async () => {
  try {
    const values = await chrome.storage.local.get(['bridgePort','bridgeToken']);
    if (values.bridgePort) portNode.value = values.bridgePort;
    if (values.bridgeToken) tokenNode.value = values.bridgeToken;
  } catch (_) { statusNode.textContent = '无法读取已保存配置，请手动输入端口及令牌。'; }
  await refresh();
})();
