import * as monaco from 'monaco-editor/esm/vs/editor/editor.api.js';
import 'monaco-editor/esm/vs/basic-languages/java/java.contribution.js';
import 'monaco-editor/esm/vs/basic-languages/xml/xml.contribution.js';
import 'monaco-editor/esm/vs/basic-languages/markdown/markdown.contribution.js';
import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker.js?worker';
import RFB from '@novnc/novnc';
import { JavaLanguage } from './lsp';
import './style.css';
import './workbench.css';
import { renderMarkdown, projectLink } from './markdown';
import { setupLayout } from './layout';
import { WorkspaceCache, type Workspace } from './workspace-cache';

(self as any).MonacoEnvironment={getWorker:()=>new EditorWorker()};
const base=import.meta.env.BASE_URL;
const el=<T extends HTMLElement=HTMLElement>(id:string)=>document.getElementById(id) as T;
type Buffer={model:monaco.editor.ITextModel;sha:string|null;saved:string;dirty:boolean;blocked:boolean;saving:Promise<void>|null;timer?:ReturnType<typeof setTimeout>};
const buffers=new Map<string,Buffer>();
let csrf='',me:any,workspace:Workspace,editor:monaco.editor.IStandaloneCodeEditor,language:JavaLanguage;
let workspaceCache: WorkspaceCache;
let current='',suppress=false,rfb:any=null,runRequested=false,annotation:{path:string,line:number}|null=null;
type Selection = {path:string; start_line:number; end_line:number};
type QuestionScope = Selection | {path: string};
let selection:Selection|null=null, mdMode='preview', generating=false;
let previewTimer:ReturnType<typeof setTimeout>, viewportTimer:ReturnType<typeof setTimeout>, lastViewport='';
let viewportRequest = Promise.resolve();
let revealPanel: ReturnType<typeof setupLayout> | undefined;
let lastVersions='',lastDiscussion='',polling=false,openSequence=0;

class ApiError extends Error {status:number;data:any;constructor(status:number,data:any){super(data.error||data.detail?.[0]?.msg||'请求未完成');this.status=status;this.data=data;}}
async function api(path:string,method='GET',body?:any) {
  const headers:Record<string,string>={};if(csrf)headers['X-CSRF-Token']=csrf;
  if(body!==undefined && !(body instanceof FormData))headers['Content-Type']='application/json';
  const response=await fetch(base+'api/'+path,{method,headers,body:body===undefined?undefined:body instanceof FormData?body:JSON.stringify(body),credentials:'same-origin'});
  const data=await response.json().catch(()=>({error:`请求失败（${response.status}）`}));
  if(!response.ok)throw new ApiError(response.status,data);return data;
}
function message(text:string,error=false){el('message').hidden=false;el('message').textContent=text;el('message').classList.toggle('error',error);}
async function perform(button:HTMLButtonElement,action:()=>Promise<any>){button.disabled=true;button.setAttribute('aria-busy','true');try{await action();button.dataset.state='success';}catch(error){button.dataset.state='error';message((error as Error).message,true);}finally{button.disabled=false;button.removeAttribute('aria-busy');}}
function click(id:string,action:()=>Promise<any>){const button=el<HTMLButtonElement>(id);button.addEventListener('click',()=>perform(button,action));}
function wsUrl(path:string){return `${location.protocol==='https:'?'wss:':'ws:'}//${location.host}${base}ws/${path}`;}
function recoveryKey(path:string){return `xq-draft:${me.id}:${path}`;}
function changed(){const count=[...buffers.values()].filter(b=>b.dirty).length;el('save-status').textContent=count?`${count} 个文件待同步`:'已保存到个人草稿';}
function remember(path:string,b:Buffer){try{localStorage.setItem(recoveryKey(path),JSON.stringify({content:b.model.getValue(),sha:b.sha}));}catch{message('本机草稿缓存空间不足，请保持页面打开并保存到服务器。',true);}}

