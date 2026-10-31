const {test}=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');
const path=require('node:path');
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function harness(options={}) {
 const nodes={},calls=[],permissions=[];
 for(const id of ['status','current','attach-reason','port','token','attach','refresh','state-jd','state-taobao','detach-jd','detach-taobao','cart-review','cart-confirm','cart-cancel']) nodes[id]={value:'',textContent:'',disabled:false,listeners:{},addEventListener(type,fn){this.listeners[type]=fn;}};
 nodes.port.value='8765';nodes.token.value='x'.repeat(32);
 const state={success:true,platforms:{jd:{connected:false},taobao:{connected:true}},current:{state:'ready',platform:'jd',matchesGrant:false,tabId:2}};
 const chrome={storage:{local:{get:async()=>({}),set:async()=>{}}},permissions:{request:args=>{permissions.push(args);return Promise.resolve(true);}},runtime:{sendMessage:async message=>{calls.push(message);if(options.failStatus && message.type==='popup_status') throw Error('offline');if(options.failAction && message.type!=='popup_status') throw Error('offline');return message.type==='popup_status'?state:{success:true};}}};
 const context=vm.createContext({document:{getElementById:id=>nodes[id]},chrome,Number,Error,Date,setInterval:()=>0});
 vm.runInContext(fs.readFileSync(path.join(__dirname,'../chrome-extension/popup.js'),'utf8'),context);
 return {nodes,calls,permissions,state,chrome};
}
test('independent connection labels, authorize/replace/already connected, explicit gesture only',async()=>{
 const h=harness();await tick();
 assert.match(h.nodes['state-taobao'].textContent,/已连接/);assert.match(h.nodes['state-jd'].textContent,/未连接/);
 assert.match(h.nodes.attach.textContent,/授权当前京东/);assert.equal(h.nodes.attach.disabled,false);
 assert.deepEqual(h.calls.map(m=>m.type),['popup_status']);assert.equal(h.permissions.length,0);
 h.state.platforms.jd.connected=true;await h.nodes.refresh.listeners.click();assert.match(h.nodes.attach.textContent,/替换京东/);
 h.state.current.matchesGrant=true;await h.nodes.refresh.listeners.click();assert.match(h.nodes.attach.textContent,/已连接/);assert.equal(h.nodes.attach.disabled,true);
 h.state.current.matchesGrant=false;await h.nodes.refresh.listeners.click();
 const action=h.nodes.attach.listeners.click();assert.equal(h.permissions.length,1);await action;
 assert.deepEqual(h.calls.filter(m=>m.type==='attach').map(m=>m.tabId),[2]);assert.match(h.nodes.status.textContent,/已授权/);
});
test('disabled reasons cover no URL, query failure, loading and blocked pages',async()=>{
 const h=harness();await tick();
 for(const [state,text] of [['unavailable',/activeTab/],['query_failed',/无法查询/],['loading',/正在加载/],['blocked',/白名单/]]){
  h.state.current={state,platform:null,matchesGrant:false};await h.nodes.refresh.listeners.click();
  assert.equal(h.nodes.attach.disabled,true);assert.match(h.nodes['attach-reason'].textContent,text);
 }
 assert.equal(h.permissions.length,0);assert(h.calls.every(m=>m.type==='popup_status'));
});
test('status failure fails closed with actionable error',async()=>{
 const h=harness({failStatus:true});await tick();
 assert.equal(h.nodes.attach.disabled,true);assert.match(h.nodes.status.textContent,/读取扩展状态失败/);assert.match(h.nodes['state-taobao'].textContent,/未知/);
});
test('attach and detach rejection are caught, status refreshed and controls restored',async()=>{
 const h=harness({failAction:true});await tick();
 await h.nodes.attach.listeners.click();assert.match(h.nodes.status.textContent,/授权未完成/);assert.equal(h.nodes.attach.disabled,false);
 await h.nodes['detach-taobao'].listeners.click();assert.match(h.nodes.status.textContent,/断开请求失败/);assert.equal(h.nodes.refresh.disabled,false);
});
test('permission refusal and invalid config never attach',async()=>{
 const h=harness();await tick();h.nodes.token.value='short';h.nodes.token.listeners.input();assert.equal(h.nodes.attach.disabled,true);
 await h.nodes.attach.listeners.click();assert.equal(h.permissions.length,0);
 h.nodes.token.value='x'.repeat(32);h.nodes.token.listeners.input();h.chrome.permissions.request=()=>Promise.resolve(false);
 await h.nodes.attach.listeners.click();assert.match(h.nodes.status.textContent,/站点权限/);assert(!h.calls.some(m=>m.type==='attach'));
});
test('blocked Taobao query has platform-specific safe actionable diagnostics',async()=>{
 const h=harness();await tick();
 h.state.current={state:'blocked',platform:'taobao',matchesGrant:false,reason:{code:'restricted_query_param',parameter:'action'}};
 await h.nodes.refresh.listeners.click();
 assert.match(h.nodes.current.textContent,/淘宝\/天猫/);assert.match(h.nodes['attach-reason'].textContent,/action/);assert.match(h.nodes['attach-reason'].textContent,/查询参数/);
 assert(!h.nodes.current.textContent.includes('京东'));assert.equal(h.nodes.attach.disabled,true);
 h.state.current.reason.parameter='secret=value';await h.nodes.refresh.listeners.click();assert(!h.nodes.current.textContent.includes('secret'));assert.match(h.nodes.current.textContent,/名称已隐藏/);
 for(const [code,text] of [['restricted_route',/受限或未知路由/],['unsupported_site',/不是支持的/]]){
  h.state.current.reason={code};await h.nodes.refresh.listeners.click();assert.match(h.nodes.current.textContent,text);
 }
 assert.equal(h.permissions.length,0);
});
test('attach bridge failures are actionable and distinct from invalid pages',async()=>{
 const h=harness();await tick();
 for(const [error,text] of [['bridge_unavailable',/启动或重启 MCP 桥接服务/],['bridge_unauthorized',/令牌验证失败/],['bridge_rejected',/版本一致/]]){
  h.chrome.runtime.sendMessage=async m=>m.type==='popup_status'?h.state:{success:false,error};
  await h.nodes.attach.listeners.click();assert.match(h.nodes.status.textContent,text);
 }
 h.chrome.runtime.sendMessage=async m=>m.type==='popup_status'?h.state:{success:false,error:'page_invalid',current:{state:'blocked',platform:'taobao',reason:{code:'restricted_query_param',parameter:'tab'}}};
 await h.nodes.attach.listeners.click();assert.match(h.nodes.status.textContent,/淘宝\/天猫.*查询参数「tab」/);assert(!h.nodes.status.textContent.includes('桥接服务不可用'));
});
test('cart renders observed selection as text, requires trusted explicit review-bound gesture',async()=>{
 const h=harness();await tick();h.state.current={state:'ready',platform:'taobao',matchesGrant:true,tabId:1};
 h.state.cart={request_id:'synthetic_request_0001',review_hash:'reviewed-hash',status:'pending_confirmation',expires_at:Date.now()+60000,selection:{title:'<img src=x>',item_id:'123',url:'https://item.taobao.com/item.htm?id=123',color:'白色',size:'M',quantity:1,price:null,options:[]}};
 await h.nodes.refresh.listeners.click();assert.equal(h.nodes['cart-confirm'].disabled,false);assert.match(h.nodes['cart-review'].textContent,/<img src=x>/);assert.match(h.nodes['cart-review'].textContent,/未知/);
 await h.nodes['cart-confirm'].listeners.click({isTrusted:false});assert(!h.calls.some(m=>m.type==='confirm_add_to_cart'));
 await h.nodes['cart-confirm'].listeners.click({isTrusted:true});
 const request=h.calls.find(m=>m.type==='confirm_add_to_cart');assert.equal(request.review_hash,'reviewed-hash');assert.equal(request.request_id,'synthetic_request_0001');
 h.state.cart.expires_at=0;await h.nodes.refresh.listeners.click();assert.equal(h.nodes['cart-confirm'].disabled,true);
});
test('storage failure is visible but status is still read',async()=>{
 const h=harness();h.chrome.storage.local.set=async()=>{throw Error('storage unavailable');};await tick();
 await h.nodes.attach.listeners.click();assert.match(h.nodes.status.textContent,/storage unavailable/);assert(h.calls.filter(m=>m.type==='popup_status').length>=2);
});
