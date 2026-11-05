import {chromium,expect} from '@playwright/test';
import fs from 'node:fs/promises';
const origin='https://124.221.144.155',base=origin+'/xiangqi/';
const output='D:/Artifacts/XiangQiStudio/revision';await fs.mkdir(output,{recursive:true});
const codes=JSON.parse(await fs.readFile('D:/AppData/XiangQiStudio/invitations.json','utf8'));
const browser=await chromium.launch({executablePath:'C:/Users/fy/AppData/Local/Google/Chrome/Application/chrome.exe',headless:true});
const context=await browser.newContext({viewport:{width:1600,height:1000}});
const login=await context.request.post(base+'api/login',{headers:{Origin:origin},data:{code:codes['test-a'].invitation_code}});
if(!login.ok())throw Error('Login '+login.status());
const csrf=(await login.json()).csrf,headers={Origin:origin,'X-CSRF-Token':csrf};
const page=await context.newPage(),errors=[],report={};page.on('pageerror',e=>errors.push(e.message));
const file=async path=>(await(await context.request.get(base+'api/file',{params:{path}})).json());
const open=async path=>{await page.locator('#tree button').filter({hasText:new RegExp('^'+path.split('/').at(-1).replaceAll('.','\\.')+'$')}).first().click();await expect(page.locator('#file-name')).toHaveText(path);};
let originalReadme;
try{
  await page.goto(base,{waitUntil:'networkidle'});
  await expect(page.locator('#file-name')).toHaveText('src/Main.java');
  await expect(page.locator('#annotate')).toHaveText('选中当前行');
  const ws=await(await context.request.get(base+'api/workspace')).json();
  if(ws.files.some(f=>f.path.startsWith('src/main/')))throw Error('Old nesting remains');
  await open('README.md');await expect(page.locator('#markdown-preview h1')).toHaveText('中国象棋');
  originalReadme=await file('README.md');
  await page.getByRole('button',{name:'对照',exact:true}).click();
  await expect(page.locator('#editor')).toBeVisible();await expect(page.locator('#markdown-preview')).toBeVisible();
  await page.locator('#editor .monaco-editor').click({position:{x:110,y:65}});
  await page.keyboard.press('Control+End');await page.keyboard.insertText('\n\n## Markdown 实时预览验证\n内容随编辑更新。\n');
  await expect(page.locator('#markdown-preview h2').last()).toHaveText('Markdown 实时预览验证');
  await expect.poll(async()=>(await file('README.md')).content,{timeout:15000}).toContain('Markdown 实时预览验证');
  const editedReadme=await file('README.md');
  const restored=await context.request.put(base+'api/file',{headers,data:{path:'README.md',content:originalReadme.content,expected_sha:editedReadme.sha}});
  if(!restored.ok())throw Error('Cannot restore Markdown fixture');
  await page.reload({waitUntil:'networkidle'});
  await open('docs/代码导读.md');await expect(page.locator('#markdown-preview svg')).toBeVisible({timeout:45000});
  await page.screenshot({path:output+'/markdown.png',fullPage:true});report.markdown=true;console.log('PASS rendered Markdown, Mermaid and live edit');
  async function drag(kind,dx,dy){const handle=page.locator(`[data-split=${kind}]`),box=await handle.boundingBox();await page.mouse.move(box.x+box.width/2,box.y+box.height/2);await page.mouse.down();await page.mouse.move(box.x+box.width/2+dx,box.y+box.height/2+dy,{steps:8});await page.mouse.up();}
  const before=await page.locator('.preview-column').boundingBox();await drag('columns',100,0);const after=await page.locator('.preview-column').boundingBox();if(after.width-before.width<70)throw Error('Column splitter failed');
  const codeBefore=await page.locator('.code-area').boundingBox();await drag('code',0,-90);const codeAfter=await page.locator('.code-area').boundingBox();if(codeBefore.height-codeAfter.height<60)throw Error('Code splitter failed');
  const treeBefore=await page.locator('#tree').boundingBox();await drag('tree',35,0);if((await page.locator('#tree').boundingBox()).width-treeBefore.width<25)throw Error('Tree splitter failed');
  const logBefore=await page.locator('.console').boundingBox();await drag('logs',0,-40);if((await page.locator('.console').boundingBox()).height-logBefore.height<30)throw Error('Log splitter failed');
  report.splitters=true;await page.locator('#reset-layout').click();
  await page.locator('#run').click();await expect(page.locator('#run-status')).toHaveText('运行中',{timeout:120000});
  await page.waitForFunction(()=>{const c=document.querySelector('#screen canvas');if(!c||c.width<700)return false;const p=c.getContext('2d').getImageData(4,4,1,1).data;return p[0]>100&&p[1]>100&&p[2]>100;},{},{timeout:45000});
  async function fit(){const m=await page.locator('#screen canvas').evaluate(c=>{const b=c.getBoundingClientRect(),s=document.querySelector('#screen').getBoundingClientRect();return{width:c.width,height:c.height,display:b.width/b.height,pane:s.width/s.height,gapX:s.width-b.width,gapY:s.height-b.height};});if(Math.abs(m.display-m.pane)>.012||m.gapX>3||m.gapY>3)throw Error('Canvas does not fill pane '+JSON.stringify(m));return m;}
  report.canvas=await fit();await page.screenshot({path:output+'/running.png',fullPage:true});
  // The frame fills the framebuffer; derive the board transform from its actual size.
  const logical=await page.locator('#screen canvas').evaluate(c=>({width:c.width,height:c.height}));
  const bw=logical.width-290,bh=logical.height-45-37,scale=Math.min(bw/488,bh/540);
  const from={x:(bw-488*scale)/2+36*scale,y:45+(bh-540*scale)/2+348*scale};
  const to={x:from.x,y:from.y-52*scale};
  const redCount=async point=>page.locator('#screen canvas').evaluate((c,p)=>{const data=c.getContext('2d').getImageData(Math.round(p.x-16),Math.round(p.y-16),32,32).data;let n=0;for(let i=0;i<data.length;i+=4)if(data[i]>120&&data[i]>data[i+1]*1.5&&data[i]>data[i+2]*1.5)n++;return n;},point);
  if(await redCount(from)<20)throw Error('Red pawn not at measured point');
  const bounds=await page.locator('#screen canvas').boundingBox();
  for(const point of [from,to])await page.mouse.click(bounds.x+point.x*bounds.width/logical.width,bounds.y+point.y*bounds.height/logical.height);
  await expect.poll(()=>redCount(to),{timeout:10000}).toBeGreaterThan(20);if(await redCount(from)>10)throw Error('Pawn remained at origin');report.swingClick=true;
  await drag('columns',130,0);await expect.poll(async()=>{try{await fit();return true;}catch{return false;}},{timeout:15000}).toBe(true);
  report.resizedCanvas=await fit();await page.screenshot({path:output+'/resized.png',fullPage:true});console.log('PASS four splitters and responsive Swing capture',report.canvas,report.resizedCanvas);
  await page.locator('#reset-layout').click();await open('src/Main.java');
  await expect(page.locator('#lsp-reconnect')).toContainText('已就绪',{timeout:90000});
  const source=await file('src/Main.java'),lines=source.content.split('\n'),line=lines.findIndex(l=>l.includes('Game game ='));
  if(line<0)throw Error('Game assembly line missing');
  await page.locator('#editor .monaco-editor').click({position:{x:110,y:60}});await page.keyboard.press('Control+Home');for(let i=0;i<line;i++)await page.keyboard.press('ArrowDown');
  await page.locator('#annotate').click();await expect(page.locator('#selection-label')).toContainText('第 '+(line+1)+' 行');
  await page.locator('#selection-question').click();
  const streamed=page.waitForResponse(r=>r.url().endsWith('/api/chat/stream')&&r.request().method()==='POST',{timeout:180000});
  await page.locator('#explain-selection').click();const response=await streamed;
  if(!response.ok())throw Error('Actual chat failed '+response.status());
  await expect(page.locator('#explain-selection')).not.toHaveAttribute('aria-busy','true',{timeout:180000});
  const history=await(await context.request.get(base+'api/chat')).json();
  const latest=history.at(-1),text=latest?.content||'',done=latest;
  const sent=response.request().postDataJSON();if(sent.selection.path!=='src/Main.java'||sent.selection.start_line!==line+1)throw Error('Selection context not sent');
  if(done?.finish_reason!=='stop'||text.length<200||!text.includes('Game'))throw Error('Incomplete contextual response '+JSON.stringify({length:text.length,done}));
  await expect(page.locator('#chat-list .markdown').last()).toContainText('Game',{timeout:15000});report.contextualChat={length:text.length,finish:done.finish_reason,selection:sent.selection};console.log('PASS actual DeepSeek selected-code response',report.contextualChat);
  const longText=Array.from({length:180},(_,i)=>`### 第 ${i+1} 段\n这是用于验证长回答完整显示、独立滚动和展开阅读的内容。`.repeat(3)).join('\n\n')+'\n\n最后一段已完整显示。';
  await page.route('**/api/chat/stream',route=>route.fulfill({contentType:'application/x-ndjson',body:JSON.stringify({type:'delta',text:longText})+'\n'+JSON.stringify({type:'done',finish_reason:'stop'})+'\n'}));
  await page.route('**/api/chat',route=>route.fulfill({json:[{role:'user',content:'长回答显示测试'},{role:'assistant',content:longText,finish_reason:'stop'}]}));
  await page.locator('#question').fill('长回答显示测试');await page.locator('#chat-form button[type=submit]').click();
  await expect(page.locator('#chat-list .markdown').last()).toContainText('最后一段已完整显示。');
  await page.locator('#expand-chat').click();await page.locator('#chat-list').evaluate(e=>e.scrollTop=e.scrollHeight);
  const end=page.getByText('最后一段已完整显示。',{exact:true});await expect(end).toBeInViewport();
  await page.screenshot({path:output+'/long-answer.png',fullPage:true});report.longAnswerCharacters=longText.length;await page.locator('#expand-chat').click();
  const downloadEvent=page.waitForEvent('download');await page.locator('#download').click();await(await downloadEvent).saveAs(output+'/browser-project.zip');report.download=true;
  report.layouts=[];for(const width of [320,375,414,768,1280,1440]){await page.setViewportSize({width,height:1000});await page.waitForTimeout(200);const value=await page.evaluate(()=>({width:innerWidth,scroll:document.documentElement.scrollWidth}));if(value.scroll>width+1)throw Error('Horizontal overflow '+JSON.stringify(value));report.layouts.push(value);}
  report.errors=errors;if(errors.length)throw Error(errors.join('\n'));console.log('PASS long-answer scroll, ZIP download and responsive widths');
  await fs.writeFile(output+'/browser-results.json',JSON.stringify(report,null,2));
}catch(error){await page.screenshot({path:output+'/failure.png',fullPage:true}).catch(()=>{});await fs.writeFile(output+'/failure.txt',error.stack||String(error));throw error;}
finally{
  await page.close({runBeforeUnload:false}).catch(()=>{});
  if(originalReadme){const current=await file('README.md');if(current.content!==originalReadme.content)await context.request.put(base+'api/file',{headers,data:{path:'README.md',content:originalReadme.content,expected_sha:current.sha}});}
  await context.request.post(base+'api/stop',{headers}).catch(()=>{});await context.request.post(base+'api/logout',{headers}).catch(()=>{});await context.close();await browser.close();
}
