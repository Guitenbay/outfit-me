const {test}=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');
const path=require('node:path');
const {webcrypto}=require('node:crypto');
function harness(){
 const listeners=new Set(), requests=[], updates=[], intervals=new Set(), messages=[];
 const tabs=new Map([[1,{id:1,url:'https://www.taobao.com/',status:'complete'}],[2,{id:2,url:'https://www.jd.com/index.html',status:'complete'}]]);
 const context=vm.createContext({URL,Map,Set,Date,Number,JSON,Math,Error,Promise,crypto:webcrypto,AbortSignal,
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
test('refs retain actual node identity, reject removed or mutated nodes',()=>{
 const h=harness();
 const el={tagName:'A',href:'https://item.taobao.com/item.htm?id=1',innerText:'item',isConnected:true,getAttribute:()=>'',getBoundingClientRect:()=>({width:20,height:20})};
 h.context.location={href:'https://www.taobao.com/'};h.context.document={body:{innerText:''},title:'',querySelectorAll:()=>[el]};h.context.getComputedStyle=()=>({visibility:'visible',display:'block'});
 h.run("globalThis.guard={platform:'taobao',expires_at:Date.now()+1000,url:location.href};globalThis.ref=pageOperation('list_elements',{},guard).elements[0].ref");
 assert(h.run("pageOperation('element_metadata',{ref},guard).metadata"));
 el.innerText='buy';assert.match(h.run("pageOperation('element_metadata',{ref},guard).__bridgeError"),/stale/);
 el.innerText='item';el.isConnected=false;assert.match(h.run("pageOperation('element_metadata',{ref},guard).__bridgeError"),/stale/);
});
