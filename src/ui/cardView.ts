/** Shared JS: renders a BookCardStructured into DOM (used by book-card and, in place, by book-list). Needs `h` from the bridge. */
export const cardViewJs = `
var SHELF_LABEL={"to-read":"To read","reading":"Reading","read":"Read"};
function starsText(n){n=n||0;return "\\u2605\\u2605\\u2605\\u2605\\u2605".slice(0,n)+"\\u2606\\u2606\\u2606\\u2606\\u2606".slice(0,5-n);}
function coverEl(url,title,big){
 var ini=(title||"?").trim().charAt(0).toUpperCase()||"?",hue=0;
 for(var i=0;i<(title||"").length;i++)hue=(hue*31+title.charCodeAt(i))%360;
 var d=h("div",{class:"cover"+(big?" big":""),style:"background:hsl("+hue+",45%,42%)"});
 if(typeof url==="string"&&url.indexOf("https://")===0){
  var img=h("img",{src:url,alt:"",loading:"lazy"});img.onerror=function(){img.remove();d.textContent=ini;};d.appendChild(img);
 }else d.textContent=ini;
 return d;}
function shelfPill(s){return h("span",{class:"pill",text:s?SHELF_LABEL[s]||s:"No shelf"});}
function renderCard(sc,opts){
 var d=sc.detail,b=d.book,root=h("div");
 if(sc.action)root.appendChild(h("div",{class:"banner",text:sc.action}));
 var latest=null;for(var i=0;i<d.reads.length;i++){if(d.reads[i].rating){latest=d.reads[i].rating;break;}}
 var meta=[b.firstPublishYear,b.pageCount?b.pageCount+" pages":null,b.publisher].filter(Boolean).join(" \\u00b7 ");
 var sel=h("select",{"aria-label":"Shelf"},[["","No shelf"],["to-read","To read"],["reading","Reading"],["read","Read"]].map(function(o){
  var op=h("option",{value:o[0],text:o[1]});if((d.shelf||"")===o[0])op.selected=true;return op;}));
 sel.onchange=function(){if(opts&&opts.onShelf)opts.onShelf(sel.value||null);};
 root.appendChild(h("div",{class:"head"},[coverEl(b.coverUrl,b.title,true),h("div",{class:"grow"},[
  h("h1",{text:b.title+(b.subtitle?": "+b.subtitle:"")}),
  h("div",{class:"muted",text:b.authors.join(", ")||"Unknown author"}),
  h("div",{class:"muted small",text:meta}),
  h("div",{style:"margin-top:6px;display:flex;gap:8px;align-items:center;flex-wrap:wrap"},[shelfPill(d.shelf),latest?h("span",{class:"stars",text:starsText(latest)}):null,sel])
 ])]));
 if(d.reads.length){root.appendChild(h("h2",{text:"Reading history"}));
  d.reads.forEach(function(r){
   var when=(r.startedAt||"?")+" \\u2192 "+(r.finishedAt||"?");
   root.appendChild(h("div",{class:"note"},[h("div",{},[when+" ",r.rating?h("span",{class:"stars",text:starsText(r.rating)}):null]),r.review?h("div",{class:"muted",text:r.review}):null]));});}
 if(d.notes.length){root.appendChild(h("h2",{text:"Notes & highlights"}));
  d.notes.forEach(function(n){var loc=[n.chapter,n.page?"p."+n.page:null].filter(Boolean).join(", ");
   root.appendChild(h("div",{class:"note "+n.kind},[h("div",{text:n.body}),loc?h("div",{class:"muted small",text:loc}):null]));});}
 if(b.description){root.appendChild(h("h2",{text:"About"}));
  var p=h("div",{class:"desc",text:b.description});p.onclick=function(){p.classList.toggle("open");};root.appendChild(p);}
 return root;}
`;
