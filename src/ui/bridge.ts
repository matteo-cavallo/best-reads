/**
 * Minimal MCP Apps client (JSON-RPC 2.0 over window.parent.postMessage), embedded as a string in each page.
 * Protocol per @modelcontextprotocol/ext-apps (LATEST_PROTOCOL_VERSION 2026-01-26).
 * Exposes global `BR` and tiny DOM helper `h`.
 */
export const bridgeJs = `
var PROTOCOL="2026-01-26";
function h(tag,attrs,kids){var e=document.createElement(tag);attrs=attrs||{};
 for(var k in attrs){var v=attrs[k];if(v==null)continue;
  if(k==="text")e.textContent=v;else if(k.slice(0,2)==="on")e[k]=v;else e.setAttribute(k,v);}
 (kids||[]).forEach(function(c){if(c==null||c===false)return;e.appendChild(typeof c==="string"?document.createTextNode(c):c);});
 return e;}
var BR=(function(){
 var pending={},nextId=1,onResult=null,standalone=(window.parent===window);
 function send(m){window.parent.postMessage(m,"*");}
 function request(method,params,ms){return new Promise(function(res,rej){var id=nextId++;
  var t=setTimeout(function(){delete pending[id];rej(new Error(method+" timed out"));},ms||15000);
  pending[id]={res:function(r){clearTimeout(t);res(r);},rej:function(e){clearTimeout(t);rej(e);}};
  send({jsonrpc:"2.0",id:id,method:method,params:params||{}});});}
 function notify(method,params){send({jsonrpc:"2.0",method:method,params:params||{}});}
 function applyCtx(ctx){if(!ctx)return;
  if(ctx.theme==="dark"||ctx.theme==="light")document.documentElement.setAttribute("data-theme",ctx.theme);
  var vars=ctx.styles&&ctx.styles.variables;
  if(vars)for(var k in vars){if(typeof vars[k]==="string"&&k.indexOf("--")===0)document.documentElement.style.setProperty(k,vars[k]);}}
 window.addEventListener("message",function(ev){
  if(ev.source!==window.parent)return;var m=ev.data;if(!m||m.jsonrpc!=="2.0")return;
  if(m.method){
   if(m.id!==undefined){
    if(m.method==="ui/resource-teardown")send({jsonrpc:"2.0",id:m.id,result:{}});
    else send({jsonrpc:"2.0",id:m.id,error:{code:-32601,message:"Method not found"}});
   }else if(m.method==="ui/notifications/tool-result"){if(onResult)onResult(m.params||{});}
   else if(m.method==="ui/notifications/host-context-changed")applyCtx(m.params);
  }else if(m.id!==undefined&&pending[m.id]){var p=pending[m.id];delete pending[m.id];
   if(m.error)p.rej(new Error(m.error.message||"error"));else p.res(m.result);}
 });
 function lastHeight(){return Math.ceil(document.documentElement.getBoundingClientRect().height);}
 return{
  standalone:standalone,
  callTool:function(name,args){return request("tools/call",{name:name,arguments:args||{}});},
  openLink:function(url){return request("ui/open-link",{url:url});},
  init:function(cb,name){onResult=cb;if(standalone)return;
   if(typeof ResizeObserver==="function"){var last=0;new ResizeObserver(function(){var hh=lastHeight();if(hh!==last){last=hh;notify("ui/notifications/size-changed",{height:hh});}}).observe(document.body);}
   request("ui/initialize",{appInfo:{name:name||"best-reads",version:"0.1.0"},appCapabilities:{},protocolVersion:PROTOCOL}).then(function(r){
    applyCtx(r&&r.hostContext);notify("ui/notifications/initialized",{});}).catch(function(){});}
 };})();
`;
