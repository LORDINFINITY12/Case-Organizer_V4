import{t as e}from"./ordinal-BaZOBHJi.js";import{n as t}from"./path-Drcw3oRx.js";import{t as n}from"./arc-CC2UMQd3.js";import{t as r}from"./array-DCLF4a3s.js";import{$t as i,N as a,O as o,Ot as s,Tn as c,Wt as l,Xt as u,Yt as d,Zt as f,dn as p,en as m,pn as h,pt as g,qt as _,un as v,wn as y}from"./markdown-to-pdf-CY9jSw5A.js";import{t as b}from"./chunk-4BX2VUAB-7tgbe0Zc.js";import{t as x}from"./mermaid-parser.core-BY7J7Se8.js";function S(e,t){return t<e?-1:t>e?1:t>=e?0:NaN}function C(e){return e}function w(){var e=C,n=S,i=null,a=t(0),o=t(s),c=t(0);function l(t){var l,u=(t=r(t)).length,d,f,p=0,m=Array(u),h=Array(u),g=+a.apply(this,arguments),_=Math.min(s,Math.max(-s,o.apply(this,arguments)-g)),v,y=Math.min(Math.abs(_)/u,c.apply(this,arguments)),b=y*(_<0?-1:1),x;for(l=0;l<u;++l)(x=h[m[l]=l]=+e(t[l],l,t))>0&&(p+=x);for(n==null?i!=null&&m.sort(function(e,n){return i(t[e],t[n])}):m.sort(function(e,t){return n(h[e],h[t])}),l=0,f=p?(_-u*b)/p:0;l<u;++l,g=v)d=m[l],x=h[d],v=g+(x>0?x*f:0)+b,h[d]={data:t[d],index:l,value:x,startAngle:g,endAngle:v,padAngle:y};return h}return l.value=function(n){return arguments.length?(e=typeof n==`function`?n:t(+n),l):e},l.sortValues=function(e){return arguments.length?(n=e,i=null,l):n},l.sort=function(e){return arguments.length?(i=e,n=null,l):i},l.startAngle=function(e){return arguments.length?(a=typeof e==`function`?e:t(+e),l):a},l.endAngle=function(e){return arguments.length?(o=typeof e==`function`?e:t(+e),l):o},l.padAngle=function(e){return arguments.length?(c=typeof e==`function`?e:t(+e),l):c},l}var T=d.pie,E={sections:new Map,showData:!1,config:T},D=E.sections,O=E.showData,k=structuredClone(T),A={getConfig:y(()=>structuredClone(k),`getConfig`),clear:y(()=>{D=new Map,O=E.showData,l()},`clear`),setDiagramTitle:h,getDiagramTitle:m,setAccTitle:p,getAccTitle:f,setAccDescription:v,getAccDescription:u,addSection:y(({label:e,value:t})=>{if(t<0)throw Error(`"${e}" has invalid value: ${t}. Negative values are not allowed in pie charts. All slice values must be >= 0.`);D.has(e)||(D.set(e,t),c.debug(`added new section: ${e}, with value: ${t}`))},`addSection`),getSections:y(()=>D,`getSections`),setShowData:y(e=>{O=e},`setShowData`),getShowData:y(()=>O,`getShowData`)},j=y((e,t)=>{b(e,t),t.setShowData(e.showData),e.sections.map(t.addSection)},`populateDb`),M={parse:y(async e=>{let t=await x(`pie`,e);c.debug(t),j(t,A)},`parse`)},N=y(e=>`
  .pieCircle{
    stroke: ${e.pieStrokeColor};
    stroke-width : ${e.pieStrokeWidth};
    opacity : ${e.pieOpacity};
  }
  .pieOuterCircle{
    stroke: ${e.pieOuterStrokeColor};
    stroke-width: ${e.pieOuterStrokeWidth};
    fill: none;
  }
  .pieTitleText {
    text-anchor: middle;
    font-size: ${e.pieTitleTextSize};
    fill: ${e.pieTitleTextColor};
    font-family: ${e.fontFamily};
  }
  .slice {
    font-family: ${e.fontFamily};
    fill: ${e.pieSectionTextColor};
    font-size:${e.pieSectionTextSize};
    // fill: white;
  }
  .legend text {
    fill: ${e.pieLegendTextColor};
    font-family: ${e.fontFamily};
    font-size: ${e.pieLegendTextSize};
  }
`,`getStyles`),P=y(e=>{let t=[...e.values()].reduce((e,t)=>e+t,0),n=[...e.entries()].map(([e,t])=>({label:e,value:t})).filter(e=>e.value/t*100>=1);return w().value(e=>e.value).sort(null)(n)},`createPieArcs`),F={parser:M,db:A,renderer:{draw:y((t,r,s,l)=>{c.debug(`rendering pie chart
`+t);let u=l.db,d=i(),f=o(u.getConfig(),d.pie),p=g(r),m=p.append(`g`);m.attr(`transform`,`translate(225,225)`);let{themeVariables:h}=d,[v]=a(h.pieOuterStrokeWidth);v??=2;let y=f.textPosition,b=n().innerRadius(0).outerRadius(185),x=n().innerRadius(185*y).outerRadius(185*y);m.append(`circle`).attr(`cx`,0).attr(`cy`,0).attr(`r`,185+v/2).attr(`class`,`pieOuterCircle`);let S=u.getSections(),C=P(S),w=[h.pie1,h.pie2,h.pie3,h.pie4,h.pie5,h.pie6,h.pie7,h.pie8,h.pie9,h.pie10,h.pie11,h.pie12],T=0;S.forEach(e=>{T+=e});let E=C.filter(e=>(e.data.value/T*100).toFixed(0)!==`0`),D=e(w).domain([...S.keys()]);m.selectAll(`mySlices`).data(E).enter().append(`path`).attr(`d`,b).attr(`fill`,e=>D(e.data.label)).attr(`class`,`pieCircle`),m.selectAll(`mySlices`).data(E).enter().append(`text`).text(e=>(e.data.value/T*100).toFixed(0)+`%`).attr(`transform`,e=>`translate(`+x.centroid(e)+`)`).style(`text-anchor`,`middle`).attr(`class`,`slice`);let O=m.append(`text`).text(u.getDiagramTitle()).attr(`x`,0).attr(`y`,-400/2).attr(`class`,`pieTitleText`),k=[...S.entries()].map(([e,t])=>({label:e,value:t})),A=m.selectAll(`.legend`).data(k).enter().append(`g`).attr(`class`,`legend`).attr(`transform`,(e,t)=>{let n=22*k.length/2;return`translate(216,`+(t*22-n)+`)`});A.append(`rect`).attr(`width`,18).attr(`height`,18).style(`fill`,e=>D(e.label)).style(`stroke`,e=>D(e.label)),A.append(`text`).attr(`x`,22).attr(`y`,14).text(e=>u.getShowData()?`${e.label} [${e.value}]`:e.label);let j=512+Math.max(...A.selectAll(`text`).nodes().map(e=>e?.getBoundingClientRect().width??0)),M=O.node()?.getBoundingClientRect().width??0,N=450/2-M/2,F=450/2+M/2,I=Math.min(0,N),L=Math.max(j,F)-I;p.attr(`viewBox`,`${I} 0 ${L} 450`),_(p,450,L,f.useMaxWidth)},`draw`)},styles:N};export{F as diagram};