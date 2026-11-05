import { chromium, expect } from '@playwright/test';
import fs from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const origin='https://124.221.144.155',base=origin+'/xiangqi/';
const root='D:/Artifacts/XiangQiStudio/acceptance';
const codes=JSON.parse(await fs.readFile('D:/AppData/XiangQiStudio/invitations.json','utf8'));
const browser=await chromium.launch({executablePath:'C:/Users/fy/AppData/Local/Google/Chrome/Application/chrome.exe',headless:true});
const sessions=[];const errors=[];
const mainPath='src/main/java/edu/sustech/xiangqi/Main.java';
const original=await fs.readFile('D:/Projects/SUSTech-CS109-XiangQi/'+mainPath,'utf8');
try {
for(const uid of ['test-a','test-b']){
  const context=await browser.newContext({viewport:{width:1600,height:1000}});
  const response=await context.request.post(base+'api/login',{headers:{Origin:origin},data:{code:codes[uid].invitation_code}});
  if(!response.ok())throw new Error('Login failed: '+response.status());
  const csrf=(await response.json()).csrf;
  if(uid==='test-a'){
    const prior=await(await context.request.get(base+'api/file',{params:{path:mainPath}})).json();
    const reset=await context.request.put(base+'api/file',{headers:{Origin:origin,'X-CSRF-Token':csrf},data:{path:mainPath,content:original,expected_sha:prior.sha}});if(!reset.ok())throw new Error('Cannot restore previous test edit');
  }
  const page=await context.newPage();page.on('pageerror',error=>errors.push({uid,error:error.message}));
  await page.goto(base,{waitUntil:'networkidle'});
  await expect(page.locator('#file-name')).toContainText('Main.java');
  sessions.push({uid,context,page,csrf});
}
await Promise.all(sessions.map(async({page,uid})=>{
  await page.locator('#run').click();
  await expect(page.locator('#run-status')).toHaveText('运行中',{timeout:120000});
  await expect(page.locator('#screen canvas')).toBeVisible({timeout:30000});
  await page.waitForFunction(()=>{const c=document.querySelector('#screen canvas');return c&&c.width>500&&c.height>500;});
  await page.waitForFunction(()=>{const c=document.querySelector('#screen canvas');if(!c)return false;const x=c.getContext('2d');let count=0;for(let r=100;r<c.height;r+=40)for(let col=100;col<c.width;col+=40){const p=x.getImageData(col,r,1,1).data;if(p[0]>220&&p[1]>190&&p[1]<230&&p[2]<200)count++;}return count>30;},{},{timeout:45000});
  await page.screenshot({path:root+'/running-'+uid+'.png',fullPage:true});
  console.log(uid,'real Swing canvas',await page.locator('#screen canvas').evaluate(c=>({width:c.width,height:c.height})));
}));
// Keep both complete sessions alive for a bounded memory observation and follow-up inspection.
await fs.writeFile(root+'/browser-running.json',JSON.stringify({errors,sessions:sessions.map(s=>s.uid)}));
console.log('TWO_SESSIONS_READY');
const stats=await promisify(execFile)('ssh',['-T','-o','BatchMode=yes','-o','StrictHostKeyChecking=yes','ubuntu@124.221.144.155','sudo -n docker stats --no-stream --format "{{.Name}} {{.MemUsage}}"'],{timeout:20000});
await fs.writeFile(root+'/two-session-memory.txt',stats.stdout);console.log(stats.stdout);
const a=sessions[0],b=sessions[1];
async function redCount(page,x,y){return page.locator('#screen canvas').evaluate((canvas,{x,y})=>{const p=canvas.getContext('2d').getImageData(x-18,y-18,36,36).data;let count=0;for(let i=0;i<p.length;i+=4)if(p[i]>120&&p[i]>p[i+1]*1.5&&p[i]>p[i+2]*1.5)count++;return count;},{x,y});}
// Coordinates are measured from the observed 1000×760 framebuffer: first red pawn, one step forward.
const from={x:131,y:448},to={x:131,y:396};
if(await redCount(a.page,from.x,from.y)<30)throw new Error('Expected red pawn missing before click');
const canvas=a.page.locator('#screen canvas');const bounds=await canvas.boundingBox();
await a.page.mouse.click(bounds.x+from.x*bounds.width/1000,bounds.y+from.y*bounds.height/760);
await a.page.mouse.click(bounds.x+to.x*bounds.width/1000,bounds.y+to.y*bounds.height/760);
await expect.poll(()=>redCount(a.page,to.x,to.y),{timeout:10000}).toBeGreaterThan(30);
if(await redCount(a.page,from.x,from.y)>10)throw new Error('Origin pawn did not move');
if(await redCount(b.page,from.x,from.y)<30||await redCount(b.page,to.x,to.y)>10)throw new Error('Other account GUI was changed');
await a.page.screenshot({path:root+'/after-pawn-move.png',fullPage:true});
console.log('PASS actual Swing click and per-account game isolation');
async function mainContent(){return(await(await a.context.request.get(base+'api/file',{params:{path:mainPath}})).json()).content;}
async function mainLine(index){
  await a.page.locator('#tree button').filter({hasText:/^Main\.java$/}).click();
  await a.page.locator('#editor .monaco-editor').click({position:{x:120,y:60}});
  await a.page.keyboard.press('Control+Home');for(let i=0;i<index;i++)await a.page.keyboard.press('ArrowDown');
}
async function insertAfter(needle,text){const source=await mainContent();await mainLine(source.split('\n').findIndex(t=>t.includes(needle)));await a.page.keyboard.press('End');await a.page.keyboard.press('Enter');await a.page.keyboard.insertText(text);await expect.poll(mainContent,{timeout:15000}).toContain(text);}
async function removeLine(needle){const source=await mainContent();await mainLine(source.split('\n').findIndex(t=>t.trim()===needle));await a.page.keyboard.press('Control+Shift+k');await expect.poll(mainContent,{timeout:15000}).not.toContain(needle);}
const colorLine='frame.getBoardPanel().setBackground(new java.awt.Color(210, 235, 220));';
await insertAfter('frame.setVisible(true);',colorLine);await a.page.locator('#run').click();
// VNC may encode the framebuffer using lossy image compression. Check the changed
// background across the board, within four channel levels of the requested RGB.
await a.page.waitForFunction(()=>{const c=document.querySelector('#screen canvas');if(!c||c.width<500)return false;let matches=0;const x=c.getContext('2d');for(let r=150;r<650;r+=40)for(let col=150;col<550;col+=40){const p=x.getImageData(col,r,1,1).data;if(Math.abs(p[0]-210)<=4&&Math.abs(p[1]-235)<=4&&Math.abs(p[2]-220)<=4)matches++;}return matches>30;},{},{timeout:120000});
await a.page.screenshot({path:root+'/edited-java-effect.png',fullPage:true});
console.log('PASS Monaco edit, asynchronous save, compile and changed Swing board color');
await expect(a.page.locator('#lsp-reconnect')).toContainText('已就绪',{timeout:90000});
await insertAfter('Board board = new Board();','board.');await a.page.keyboard.insertText('try');await a.page.keyboard.press('Control+Space');
await expect(a.page.locator('.suggest-widget.visible')).toContainText('tryMove',{timeout:30000});
await a.page.screenshot({path:root+'/java-completion.png',fullPage:true});
await a.page.keyboard.press('Enter');await expect.poll(mainContent,{timeout:15000}).toContain('board.tryMove(');
await a.page.keyboard.press('Escape');
await removeLine((await mainContent()).split('\n').find(t=>t.trim().startsWith('board.tryMove(')).trim());
await removeLine(colorLine);
await expect.poll(async()=>(await mainContent()).replaceAll('\r\n','\n'),{timeout:15000}).toBe(original.replaceAll('\r\n','\n'));
const lines=(await mainContent()).split('\n'),line=lines.findIndex(t=>t.includes('Board board'));
await a.page.keyboard.press('Control+Home');for(let i=0;i<line;i++)await a.page.keyboard.press('ArrowDown');for(let i=0;i<lines[line].indexOf('Board')+2;i++)await a.page.keyboard.press('ArrowRight');await a.page.keyboard.press('F12');
await expect(a.page.locator('#file-name')).toContainText('model/Board.java',{timeout:30000});
await a.page.screenshot({path:root+'/java-definition.png',fullPage:true});
console.log('PASS visible semantic completion menu and F12 definition navigation');
const downloadEvent=a.page.waitForEvent('download');await a.page.locator('#download').click();const download=await downloadEvent;await download.saveAs(root+'/browser-downloaded-project.zip');
console.log('PASS one-click browser ZIP download');
await fs.writeFile(root+'/browser-results.json',JSON.stringify({errors,sessions:sessions.map(s=>s.uid),swingClick:true,gameIsolation:true,editRunChangesGui:true,semanticCompletionMenu:true,definitionNavigation:true,download:true,restoredMain:true},null,2));
if(errors.length)throw new Error(JSON.stringify(errors));
} catch(error) {
  await fs.writeFile(root+'/browser-failure.txt',String(error.stack||error));
  for(const {page,uid} of sessions)await page.screenshot({path:root+'/failed-'+uid+'.png',fullPage:true}).catch(()=>{});
  throw error;
} finally {
  for(const {page,context,csrf,uid} of sessions){
    await page.close({runBeforeUnload:false}).catch(()=>{});
    if(uid==='test-a'){
      const prior=await(await context.request.get(base+'api/file',{params:{path:mainPath}})).json();
      await context.request.put(base+'api/file',{headers:{Origin:origin,'X-CSRF-Token':csrf},data:{path:mainPath,content:original,expected_sha:prior.sha}});
    }
    await context.request.post(base+'api/stop',{headers:{Origin:origin,'X-CSRF-Token':csrf}}).catch(()=>{});
    await context.request.post(base+'api/logout',{headers:{Origin:origin,'X-CSRF-Token':csrf}}).catch(()=>{});
    await context.close();
  }
  await browser.close();
}
