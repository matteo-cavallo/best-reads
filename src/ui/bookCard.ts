import { bridgeJs } from "./bridge.js";
import { cardViewJs } from "./cardView.js";
import { css } from "./theme.js";

export const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark"><title>Book</title>
<style>${css}</style></head>
<body><div id="app" class="muted">Loading…</div>
<script>
${bridgeJs}
${cardViewJs}
var app=document.getElementById("app");
function message(t,err){app.textContent="";app.appendChild(h("div",{class:err?"err":"muted",text:t}));}
function render(sc){
 app.textContent="";
 if(sc&&sc.kind==="book-card"){app.appendChild(renderCard(sc,{onShelf:function(s){
  BR.callTool("set_shelf",{bookId:sc.detail.book.id,shelf:s}).then(function(r){if(r&&r.isError)message(r.content&&r.content[0]&&r.content[0].text||"Error",true);else render(r.structuredContent);}).catch(function(e){message(e.message,true);});
 }}));}
 else message("No book to show.");}
window.__bestReadsRender=render;
BR.init(function(res){if(res.isError)message(res.content&&res.content[0]&&res.content[0].text||"Error",true);else render(res.structuredContent);},"best-reads-card");
</script></body></html>`;