async function saveBuffer(path:string,b:Buffer):Promise<void>{
  if(b.saving){await b.saving;if(b.dirty)return saveBuffer(path,b);return;}
  if(!b.dirty)return;
  if(b.blocked)throw new Error('存在已保留的草稿冲突，请先在版本页处理。');
  const content=b.model.getValue();
  b.saving=(async()=>{
    try{const result=await api('file','PUT',{path,content,expected_sha:b.sha});b.sha=result.sha;b.saved=content;b.dirty=b.model.getValue()!==content;
      const file = workspace.files.find(file => file.path === path);
      if (file) {
        file.sha = result.sha;
        file.size = new TextEncoder().encode(content).length;
      }
      workspace.head = result.head;
      workspaceCache.rememberFile(path, {content, sha: result.sha});
      if(b.dirty)remember(path,b);else localStorage.removeItem(recoveryKey(path));language?.saved(b.model);
    }catch(error){if(error instanceof ApiError&&error.status===409){b.blocked=true;tab('versions');}remember(path,b);throw error;}
    finally{changed();}
  })();
  try{await b.saving;}finally{b.saving=null;}
}
async function saveAll(){for(const [path,b] of buffers){clearTimeout(b.timer);await saveBuffer(path,b);if(b.dirty)await saveBuffer(path,b);}}

async function openFile(path:string){
  const sequence=++openSequence;
  let buffer=buffers.get(path);
  if(!buffer){
    const expected = workspace.files.find(file => file.path === path)?.sha;
    const cached = workspaceCache.file(path, expected);
    const file = cached ?? await api('file?' + new URLSearchParams({path}));
    if (sequence !== openSequence) return;
    if (!cached) workspaceCache.rememberFile(path, file);
    const uri=monaco.Uri.from({scheme:'file',path:'/workspace/'+path});
    const type=path.endsWith('.java')?'java':path.endsWith('.xml')?'xml':path.endsWith('.md')?'markdown':'plaintext';
    const model=monaco.editor.createModel(file.content,type,uri);
    buffer={model,sha:file.sha,saved:file.content,dirty:false,blocked:false,saving:null};
    buffers.set(path,buffer);
    const b=buffer;
    model.onDidChangeContent(()=>{if(selection?.path===path)clearSelection();if(suppress)return;b.dirty=model.getValue()!==b.saved;remember(path,b);language?.change(model);if(current===path&&path.endsWith('.md'))scheduleMarkdown();clearTimeout(b.timer);b.timer=setTimeout(()=>saveBuffer(path,b).catch(e=>message(e.message,true)),900);changed();});
    try{const cached=JSON.parse(localStorage.getItem(recoveryKey(path))||'null');
      if(cached && cached.content!==file.content){b.sha=cached.sha;b.model.setValue(cached.content);message('已恢复这台浏览器尚未同步的草稿，正在校验服务器版本。');}
    }catch{message('本机草稿缓存无法读取；服务器文件未改变。',true);}
    language?.open(model);
  }
  if(sequence!==openSequence)return;
  if (current !== path) clearSelection();
  current=path;editor.updateOptions({readOnly:false});editor.setModel(buffer.model);el('file-name').textContent=path;
  workspaceCache.select(path);
  document.querySelectorAll<HTMLButtonElement>('#tree button').forEach(button=>button.classList.toggle('selected',button.dataset.path===path));
  updateFileMode();if(!path.endsWith('.md')||mdMode!=='preview')editor.focus();changed();
}

