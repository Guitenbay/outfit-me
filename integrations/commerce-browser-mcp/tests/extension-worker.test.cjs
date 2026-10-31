const {test}=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');
const path=require('node:path');
const {webcrypto}=require('node:crypto');
function harness(){
 const listeners=new Set(), requests=[], updates=[], intervals=new Set(), messages=[];
 const tabs=new Map([[1,{id:1,url:'https://www.taobao.com/',status:'complete'}],[2,{id:2,url:'https://www.jd.com/index.html',status:'complete'}]]);
 const context=vm.createContext({URL,Map,Set,Date,Number,JSON,Math,Error,Promise,TextEncoder,Uint8Array,crypto:webcrypto,AbortSignal,
 setTimeout,clearTimeout,setInterval:(fn)=>{intervals.add(fn);return fn;},clearInterval:fn=>intervals.delete(fn),
 fetch:async(url,options)=>{requests.push({url,options});return {ok:true,json:async()=>({success:true,command:null})};},
 chrome:{permissions:{contains:async()=>true},runtime:{id:'extension',getURL:p=>'chrome-extension://extension/'+p,onMessage:{addListener:fn=>messages.push(fn)}},
 tabs:{query:async query=>{assert.deepEqual(JSON.parse(JSON.stringify(query)),{active:true,currentWindow:true});return [tabs.get(2)];},get:async id=>tabs.get(id),update:async(id,change)=>{updates.push(id);Object.assign(tabs.get(id),change);return tabs.get(id);},onRemoved:{addListener(){}},onUpdated:{addListener:fn=>listeners.add(fn),removeListener:fn=>listeners.delete(fn)}},
 scripting:{executeScript:async()=>[{result:{url:'https://www.taobao.com/',success:true}}]}}});
 vm.runInContext(fs.readFileSync(path.join(__dirname,'../chrome-extension/service-worker.js'),'utf8'),context);
 return {context,listeners,requests,updates,intervals,tabs,messages,run:s=>vm.runInContext(s,context)};
}
test('popup-only status is minimal, independent, and does not revoke on selection change',async()=>{
 const h=harness();seed(h);
 const ask=()=>new Promise(resolve=>h.messages[0]({type:'popup_status'},{id:'extension',url:'chrome-extension://extension/popup.html'},resolve));
 assert.equal(h.messages[0]({type:'popup_status'},{id:'extension',url:'https://www.taobao.com/'},()=>assert.fail('untrusted sender')),false);
 assert.equal(h.messages[0]({type:'popup_status'},{id:'other',url:'chrome-extension://extension/popup.html'},()=>assert.fail('wrong extension')),false);
 let status=await ask();
 assert.deepEqual(JSON.parse(JSON.stringify(status)),{success:true,platforms:{jd:{connected:false},taobao:{connected:true}},current:{state:'ready',platform:'jd',reason:null,matchesGrant:false,tabId:2}});
 h.context.chrome.tabs.query=async()=>[h.tabs.get(1)];
 status=await ask();assert.equal(status.current.matchesGrant,true);
 h.context.chrome.tabs.query=async()=>[h.tabs.get(2)];await ask();
 assert.equal(h.run('sessions.size'),1);assert.equal(h.requests.length,0);assert.equal(h.updates.length,0);
 assert(!JSON.stringify(status).includes('fake'));assert(!JSON.stringify(status).includes('https:'));
});
test('popup status handles unavailable, loading, blocked and query failure without grant mutation',async()=>{
 const h=harness();seed(h);
 for(const [tab,state] of [[{id:2},'unavailable'],[{id:2,url:'https://www.jd.com/index.html',pendingUrl:'https://passport.jd.com/',status:'loading'},'loading'],[{id:2,url:'chrome://extensions/',status:'complete'},'blocked'],[undefined,'unavailable']]){
  h.context.chrome.tabs.query=async()=>tab?[tab]:[];
  const status=await h.run('popupStatus()');assert.equal(status.current.state,state);assert.equal(status.current.tabId,undefined);
 }
 h.context.chrome.tabs.query=async()=>{throw Error('query denied');};
 assert.equal((await h.run('popupStatus()')).current.state,'query_failed');assert.equal(h.run('sessions.size'),1);
});
test('attach rejects pending navigation before replacing any grant',async()=>{
 const h=harness();seed(h);h.tabs.get(1).pendingUrl='https://www.taobao.com/';
 await assert.rejects(h.run("attach({tabId:1,port:8765,token:'x'.repeat(32)})"),/navigation_in_progress/);
 assert.equal(h.run('sessions.get("taobao") === s'),true);assert.equal(h.requests.length,0);
});
test('bounded classification identifies platforms without exposing URLs or values',async()=>{
 const h=harness();
 for(const [url,platform,code,parameter] of [
  ['https://s.taobao.com/search?q=PRIVATE&action=SECRET','taobao','restricted_query_param','action'],
  ['https://s.taobao.com/search?redirect=https%3A%2F%2Fcart.taobao.com%2F%3Ftoken%3DSECRET','taobao','restricted_query_param','redirect'],
  ['https://passport.jd.com/?token=SECRET','jd','restricted_route'],
  ['https://detail.tmall.com/order?token=SECRET','taobao','restricted_route'],
  ['https://jd.com.evil.test/?token=SECRET',null,'unsupported_site'],
  ['not a url',null,'unavailable']]) {
  h.tabs.get(2).url=url;
  const {current}=await h.run('popupStatus()');
  assert.equal(current.platform,platform);assert.equal(current.reason.code,code);assert.equal(current.reason.parameter,parameter);
  assert.equal(current.tabId,undefined);assert.equal(current.matchesGrant,false);
  assert(!JSON.stringify(current).includes('SECRET'));assert(!JSON.stringify(current).includes('PRIVATE'));assert(JSON.stringify(current).length<220);
 }
});
test('attach differentiates invalid page, unavailable bridge, authentication and rejection',async()=>{
 const h=harness();
 const ask=()=>new Promise(resolve=>h.messages[0]({type:'attach',tabId:2,port:8765,token:'x'.repeat(32)},{id:'extension',url:'chrome-extension://extension/popup.html'},resolve));
 h.tabs.get(2).url='https://s.taobao.com/search?action=SECRET';
 let result=await ask();assert.equal(result.error,'page_invalid');assert.equal(result.current.platform,'taobao');assert.equal(result.current.reason.parameter,'action');assert.equal(h.requests.length,0);
 h.tabs.get(2).url='https://www.jd.com/';
 for(const [fetch,code] of [
  [async()=>{throw Error('SECRET network URL');},'bridge_unavailable'],
  [async()=>({ok:false,status:401}),'bridge_unauthorized'],
  [async()=>({ok:false,status:409}),'bridge_rejected'],
  [async()=>({ok:true,json:async()=>({success:false})}),'bridge_rejected']]) {
  h.context.fetch=fetch;result=await ask();assert.equal(result.error,code);assert.equal(result.current,undefined);assert.equal(h.run('sessions.size'),0);assert(!JSON.stringify(result).includes('SECRET'));
 }
});
function seed(h){h.run("globalThis.s={platform:'taobao',tabId:1,port:8765,token:'fake',clientId:'grant',cancel:new Set()};sessions.set('taobao',s);globalThis.c={request_id:'r',client_id:'grant',platform:'taobao',expires_at:Date.now()+5000,operation:'navigate',payload:{url:'https://s.taobao.com/search?q=gym'}};");}
test('scope revocation reports bounded cause and preserves other platform',async()=>{
 const h=harness();seed(h);
 h.run("sessions.set('jd',{platform:'jd',tabId:2,clientId:'other',cancel:new Set()})");
 h.tabs.get(1).url='https://passport.taobao.com/';
 await assert.rejects(h.run('currentTab(s)'),/selected_tab_left_public_shopping_scope/);
 const request=h.requests.find(r=>r.url.endsWith('/v1/detach'));
 assert.equal(JSON.parse(request.options.body).reason,'selected_tab_left_public_shopping_scope');
 assert.equal(h.run("sessions.has('jd')"),true);
 assert.equal(h.run("detachReason(new Error('expired_or_wrong_grant'))"),'command_expired');
 assert.equal(h.run("detachReason(new Error('private arbitrary text'))"),'bridge_connection_failed');
});
test('dual explicit attach and independent disconnect',async()=>{
 const h=harness();
 await h.run("attach({tabId:1,port:8765,token:'x'.repeat(32)})");
 await h.run("attach({tabId:2,port:8765,token:'x'.repeat(32)})");
 assert.equal(h.run('sessions.size'),2);
 await h.run("detach(sessions.get('jd'))");
 assert.equal(h.run("sessions.has('taobao')"),true);
 await h.run("detach(sessions.get('taobao'))");
 assert.equal(h.intervals.size,0);
});
test('immediate complete navigation cleans observer',async()=>{
 const h=harness();seed(h);
 await h.run('runCommand(s,c)');
 assert.deepEqual(h.updates,[1]);assert.equal(h.listeners.size,1); // permanent scope listener only
 assert(h.requests.some(r=>r.url.endsWith('/v1/results')));
});
test('update failure cleans observer; expired and replacement grants cannot execute',async()=>{
 const h=harness();seed(h);
 h.context.chrome.tabs.update=async()=>{throw Error('failed');};
 await h.run('runCommand(s,c)');assert.equal(h.listeners.size,1);
 h.run('c.expires_at=Date.now()-1');
 await assert.rejects(h.run('runCommand(s,c)'),/expired/);
 h.run("c.expires_at=Date.now()+5000;sessions.set('taobao',{clientId:'new'})");
 await assert.rejects(h.run('runCommand(s,c)'),/revoked/);
});
test('navigation timeout and revocation remove observers',async()=>{
 const h=harness();seed(h);h.tabs.get(1).status='loading';
 h.run('c.expires_at=Date.now()+20');
 await h.run('runCommand(s,c)').catch(()=>{});
 assert.equal(h.listeners.size,1);
 seed(h);const pending=h.run('runCommand(s,c)');
 await new Promise(r=>setTimeout(r,5));await h.run('detach(s)');await pending.catch(()=>{});
 assert.equal(h.listeners.size,1);
});
test('heartbeat continues independently while navigation waits',async()=>{
 const h=harness();await h.run("attach({tabId:1,port:8765,token:'x'.repeat(32)})");
 h.run("globalThis.s=sessions.get('taobao');globalThis.c={request_id:'r',client_id:s.clientId,platform:'taobao',expires_at:Date.now()+5000,operation:'navigate',payload:{url:'https://s.taobao.com/search?q=gym'}}");
 h.context.chrome.tabs.update=async(id,change)=>{Object.assign(h.tabs.get(id),change,{status:'loading'});};
 const pending=h.run('runCommand(s,c)');await new Promise(r=>setTimeout(r,5));
 for(const beat of h.intervals) await beat();
 assert(h.requests.some(r=>r.url.endsWith('/v1/heartbeat')));
 await h.run('detach(s)');await pending.catch(()=>{});
});
test('heartbeats survive a navigation longer than the Python lease and result completes',async()=>{
 const h=harness();let now=100000;
 h.context.Date={now:()=>now};
 await h.run("attach({tabId:1,port:8765,token:'x'.repeat(32)})");
 h.run("globalThis.s=sessions.get('taobao');globalThis.c={request_id:'r',client_id:s.clientId,platform:'taobao',expires_at:Date.now()+45000,operation:'navigate',payload:{url:'https://s.taobao.com/search?q=gym'}}");
 h.context.chrome.tabs.update=async(id,change)=>{Object.assign(h.tabs.get(id),change,{status:'loading'});};
 const pending=h.run('runCommand(s,c)');
 await new Promise(r=>setImmediate(r));
 const before=h.requests.filter(r=>r.url.endsWith('/v1/commands/next')).length;
 try {
  for(let i=0;i<15;i++) {
   now+=2000;
   for(const beat of h.intervals) await beat();
   assert.equal(h.run("sessions.get('taobao') === s"),true);
  }
  assert.equal(h.requests.filter(r=>r.url.endsWith('/v1/heartbeat')).length,15);
  assert.equal(h.requests.filter(r=>r.url.endsWith('/v1/commands/next')).length,before);
  h.tabs.get(1).status='complete';
  for(const listener of [...h.listeners]) listener(1,{status:'complete'});
  await pending;
  const response=JSON.parse(h.requests.find(r=>r.url.endsWith('/v1/results')).options.body);
  assert.equal(response.ok,true);assert.equal(h.listeners.size,1);
 } finally {await h.run('detach(s)');await pending.catch(()=>{});}
});
test('worker and injected page deny unsafe operations and account routes',async()=>{
 const h=harness();seed(h);
 for(const operation of ['click','type_text','go_back','eval','cdp']){
  h.context.operation=operation;await h.run('runCommand(s,{...c,operation})');
  const body=JSON.parse(h.requests.at(-1).options.body);assert.equal(body.ok,false);
 }
 for(const url of ['https://i.taobao.com/my_itaobao','https://cart.jd.com/','https://item.jd.com/1.html?action=buy']) {h.context.raw=url;assert.equal(h.run('platformFor(raw)'),null);}
 h.context.location={href:'https://www.taobao.com/'};
 h.context.document={body:{innerText:''},title:''};
 for(const operation of ['click','type_text','go_back']){
 h.context.operation=operation;
 assert.match(h.run("pageOperation(operation,{}, {platform:'taobao',expires_at:Date.now()+1000,url:location.href}).__bridgeError"),/unsafe/);
 }
 assert.match(h.run("pageOperation('snapshot',{}, {platform:'taobao',expires_at:0,url:location.href}).__bridgeError"),/deadline/);
});
test('ordinary parameters pass popup, worker and isolated-world guards on public routes',async()=>{
 const h=harness();
 h.context.document={body:{innerText:''},title:'JD'};
 for(const path of ['/','/index.html']){
  const url=`https://www.jd.com${path}?a=1791970336267&spm=home`;
  h.context.raw=url;h.context.location={href:url};h.tabs.get(2).url=url;
  assert.equal(h.run('platformFor(raw)'),'jd');
  assert.equal((await h.run('popupStatus()')).current.state,'ready');
  assert.equal(h.run("pageOperation('page_state',{}, {platform:'jd',expires_at:Date.now()+1000,url:location.href}).success"),true);
 }
 for(const url of ['https://www.jd.com/?a=','https://www.jd.com/?a=abc&a=buy','https://search.jd.com/Search?keyword=gym&a=123','https://item.jd.com/1.html?tracking=https%3A%2F%2Fcart.jd.com%2F','https://s.taobao.com/search?q=gym&tab=&tab=other','https://item.taobao.com/item.htm?id=1&tab=all','https://www.taobao.com/?unknown=one&unknown=two&source=buy&from=checkout&return=campaign','https://detail.tmall.com/item.htm?id=1&return_url=%2Fitem.htm%3Fid%3D2']){
  h.context.raw=url;h.context.location={href:url};h.tabs.get(2).url=url;
  const platform=url.includes('jd.com')?'jd':'taobao';
  assert.equal(h.run('platformFor(raw)'),platform,url);
  assert.equal((await h.run('popupStatus()')).current.state,'ready');
  h.context.platform=platform;
  assert.equal(h.run("pageOperation('page_state',{}, {platform,expires_at:Date.now()+1000,url:location.href}).success"),true,url);
 }
});
test('Taobao tab is ordinary while sensitive routes and routing parameters remain blocked',async()=>{
 const h=harness();
 const url='https://s.taobao.com/search?page=1&q=Reebok%20Nano%20X5%20%E7%94%B7%20%E8%AE%AD%E7%BB%83%E9%9E%8B&tab=all';
 h.context.raw=url;h.context.location={href:url};h.context.document={body:{innerText:''},title:'search'};
 h.context.chrome.tabs.query=async()=>[{id:1,url,status:'complete'}];
 assert.equal(h.run('platformFor(raw)'),'taobao');
 assert.equal((await h.run('popupStatus()')).current.state,'ready');
 assert.equal(h.run("pageOperation('page_state',{}, {platform:'taobao',expires_at:Date.now()+1000,url:location.href}).success"),true);
 for(const raw of ['https://s.taobao.com/order?tab=all','https://www.jd.com/?action=buy','https://www.jd.com/?ACTION=','https://s.taobao.com/search?add_to_cart=1','https://www.jd.com/?return_url=%2Forder','https://www.jd.com/?next=https%3A%2F%2Fevil.test%2F','https://www.jd.com/?redirect=%2F%3Faction%3Dbuy','https://www.jd.com/?redirect=javascript%3Aalert(1)','http://www.jd.com/','https://user:password@www.jd.com/','https://www.jd.com:444/','https://www.jd.com/#cart']){
  h.context.raw=raw;h.context.location={href:raw};
  assert.equal(h.run('platformFor(raw)'),null,raw);
  assert.match(h.run("pageOperation('page_state',{}, {platform:raw.includes('jd.com')?'jd':'taobao',expires_at:Date.now()+1000,url:location.href}).__bridgeError"),/scope/,raw);
 }
});
test('exact Taobao paid-search landing passes popup, worker and injected guards',async()=>{
 const h=harness();
 h.context.document={body:{innerText:''},title:'landing'};
 const landing='https://www.taobao.com/wow/z/tbhome/pcsem/alimama';
 // Synthetic search/tracking values only.
 for(const url of [landing,
  landing+'?refpid=test&keyword=shirt&bc_fl_src=test&channelSrp=test&msclkid=test&clk1=test&upsId=test',
  landing+'?keyword=shirt&keyword=coat&refpid=&refpid=test&source=buy']) {
  h.context.raw=url;h.context.location={href:url};h.tabs.get(2).url=url;
  assert.equal(h.run('platformFor(raw)'),'taobao');
  const {current}=await h.run('popupStatus()');
  assert.equal(current.state,'ready');assert.equal(current.reason,null);
  assert(!JSON.stringify(current).includes('https:'));assert(!JSON.stringify(current).includes('shirt'));
  assert.equal(h.run("pageOperation('page_state',{}, {platform:'taobao',expires_at:Date.now()+1000,url:location.href}).success"),true);
 }
 for(const [url,code,parameter] of [
  ['https://www.taobao.com/wow/z/tbhome/pcsem/unknown','restricted_route'],
  [landing+'/','restricted_route'],[landing+';extra','restricted_route'],
  ['https://www.tmall.com/wow/z/tbhome/pcsem/alimama','restricted_route'],
  [landing+'?action=buy','restricted_query_param','action'],
  [landing+'?keyword=shirt&ACTION=','restricted_query_param','ACTION'],
  [landing+'?next=https%3A%2F%2Fcart.taobao.com%2Fcart.htm','restricted_query_param','next'],
  [landing+'?next=https%3A%2F%2Fevil.test%2F','restricted_query_param','next'],
  [landing+'?next=%3Faction%3Dbuy','restricted_query_param','next']]) {
  h.context.raw=url;h.context.location={href:url};h.tabs.get(2).url=url;
  assert.equal(h.run('platformFor(raw)'),null);
  const {current}=await h.run('popupStatus()');
  assert.equal(current.state,'blocked');assert.equal(current.reason.code,code);assert.equal(current.reason.parameter,parameter);
  assert.match(h.run("pageOperation('page_state',{}, {platform:'taobao',expires_at:Date.now()+1000,url:location.href}).__bridgeError"),/scope/);
 }
});
test('landing navigation validates actual completed URL and injected result',async()=>{
 const landing='https://www.taobao.com/wow/z/tbhome/pcsem/alimama?keyword=shirt';
 for(const finalUrl of [landing,'https://item.taobao.com/item.htm?id=1',
  'https://www.taobao.com/wow/z/tbhome/pcsem/unknown','https://trade.taobao.com/order/list.htm']) {
  const h=harness();seed(h);h.context.destination=landing;
  h.run('c.payload.url=destination');
  let injected=false;
  h.context.chrome.tabs.update=async(id)=>{h.tabs.get(id).url=finalUrl;return h.tabs.get(id);};
  h.context.chrome.scripting.executeScript=async()=>{injected=true;return [{result:{success:true,url:finalUrl}}];};
  await h.run('runCommand(s,c)').catch(error=>assert.match(error.message,/grant_revoked/));
  const allowed=finalUrl===landing || finalUrl.includes('item.taobao.com');
  assert.equal(injected,allowed);assert.equal(h.run("sessions.has('taobao')"),allowed);
  const response=h.requests.find(r=>r.url.endsWith('/v1/results'));
  if(allowed) assert.equal(JSON.parse(response.options.body).ok,true);
  else assert.equal(response,undefined);
 }
 const h=harness();seed(h);h.context.destination=landing;h.run('c.payload.url=destination');
 h.context.chrome.scripting.executeScript=async()=>[{result:{success:true,url:'https://cart.taobao.com/cart.htm'}}];
 await h.run('runCommand(s,c)');
 const response=JSON.parse(h.requests.find(r=>r.url.endsWith('/v1/results')).options.body);
 assert.equal(response.ok,false);assert.equal(response.error,'invalid_page_result');
});
// Synthetic legacy DOM only: no real Taobao layout/support is claimed.
function cartFixture(h) {
 const node=(tag,text,attrs={})=>({tagName:tag,innerText:text,isConnected:true,id:attrs.id||'',type:attrs.type||'',value:attrs.value||'',disabled:false,readOnly:false,
  getAttribute:k=>Object.hasOwn(attrs,k)?attrs[k]:null,getBoundingClientRect:()=>({width:30,height:20}),classList:{contains:()=>false},closest:()=>null,querySelectorAll:()=>[]});
 const color=node('LI','白色',{'data-value':'1627207:28320'}), size=node('LI','M',{'data-value':'20509:28315'});
 const group=(label,selected)=>{const g=node('UL','',{'data-property':label});g.querySelectorAll=q=>q==='li.tb-selected[data-value]'?[selected]:q==='li[data-value]'?[selected]:[];return g;};
 const groups=[group('颜色分类',color),group('尺码',size)];
 const quantity=node('INPUT','',{name:'quantity',value:'1'}),title=node('H3','Synthetic shirt'), button=node('BUTTON','加入购物车',{id:'J_LinkBasket',type:'button'});
 let clicks=0;button.click=()=>{clicks++;};
 const root=node('DIV',''); root.querySelectorAll=q=>q==='ul[data-property]'?groups:q==='input.tb-text[name="quantity"]'?[quantity]:q==='#J_LinkBasket'?[button]:[];
 h.context.document={body:{innerText:'Synthetic product'},querySelectorAll:q=>q==='.tb-skin'?[root]:q==='.tb-title h3'?[title]:[]};
 h.context.location={href:'https://item.taobao.com/item.htm?id=123'};h.tabs.get(1).url=h.context.location.href;
 h.context.getComputedStyle=()=>({display:'block',visibility:'visible'});
 h.context.expected={product_url:h.context.location.href,item_id:'123',color:'白色',size:'M',quantity:1};
 h.run("globalThis.cartGuard={url:location.href,expires_at:Date.now()+60000};globalThis.review=cartPageOperation('review',{expected,nonce:'nonce'},cartGuard)");
 return {color,size,groups,quantity,title,button,root,clicks:()=>clicks};
}
function cartSeed(h) {
 seed(h);const f=cartFixture(h);h.run("s.allowCart=true;s.epoch=0;globalThis.p={request_id:'synthetic_request_0001',expected_product_url:location.href,expected_item_id:'123',color:'白色',size:'M',quantity:1}");
 h.context.chrome.tabs.query=async()=>[h.tabs.get(1)];
 h.context.chrome.scripting.executeScript=async({args})=>{h.context.injectArgs=args;return [{result:h.run('cartPageOperation(...injectArgs)')}];};
 return f;
}
test('legacy selected SKU adapter makes exactly one attempt, never claims cart success',()=>{
 const h=harness(),f=cartFixture(h);assert.equal(h.run('review.color'),'白色');assert.equal(h.run('review.price'),null);
 assert.equal(h.run("cartPageOperation('commit',{expected,nonce:'nonce',selection:review},cartGuard).status"),'attempted_unverified');
 assert.equal(h.run("cartPageOperation('commit',{expected,nonce:'nonce',selection:review},cartGuard).status"),'rejected');assert.equal(f.clicks(),1);
});
test('selection, quantity, identity, deadline and control changes fail closed',()=>{
 for(const change of [f=>f.color.innerText='黑色',f=>f.quantity.value='2',f=>f.button.getAttribute=k=>k==='href'?'/checkout':null,f=>f.groups.push(f.groups[0]),f=>f.groups[0].querySelectorAll=()=>[],f=>f.groups[0].querySelectorAll=()=>[f.color,f.color],f=>f.button.isConnected=false]){
  const h=harness(),f=cartFixture(h);change(f);
  assert.equal(h.run("cartPageOperation('commit',{expected,nonce:'nonce',selection:review},cartGuard).status"),'rejected');assert.equal(f.clicks(),0);
 }
 const h=harness(),f=cartFixture(h);h.run('cartGuard.expires_at=0');assert.equal(h.run("cartPageOperation('commit',{expected,nonce:'nonce',selection:review},cartGuard).status"),'rejected');assert.equal(f.clicks(),0);
});
test('adapter rejects non-finite deadlines and form/target/download controls',()=>{
 for(const key of ['form','target','download']) {
  const h=harness(),f=cartFixture(h),get=f.button.getAttribute;
  f.button.getAttribute=k=>k===key?'':get(k);
  assert.equal(h.run("cartPageOperation('commit',{expected,nonce:'nonce',selection:review},cartGuard).status"),'rejected');assert.equal(f.clicks(),0);
 }
 const h=harness(),f=cartFixture(h);h.run('cartGuard.expires_at=NaN');
 assert.equal(h.run("cartPageOperation('commit',{expected,nonce:'nonce',selection:review},cartGuard).status"),'rejected');assert.equal(f.clicks(),0);
});
test('unsupported DOM and mismatched expectations cannot prepare an approval',async()=>{
 const h=harness(),f=cartSeed(h);f.size.innerText='L';
 assert.equal((await h.run('prepareCart(s,p)')).status,'not_supported');assert.equal(h.run('s.cart'),undefined);
 f.size.innerText='M';h.context.document.querySelectorAll=()=>[];
 assert.equal((await h.run('prepareCart(s,p)')).status,'not_supported');assert.equal(f.clicks(),0);
});
test('default off, JD, quantity types and duplicate URL ids are rejected',async()=>{
 const h=harness();cartSeed(h);h.run('s.allowCart=false');await assert.rejects(h.run('prepareCart(s,p)'),/disabled/);
 h.run("s.allowCart=true;s.platform='jd'");await assert.rejects(h.run('prepareCart(s,p)'),/disabled/);h.run("s.platform='taobao'");
 for(const quantity of [0,11,1.5,'1',true]){h.context.qty=quantity;await assert.rejects(h.run('prepareCart(s,{...p,quantity:qty})'),/quantity/);}
 await assert.rejects(h.run("prepareCart(s,{...p,expected_product_url:p.expected_product_url+'&id=123'})"),/numeric/);
});
test('worker pending intent is idempotent, popup review-bound, one-shot under concurrency',async()=>{
 const h=harness(),f=cartSeed(h);assert.equal((await h.run('prepareCart(s,p)')).status,'pending_confirmation');
 const nonce=h.run('s.cart.nonce');await h.run('prepareCart(s,p)');assert.equal(h.run('s.cart.nonce'),nonce);
 assert.equal(h.run('cartView(s).review_hash'),undefined);
 await assert.rejects(h.run("confirmCart({request_id:p.request_id,review_hash:'forged'})"),/invalid_review_hash/);
 h.run('globalThis.approval={request_id:p.request_id,review_hash:s.cart.review_hash}');
 const results=await h.run('Promise.all([confirmCart(approval),confirmCart(approval)])');
 assert.equal(results[0].status,'attempted_unverified');assert.equal(f.clicks(),1);
 assert.equal((await h.run('prepareCart(s,p)')).status,'attempted_unverified');assert.equal(f.clicks(),1);
});
test('expiry, navigation/reload and changed selections invalidate approval without click',async()=>{
 for(const kind of ['expiry','reload','selection']){
  const h=harness(),f=cartSeed(h);await h.run('prepareCart(s,p)');h.run('globalThis.approval={request_id:p.request_id,review_hash:s.cart.review_hash}');
  if(kind==='expiry') h.run('s.cart.expires_at=Date.now()-1');
  if(kind==='reload') for(const listener of h.listeners) listener(1,{status:'loading'});
  if(kind==='selection') f.quantity.value='2';
  const status=await h.run('confirmCart(approval)');assert(['expired','cancelled','rejected'].includes(status.status));assert.equal(f.clicks(),0);
 }
});
test('lost execution response is unknown and cannot be retried; status TTL bounded',async()=>{
 const h=harness(),f=cartSeed(h);await h.run('prepareCart(s,p)');h.run('globalThis.approval={request_id:p.request_id,review_hash:s.cart.review_hash}');
 h.context.chrome.scripting.executeScript=async({args})=>{h.context.injectArgs=args;h.run('cartPageOperation(...injectArgs)');throw Error('lost response');};
 assert.equal((await h.run('confirmCart(approval)')).status,'unknown');await h.run('confirmCart(approval)');assert.equal(f.clicks(),1);
 h.run('s.cart.expires_at=Date.now()-400000');assert.equal(h.run('cartView(s).status'),'not_found');assert.equal(h.run('cartRecords(s).size'),0);
});
test('old execution aliases, arbitrary checkout/payment and untrusted runtime senders remain blocked',async()=>{
 const h=harness(),f=cartSeed(h);
 for(const operation of ['execute_add_to_cart','cart_commit','click','checkout','payment','pay']){
  h.context.operation=operation;await h.run('runCommand(s,{...c,operation,payload:{...p,approved:true}})');
  const result=JSON.parse(h.requests.at(-1).options.body);assert.equal(result.ok,false);assert.equal(result.error,'unsafe_or_unsupported_operation');
 }
 assert.equal(h.messages[0]({type:'confirm_add_to_cart'},{id:'extension',url:'https://item.taobao.com/'},()=>assert.fail()),false);assert.equal(f.clicks(),0);
});
async function cartCommand(h, operation, payload) {
 const request_id=webcrypto.randomUUID();h.context.internalCommand={...h.run('c'),request_id,operation,payload};
 await h.run('runCommand(s,internalCommand)');
 return JSON.parse(h.requests.find(r=>r.url.endsWith('/v1/results') && JSON.parse(r.options.body).request_id===request_id).options.body);
}
test('internal review returns only the prepared hash; Agent confirm uses authorized inactive tab once',async()=>{
 const h=harness(),f=cartSeed(h),payload=h.run('p');
 const prepared=await cartCommand(h,'prepare_add_to_cart',payload);
 assert.equal(prepared.ok,true);assert.equal(prepared.result.review_hash,undefined);
 const nonce=h.run('s.cart.nonce');
 const reviewed=await cartCommand(h,'review_add_to_cart',{request_id:payload.request_id});
 assert.equal(reviewed.ok,true);assert.match(reviewed.result.review_hash,/^[0-9a-f]{64}$/);
 assert.equal(reviewed.result.review_hash,h.run('s.cart.review_hash'));assert.equal(h.run('s.cart.nonce'),nonce);
 assert.deepEqual(reviewed.result.selection,prepared.result.selection);
 const status=await cartCommand(h,'get_add_to_cart_status',{request_id:payload.request_id});assert.equal(status.result.review_hash,undefined);
 h.context.chrome.tabs.query=async()=>{assert.fail('Agent confirmation must not query the active tab');};
 const approval={request_id:payload.request_id,review_hash:reviewed.result.review_hash};
 const confirmed=await cartCommand(h,'confirm_add_to_cart',approval);
 assert.equal(confirmed.ok,true);assert.equal(confirmed.result.status,'attempted_unverified');assert.equal(confirmed.result.review_hash,undefined);
 assert.equal(f.clicks(),1);assert.equal(h.run('s.busy'),false);
 const replay=await cartCommand(h,'confirm_add_to_cart',approval);
 assert.equal(replay.result.status,'attempted_unverified');assert.equal(f.clicks(),1);
 assert.equal((await cartCommand(h,'prepare_add_to_cart',payload)).result.status,'attempted_unverified');assert.equal(h.run('s.cart.nonce'),nonce);
 assert.equal((await cartCommand(h,'review_add_to_cart',approval)).result.review_hash,undefined);
});
test('internal confirm claims once and retains its busy lock under concurrent commands and popup replay',async()=>{
 const h=harness(),f=cartSeed(h);await h.run('prepareCart(s,p)');
 const approval={request_id:h.run('p.request_id'),review_hash:h.run('s.cart.review_hash')};
 const execute=h.context.chrome.scripting.executeScript;let release,started;
 const gate=new Promise(resolve=>{release=resolve;}),entered=new Promise(resolve=>{started=resolve;});
 h.context.chrome.scripting.executeScript=async args=>{started();await gate;return execute(args);};
 const first=cartCommand(h,'confirm_add_to_cart',approval);await entered;
 try {
  assert.equal(h.run('s.busy'),true);assert.equal(h.run('s.cart.status'),'consumed');
  const duplicate=await cartCommand(h,'confirm_add_to_cart',approval);assert.equal(duplicate.error,'page_busy');
  assert.equal(h.run('s.busy'),true);
  h.context.approval=approval;assert.equal((await h.run('confirmCart(approval)')).status,'consumed');assert.equal(h.run('s.busy'),true);
 } finally {release();}
 assert.equal((await first).result.status,'attempted_unverified');assert.equal(f.clicks(),1);assert.equal(h.run('s.busy'),false);
 assert.equal(h.requests.filter(r=>r.url.endsWith('/v1/claim')).length,1);
 assert.equal((await cartCommand(h,'confirm_add_to_cart',approval)).result.status,'attempted_unverified');assert.equal(f.clicks(),1);
});
test('internal confirm rejects malformed/mismatched hashes and cannot invent or replace a prepared request',async()=>{
 const h=harness(),f=cartSeed(h),request_id=h.run('p.request_id');
 assert.equal((await cartCommand(h,'review_add_to_cart',{request_id})).result.status,'not_found');
 assert.equal((await cartCommand(h,'confirm_add_to_cart',{request_id,review_hash:'a'.repeat(64),approved:true})).error,'review_mismatch');
 assert.equal(h.run('s.cart'),undefined);
 await h.run('prepareCart(s,p)');const review_hash=h.run('s.cart.review_hash'),nonce=h.run('s.cart.nonce');
 for(const hash of [undefined,null,true,64,'',review_hash.toUpperCase(),'a'.repeat(63),'a'.repeat(65),'a'.repeat(64)+'\n','g'.repeat(64)]) {
  assert.equal((await cartCommand(h,'confirm_add_to_cart',{request_id,review_hash:hash,approved:true})).error,'invalid_review_hash');
 }
 const wrong=(review_hash[0]==='a'?'b':'a')+review_hash.slice(1);
 assert.equal((await cartCommand(h,'confirm_add_to_cart',{request_id,review_hash:wrong})).error,'review_mismatch');
 assert.equal((await cartCommand(h,'confirm_add_to_cart',{request_id:'unprepared_request_0002',review_hash})).error,'review_mismatch');
 for(const id of ['short',request_id+'\n']) assert.equal((await cartCommand(h,'review_add_to_cart',{request_id:id})).error,'invalid_request_id');
 assert.equal(h.run('s.cart.status'),'pending_confirmation');assert.equal(h.run('s.cart.nonce'),nonce);assert.equal(f.clicks(),0);
 await assert.rejects(h.run("prepareCart(s,{...p,size:'L'})"),/request_id_conflict/);
 assert.equal((await cartCommand(h,'prepare_add_to_cart',h.run('({...p,approved:true})'))).result.status,'pending_confirmation');assert.equal(f.clicks(),0);
});
test('Agent confirmation revalidates expiry, epoch, current scope, snapshot and actual nodes',async()=>{
 for(const kind of ['expiry','reload','epoch','selection','node','loading','scope','inactive_record']) {
  const h=harness(),f=cartSeed(h);await h.run('prepareCart(s,p)');
  const approval={request_id:h.run('p.request_id'),review_hash:h.run('s.cart.review_hash')};
  if(kind==='expiry') h.run('s.cart.expires_at=Date.now()-1');
  if(kind==='reload') for(const listener of h.listeners) listener(1,{status:'loading'});
  if(kind==='epoch') h.run('s.epoch++');
  if(kind==='selection') f.quantity.value='2';
  if(kind==='node') {const replacement={...f.quantity};const query=f.root.querySelectorAll;f.root.querySelectorAll=q=>q==='input.tb-text[name="quantity"]'?[replacement]:query(q);}
  if(kind==='loading') h.tabs.get(1).status='loading';
  if(kind==='scope') h.tabs.get(1).url='https://cart.taobao.com/cart.htm';
  if(kind==='inactive_record') h.run('delete s.cart');
  if(kind==='scope') await assert.rejects(cartCommand(h,'confirm_add_to_cart',approval),/grant_revoked/);
  else {
   const confirmed=await cartCommand(h,'confirm_add_to_cart',approval);assert.equal(confirmed.ok,true);
   assert(['expired','cancelled','rejected','unknown'].includes(confirmed.result.status),kind);
   assert.equal((await cartCommand(h,'confirm_add_to_cart',approval)).result.status,confirmed.result.status);
  }
  assert.equal(f.clicks(),0,kind);
 }
});
test('terminal replay uses its original record even after another intent is prepared',async()=>{
 const h=harness(),f=cartSeed(h);await h.run('prepareCart(s,p)');
 const approval={request_id:h.run('p.request_id'),review_hash:h.run('s.cart.review_hash')};
 assert.equal((await cartCommand(h,'confirm_add_to_cart',approval)).result.status,'attempted_unverified');
 await h.run("prepareCart(s,{...p,request_id:'synthetic_request_0002'})");const nonce=h.run('s.cart.nonce');
 assert.equal((await cartCommand(h,'confirm_add_to_cart',approval)).result.status,'attempted_unverified');
 assert.equal(h.run('s.cart.status'),'pending_confirmation');assert.equal(h.run('s.cart.nonce'),nonce);assert.equal(f.clicks(),1);
 assert.equal((await cartCommand(h,'prepare_add_to_cart',h.run('p'))).result.status,'attempted_unverified');
});
test('popup still rejects an inactive authorized tab and never releases another owner busy lock',async()=>{
 const h=harness(),f=cartSeed(h);await h.run('prepareCart(s,p)');h.run('globalThis.approval={request_id:p.request_id,review_hash:s.cart.review_hash}');
 h.context.chrome.tabs.query=async()=>[h.tabs.get(2)];
 assert.equal((await h.run('confirmCart(approval)')).status,'unknown');assert.equal(f.clicks(),0);
 await h.run("prepareCart(s,{...p,request_id:'synthetic_request_0002'})");
 h.run('approval={request_id:s.cart.request_id,review_hash:s.cart.review_hash};s.busy=true');
 assert.equal((await h.run('confirmCart(approval)')).status,'cancelled');assert.equal(h.run('s.busy'),true);assert.equal(f.clicks(),0);
});
test('internal commit uses the shorter intent/transport deadline and validates grant after tab awaits',async()=>{
 for(const shorter of ['command','intent']) {
  const h=harness(),f=cartSeed(h);await h.run('prepareCart(s,p)');
  h.run("globalThis.approval={request_id:p.request_id,review_hash:s.cart.review_hash};c={...c,operation:'confirm_add_to_cart',payload:approval}");
  if(shorter==='command') h.run('c.expires_at=Date.now()+2000');else h.run('s.cart.expires_at=Date.now()+1000');
  const deadline=h.run('Math.min(c.expires_at,s.cart.expires_at)');
  await h.run('runCommand(s,c)');assert.equal(h.context.injectArgs[2].expires_at,deadline);assert.equal(f.clicks(),1);
 }
 for(const kind of ['expired','replaced']) {
  const h=harness(),f=cartSeed(h);await h.run('prepareCart(s,p)');
  h.run("globalThis.approval={request_id:p.request_id,review_hash:s.cart.review_hash};c={...c,operation:'confirm_add_to_cart',payload:approval}");
  let gets=0,injections=0;const get=h.context.chrome.tabs.get;
  h.context.chrome.scripting.executeScript=async()=>{injections++;assert.fail('stale command must not inject');};
  h.context.chrome.tabs.get=async id=>{if(++gets===2) h.run(kind==='expired'?'c.expires_at=Date.now()-1':"sessions.set('taobao',{clientId:'replacement'})");return get(id);};
  await assert.rejects(h.run('runCommand(s,c)'),kind==='expired'?/expired_or_wrong_grant/:/grant_revoked/);
  assert.equal(injections,0);assert.equal(f.clicks(),0);assert.equal(h.run('s.busy'),false);
 }
});

