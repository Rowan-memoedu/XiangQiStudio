import {chromium,expect} from '@playwright/test';
import fs from 'node:fs/promises';
import {spawn} from 'node:child_process';
const server=spawn(process.execPath,['node_modules/vite/bin/vite.js','--host','127.0.0.1','--port','5178','--strictPort','--base','/'],{stdio:'inherit'});
const browser=await chromium.launch({executablePath:'C:/Users/fy/AppData/Local/Google/Chrome/Application/chrome.exe',headless:true});
const directory='D:/Artifacts/XiangQiStudio/mermaid';await fs.mkdir(directory,{recursive:true});
try{
 for(let i=0;i<50;i++){try{if((await fetch('http://127.0.0.1:5178/tests/markdown-harness.html')).ok)break;}catch{}await new Promise(r=>setTimeout(r,200));}
 const page=await browser.newPage({viewport:{width:1100,height:1000}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto('http://127.0.0.1:5178/tests/markdown-harness.html');
 const source=await fs.readFile('D:/Projects/SUSTech-CS109-XiangQi/docs/代码导读.md','utf8');
 const expected=(source.match(/^```mermaid/gm)||[]).length;
 await page.evaluate(async source=>{const {renderMarkdown}=await import('/web/markdown.ts');await renderMarkdown(document.querySelector('#document'),source);},source);
 await expect(page.locator('.markdown-diagram svg')).toHaveCount(expected);
 await expect(page.locator('.diagram-error')).toHaveCount(0);
 const metrics=await page.locator('.markdown-diagram svg').evaluateAll(svgs=>svgs.map(svg=>({texts:svg.querySelectorAll('text').length,labels:[...svg.querySelectorAll('.node .label')].map(n=>(n.textContent||'').trim()),foreign:svg.querySelectorAll('foreignObject').length,width:svg.getBoundingClientRect().width,height:svg.getBoundingClientRect().height})));
 for(const [i,m] of metrics.entries()){if(m.foreign||!m.texts||m.width<100||m.height<50||m.labels.some(s=>!s))throw Error('Blank or invalid graph '+i+': '+JSON.stringify(m));}
 await page.locator('.markdown-diagram').first().screenshot({path:directory+'/overview.png'});
 for(const width of [320,375,414,768]){await page.setViewportSize({width,height:1000});if(await page.evaluate(()=>document.documentElement.scrollWidth)>width+1)throw Error('Page overflow at '+width);}
 await page.evaluate(async()=>{const {renderMarkdown}=await import('/web/markdown.ts');const t=document.querySelector('#document');await renderMarkdown(t,'<img src=x onerror="window.executed=true"><script>window.executed=true</script>\n\n```mermaid\nflowchart TD\n A[中文节点] --> B[下一步]\n```');if(window.executed||t.querySelector('[onerror],script'))throw Error('Unsafe HTML');if(!t.querySelector('svg').textContent.includes('中文节点'))throw Error('Missing Chinese labels');await renderMarkdown(t,'```mermaid\nflowchart TD\n A --> [\n```');if(!t.querySelector('.diagram-error-message')||!t.textContent.includes('A --> ['))throw Error('Missing error fallback');await Promise.all([renderMarkdown(t,'```mermaid\nflowchart TD\n A[旧图]\n```'),renderMarkdown(t,'# 最新内容')]);if(t.textContent.trim()!=='最新内容')throw Error('Stale render replaced current content');});
 if(errors.length)throw Error(errors.join('\n'));
 await fs.writeFile(directory+'/render-results.json',JSON.stringify({diagrams:expected,metrics,security:true,errorFallback:true,staleRender:true,responsive:true},null,2));console.log('PASS',expected,'diagrams: visible text, dimensions, responsive widths, sanitization and fallback');
}finally{await browser.close();server.kill();}