function scheduleMarkdown(){clearTimeout(previewTimer);previewTimer=setTimeout(()=>updateMarkdown(),160);}
async function updateMarkdown(){
  const buffer=buffers.get(current);if(!buffer||!current.endsWith('.md'))return;
  await renderMarkdown(el('markdown-preview'),buffer.model.getValue());
}
function updateFileMode(){
  const markdown=current.endsWith('.md');el('md-modes').hidden=!markdown;
  document.querySelector<HTMLElement>('.editor-content')!.dataset.mode=markdown?mdMode:'code';
  for(const button of document.querySelectorAll<HTMLButtonElement>('[data-md-mode]'))button.setAttribute('aria-pressed',String(button.dataset.mdMode===mdMode));
  if(markdown)void updateMarkdown();requestAnimationFrame(()=>editor.layout());
}
for(const button of document.querySelectorAll<HTMLButtonElement>('[data-md-mode]'))button.onclick=()=>{mdMode=button.dataset.mdMode!;updateFileMode();};
el('markdown-preview').addEventListener('click',event=>{
  const link=(event.target as HTMLElement).closest<HTMLAnchorElement>('a[href]');if(!link)return;
  const href=link.getAttribute('href')!;
  if(href.startsWith('#')){event.preventDefault();el('markdown-preview').querySelector('#'+CSS.escape(decodeURIComponent(href.slice(1))))?.scrollIntoView({block:'start'});return;}
  const path=projectLink(current,href);if(path){event.preventDefault();openFile(path).catch(e=>message(e.message,true));}
});
function selectCurrentLine() {
  const model = editor.getModel();
  const position = editor.getPosition();
  if (!current || !model || !position) throw new Error('请先打开一个项目文件');
  const start = position.lineNumber;
  const tabSize = model.getOptions().tabSize;
  function indentation(text: string) {
    let width = 0;
    for (const char of text) {
      if (char === ' ') width++;
      else if (char === '\t') width += tabSize - width % tabSize;
      else break;
    }
    return width;
  }
  const firstLine = model.getLineContent(start);
  const baseIndent = indentation(firstLine);
  let end = start;
  if (firstLine.trim()) {
    for (let row = start + 1; row <= model.getLineCount(); row++) {
      const text = model.getLineContent(row);
      if (!text.trim()) continue;
      if (indentation(text) <= baseIndent) break;
      end = row;
    }
  }
  selection={path:current,start_line:start,end_line:end};
  editor.setSelection(new monaco.Range(start, 1, start, model.getLineMaxColumn(start)));
  annotation={path:current,line:start};
  el('selection-context').hidden=false;el('selection-label').textContent=current+' · 第 '+start+(end===start?'':'–'+end)+' 行';
  el('annotation').hidden=false;el('annotation').textContent='批注 '+current+':'+start;el('clear-annotation').hidden=false;
}
function clearSelection(){
  selection=null;annotation=null;el('selection-context').hidden=true;el('annotation').hidden=true;el('clear-annotation').hidden=true;
}
function viewportSize(){
  const bounds=document.querySelector('.screen-wrap')!.getBoundingClientRect();
  if (!bounds.width || !bounds.height) return;
  const minimumScale = Math.max(810 / bounds.width, 650 / bounds.height, 1);
  const scale = Math.min(minimumScale, 4096 / bounds.width, 3072 / bounds.height);
  return {
    width: Math.max(810, Math.round(bounds.width * scale)),
    height: Math.max(650, Math.round(bounds.height * scale))
  };
}
function syncViewport(force=false){
  // Read dimensions when the request runs, and never let a hidden panel resize the game.
  const update = viewportRequest.then(async () => {
    if (!me || (!runRequested && !force)) return;
    const size = viewportSize();
    if (!size) return;
    const value = JSON.stringify(size);
    if (value === lastViewport && !force) return;
    await api('viewport', 'POST', size);
    lastViewport = value;
  });
  viewportRequest = update.catch(() => {});
  return update;
}
function layoutChanged(){
  editor?.layout();clearTimeout(viewportTimer);viewportTimer=setTimeout(()=>syncViewport().catch(e=>message(e.message,true)),250);
}

function tree(files:any[]){
  const root:any={};for(const file of files){let node=root;const parts=file.path.split('/');parts.forEach((part:string,index:number)=>{node[part]??=index===parts.length-1?{_file:file.path}:{};node=node[part];});}
  function render(node:any,parent:HTMLElement){for(const name of Object.keys(node).sort((a,b)=>Number(!!node[a]._file)-Number(!!node[b]._file)||a.localeCompare(b))){
    if(node[name]._file){const button=document.createElement('button');button.textContent=name;button.dataset.path=node[name]._file;button.title=node[name]._file;button.classList.toggle('selected',node[name]._file===current);button.addEventListener('click',()=>openFile(node[name]._file).catch(e=>message(e.message,true)));parent.append(button);}
    else{const details=document.createElement('details');details.open=true;const summary=document.createElement('summary');summary.textContent=name;const children=document.createElement('div');details.append(summary,children);parent.append(details);render(node[name],children);}
  }}
  el('tree').replaceChildren();render(root,el('tree'));
}

