import { readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const playwrightModule=process.env.ATLAS_PLAYWRIGHT
 ? pathToFileURL(resolve(process.env.ATLAS_PLAYWRIGHT,'index.mjs')).href
 : 'playwright';
const { chromium }=await import(playwrightModule);
const chromePath=process.env.ATLAS_CHROME||'C:/Program Files/Google/Chrome/Application/chrome.exe';
const gameUrl=new URL(process.env.ATLAS_GAME_URL||'http://127.0.0.1:5174/');
for(const [key,value] of Object.entries({mode:'dev',ndbg:'0',narrativeWarp:'开放雾津'})){
 if(!gameUrl.searchParams.has(key))gameUrl.searchParams.set(key,value);
}
const driverPort=Number(process.env.ATLAS_DRIVER_PORT||5184);
if(!Number.isInteger(driverPort)||driverPort<1||driverPort>65535)throw Error('ATLAS_DRIVER_PORT must be an integer from 1 to 65535');
const out=dirname(fileURLToPath(import.meta.url));
const helpers=readFileSync(resolve(out,'../player_driver.js'),'utf8');
const errors=[];
const browser=await chromium.launch({headless:true,executablePath:chromePath,args:['--use-angle=swiftshader','--enable-unsafe-swiftshader','--disable-background-timer-throttling','--disable-renderer-backgrounding']});
const context=await browser.newContext({viewport:{width:1280,height:800},deviceScaleFactor:1});
const page=await context.newPage();
page.on('pageerror',e=>errors.push(String(e)));
page.on('console',m=>{if(['error','warning'].includes(m.type()))errors.push(m.type()+': '+m.text());});
await page.route('**/__gamedraft-api/**',async route=>{
 const req=route.request(),url=new URL(req.url());
 if(url.pathname.endsWith('/runtime-command')) return route.fulfill({status:200,contentType:'application/json',body:'{"ok":true,"commands":[]}'});
 if(req.method()!=='GET') return route.fulfill({status:200,contentType:'application/json',body:'{"ok":true}'});
 return route.continue();
});
await page.goto(gameUrl.href);
await page.waitForFunction(()=>window.__game?.hud&&window.__game.sceneManager.currentSceneData?.id,{timeout:60000});
await page.evaluate('('+helpers+')()');
const server=createServer(async(req,res)=>{
 try{
  let chunks=[];for await(const c of req)chunks.push(c);
  const arg=JSON.parse(Buffer.concat(chunks).toString()||'{}');
  let result;
  if(req.url==='/eval')result=await page.evaluate('('+arg.code+')()');
  else if(req.url==='/shot'){const p=resolve(out,'walkability-'+(arg.name||'scene')+'.png');await page.screenshot({path:p});result=p;}
  else if(req.url==='/errors')result=errors.slice(-80);
  else if(req.url==='/reload'){await page.reload();await page.waitForFunction(()=>window.__game?.hud);await page.evaluate('('+helpers+')()');result=true;}
  else if(req.url==='/save'){writeFileSync(resolve(out,'walkability-'+arg.name+'.json'),JSON.stringify(arg.data,null,2)+'\n');result=true;}
  else if(req.url==='/close'){await browser.close();server.close();result=true;}
  else throw Error('Unknown endpoint');
  res.writeHead(200,{'content-type':'application/json; charset=utf-8'}).end(JSON.stringify({ok:true,result}));
 }catch(e){res.writeHead(500,{'content-type':'application/json; charset=utf-8'}).end(JSON.stringify({ok:false,error:String(e)}));}
});
server.listen(driverPort,'127.0.0.1',()=>console.log(`walkability driver ready on ${driverPort}, isolated browser at ${gameUrl.href}`));
