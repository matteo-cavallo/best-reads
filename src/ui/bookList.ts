import { bridgeJs } from "./bridge.js";
import { cardViewJs } from "./cardView.js";
import { css } from "./theme.js";

export const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark"><title>Library</title>
<style>${css}</style></head>
<body><div id="app" class="muted">Loading…</div>
<script>
${bridgeJs}
${cardViewJs}
var app=document.getElementById("app"),lastList=null,dirty=false;
function message(t,err){app.textContent="";app.appendChild(h("div",{class:err?"err":"muted",text:t}));}
function errText(r){return r&&r.content&&r.content[0]&&r.content[0].text||"Error";}
function loadShelf(shelf){
 var args={limit:30};if(shelf)args.shelf=shelf;
 return BR.callTool("show_shelf",args).then(function(r){if(r&&r.isError)message(errText(r),true);else{dirty=false;render(r.structuredContent);}}).catch(function(e){message(e.message,true);});}
function showCard(sc){
 app.textContent="";
 var back=h("button",{text:"\\u2190 Back"});
 back.onclick=function(){if(dirty)loadShelf(lastList&&lastList.shelf);else if(lastList)render(lastList);};
 var bar=h("div",{style:"margin-bottom:10px"},[lastList?back:null]);
 app.appendChild(bar);
 app.appendChild(renderCard(sc,{onShelf:function(s){
  BR.callTool("set_shelf",{bookId:sc.detail.book.id,shelf:s}).then(function(r){if(r&&r.isError)message(errText(r),true);else{dirty=true;showCard(r.structuredContent);}}).catch(function(e){message(e.message,true);});}}));}
function openBook(id){BR.callTool("get_book",{bookId:id}).then(function(r){if(r&&r.isError)message(errText(r),true);else showCard(r.structuredContent);}).catch(function(e){message(e.message,true);});}
function renderList(sc){
 lastList=sc;app.textContent="";
 app.appendChild(h("h1",{text:sc.title+" ("+sc.total+")"}));
 var chips=h("div",{class:"chips"});
 [[null,"All"],["to-read","To read"],["reading","Reading"],["read","Read"]].forEach(function(c){
  var b=h("button",{text:c[1],class:(sc.shelf||null)===c[0]?"on":""});b.onclick=function(){loadShelf(c[0]);};chips.appendChild(b);});
 app.appendChild(chips);
 if(!sc.items.length){app.appendChild(h("div",{class:"empty muted",text:"No books here yet."}));return;}
 sc.items.forEach(function(it){
  var sub=[it.authors.join(", "),it.firstPublishYear].filter(Boolean).join(" \\u00b7 ");
  var tail=[it.lastFinishedAt?"finished "+it.lastFinishedAt:null,it.noteCount?it.noteCount+" notes":null].filter(Boolean).join(" \\u00b7 ");
  var row=h("div",{class:"row",tabindex:"0",role:"button"},[coverEl(it.coverUrl,it.title,false),
   h("div",{class:"grow"},[h("div",{class:"t",text:it.title}),h("div",{class:"muted small",text:sub}),tail?h("div",{class:"muted small",text:tail}):null]),
   h("div",{style:"text-align:right"},[shelfPill(it.shelf),it.rating?h("div",{class:"stars",text:starsText(it.rating)}):null])]);
  row.onclick=function(){openBook(it.id);};
  row.onkeydown=function(e){if(e.key==="Enter"||e.key===" "){e.preventDefault();openBook(it.id);}};
  app.appendChild(row);});
 if(sc.total>sc.items.length)app.appendChild(h("div",{class:"muted small",text:"Showing "+sc.items.length+" of "+sc.total+"."}));}
function render(sc){
 if(sc&&sc.kind==="book-list")renderList(sc);
 else if(sc&&sc.kind==="book-card")showCard(sc);
 else message("Nothing to show.");}
window.__bestReadsRender=render;
BR.init(function(res){if(res.isError)message(errText(res),true);else render(res.structuredContent);},"best-reads-list");
</script></body></html>`;