function showWorkspace(snapshot: Workspace) {
  if (workspace?.head !== snapshot.head) tree(snapshot.files);
  workspace = snapshot;
  workspaceCache.workspace = snapshot;
  workspaceCache.persist();
  el('workspace-state').textContent=workspace.base===workspace.shared?'个人草稿 · 共同版本已同步':'个人草稿 · 有新的共同版本';
}

function initialFile() {
  const files = workspace.files;
  return files.find(file => file.path === workspaceCache.lastPath)
    ?? files.find(file => file.path.endsWith('/Main.java')) ?? files[0];
}

async function refreshWorkspace(reload=false){
  showWorkspace(await api('workspace'));
  if (!reload) return;
  for (const [path, b] of buffers) {
    const latest = workspace.files.find(file => file.path === path);
    if (b.dirty || !latest || latest.sha === b.sha) continue;
    const version = b.model.getVersionId();
    const file = await api('file?' + new URLSearchParams({path}));
    if (buffers.get(path) !== b || b.dirty || b.model.getVersionId() !== version) continue;
    workspaceCache.rememberFile(path, file);
    suppress=true;try{b.model.setValue(file.content);b.sha=file.sha;b.saved=file.content;b.blocked=false;}finally{suppress=false;}
    if (path === current && path.endsWith('.md')) scheduleMarkdown();
    language?.change(b.model);
  }
}

function tab(name:string){revealPanel?.('discussion');for(const id of ['chat','discussion','versions']){el('pane-'+id).hidden=id!==name;el('tab-'+id).setAttribute('aria-selected',String(id===name));}}
document.querySelectorAll<HTMLButtonElement>('[data-tab]').forEach(button=>button.addEventListener('click',()=>tab(button.dataset.tab!)));

