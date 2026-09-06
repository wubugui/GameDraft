(() => {
'use strict';
const D=window.WALKTHROUGH_DATA;
if(!D){document.getElementById('step-body').textContent='攻略数据尚未生成。';return;}
const scenes=D.atlas.scenes,steps=D.route.steps,byScene=new Map(scenes.map(s=>[s.id,s]));
const allEntities=new Map(scenes.flatMap(s=>s.entities.map(e=>[e.markerId,{...e,sceneId:s.id}])));
const $=id=>document.getElementById(id),esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const str=v=>typeof v==='string'?v:Array.isArray(v)?v.map(str).join('；'):v?JSON.stringify(v):'';
const labelItem=id=>D.itemNames[id]||id;
const playerText=t=>str(t).replaceAll('主线_吃饭点A','包子铺');
let stepIndex=0,sceneId=steps[0]?.sceneId||scenes[0].id,allPoints=false,selectedMarker=null;
const params=new URLSearchParams(location.search),exportMode=params.has('export');
if(exportMode){document.body.classList.add('export-mode');sceneId=params.get('scene')||sceneId;allPoints=true;$('point-detail').open=true;}
if(params.has('step')){stepIndex=Math.max(0,Math.min(steps.length-1,Number(params.get('step'))||0));if(!params.has('scene'))sceneId=steps[stepIndex].sceneId;}

function minutes(value){if(typeof value==='number')return value;const m=String(value||'07:00').match(/(\d{1,2}):(\d{2})/);return m?Number(m[1])*60+Number(m[2]):420;}
function fmtClock(v){if(typeof v==='number')return String(Math.floor(v/60)).padStart(2,'0')+':'+String(v%60).padStart(2,'0');return str(v);}
function timeIn(min,a,b){a=minutes(a);b=minutes(b);if(a===b)return true;return a<b?(min>=a&&min<b):(min>=a||min<b);}
function narrativeState(){const states={};const outcomes=D.route.chosenOutcomeStates||{};for(let i=0;i<stepIndex;i++){
 const s=steps[i];Object.assign(states,s.stateChecks||{},s.narrativeStatesAfter||{});
 for(const id of s.completedQuestIds||[]){const graph='flow_'+id;const v=outcomes[graph]??outcomes[id];if(typeof v==='string')states[graph]=v;else if(v?.state)states[v.graph||graph]=v.state;}
}return states;}
function condition(c,states,min){if(!c)return true;if(Array.isArray(c))return c.every(x=>condition(x,states,min));if(c.not)return !condition(c.not,states,min);if(c.any)return c.any.some(x=>condition(x,states,min));if(c.all)return c.all.every(x=>condition(x,states,min));if(c.narrative){const state=states[c.narrative];return Array.isArray(c.state)?c.state.includes(state):state===c.state;}if(c.flag==='minutes_of_day'){const v=c.value;return c.op==='>='?min>=v:c.op==='<'?min<v:c.op==='>'?min>v:c.op==='<='?min<=v:min===v;}return true;}
function npcHere(e,sid){const rules=e.scheduleAllEntries;if(!rules?.length)return true;const min=minutes(steps[stepIndex]?.clock?.before),states=narrativeState();const match=rules.find(r=>timeIn(min,r.from,r.to)&&condition(r.conditions,states,min));return match?.scene===sid;}
function targets(step=steps[stepIndex]){return (step.entities||[]).map(e=>typeof e==='string'?(e.includes('::')?e:step.sceneId+'::'+e):(e.markerId||(e.sceneId||step.sceneId)+'::'+(e.id||e.entityId)));}
function nameFor(ref,sid){const k=typeof ref==='string'?(ref.includes('::')?ref:sid+'::'+ref):(ref.markerId||(ref.sceneId||sid)+'::'+(ref.id||ref.entityId));return allEntities.get(k);}
function scheduleText(e){if(e.kind!=='npc')return '';return (e.schedule||[]).map(r=>`${r.from}—${r.to}${r.conditions?.length?'（随任务结果）':''}`).join('；')||str(e.hours)||'按现场出现';}
function deltaHTML(delta){if(!delta)return '';const rows=[];if(delta.coins)rows.push(`${delta.coins>0?'+':''}${delta.coins} 文`);for(const [id,n]of Object.entries(delta.items||{}))if(n)rows.push(`${labelItem(id)} ${n>0?'+':''}${n}`);if(delta.minutes)rows.push(`用时 ${delta.minutes} 分钟`);return rows.map(x=>`<span>${esc(x)}</span>`).join('');}

function drawMap(){
 const s=byScene.get(sceneId);if(!s)return;
 const targetIds=new Set(targets()),stage=$('map-stage'),W=exportMode?1500:Math.max(320,Math.round(stage.clientWidth||1000));
 const H=exportMode?830:Math.round(Math.min(650,Math.max(370,W*.62)));
 const entities=s.entities.filter(e=>allPoints||e.kind!=='npc'||npcHere(e,s.id)||targetIds.has(e.markerId));
 let minX=Math.min(...s.entities.map(e=>e.anchor.x)),maxX=Math.max(...s.entities.map(e=>e.anchor.x)),minY=Math.min(...s.entities.map(e=>e.anchor.y)),maxY=Math.max(...s.entities.map(e=>e.anchor.y));
 for(const e of s.entities)for(const p of e.motion?.route||[]){minX=Math.min(minX,p.x);maxX=Math.max(maxX,p.x);minY=Math.min(minY,p.y);maxY=Math.max(maxY,p.y);}
 const x0=Math.max(0,minX-180),y0=Math.max(0,minY-180),cw=Math.min(s.worldWidth,maxX+180)-x0,ch=Math.min(s.worldHeight,maxY+180)-y0;
 const pad=26,scale=Math.min((W-pad*2)/cw,(H-pad*2)/ch),ox=(W-cw*scale)/2-x0*scale,oy=(H-ch*scale)/2-y0*scale;
 const pt=p=>({x:p.x*scale+ox,y:p.y*scale+oy}),bg=s.background,r=bg.rect;
 let svg=`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(s.name)}位置图"><defs><clipPath id="map-clip"><rect x="0" y="0" width="${W}" height="${H}"/></clipPath></defs><g clip-path="url(#map-clip)"><image href="${esc(bg.fileHref)}" x="${r.x*scale+ox}" y="${r.y*scale+oy}" width="${r.width*scale}" height="${r.height*scale}" preserveAspectRatio="none"/><rect width="${W}" height="${H}" fill="#081710" opacity=".12"/>`;
 const colors={npc:'#ecb551',pickup:'#70d8c0',hotspot:'#9ac9ff',exit:'#f3f3df','mainline-warning':'#ff8b73'};
 for(const e of entities){const path=e.motion?.route;if(path?.length>1){svg+=`<polyline points="${path.map(p=>{const q=pt(p);return q.x+','+q.y;}).join(' ')}" stroke="${colors.npc}" fill="none" stroke-width="2" stroke-dasharray="5 5" opacity=".75"/>`;}}
 const occupied=[],font=W<600?11:exportMode?15:12;
 const ordered=[...entities].sort((a,b)=>Number(targetIds.has(b.markerId))-Number(targetIds.has(a.markerId))||a.anchor.y-b.anchor.y);
 const layout=[];
 for(const e of ordered){const p=pt(e.anchor),isTarget=targetIds.has(e.markerId),isSelected=e.markerId===selectedMarker;
  let short=e.name.replace(/ · .+$/,'').replace(/（[^）]*）/g,'');if(short.length>13)short=short.slice(0,12)+'…';
  const text=e.code+' '+short,tw=(Array.from(text).reduce((a,c)=>a+(c.charCodeAt(0)>255?1:.57),0)*font)+18,th=font+15;
  let best=null;const candidates=[];
  for(let ring=0;ring<7;ring++)for(const angle of [0,Math.PI,-Math.PI/2,Math.PI/2,-.55,.55,Math.PI-.55,Math.PI+.55]){const d=18+ring*24;let x=p.x+Math.cos(angle)*d+(Math.cos(angle)<-.1?-tw:Math.abs(Math.cos(angle))<.1?-tw/2:0);let y=p.y+Math.sin(angle)*d-th/2;x=Math.max(5,Math.min(W-tw-5,x));y=Math.max(5,Math.min(H-th-5,y));candidates.push({x,y});}
  for(const c of candidates){let overlap=0;for(const b of occupied){overlap+=Math.max(0,Math.min(c.x+tw+3,b.x+b.w)-Math.max(c.x-3,b.x))*Math.max(0,Math.min(c.y+th+3,b.y+b.h)-Math.max(c.y-3,b.y));}const distance=Math.hypot(c.x+tw/2-p.x,c.y+th/2-p.y);const score=overlap*100+distance;if(!best||score<best.score)best={...c,score};}
  occupied.push({...best,w:tw,h:th});layout.push({e,p,isTarget,isSelected,text,tw,th,x:best.x,y:best.y});
 }
 for(const q of layout.reverse()){const {e,p,isTarget,isSelected,text,tw,th,x,y}=q,c=colors[e.displayKind]||colors.hotspot,focus=isTarget||isSelected;const edge={x:Math.max(x,Math.min(x+tw,p.x)),y:Math.max(y,Math.min(y+th,p.y))};
  svg+=`<g class="atlas-marker" role="button" aria-label="${esc(e.code+' '+e.name)}" tabindex="0" data-marker="${esc(e.markerId)}"><line x1="${p.x}" y1="${p.y}" x2="${edge.x}" y2="${edge.y}" stroke="#101b15" stroke-width="4"/><line x1="${p.x}" y1="${p.y}" x2="${edge.x}" y2="${edge.y}" stroke="${c}" stroke-width="${focus?2.5:1.4}"/>`;
  if(focus)svg+=`<circle cx="${p.x}" cy="${p.y}" r="14" fill="none" stroke="#fff2b5" stroke-width="3"/>`;
  if(e.kind==='npc')svg+=`<circle cx="${p.x}" cy="${p.y}" r="6" fill="${c}" stroke="#17251c" stroke-width="2"/>`;
  else svg+=`<rect x="${p.x-5}" y="${p.y-5}" width="10" height="10" fill="${c}" stroke="#17251c" stroke-width="2" ${e.displayKind==='hotspot'?`transform="rotate(45 ${p.x} ${p.y})"`:''}/>`;
  svg+=`<rect x="${x}" y="${y}" width="${tw}" height="${th}" rx="3" fill="${focus?'#4e512a':'#17251e'}" fill-opacity=".96" stroke="${c}" stroke-width="${focus?2:1}"/><text x="${x+8}" y="${y+th/2+font*.36}" font-size="${font}" fill="#fff9e6" font-family="Microsoft YaHei,PingFang SC,sans-serif">${esc(text)}</text></g>`;
 }
 const special=steps.filter(st=>st.sceneId===s.id&&st.navigation?.verifiedApproachWorld&&(exportMode||st.id===steps[stepIndex].id));
 if(exportMode||allPoints)for(const n of D.route.navigationNotesOutsideSelectedRoute||[])if(n.sceneId===s.id)special.push({navigation:n});
 const drawn=new Set();for(const st of special){const nav=st.navigation,key=JSON.stringify(nav.verifiedApproachWorld);if(drawn.has(key))continue;drawn.add(key);const p=pt(nav.verifiedApproachWorld);if(nav.referenceWaypoints?.length){const line=nav.referenceWaypoints.map(w=>{const q=pt(w);return q.x+','+q.y;}).join(' ');svg+=`<polyline points="${line}" fill="none" stroke="#13251c" stroke-width="7"/><polyline points="${line}" fill="none" stroke="#fff0a1" stroke-width="3" stroke-dasharray="8 5"/>`;}svg+=`<circle cx="${p.x}" cy="${p.y}" r="8" fill="#ffe69b" stroke="#142b20" stroke-width="3"/><text x="${p.x}" y="${p.y+3.5}" text-anchor="middle" font-size="10" font-weight="bold" fill="#142b20" font-family="Microsoft YaHei,sans-serif">站</text>`;}
 svg+='</g></svg>';stage.innerHTML=svg;
 for(const n of stage.querySelectorAll('[data-marker]')){const activate=()=>selectMarker(n.dataset.marker);n.addEventListener('click',activate);n.addEventListener('keydown',ev=>{if(ev.key==='Enter'||ev.key===' '){ev.preventDefault();activate();}});}
 $('map-title').textContent=s.name;$('map-note').textContent=exportMode?'细线连接编号与真实落点；黄色虚线提示绕行，黄色圆点是指定站位。人物会在工位或巡逻线附近移动，班次见下表。':'编号连线的落点是场景中的真实坐标。人物会走动，请在工位或巡逻线附近找；黄色圆点表示本步指定站位。';$('map-kicker').textContent=exportMode?'场景实景定位图 / 全部班次':(allPoints?'全部班次工位 / 对照下方时段':'按当前步骤时段显示 NPC');$('map-count').textContent=entities.length+' 个标记 · '+(exportMode?'查看图例与点位表':'点编号看说明');
 const rows=entities.map(e=>`<tr><td><button type="button" data-point="${esc(e.markerId)}">${esc(e.code)}</button></td><td>${esc(e.name)}</td><td>${esc(e.accessNote||(e.kind==='npc'?scheduleText(e):(e.kind==='exit'?'通往 '+(byScene.get(e.exit?.targetScene)?.name||e.exit?.targetScene||'剧情目的地'):e.kind==='mainline-warning'?'本路线不要操作':e.kind==='start'?'新试玩出生处':'按步骤中的动作交互')))}</td></tr>`);
 const table=r=>`<table><thead><tr><th>编号</th><th>位置 / 物件</th><th>说明</th></tr></thead><tbody>${r.join('')}</tbody></table>`;
 $('point-table').innerHTML=exportMode?table(rows.slice(0,Math.ceil(rows.length/2)))+table(rows.slice(Math.ceil(rows.length/2))):table(rows);
 for(const b of $('point-table').querySelectorAll('[data-point]'))b.onclick=()=>selectMarker(b.dataset.point);
}

function selectMarker(id){selectedMarker=id;const e=allEntities.get(id);if(!e)return;const scene=byScene.get(e.sceneId);const matches=steps.map((s,i)=>({s,i})).filter(({s})=>targets(s).includes(id));
 $('selected-point').hidden=false;$('selected-point').innerHTML=`<h3>${esc(e.code+' · '+e.name)}</h3><p>${esc(scene.name)} · 图中落点 ${Math.round(e.anchor.x)}, ${Math.round(e.anchor.y)}${e.kind==='npc'?'；人物会在工位 / 巡逻线附近移动。':''}</p>${e.kind==='npc'?`<p>本场景班次：${esc(scheduleText(e))}</p>`:''}${e.accessNote?'<p>'+esc(e.accessNote)+'</p>':''}${e.kind==='mainline-warning'?'<p>本条全任务路线不要操作包子铺。它会推进另一段主线。</p>':''}<p>${matches.length?'相关步骤：'+matches.map(({s,i})=>`<button type="button" data-goto="${i}">${i+1} · ${esc(s.title)}</button>`).join(' '):'其他出口或备用位置；按本步指定点位继续。'}</p>`;
 for(const b of $('selected-point').querySelectorAll('[data-goto]'))b.onclick=()=>setStep(Number(b.dataset.goto));drawMap();}

function renderStep(){const s=steps[stepIndex];if(!s)return;const clock=s.clock||{};$('step-number').textContent=`步骤 ${stepIndex+1} / ${steps.length}`;$('step-clock').textContent=`${clock.routeDayBefore===0?'开局':'路线第 '+(clock.routeDayBefore??clock.day??1)+' 天'} · ${fmtClock(clock.before)}${clock.after!==clock.before?' → '+(clock.routeDayAfter>clock.routeDayBefore?'次日 ':'')+fmtClock(clock.after):''}`;$('step-title').textContent=s.title;
 $('step-location').innerHTML=esc(byScene.get(s.sceneId)?.name||s.sceneId)+' · '+(s.entities||[]).map(ref=>{const e=nameFor(ref,s.sceneId);return e?`<button type="button" data-locate="${esc(e.markerId)}">${esc(e.code+' '+e.name)}</button>`:esc(typeof ref==='string'?ref:ref.id||ref.entityId);}).join(' / ');
 for(const b of $('step-location').querySelectorAll('[data-locate]'))b.onclick=()=>{sceneId=s.sceneId;selectMarker(b.dataset.locate);};
 const actions=Array.isArray(s.operation)?s.operation:[s.operation];$('step-body').innerHTML=actions.map(t=>`<p>${esc(str(t))}</p>`).join('')+(s.options?.length?'<ol>'+s.options.map(t=>`<li>${esc(typeof t==='string'?t:t.text||t.label||'按画面选项继续')}</li>`).join('')+'</ol>':'')+(s.navigation?`<p><strong>怎么走：</strong>${esc(typeof s.navigation==='string'?s.navigation:s.navigation.instruction)}</p>`:'')+(s.notes||[]).filter(n=>!/(根代理|routeDay|原生|实测|测试|flow_|state_|maxStack|场景切换坐标)/.test(n)).map(n=>`<p class="map-note">${esc(playerText(n))}</p>`).join('');
 $('step-check').innerHTML='<strong>看到这些，才进入下一步</strong>'+esc(str(s.visibleCheck));
 $('step-ledger').innerHTML='<strong>本步收支</strong>'+(deltaHTML(s.delta)||'不消耗材料、不花钱。')+(s.inventoryAfter?.coins!==undefined?`<p>完成后应有 <b>${esc(s.inventoryAfter.coins)} 文</b>${s.inventoryAfter.items?'；持有：'+(Object.keys(s.inventoryAfter.items).length?'':'空囊')+Object.entries(s.inventoryAfter.items).filter(([,n])=>n>0).map(([id,n])=>esc(labelItem(id)+'×'+n)).join('、'):''}</p>`:'');
 const next=s.next||{};const e=next.exitId?allEntities.get(s.sceneId+'::'+next.exitId):null;const dest=(next.entityIds||[]).map(id=>allEntities.get(next.sceneId+'::'+id)).filter(Boolean);$('step-next').innerHTML='<strong>下一站 / 出口</strong>'+esc(next.instruction||next.description||next.text||((next.sceneId?byScene.get(next.sceneId)?.name||next.sceneId:'')+(e?'：经 '+e.code+' '+e.name+'，按 E':'')+(dest.length?' → '+dest.map(x=>x.code+' '+x.name).join(' / '):' · '+(next.title||'完成'))));
 $('previous-step').disabled=stepIndex===0;$('next-step').disabled=stepIndex===steps.length-1;$('step-select').value=String(stepIndex);$('scene-select').value=sceneId;
 const chapters=D.route.chapters||[];const found=chapters.find(c=>(c.stepIds||c.steps||[]).includes(s.id))||chapters.find(c=>c.id===s.chapterId);if(found)$('chapter-select').value=found.id;
 const done=new Set(steps.slice(0,stepIndex+1).flatMap(x=>x.completedQuestIds||[]));$('quest-checklist').innerHTML='<div class="quest-list">'+Object.entries(D.questNames).map(([id,name])=>`<span class="${done.has(id)?'done':''}">${done.has(id)?'✓':'○'} ${esc(name)}</span>`).join('')+'</div><p>勾选只表示按攻略走到这一步应完成的任务，不读取你的游戏状态。</p>';
}
function setStep(i){stepIndex=Math.max(0,Math.min(steps.length-1,i));sceneId=steps[stepIndex].sceneId;selectedMarker=null;$('selected-point').hidden=true;render();}
function render(){renderStep();drawMap();}

$('scene-select').innerHTML=scenes.map(s=>`<option value="${esc(s.id)}">${esc(s.name)}</option>`).join('');
$('step-select').innerHTML=steps.map((s,i)=>`<option value="${i}">${i+1}. ${esc(s.title)}</option>`).join('');
const chapters=D.route.chapters||[];$('chapter-select').innerHTML=chapters.length?chapters.map(c=>`<option value="${esc(c.id)}">${esc(c.title||c.name||c.id)}</option>`).join(''):'<option>完整路线</option>';
$('chapter-select').onchange=()=>{const c=chapters.find(x=>x.id===$('chapter-select').value);const id=(c?.stepIds||c?.steps||[])[0];const i=steps.findIndex(s=>s.id===id||s.chapterId===c?.id);if(i>=0)setStep(i);};
$('scene-select').onchange=()=>{sceneId=$('scene-select').value;selectedMarker=null;$('selected-point').hidden=true;drawMap();};
$('all-points').onclick=()=>{allPoints=!allPoints;$('all-points').setAttribute('aria-pressed',String(allPoints));drawMap();};
$('return-route').onclick=()=>{sceneId=steps[stepIndex].sceneId;$('scene-select').value=sceneId;drawMap();};
$('previous-step').onclick=()=>setStep(stepIndex-1);$('next-step').onclick=()=>setStep(stepIndex+1);$('step-select').onchange=()=>setStep(Number($('step-select').value));
const entry=D.route.entry||{};$('entry-notes').innerHTML='<p>本路线固定从新的“开放雾津”试玩起步，先在歇脚点选择早晨。若你的背包或任务已经不同，不要照抄后续库存数字；可对照当前步骤回到未完成的任务。</p><p>目标是完成当前 25 个已接入事件，每个复杂事件只走一种结局。尚未制作的 5 个计划事件、原有主线最终结局不计入这里的“全清”。</p>'+(D.route.assumptions||[]).map(x=>`<p>${esc(str(x))}</p>`).join('');
$('verification-notes').innerHTML='<p>地图由游戏原场景底图与实际世界坐标生成。人物标的是工位与巡逻范围，不是永远不动的坐标；全部点位模式会显示不同时段的工位。</p><p>地图中编号到落点的细线是标注引线，不是穿墙的行走路线。请沿画面中的街巷接近目标；具体出口以每一步说明为准。</p><p>路线材料、金额和时刻来自当前原生数据；实际输入核验与发现的阻碍以同目录 walkability 报告及逐步攻略为准。不把数据核对冒充完整普通新游戏实测。</p>';
window.ATLAS_VIEW={setStep,drawMap,getState:()=>({stepIndex,sceneId,allPoints,steps:steps.length}),exportScene:id=>{sceneId=id;allPoints=true;document.body.classList.add('export-mode');$('point-detail').open=true;render();},data:D};
new ResizeObserver(()=>drawMap()).observe($('map-stage'));render();
})();
