/* Render the local HTML/SVG atlas using installed Chrome. No browser downloads. */
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.ATLAS_PLAYWRIGHT || 'playwright');
const base = process.env.ATLAS_URL || 'http://127.0.0.1:5182/artifact/OpenWorld/WalkthroughAtlas/';
const chrome = process.env.ATLAS_CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
(async () => {
 const browser = await chromium.launch({executablePath: chrome, headless: true});
 try {
  const page = await browser.newPage({viewport:{width:1560,height:1100},deviceScaleFactor:1});
  const errors=[], requests=[], httpErrors=[];
  page.on('pageerror',e=>errors.push(String(e)));
  page.on('response',r=>{if(r.status()>=400)httpErrors.push({url:r.url(),status:r.status()});});
  page.on('request',r=>{if(!new URL(r.url()).hostname.match(/^(127\.0\.0\.1|localhost)$/))requests.push(r.url());});
  const ready=async()=>{await page.waitForSelector('#map-stage svg');await page.evaluate(()=>document.fonts.ready);};
  await page.goto(base,{waitUntil:'networkidle'});await ready();
  await page.screenshot({path:path.join(__dirname,'atlas-desktop.png'),fullPage:true});
  await page.locator('#next-step').click();
  if((await page.evaluate(()=>ATLAS_VIEW.getState())).stepIndex!==1)throw Error('Next step failed');
  await page.locator('#step-select').selectOption('45');
  if(!(await page.locator('#step-body').innerText()).includes('西侧'))throw Error('Workbench approach missing');
  await page.screenshot({path:path.join(__dirname,'atlas-workbench.png'),fullPage:true});
  const contentCheck=await page.evaluate(()=>{
   const issues=[];for(let i=0;i<ATLAS_VIEW.data.route.steps.length;i++){
    ATLAS_VIEW.setStep(i);const st=ATLAS_VIEW.data.route.steps[i];
    if(!document.getElementById('step-title').textContent.includes(st.title))issues.push('title '+i);
    for(const ref of st.entities)if(![...document.querySelectorAll('[data-marker]')].some(e=>e.dataset.marker===ref.markerId))issues.push('target '+i+' '+ref.markerId);
    if(/undefined|\[object Object\]|verifiedApproachWorld/.test(document.getElementById('step-body').textContent))issues.push('unrendered content '+i);
   }
   if(document.querySelectorAll('.quest-list .done').length!==25)issues.push('completion checklist');
   return issues;
  });
  if(contentCheck.length)throw Error(JSON.stringify(contentCheck));
  await page.setViewportSize({width:390,height:844});
  await page.goto(base,{waitUntil:'networkidle'});await ready();
  const overflow=await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1);
  if(overflow)throw Error('Mobile horizontal overflow');
  await page.screenshot({path:path.join(__dirname,'atlas-mobile.png'),fullPage:true});
  await page.setViewportSize({width:1560,height:1100});
  const scenes=await page.evaluate(()=>ATLAS_VIEW.data.atlas.scenes.map(s=>({id:s.id,slug:s.slug})));
  fs.mkdirSync(path.join(__dirname,'maps'),{recursive:true});
  for(const scene of scenes){
   await page.goto(base+'?export=1&scene='+encodeURIComponent(scene.id),{waitUntil:'networkidle'});await ready();
   await page.screenshot({path:path.join(__dirname,'maps',scene.slug+'.png'),fullPage:true});
   const svg=await page.locator('#map-stage svg').evaluate(el=>el.outerHTML);
   fs.writeFileSync(path.join(__dirname,'maps',scene.slug+'.svg'),svg.replaceAll('../../../public/','../../../../public/'));
   console.log('Rendered '+scene.slug);
  }
  const result={ok:errors.length===0&&requests.length===0&&httpErrors.length===0,checkedAt:new Date().toISOString(),maps:scenes.length,steps:80,pageErrors:errors,httpErrors,externalRequests:requests,mobileOverflow:overflow,checks:['step advance','80 steps: titles and target markers','25 item completion checklist','workbench navigation','390px mobile layout','nine local scene map renders']};
  fs.writeFileSync(path.join(__dirname,'presentation-check.json'),JSON.stringify(result,null,2)+'\n');
  console.log(JSON.stringify(result));if(!result.ok)process.exitCode=1;
 } finally {await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