test('product diagnostics expose only bounded product controls and numeric quantity',()=>{
 const h=harness();
 const node=(tag,text,attrs={})=>({tagName:tag,innerText:text,id:attrs.id||'',name:attrs.name||'',type:attrs.type||'',value:attrs.value||'',parentElement:null,
  getAttribute:k=>Object.hasOwn(attrs,k)?attrs[k]:null,getBoundingClientRect:()=>({width:20,height:20}),closest:()=>null});
 const label=node('SPAN','颜色分类'),option=node('DIV','深海蓝',{'class':'valueItem--synthetic selected--synthetic','title':'深海蓝'});
 const group=node('DIV','',{'class':'skuItem--synthetic'});group.querySelector=()=>label;group.querySelectorAll=()=>[option];
 const cart=node('BUTTON','加入购物车',{'class':'cartButton--synthetic',type:'button'});
 const quantity=node('INPUT','',{name:'quantity',type:'text',value:'1'});
 const secret=node('INPUT','',{name:'account',type:'text',value:'PRIVATE_ACCOUNT_VALUE','class':'accountInput--synthetic'});
 h.context.location={href:'https://detail.tmall.com/item.htm?id=123'};
 h.context.document={body:{innerText:'商品'},title:'Product',querySelectorAll:q=>q.includes('skuItem--')?[group]:q==='input'?[quantity,secret]:q==='button,[role="button"],a'?[cart]:[]};
 h.context.getComputedStyle=()=>({visibility:'visible',display:'block'});
 const result=h.run("pageOperation('list_elements',{}, {platform:'taobao',expires_at:Date.now()+1000,url:location.href})");
 assert.equal(result.product_controls.item_id,'123');assert.equal(result.product_controls.groups[0].options[0].text,'深海蓝');
 assert.equal(result.product_controls.quantities.length,1);assert.equal(result.product_controls.quantities[0].quantity,1);
 assert.equal(result.product_controls.buttons[0].text,'加入购物车');assert(!JSON.stringify(result).includes('PRIVATE_ACCOUNT_VALUE'));
 quantity.value='PRIVATE_INPUT_VALUE';
 const invalid=h.run("pageOperation('list_elements',{}, {platform:'taobao',expires_at:Date.now()+1000,url:location.href})");
 assert.equal(invalid.product_controls.quantities[0].quantity,null);assert(!JSON.stringify(invalid).includes('PRIVATE_INPUT_VALUE'));
 h.context.location={href:'https://s.taobao.com/search?q=shirt'};
 const search=h.run("pageOperation('list_elements',{}, {platform:'taobao',expires_at:Date.now()+1000,url:location.href})");
 assert.equal(search.product_controls,undefined);
});

test('refs retain actual node identity, reject removed or mutated nodes',()=>{
 const h=harness();
 const el={tagName:'A',href:'https://item.taobao.com/item.htm?id=1',innerText:'item',isConnected:true,getAttribute:()=>'',getBoundingClientRect:()=>({width:20,height:20})};
 h.context.location={href:'https://www.taobao.com/'};h.context.document={body:{innerText:''},title:'',querySelectorAll:()=>[el]};h.context.getComputedStyle=()=>({visibility:'visible',display:'block'});
 h.run("globalThis.guard={platform:'taobao',expires_at:Date.now()+1000,url:location.href};globalThis.ref=pageOperation('list_elements',{},guard).elements[0].ref");
 assert(h.run("pageOperation('element_metadata',{ref},guard).metadata"));
 el.innerText='buy';assert.match(h.run("pageOperation('element_metadata',{ref},guard).__bridgeError"),/stale/);
 el.innerText='item';el.isConnected=false;assert.match(h.run("pageOperation('element_metadata',{ref},guard).__bridgeError"),/stale/);
});