function article(byline:string,body:string){const item=document.createElement('article');const who=document.createElement('div');who.className='byline';who.textContent=byline;const content=document.createElement('div');content.className='content';content.textContent=body;item.append(who,content);return item;}
function renderChat(rows:any[]){
  const items=rows.map(row=>{
    const item=article(row.role==='user'?'你':'项目助手',row.role==='user'?row.content:'');
    if(row.selection){const context=document.createElement('div');context.className='byline';context.textContent=row.selection.split('\n')[0];item.append(context);}
    if(row.role==='assistant'){
      const content=item.querySelector<HTMLElement>('.content')!;content.classList.add('markdown');void renderMarkdown(content,row.content);
      if(row.finish_reason&&row.finish_reason!=='stop'){
        const status=document.createElement('p');status.className='answer-status';status.textContent='这次回答尚未完整结束，已收到的全文已保留。';
        const more=document.createElement('button');more.textContent='继续回答';more.onclick=()=>perform(more,()=>askQuestion('请继续上一条尚未完成的回答，从中断的位置接着讲。'));
        item.append(status,more);
      }
    }
    return item;
  });
  el('chat-list').replaceChildren(...items);
  requestAnimationFrame(()=>{const lastQuestion=items.at(-2);if(lastQuestion)el('chat-list').scrollTop=lastQuestion.offsetTop-el('chat-list').offsetTop;});
}
async function askQuestion(question:string, scope: QuestionScope | null = selection){
  if(generating)throw new Error('上一条回答正在生成');
  await saveAll();generating=true;tab('chat');
  const questionItem=article('你',question),answerItem=article('项目助手','正在准备回答…');
  if (scope) {
    const label = 'start_line' in scope ? `第 ${scope.start_line}–${scope.end_line} 行` : '整个文件';
    questionItem.append(article('解释范围', scope.path + ' · ' + label));
  }
  const content=answerItem.querySelector<HTMLElement>('.content')!;content.classList.add('markdown');
  el('chat-list').append(questionItem,answerItem);questionItem.scrollIntoView({block:'nearest'});
  let answer='',status='',paint=0;
  try{
    const response=await fetch(base+'api/chat/stream',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json','X-CSRF-Token':csrf},body:JSON.stringify({question,selection:scope})});
    if(!response.ok){const error=await response.json();throw new Error(error.error||'问答请求未完成');}
    const reader=response.body!.getReader(),decoder=new TextDecoder();let pending='';
    const consume=(line:string)=>{
      if(!line.trim())return;const event=JSON.parse(line);
      if(event.type==='delta'){
        answer+=event.text;
        if(Date.now()-paint>120){paint=Date.now();void renderMarkdown(content,answer,false);}
      }else if(event.type==='error')status=event.text;
      else if(event.type==='status')answerItem.setAttribute('aria-label',event.text);
      else if(event.type==='done'&&event.finish_reason!=='stop')status='回答尚未完整结束，已收到的内容会保留，可点击“继续回答”。';
    };
    while(true){const {done,value}=await reader.read();if(done)break;pending+=decoder.decode(value,{stream:true});const lines=pending.split('\n');pending=lines.pop()!;for(const line of lines)consume(line);}
    pending+=decoder.decode();if(pending.trim())consume(pending);
    if(answer){await renderMarkdown(content,answer);el<HTMLTextAreaElement>('question').value='';renderChat(await api('chat'));}
    else throw new Error(status||'没有收到回答，请重试');
    if(status)message(status,true);
  }catch(error){
    await renderMarkdown(content,answer||'');
    const notice=document.createElement('p');notice.className='answer-status';notice.textContent=(error as Error).message;answerItem.append(notice);
    throw error;
  }finally{generating=false;}
}

function renderDiscussion(data:any){
  const unread=new Set(data.mentions.filter((m:any)=>!m.seen).map((m:any)=>m.comment));
  el('unread').textContent=unread.size?String(unread.size):'';
  const select=el<HTMLSelectElement>('mention');const previous=select.value;select.replaceChildren(new Option('不 @',''));
  for(const member of data.members)if(member.id!==me.id)select.add(new Option('@ '+member.name,member.id));select.value=previous;
  const items=data.comments.map((comment:any)=>{
    const item=article(`${comment.name} · ${new Date(comment.created*1000).toLocaleString('zh-CN')}`,comment.body);
    if(comment.path){const label=document.createElement('p');label.className='muted';label.textContent=`${comment.path}:${comment.line} · 批注时的原文`;const source=document.createElement('pre');source.textContent=comment.snippet;item.append(label,source);}
    if(unread.has(comment.id)){item.classList.add('unread');const button=document.createElement('button');button.textContent='@ 了你 · 标为已读';button.onclick=()=>perform(button,async()=>{await api(`mentions/${comment.id}/read`,'POST');lastDiscussion='';await poll();});item.append(button);}
    return item;
  });
  el('discussion-list').replaceChildren(...items);
  if(!items.length)el('discussion-list').append(article('讨论区','可以留言，也可以选择代码行添加批注并 @ 同伴。'));
}

const stateNames:Record<string,string>={queued:'等待 CI',testing:'正在校验',failed:'校验未通过',conflict:'有合并冲突','draft-conflict':'私人草稿冲突','sync-conflict':'同步冲突','needs-base':'等待选择基线',merged:'已合并'};
function renderVersions(rows:any[]){
  el('versions-list').replaceChildren(...rows.map(row=>{
    const item=document.createElement('article');item.className='version-row';const button=document.createElement('button');button.textContent=row.title;button.title=row.title;button.onclick=()=>perform(button,()=>showVersion(row.id));
    const state=document.createElement('span');state.textContent=stateNames[row.state]||row.state;item.append(button,state);return item;
  }));
  if(!rows.length)el('versions-list').append(article('还没有提交','提交草稿或上传 ZIP 后，校验进度和候选版本会显示在这里。'));
}

async function showVersion(id:string){
  const row=await api('submissions/'+id);el('version-title').textContent=row.title;el('version-state').textContent=stateNames[row.state]||row.state;
  el('version-diff').textContent=row.diff||'没有文本差异';el('version-log').textContent=row.log||'等待校验';el('version-actions').replaceChildren();
  const download=document.createElement('button');download.textContent='下载这个版本';download.onclick=()=>{location.href=base+'api/download?submission='+encodeURIComponent(id);};el('version-actions').append(download);
  if(row.account===me.id && !['merged','testing','queued'].includes(row.state)){
    const retry=document.createElement('button');retry.textContent=['draft-conflict','sync-conflict'].includes(row.state)?'提交此版本到共同区':'重新校验';retry.onclick=()=>perform(retry,async()=>{await api('submissions/'+id+'/retry','POST');el<HTMLDialogElement>('version-dialog').close();tab('versions');});el('version-actions').append(retry);
  }
  if(!row.base&&row.account===me.id){const choose=document.createElement('button');choose.textContent='选择当前共同版本为基线';choose.onclick=()=>perform(choose,async()=>{
    await refreshWorkspace();if(!confirm('请确认这个上传包是基于当前共同版本修改的。选择后会重新运行 CI 和三方合并；原候选保留。'))return;
    await api('submissions/'+id+'/base','POST',{base:workspace.shared});el<HTMLDialogElement>('version-dialog').close();tab('versions');
  });el('version-actions').append(choose);}
  el<HTMLDialogElement>('version-dialog').showModal();
}

async function poll(){
  if(!me||polling)return;polling=true;
  try{
    const [versions,discussion]=await Promise.all([api('submissions'),api('discussion')]);
    const versionsString=JSON.stringify(versions);if(versionsString!==lastVersions){renderVersions(versions);lastVersions=versionsString;}
    const discussionString=JSON.stringify(discussion);if(discussionString!==lastDiscussion){renderDiscussion(discussion);lastDiscussion=discussionString;}
    if(runRequested){const status=await api('runtime');el('logs').textContent=status.log||'正在准备运行环境…';el('run-status').textContent=status.ready?'运行中':status.state==='running'?'正在编译…':status.state==='exited'?'运行已结束':'尚未运行';
      if(status.ready&&!rfb){el('screen-empty').hidden=true;const connection=new RFB(el('screen'),wsUrl('vnc'),{shared:true});rfb=connection;rfb.scaleViewport=true;rfb.resizeSession=false;rfb.viewOnly=false;
        connection.background = 'var(--color-panel)';
        connection.addEventListener('disconnect',()=>{if(rfb===connection)rfb=null;});
      }
    }
  }catch(error){if(error instanceof ApiError&&error.status===401)message('登录已过期，请保存本机草稿后重新登录。',true);}
  finally{polling=false;}
}

async function start(){revealPanel?.('preview');await saveAll();rfb?.disconnect();rfb=null;el('screen-empty').hidden=false;await syncViewport(true);await api('run','POST');runRequested=true;el('run-status').textContent='正在编译…';await poll();}
click('run',start);click('run-empty',start);
click('toggle-tree',async()=>{const visible=document.querySelector('.code-area')!.classList.toggle('show-tree');el('toggle-tree').setAttribute('aria-expanded',String(visible));});
click('stop',async()=>{await api('stop','POST');runRequested=false;rfb?.disconnect();rfb=null;el('screen-empty').hidden=false;el('run-status').textContent='已停止';});
click('save',saveAll);
click('submit',async()=>{await saveAll();await api('submit','POST',{title:'提交个人草稿'});tab('versions');await poll();});
click('download',async()=>{await saveAll();location.href=base+'api/download';});
click('upload',async()=>el<HTMLInputElement>('zip-file').click());
el<HTMLInputElement>('zip-file').addEventListener('change',async event=>{
  const input=event.target as HTMLInputElement;if(!input.files?.[0])return;
  await perform(el<HTMLButtonElement>('upload'),async()=>{const form=new FormData();form.append('file',input.files![0]);await api('upload','POST',form);tab('versions');message('ZIP 已保存为独立候选，正在运行 CI。未包含的文件会保留。');await poll();});input.value='';
});
click('pull',async()=>{editor.updateOptions({readOnly:true});try{await saveAll();await api('pull','POST');await refreshWorkspace(true);message('已同步共同版本；个人修改经过三方合并后保留。');}finally{editor.updateOptions({readOnly:false});}});
click('resolve-draft',async()=>{
  try{
  if(!confirm('当前服务器草稿会保留为私人版本，编辑区切换到共同版本。你可以参考冲突差异重新修改并提交。未同步的本机内容也将保留。'))return;
  editor.updateOptions({readOnly:true});
  for(const [path,b]of buffers){clearTimeout(b.timer);if(b.dirty)remember(path,b);}
  await Promise.allSettled([...buffers.values()].map(b=>b.saving).filter(Boolean));
  await api('resolve-draft','POST');for(const b of buffers.values()){b.model.dispose();}buffers.clear();current='';
  // Recovery entries are preserved under a distinct key so the deliberate new draft starts cleanly.
  for(const key of Object.keys(localStorage))if(key.startsWith(`xq-draft:${me.id}:`)){localStorage.setItem('xq-preserved:'+Date.now()+':'+key,localStorage.getItem(key)!);localStorage.removeItem(key);}
  await refreshWorkspace();await openFile(workspace.files.find((f:any)=>f.path.endsWith('/Main.java'))?.path||workspace.files[0].path);await reconnectLanguage();await poll();
  }finally{editor.updateOptions({readOnly:false});}
});
click('recovery-download',async()=>{const saved:Record<string,string>={};for(const key of Object.keys(localStorage))if((key.startsWith('xq-preserved:')&&key.includes(`xq-draft:${me.id}:`))||key.startsWith(`xq-draft:${me.id}:`))saved[key]=localStorage.getItem(key)!;const blob=new Blob([JSON.stringify(saved,null,2)],{type:'application/json'});const link=document.createElement('a');link.href=URL.createObjectURL(blob);link.download='xiangqi-local-drafts.json';link.click();setTimeout(()=>URL.revokeObjectURL(link.href),1000);});
click('logout',async()=>{await saveAll();await api('stop','POST');language?.dispose();await api('logout','POST');workspaceCache.clear();location.reload();});
click('close-dialog',async()=>el<HTMLDialogElement>('version-dialog').close());
async function reconnectLanguage(){language?.dispose();await new Promise(resolve=>setTimeout(resolve,600));language=new JavaLanguage(wsUrl('lsp'),text=>el('lsp-reconnect').textContent=text);}
click('lsp-reconnect',reconnectLanguage);
click('new-file',async()=>{const path=prompt('项目内文件路径，例如 src/model/game/Example.java');if(!path)return;await api('file','PUT',{path,content:'',expected_sha:null});await refreshWorkspace();await openFile(path);});
click('annotate',async()=>selectCurrentLine());
click('selection-comment',async()=>{tab('discussion');el('comment').focus();});
click('selection-question',async()=>{tab('chat');el('question').focus();});
click('selection-clear',async()=>clearSelection());
click('clear-annotation',async()=>clearSelection());
click('explain-selection', async () => {
  if (!current) throw new Error('请先打开一个项目文件');
  if (selection?.path === current) {
    await askQuestion('请解释选中的这一行及其下方的缩进块，说明它们的作用、执行顺序和调用关系。', selection);
  } else {
    await askQuestion('请解释当前打开的整个文件，说明整体职责、主要结构、关键方法和它与其他文件的调用关系。', {path: current});
  }
});
el<HTMLFormElement>('comment-form').addEventListener('submit',event=>{event.preventDefault();const button=el<HTMLFormElement>('comment-form').querySelector<HTMLButtonElement>('button[type=submit]')!;perform(button,async()=>{
  await saveAll();const mention=el<HTMLSelectElement>('mention').value;await api('comments','POST',{body:el<HTMLTextAreaElement>('comment').value,path:annotation?.path||'',line:annotation?.line||0,mentions:mention?[mention]:[]});
  el<HTMLTextAreaElement>('comment').value='';lastDiscussion='';await poll();
});});
el<HTMLFormElement>('chat-form').addEventListener('submit',event=>{
  event.preventDefault();const button=el('chat-form').querySelector<HTMLButtonElement>('button[type=submit]')!;
  perform(button,async()=>{const question=el<HTMLTextAreaElement>('question').value.trim();if(question)await askQuestion(question);});
});

async function boot(){
  me=await api('me');csrf=me.csrf;el('login').hidden=true;el('studio').hidden=false;el('who').textContent=me.name+(me.team==='test'?' · 测试区':'');
  workspaceCache = new WorkspaceCache(me.id);
  const style=getComputedStyle(document.documentElement);monaco.editor.defineTheme('xiangqi',{base:'vs',inherit:true,rules:[],colors:{'editor.background':style.getPropertyValue('--editor-bg').trim(),'editor.foreground':style.getPropertyValue('--editor-ink').trim(),'editor.lineHighlightBackground':style.getPropertyValue('--editor-line').trim()}});
  editor=monaco.editor.create(el('editor'),{theme:'xiangqi',automaticLayout:true,fontSize:14,fontFamily:style.getPropertyValue('--font-code'),minimap:{enabled:false},scrollBeyondLastLine:false,tabSize:4,wordWrap:'off',padding:{top:12},fixedOverflowWidgets:true,accessibilitySupport:'auto'});
  revealPanel = setupLayout(me.id, layoutChanged, error => message(error, true));
  new ResizeObserver(layoutChanged).observe(document.querySelector('.screen-wrap')!);
  editor.addCommand(monaco.KeyMod.CtrlCmd|monaco.KeyMod.Shift|monaco.KeyCode.KeyV,()=>{if(current.endsWith('.md')){mdMode=mdMode==='preview'?'code':'preview';updateFileMode();}});
  editor.addCommand(monaco.KeyMod.CtrlCmd|monaco.KeyCode.KeyS,()=>saveAll().catch(e=>message(e.message,true)));
  monaco.editor.registerEditorOpener({openCodeEditor:async(_source,resource,selection)=>{
    if(resource.path.startsWith('/workspace/'))await openFile(resource.path.slice('/workspace/'.length));
    else if(resource.scheme==='jdt'){
      const content=await language.request('java/classFileContents',{uri:resource.toString()});let model=monaco.editor.getModel(resource);if(!model)model=monaco.editor.createModel(content||'没有可用的源代码','java',resource);clearSelection();editor.setModel(model);editor.updateOptions({readOnly:true});current='';el('file-name').textContent='JDK 参考源码';
    }else return false;
    if(selection){if('startLineNumber'in selection){editor.setSelection(selection);editor.revealRangeInCenter(selection);}else{editor.setPosition(selection);editor.revealPositionInCenter(selection);}}return true;
  }});
  language=new JavaLanguage(wsUrl('lsp'),text=>el('lsp-reconnect').textContent=text);
  if (workspaceCache.workspace) {
    showWorkspace(workspaceCache.workspace);
    const file = initialFile();
    if (file && workspaceCache.file(file.path, file.sha)) await openFile(file.path);
  }
  try {
    await refreshWorkspace(true);
    if (!current || (!workspace.files.some(file => file.path === current) && !buffers.get(current)?.dirty)) {
      const file = initialFile();
      if (file) await openFile(file.path);
    }
  } catch (error) {
    message(current ? '已打开本机缓存。暂时无法核对服务器版本。' : (error as Error).message, true);
  }
  void api('chat').then(chat => {
    if (chat.length && !generating && !el('chat-list').querySelector('article')) renderChat(chat);
  }).catch(() => {});
  void api('runtime').then(status => {
    if (status.state === 'running') {
      runRequested = true;
      layoutChanged();
      void poll();
    }
  }).catch(() => {});
  void poll();
  setInterval(poll,2500);
}
el<HTMLFormElement>('login-form').addEventListener('submit',event=>{event.preventDefault();const button=el<HTMLFormElement>('login-form').querySelector<HTMLButtonElement>('button[type=submit]')!;button.disabled=true;
  api('login','POST',{code:el<HTMLInputElement>('invite').value.trim()}).then(boot).catch(error=>{el('login-error').textContent=error.message;el('invite').setAttribute('aria-invalid','true');}).finally(()=>button.disabled=false);
});
window.addEventListener('beforeunload',event=>{if([...buffers.values()].some(b=>b.dirty)){event.preventDefault();}});
boot().catch(error=>{if(!(error instanceof ApiError&&error.status===401))el('login-error').textContent=error.message;});
