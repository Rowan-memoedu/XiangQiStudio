import { chromium } from '@playwright/test';
import fs from 'node:fs/promises';
const origin='https://124.221.144.155', base=origin+'/xiangqi/';
const artifacts='D:/Artifacts/XiangQiStudio/screenshots';
await fs.mkdir(artifacts,{recursive:true});
const codes=JSON.parse(await fs.readFile('D:/AppData/XiangQiStudio/invitations.json','utf8'));
const browser=await chromium.launch({executablePath:'C:/Users/fy/AppData/Local/Google/Chrome/Application/chrome.exe',headless:true});
const context=await browser.newContext({viewport:{width:1440,height:1000}});
const page=await context.newPage();
const errors=[];page.on('pageerror',error=>errors.push(error.message));
await page.goto(base,{waitUntil:'networkidle'});
for(const width of [1440,1280,768,414,375,320]){
  await page.setViewportSize({width,height:width===1280?800:900});
  await page.waitForTimeout(250); // Allow responsive layout and screenshot dimensions to settle.
  await page.screenshot({path:artifacts+'/login-'+width+'.png',fullPage:true});
}
const response=await context.request.post(base+'api/login',{headers:{Origin:origin},data:{code:codes['test-a'].invitation_code}});
if(!response.ok())throw new Error('Test login failed: '+response.status());
await page.reload({waitUntil:'networkidle'});
await page.locator('#studio').waitFor({state:'visible'});
await page.locator('#file-name').filter({hasText:'Main.java'}).waitFor();
const layouts=[];
for(const width of [1440,1280,768,414,375,320]){
  await page.setViewportSize({width,height:width>1000?1000:900});
  await page.waitForTimeout(250); // Monaco's ResizeObserver updates after the viewport change.
  await page.screenshot({path:artifacts+'/studio-'+width+'.png',fullPage:true});
  layouts.push(await page.evaluate(()=>({width:innerWidth,body:document.body.scrollWidth,root:document.documentElement.scrollWidth,editor:document.querySelector('#editor').getBoundingClientRect().width,buttons:[...document.querySelectorAll('button')].filter(b=>b.offsetWidth&&b.getBoundingClientRect().right>innerWidth).map(b=>b.textContent)})));
}
const contrast=await page.evaluate(()=>{
  const style=getComputedStyle(document.documentElement),ctx=document.createElement('canvas').getContext('2d');
  const rgb=name=>{ctx.fillStyle=style.getPropertyValue(name).trim();ctx.fillRect(0,0,1,1);return [...ctx.getImageData(0,0,1,1).data].slice(0,3);};
  const lum=v=>v.map(x=>{x/=255;return x<=.04045?x/12.92:((x+.055)/1.055)**2.4;}).reduce((n,x,i)=>n+x*[.2126,.7152,.0722][i],0);
  return [['--color-ink','--color-paper',4.5],['--color-ink','--color-panel',4.5],['--color-muted','--color-paper-2',4.5],['--color-on-accent','--color-accent',4.5],['--color-danger','--color-selected',4.5],['--color-accent','--color-selected',4.5],['--color-focus','--color-paper',3],['--editor-ink','--editor-bg',4.5]].map(([fg,bg,minimum])=>{const a=lum(rgb(fg)),b=lum(rgb(bg));return {fg,bg,minimum,ratio:(Math.max(a,b)+.05)/(Math.min(a,b)+.05)};});
});
await context.close();await browser.close();
console.log(JSON.stringify({errors,layouts,contrast},null,2));
await fs.writeFile('D:/Artifacts/XiangQiStudio/layout-check.json',JSON.stringify({errors,layouts,contrast},null,2));
if(errors.length||layouts.some(l=>l.root>l.width||l.buttons.length)||contrast.some(c=>c.ratio<c.minimum))throw new Error('Layout or contrast check failed');
