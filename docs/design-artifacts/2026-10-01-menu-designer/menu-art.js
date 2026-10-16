(function(){
const PAIR={
'elegant-script':{name:'Garden Script',t:["'Pinyon Script',cursive",88,400,'none','0'],h:["'Cormorant Garamond',Georgia,serif",25,700,'0'],b:["'Cormorant Garamond',Georgia,serif",17.5,500],ink:'#2c2238',acc:'#8a6a2f'},
'rustic':{name:'Barn & Ledger',t:["'Rye',Georgia,serif",60,400,'none','.02em'],h:["'Alegreya SC',Georgia,serif",22,700,'.02em'],b:["'Alegreya',Georgia,serif",16,400],ink:'#33251a',acc:'#8e3b1c'},
'modern-clean':{name:'Gallery',t:["'Josefin Sans',sans-serif",54,300,'uppercase','.32em'],h:["'Josefin Sans',sans-serif",18,600,'.1em'],b:["'Karla',sans-serif",15,400],ink:'#1d232b',acc:'#3d5c8c'},
'retro':{name:'Mirror Ball',t:["'Shrikhand',Georgia,serif",68,400,'none','0'],h:["'Righteous',sans-serif",21,400,'.01em'],b:["'Work Sans',sans-serif",15,400],ink:'#2a1838',acc:'#c8336f'},
'spooky':{name:'Hollow',t:["'Creepster',fantasy",84,400,'none','.03em'],h:["'IM Fell English SC',Georgia,serif",23,400,'.02em'],b:["'IM Fell English',Georgia,serif",16,400],ink:'#1f1a15',acc:'#8d2f10'},
'tropical':{name:'Tiki Hour',t:["'Pacifico',cursive",64,400,'none','0'],h:["'Fredoka',sans-serif",22,600,'0'],b:["'Nunito Sans',sans-serif",15,400],ink:'#173a38',acc:'#cf4f37'}};
const CLIENT=[['Periwinkle','#8f9ee6'],['Lilac','#b9a2d8'],['Coral','#ee8a72'],['Plum','#6b3a6e'],['Mustard','#d9a93a']];
const DR=[
{id:'g1',name:'Roscoe’s Paloma',desc:'Tequila, grapefruit, lime, and soda. Bright and a little tart.',glass:'highball',liq:'#f6b0a6',gar:'grapefruit'},
{id:'g2',name:'The Groom’s Old Fashioned',desc:'Bourbon, bitters, orange, and a touch of sugar. Smooth and classic.',glass:'rocks',liq:'#c98a3a',gar:'orangepeel'},
{id:'g3',name:'Lavender Lemon Drop',desc:'Vodka, lemon, and lavender syrup. Floral and crisp.',glass:'martini',liq:'#efe2a0',gar:'lavender'},
{id:'g4',name:'Phoebe’s Garden Spritz',desc:'Aperol, prosecco, and soda. Light and sunny.',glass:'wine',liq:'#f39a4a',gar:'orange'},
{id:'g5',name:'Coral Crush',desc:'Strawberry, lime, mint, and sparkling water.',glass:'highball',liq:'#f58a78',gar:'strawberry',mock:true}];
const ALSO=[['Beer and Wine','Pinot Grigio, Cabernet, Prosecco, Miller Lite, Corona.'],['Spirits','Vodka, Tequila, Bourbon.'],['Non-Alcoholic','Athletic Brewing NA, sparkling water.']];
const SK='stroke="currentColor" stroke-width="2.2" stroke-linejoin="round" stroke-linecap="round"';
function garnish(g,x,y){switch(g){
case 'grapefruit':return `<path d="M${x-11} ${y} A11 11 0 0 1 ${x+11} ${y}Z" fill="#f59a8f" ${SK}/>`;
case 'orangepeel':return `<path d="M${x-4} ${y-16} q12 6 4 16 q-7 10 5 19" fill="none" stroke="#e8892f" stroke-width="3.6" stroke-linecap="round"/>`;
case 'lavender':return `<path d="M${x} ${y+6} L${x+8} ${y-24}" stroke="#6f8f5a" stroke-width="1.6"/>`+[0,1,2,3,4].map(i=>`<ellipse cx="${x+2+i*1.6}" cy="${y-6-i*4.5}" rx="2.6" ry="1.7" fill="#9b7fc7" transform="rotate(-60 ${x+2+i*1.6} ${y-6-i*4.5})"/>`).join('');
case 'orange':return `<circle cx="${x}" cy="${y}" r="10" fill="#f2a03b" ${SK}/>`;
case 'strawberry':return `<path d="M${x} ${y+10} C${x-11} ${y+2} ${x-9} ${y-8} ${x} ${y-6} C${x+9} ${y-8} ${x+11} ${y+2} ${x} ${y+10}Z" fill="#e2433f" ${SK}/>`;
default:return '';}}
function glass(d){const L=d.liq,g=d.gar;let s='';
switch(d.glass){
case 'highball':s=`<path d="M31 34 L34.5 125 Q50 128 65.5 125 L69 34Z" fill="${L}"/><path d="M58 3 L52 112" ${SK}/><path d="M30 18 L34 127 Q50 131 66 127 L70 18" fill="none" ${SK}/><ellipse cx="50" cy="18" rx="20" ry="3.2" fill="none" ${SK}/>`+garnish(g,69,20);break;
case 'rocks':s=`<path d="M26.5 76 L29 123 Q50 127 71 123 L73.5 76Z" fill="${L}"/><rect x="37" y="78" width="25" height="25" rx="3" transform="rotate(-8 49 90)" fill="rgba(255,255,255,.32)" stroke="currentColor" stroke-width="1.4"/><path d="M24 52 L28.5 125 Q50 130 71.5 125 L76 52" fill="none" ${SK}/><ellipse cx="50" cy="52" rx="26" ry="4.2" fill="none" ${SK}/>`+garnish(g,70,60);break;
case 'martini':s=`<path d="M21 31 L79 31 L50 65Z" fill="${L}"/><path d="M12 24 L50 70 L88 24" fill="none" ${SK}/><ellipse cx="50" cy="24" rx="38" ry="3.6" fill="none" ${SK}/><path d="M50 72 L50 122" ${SK}/><ellipse cx="50" cy="124" rx="20" ry="4" fill="none" ${SK}/>`+garnish(g,80,26);break;
case 'wine':s=`<path d="M28.5 44 Q28 72 50 75 Q72 72 71.5 44Z" fill="${L}"/><path d="M30 14 Q22 70 50 77 Q78 70 70 14" fill="none" ${SK}/><ellipse cx="50" cy="14" rx="20" ry="3" fill="none" ${SK}/><path d="M50 77 L50 122" ${SK}/><ellipse cx="50" cy="124" rx="20" ry="4" fill="none" ${SK}/>`+garnish(g,48,52);break;}
return `<svg viewBox="0 0 100 140" style="width:100%;height:100%;overflow:visible;display:block" aria-hidden="true">${s}</svg>`;}
function rng(seed){return function(){seed|=0;seed=seed+0x6D2B79F5|0;let t=Math.imul(seed^seed>>>15,1|seed);t=t+Math.imul(t^t>>>7,61|t)^t;return((t^t>>>14)>>>0)/4294967296}}
function edgePt(r,band){const side=Math.floor(r()*4),along=r()<.62?(r()<.5?r()*.3:1-r()*.3):r(),dep=r()*band;if(side===0)return[along*800,dep];if(side===1)return[800-dep,along*1000];if(side===2)return[along*800,1000-dep];return[dep,along*1000];}
const BGC={};
function bgHTML(v){if(BGC[v])return BGC[v];const r=rng(17+v*97);const pal=['#c9b6e4','#f4a48e','#9fb0e8','#e7c25a','#8e5a8f','#f2b9c9'];let lv='',fl='';
for(let i=0;i<46;i++){const[x,y]=edgePt(r,95);const a=r()*360;lv+=`<ellipse cx="${x}" cy="${y}" rx="${18+r()*14}" ry="${6+r()*4}" fill="${r()<.5?'#9db88f':'#7fa07a'}" opacity=".6" transform="rotate(${a} ${x} ${y})"/>`;}
for(let i=0;i<34;i++){const[x,y]=edgePt(r,80);const rad=14+r()*22;const c=pal[Math.floor(r()*pal.length)];const n=5+Math.floor(r()*2);const rot=r()*72;for(let k=0;k<n;k++){const a=rot+k*360/n;fl+=`<ellipse cx="${x+rad*.48}" cy="${y}" rx="${rad*.56}" ry="${rad*.33}" fill="${c}" opacity=".78" transform="rotate(${a} ${x} ${y})"/>`;}fl+=`<circle cx="${x}" cy="${y}" r="${rad*.2}" fill="${r()<.5?'#e7c25a':'#8e5a8f'}" opacity=".9"/>`;}
const h=`<div style="position:absolute;inset:0;background:radial-gradient(circle at 0% 0%,rgba(201,182,228,.85),transparent 32%),radial-gradient(circle at 100% 6%,rgba(244,164,142,.65),transparent 28%),radial-gradient(circle at 0% 100%,rgba(159,176,232,.75),transparent 32%),radial-gradient(circle at 100% 100%,rgba(201,182,228,.8),transparent 30%),#faf6f8"><svg viewBox="0 0 800 1000" style="position:absolute;inset:0;width:800px;height:1000px">${lv}${fl}</svg></div>`;
BGC[v]=h;return h;}
const SHIM='<div style="position:absolute;inset:0;background:linear-gradient(100deg,transparent 32%,rgba(255,255,255,.6) 50%,transparent 68%);background-size:240% 100%;animation:mdsh 1.4s linear infinite"></div>';
const ORN='<svg viewBox="0 0 230 14" style="width:230px;height:14px" aria-hidden="true"><path d="M0 7 H96 M134 7 H230" stroke="currentColor" stroke-width="1"/><path d="M115 1 L121 7 L115 13 L109 7Z" fill="currentColor"/></svg>';
const ROWS={1:[1],2:[2],3:[3],4:[4],5:[3,2],6:[3,3],7:[4,3],8:[4,4]};
const SLOTW={1:300,2:250,3:200,4:146};
const chunk=l=>{const o=[];let i=0;for(const c of(ROWS[l.length]||[])){o.push(l.slice(i,i+c));i+=c;}return o;};
const esc=s=>String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;');
function menuHTML(o){
  const P=PAIR[o.pairing],ink=P.ink,acc=o.accent||P.acc;
  const vis=DR.filter(d=>!o.hidden[d.id]);const sig=vis.filter(d=>!d.mock),mk=vis.filter(d=>d.mock);
  const rows=chunk(sig).length+chunk(mk).length;
  const il=Math.max(60,(({1:260,2:210,3:160,4:120})[rows]||160)-(o.ilCut||0));
  const bg=o.bgRer?`<div style="position:absolute;inset:0;background:#ebe7ec">${SHIM}</div>`:bgHTML(o.bgV||0);
  const sc='252,248,250';
  const bk=o.backing==='Soft'?`<div style="position:absolute;inset:0;background:radial-gradient(ellipse 50% 50% at 50% 50%,rgba(${sc},.9),rgba(${sc},.72) 62%,rgba(${sc},0) 100%)"></div>`
    :o.backing==='Panel'?`<div style="position:absolute;inset:44px 50px;background:rgba(${sc},.86);border:1px solid ${acc}"></div>`:'';
  const logo=`<div style="width:92px;height:92px;border-radius:50%;box-shadow:inset 0 0 0 1.6px #5b3566,inset 0 0 0 6px transparent,inset 0 0 0 7px #5b3566;display:flex;align-items:center;justify-content:center;font:600 28px 'Cormorant Garamond',serif;color:#5b3566">R&amp;P</div>`;
  const gh=t=>`<div style="display:flex;align-items:center;gap:14px;font-family:${P.h[0]};font-weight:${P.h[2]};font-size:15px;letter-spacing:.22em;text-transform:uppercase;color:${acc}"><i style="width:46px;height:1px;background:currentColor;opacity:.7"></i><span>${t}</span><i style="width:46px;height:1px;background:currentColor;opacity:.7"></i></div>`;
  const slot=(d,w)=>{const sel=o.sel===d.id,run=o.rer&&o.rer[d.id];
    const art=run?`<div style="position:absolute;inset:0;border-radius:12px;border:2.5px dashed rgba(90,90,100,.5);background:rgba(255,255,255,.4);overflow:hidden">${SHIM}</div>`:glass(d);
    return `<div data-id="${d.id}" style="flex:0 0 ${w}px;display:flex;flex-direction:column;align-items:center;gap:6px;position:relative;cursor:pointer;border-radius:10px;${sel?'outline:5px solid #2b78d6;outline-offset:10px;':''}"><div data-art="1" style="height:${il}px;width:${Math.round(il*.72)}px;color:${acc};position:relative">${art}</div><h3 style="margin:0;font-family:${P.h[0]};font-weight:${P.h[2]};font-size:${P.h[1]}px;line-height:1.12;letter-spacing:${P.h[3]};color:${ink};text-wrap:balance">${esc(d.name)}</h3><p style="margin:0;font-family:${P.b[0]};font-weight:${P.b[2]};font-size:${P.b[1]}px;line-height:1.32;color:${ink};text-wrap:balance">${esc(d.desc)}</p></div>`;};
  const group=(l,t)=>l.length?`<div style="display:flex;flex-direction:column;align-items:center;gap:14px;width:100%">${gh(t)}${chunk(l).map(r=>`<div style="display:flex;justify-content:center;gap:16px 26px;width:100%">${r.map(d=>slot(d,SLOTW[r.length])).join('')}</div>`).join('')}</div>`:'';
  const also=`<div style="margin-top:auto;display:flex;flex-direction:column;align-items:center;gap:5px;max-width:560px">${ALSO.map(a=>`<p style="margin:0;font-family:${P.b[0]};font-weight:${P.b[2]};font-size:${P.b[1]}px;line-height:1.35;color:${ink}"><span style="font-family:${P.h[0]};font-weight:${P.h[2]};color:${acc};letter-spacing:.08em;text-transform:uppercase;font-size:.78em;margin-right:.55em">${a[0]}</span>${a[1]}</p>`).join('')}</div>`;
  const mc=o.markColor==='accent'?acc:o.markColor==='gold'?'#d9b77e':ink;
  const mark=o.mark!==false?`<div style="position:absolute;right:40px;bottom:34px;display:flex;align-items:center;gap:8px"><img src="assets/dr-bartender-avatar.png" alt="" style="height:40px;width:auto;display:block"><div role="img" aria-label="Dr. Bartender" style="height:18px;width:159px;background:${mc};-webkit-mask:url(assets/dr-bartender-wordmark.png) center/contain no-repeat;mask:url(assets/dr-bartender-wordmark.png) center/contain no-repeat"></div></div>`:'';
  return `<div style="position:absolute;inset:0;overflow:hidden;-webkit-font-smoothing:antialiased">${bg}${bk}<div data-md-page="1" style="position:relative;height:1000px;box-sizing:border-box;padding:58px 66px 86px;display:flex;flex-direction:column;align-items:center;gap:20px;text-align:center"><header style="display:flex;flex-direction:column;align-items:center;gap:4px">${logo}<h1 style="margin:0;font-family:${P.t[0]};font-size:${P.t[1]}px;font-weight:${P.t[2]};text-transform:${P.t[3]};letter-spacing:${P.t[4]};color:${acc};line-height:1.2">Bar Menu</h1><span style="color:${acc};display:flex">${ORN}</span></header>${group(sig,'Signature Cocktails')}${group(mk,'Mocktails')}${also}</div>${mark}</div>`;}
window.MenuArt={PAIR,CLIENT,DR,menuHTML};
})();
