import {chromium} from '@playwright/test';
import fs from 'node:fs/promises';
const codes=JSON.parse(await fs.readFile('D:/AppData/XiangQiStudio/invitations.json','utf8'));
const browser=await chromium.launch({executablePath:'C:/Users/fy/AppData/Local/Google/Chrome/Application/chrome.exe',headless:true});
const context=await browser.newContext({viewport:{width:1600,height:1000}}),base='https://124.221.144.155/xiangqi/';
const login=await context.request.post(base+'api/login',{headers:{Origin:'https://124.221.144.155'},data:{code:codes['test-a'].invitation_code}});
const csrf=(await login.json()).csrf;
try{
 const page=await context.newPage();page.on('pageerror',e=>console.log('PAGE ERROR',e.message));await page.goto(base,{waitUntil:'networkidle'});
 await page.locator('#tree button').filter({hasText:'代码导读.md'}).click();
 await page.waitForFunction(()=>document.querySelectorAll('#markdown-preview .markdown-diagram svg').length===17,{},{timeout:60000});
 const metrics=await page.locator('#markdown-preview svg').evaluateAll(svgs=>svgs.map(e=>({texts:e.querySelectorAll('text').length,blankLabels:[...e.querySelectorAll('.node .label')].filter(n=>!n.textContent.trim()).length,foreignObjects:e.querySelectorAll('foreignObject').length})));
 if(metrics.some(m=>!m.texts||m.blankLabels||m.foreignObjects))throw Error('Blank labels: '+JSON.stringify(metrics));
 await fs.writeFile('D:/Artifacts/XiangQiStudio/mermaid/live-results.json',JSON.stringify({diagrams:metrics.length,metrics},null,2));
 await page.locator('#markdown-preview .markdown-diagram').first().screenshot({path:'D:/Artifacts/XiangQiStudio/mermaid/live-overview.png'});
 console.log('PASS deployed guide: 17 diagrams, every node label visible');
}finally{await context.request.post(base+'api/logout',{headers:{Origin:'https://124.221.144.155','X-CSRF-Token':csrf}});await context.close();await browser.close();}
