'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const {test}=require('node:test');
const html=(extra={})=>({status:200,headers:{'content-type':'text/html; charset=utf-8','content-length':'100'},text:'<title>Example</title>',...extra});
const flush=async()=>{for(let i=0;i<10;i++)await Promise.resolve();};
function env(responder=()=>html()){
 class Empty{};const timers=new Map(),requests=[];let nextTimer=1;
 const obs={Plugin:Empty,PluginSettingTab:Empty,ItemView:Empty,Modal:Empty,SuggestModal:Empty,FuzzySuggestModal:Empty,Notice:Empty,requestUrl:options=>{requests.push(options);return Promise.resolve(responder(options,requests.length));}};
 const c={module:{exports:{}},require:n=>n==='obsidian'?obs:require(n),console:{log(){}},Intl,URL,Buffer,setTimeout:fn=>{const id=nextTimer++;timers.set(id,fn);return id;},clearTimeout:id=>timers.delete(id)};
 vm.runInNewContext(fs.readFileSync(process.env.TOOLKIT_MAIN||path.join(__dirname,'main.js'),'utf8'),c);
 const plugin=new c.module.exports();
 function paste(url='https://example.com/page'){
  let text='',prevented=false;
  const editor={getCursor:()=>({line:0,ch:0}),getLine:()=>text,getValue:()=>text,getRange:(f,t)=>text.slice(f.ch,t.ch),replaceSelection:v=>{text=v;},replaceRange:(v,f,t)=>{text=text.slice(0,f.ch)+v+text.slice(t.ch);},offsetToPos:n=>({line:0,ch:n})};
  const promise=plugin.handlePaste({clipboardData:{getData:()=>url},preventDefault:()=>{prevented=true;}},editor);
  return{promise,result:()=>({text,prevented})};
 }
 return{plugin,paste,requests,timers,expire:()=>{for(const fn of [...timers.values()])fn();}};
}
test('ordinary small HTML keeps automatic title through native HEAD then GET',async()=>{
 const e=env(),p=e.paste();await p.promise;assert.equal(p.result().text,'[Example](https://example.com/page)');assert.deepEqual(e.requests.map(x=>x.method),['HEAD','GET']);assert.equal(e.plugin._linkTitleRequests,0);assert.equal(e.timers.size,0);assert.equal(e.requests[1].headers.Range,'bytes=0-524287');
});
test('unknown length, declared large HTML and non-HTML never start GET',async()=>{
 for(const headers of [{'content-type':'text/html'},{'content-type':'text/html','content-length':'524289'},{'content-type':'application/pdf','content-length':'100'}]){
  const e=env(()=>html({headers})),p=e.paste();await p.promise;assert.equal(p.result().text,'https://example.com/page');assert.deepEqual(e.requests.map(x=>x.method),['HEAD']);assert.equal(e.plugin._linkTitleRequests,0);assert.equal(e.timers.size,0);
 }
});
test('known binary extensions keep native plain paste and start no HEAD',async()=>{
 for(const url of ['https://example.com/file.bin','https://example.com/file.PDF?x=1','https://example.com/file.zip']){
  const e=env(),p=e.paste(url);await p.promise;assert.deepEqual(p.result(),{text:'',prevented:false});assert.equal(e.requests.length,0);
 }
});
test('GET must still be HTML and actual buffered data must stay within parser limit',async()=>{
 for(const response of [html({headers:{'content-type':'application/pdf','content-length':'100'}}),html({arrayBuffer:new ArrayBuffer(524289)})]){
  const e=env(o=>o.method==='HEAD'?html():response),p=e.paste();await p.promise;assert.equal(p.result().text,'https://example.com/page');assert.equal(e.requests.length,2);
 }
});
test('decompressed title response is bounded before HTML matching',async()=>{
 const zlib=require('node:zlib'),compressed=zlib.gzipSync(Buffer.from('<title>'+('A'.repeat(600000))+'</title>'));
 const response=html({headers:{'content-type':'text/html','content-length':String(compressed.length),'content-encoding':'gzip'},arrayBuffer:compressed.buffer.slice(compressed.byteOffset,compressed.byteOffset+compressed.byteLength),text:''});
 const e=env(o=>o.method==='HEAD'?html():response),p=e.paste();await p.promise;assert.equal(p.result().text,'https://example.com/page');assert.equal(e.timers.size,0);
});
test('100 pastes cannot exceed two unresolved HEADs even after wait timeouts',async()=>{
 const resolvers=[];const e=env(()=>new Promise(resolve=>resolvers.push(resolve))),ps=[];
 for(let i=0;i<100;i++)ps.push(e.paste('https://example.com/page'+i));
 assert.equal(e.requests.length,2);assert.equal(e.plugin._linkTitleRequests,2);assert.equal(e.timers.size,2);
 e.expire();await Promise.all(ps.map(p=>p.promise));assert.equal(e.plugin._linkTitleRequests,2);
 const blocked=e.paste();await blocked.promise;assert.equal(e.requests.length,2);assert.equal(blocked.result().prevented,false);
 resolvers.forEach(resolve=>resolve(html()));await flush();assert.equal(e.plugin._linkTitleRequests,0);assert.equal(e.requests.length,2,'timed-out HEAD must not launch GET');
});
test('timed-out GET retains a slot until the underlying native request settles',async()=>{
 let resolveGet;const e=env(o=>o.method==='HEAD'?html():new Promise(resolve=>{resolveGet=resolve;}));const p=e.paste();await flush();assert.equal(e.requests.length,2);assert.equal(e.plugin._linkTitleRequests,1);
 e.expire();await p.promise;assert.equal(p.result().text,'https://example.com/page');assert.equal(e.plugin._linkTitleRequests,1);
 resolveGet(html());await flush();assert.equal(e.plugin._linkTitleRequests,0);assert.equal(p.result().text,'https://example.com/page','late title must not overwrite timeout fallback');
});
test('native request failures release slots and clear wait timers',async()=>{
 const e=env(()=>Promise.reject(Error('offline'))),p=e.paste();await p.promise;assert.equal(p.result().text,'https://example.com/page');assert.equal(e.plugin._linkTitleRequests,0);assert.equal(e.timers.size,0);
});
