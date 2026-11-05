import {chromium,expect} from '@playwright/test';
import fs from 'node:fs/promises';
const base='https://124.221.144.155/xiangqi/',origin='https://124.221.144.155',output='D:/Artifacts/XiangQiStudio/revision';
const codes=JSON.parse(await fs.readFile('D:/AppData/XiangQiStudio/invitations.json','utf8'));
const browser=await chromium.launch({executablePath:'C:/Users/fy/AppData/Local/Google/Chrome/Application/chrome.exe',headless:true});
const context=await browser.newContext({viewport:{width:1600,height:1000}});
const login=await context.request.post(base+'api/login',{headers:{Origin:origin},data:{code:codes['test-a'].invitation_code}});if(!login.ok())throw Error('Login failed');
const headers={Origin:origin,'X-CSRF-Token':(await login.json()).csrf};
const path='src/Main.java',read=async()=>(await(await context.request.get(base+'api/file',{params:{path}})).json());
const original=(await read()).content,page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
async function lineContaining(text){
  await page.locator('#tree button').filter({hasText:/^Main\.java$/}).click();
  const lines=(await read()).content.split('\n'),index=lines.findIndex(l=>l.includes(text));if(index<0)throw Error('Missing line: '+text);
  await page.locator('#editor .monaco-editor').click({position:{x:150,y:65}});await page.keyboard.press('Control+Home');for(let i=0;i<index;i++)await page.keyboard.press('ArrowDown');return lines[index];
}
async function restore(){const current=await read();const response=await context.request.put(base+'api/file',{headers,data:{path,content:original,expected_sha:current.sha}});if(!response.ok())throw Error('Restore conflict');}
try{
  await page.goto(base,{waitUntil:'networkidle'});await expect(page.locator('#file-name')).toHaveText(path);
  await lineContaining('frame.setVisible(true);');await page.keyboard.press('End');await page.keyboard.press('Enter');
  const color='frame.getBoardPanel().setBackground(new java.awt.Color(210, 235, 220));';await page.keyboard.insertText(color);
  await expect.poll(async()=>(await read()).content,{timeout:15000}).toContain(color);
  await page.locator('#run').click();await expect(page.locator('#run-status')).toHaveText('运行中',{timeout:120000});
  await page.waitForFunction(()=>{const c=document.querySelector('#screen canvas');if(!c||c.width<700)return false;const ctx=c.getContext('2d');let n=0;for(let y=100;y<c.height-60;y+=40)for(let x=50;x<c.width-350;x+=40){const p=ctx.getImageData(x,y,1,1).data;if(Math.abs(p[0]-210)<5&&Math.abs(p[1]-235)<5&&Math.abs(p[2]-220)<5)n++;}return n>30;},{},{timeout:45000});
  await page.screenshot({path:output+'/edited-java.png',fullPage:true});console.log('PASS Java edit → async save → compile → changed Swing rendering');
  await expect(page.locator('#lsp-reconnect')).toContainText('已就绪',{timeout:90000});
  await lineContaining('Game game =');await page.keyboard.press('End');await page.keyboard.press('Enter');await page.keyboard.insertText('game.try');await page.keyboard.press('Control+Space');
  await expect(page.locator('.suggest-widget.visible')).toContainText('tryMove',{timeout:30000});await page.keyboard.press('Enter');await page.keyboard.press('Escape');
  await expect.poll(async()=>(await read()).content,{timeout:15000}).toContain('game.tryMove(');
  await page.screenshot({path:output+'/completion.png',fullPage:true});
  await restore();await page.reload({waitUntil:'networkidle'});await expect(page.locator('#lsp-reconnect')).toContainText('已就绪',{timeout:90000});
  const line=await lineContaining('Game game =');await page.keyboard.press('Home');for(let i=0;i<2;i++)await page.keyboard.press('ArrowRight');await page.keyboard.press('F12');
  await expect(page.locator('#file-name')).toHaveText('src/model/game/Game.java',{timeout:30000});
  await page.screenshot({path:output+'/definition.png',fullPage:true});if(errors.length)throw Error(errors.join('\n'));
  await fs.writeFile(output+'/code-browser-results.json',JSON.stringify({editRun:true,semanticMenu:true,completionInserted:true,definition:true,restoredSource:true,errors},null,2));console.log('PASS visible completion insertion and F12 navigation');
}catch(error){await page.screenshot({path:output+'/code-failure.png',fullPage:true}).catch(()=>{});throw error;}
finally{await page.close({runBeforeUnload:false}).catch(()=>{});await restore();await context.request.post(base+'api/stop',{headers});await context.request.post(base+'api/logout',{headers});await context.close();await browser.close();}
