import * as monaco from 'monaco-editor/esm/vs/editor/editor.api.js';

type Pending = { resolve:(data:any)=>void; reject:(error:Error)=>void; timer:ReturnType<typeof setTimeout> };

export class JavaLanguage {
  socket: WebSocket;
  pending = new Map<number, Pending>();
  opened = new Set<string>();
  sequence = 0;
  ready = false;
  disposables: monaco.IDisposable[] = [];
  status: (text:string)=>void;

  constructor(url:string, status:(text:string)=>void) {
    this.status = status;
    this.socket = new WebSocket(url);
    this.socket.onopen = () => this.initialize().catch(e=>status(e.message));
    this.socket.onmessage = e => this.receive(JSON.parse(e.data));
    this.socket.onclose = e => {
      this.ready=false;
      status(e.code === 4429 ? '两路会话已满，关闭闲置会话后重连' : '语义服务已断开，可点击重连');
      for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error('语义服务已断开')); }
      this.pending.clear();
    };
    this.providers();
  }

  send(message:any) { if(this.socket.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify({jsonrpc:'2.0',...message})); }
  notify(method:string, params:any) { this.send({method,params}); }
  request(method:string, params:any, timeout=30000):Promise<any> {
    if(this.socket.readyState !== WebSocket.OPEN) return Promise.reject(new Error('语义服务尚未连接'));
    const id=++this.sequence;
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{this.pending.delete(id);reject(new Error('项目索引尚未就绪，请稍后重试'));},timeout);
      this.pending.set(id,{resolve,reject,timer});this.send({id,method,params});
    });
  }

  async initialize() {
    this.status('正在连接 Java 语义服务…');
    await this.request('initialize',{
      processId:null,rootUri:'file:///workspace',workspaceFolders:[{uri:'file:///workspace',name:'XiangQi'}],
      capabilities:{workspace:{configuration:true,workspaceFolders:true},textDocument:{
        completion:{completionItem:{snippetSupport:true,insertReplaceSupport:true,resolveSupport:{properties:['documentation','detail','additionalTextEdits','textEdit']}}},
        hover:{contentFormat:['markdown','plaintext']},signatureHelp:{signatureInformation:{documentationFormat:['markdown','plaintext']}},
        definition:{linkSupport:true},publishDiagnostics:{relatedInformation:true}}},
      initializationOptions:{settings:this.settings(),extendedClientCapabilities:{classFileContentsSupport:true}}
    },90000);
    this.notify('initialized',{});
    this.notify('workspace/didChangeConfiguration',{settings:this.settings()});
    if(!this.ready)this.status('正在建立 Java 项目索引…');
  }

  settings() { return {java:{home:'/opt/java/openjdk',autobuild:{enabled:true},configuration:{updateBuildConfiguration:'automatic',maven:{userSettings:'/home/runner/.m2/settings.xml'}},
    import:{gradle:{enabled:false},maven:{enabled:true}},maven:{downloadSources:false},signatureHelp:{enabled:true},completion:{favoriteStaticMembers:[]},
    project:{referencedLibraries:['/opt/junit-console.jar']}}}; }

  receive(message:any) {
    if(message.id !== undefined && !message.method) {
      const pending=this.pending.get(message.id);if(!pending)return;
      clearTimeout(pending.timer);this.pending.delete(message.id);
      message.error ? pending.reject(new Error(message.error.message)) : pending.resolve(message.result);return;
    }
    if(message.id !== undefined) {
      let result:any=null;
      if(message.method==='workspace/configuration') result=message.params.items.map((item:any)=>item.section==='java'?this.settings().java:this.settings());
      if(message.method==='workspace/workspaceFolders')result=[{uri:'file:///workspace',name:'XiangQi'}];
      if(message.method==='workspace/applyEdit'){this.send({id:message.id,result:{applied:false,failureReason:'请在编辑器中确认修改'}});return;}
      this.send({id:message.id,result});return;
    }
    if(message.method==='textDocument/publishDiagnostics') {
      const model=monaco.editor.getModel(monaco.Uri.parse(message.params.uri));
      if(model)monaco.editor.setModelMarkers(model,'java-lsp',(message.params.diagnostics||[]).map((d:any)=>({
        ...this.range(d.range),message:d.message,source:d.source||'Java',code:String(d.code??''),
        severity:d.severity===1?monaco.MarkerSeverity.Error:d.severity===2?monaco.MarkerSeverity.Warning:monaco.MarkerSeverity.Info
      })));
    }
    if(message.method==='language/status' && message.params.type==='Started'){
      this.ready=true;for(const model of monaco.editor.getModels())this.open(model);
      this.status('Java 补全与定义跳转已就绪');
    }
  }

  open(model:monaco.editor.ITextModel) {
    const uri=model.uri.toString();
    if(!this.ready||!uri.startsWith('file:///workspace/')||!uri.endsWith('.java')||this.opened.has(uri))return;
    this.opened.add(uri);
    this.notify('textDocument/didOpen',{textDocument:{uri,languageId:'java',version:model.getVersionId(),text:model.getValue()}});
  }
  change(model:monaco.editor.ITextModel) {
    this.open(model);if(!this.ready||!this.opened.has(model.uri.toString()))return;
    this.notify('textDocument/didChange',{textDocument:{uri:model.uri.toString(),version:model.getVersionId()},contentChanges:[{text:model.getValue()}]});
  }
  saved(model:monaco.editor.ITextModel) {
    if(!this.ready)return;
    this.notify('textDocument/didSave',{textDocument:{uri:model.uri.toString()}});
    this.notify('workspace/didChangeWatchedFiles',{changes:[{uri:model.uri.toString(),type:2}]});
  }
  position(model:monaco.editor.ITextModel,p:monaco.Position) { return {textDocument:{uri:model.uri.toString()},position:{line:p.lineNumber-1,character:p.column-1}}; }
  range(r:any) { return {startLineNumber:r.start.line+1,startColumn:r.start.character+1,endLineNumber:r.end.line+1,endColumn:r.end.character+1}; }
  markup(value:any):monaco.IMarkdownString|undefined { return value?{value:typeof value==='string'?value:value.value,isTrusted:false}:undefined; }

  completion(item:any,model:monaco.editor.ITextModel,p:monaco.Position):monaco.languages.CompletionItem {
    const word=model.getWordUntilPosition(p);
    const edit=item.textEdit;
    const range=edit?(edit.range||edit.replace||edit.insert):null;
    const kinds=[monaco.languages.CompletionItemKind.Text,monaco.languages.CompletionItemKind.Method,
      monaco.languages.CompletionItemKind.Function,monaco.languages.CompletionItemKind.Constructor,monaco.languages.CompletionItemKind.Field,
      monaco.languages.CompletionItemKind.Variable,monaco.languages.CompletionItemKind.Class,monaco.languages.CompletionItemKind.Interface,
      monaco.languages.CompletionItemKind.Module,monaco.languages.CompletionItemKind.Property];
    return {label:item.label,kind:kinds[item.kind-1]??monaco.languages.CompletionItemKind.Text,detail:item.detail,
      documentation:this.markup(item.documentation),sortText:item.sortText,filterText:item.filterText,
      insertText:edit?.newText??item.insertText??item.label,
      insertTextRules:item.insertTextFormat===2?monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet:undefined,
      range:range?this.range(range):new monaco.Range(p.lineNumber,word.startColumn,p.lineNumber,word.endColumn),
      additionalTextEdits:item.additionalTextEdits?.map((e:any)=>({range:this.range(e.range),text:e.newText})),
      _lsp:item,_model:model,_position:p} as any;
  }

  providers() {
    this.disposables.push(monaco.languages.registerCompletionItemProvider('java',{
      triggerCharacters:['.','@'],
      provideCompletionItems:async(model,p)=>{
        if(!this.ready)return {suggestions:[]};this.open(model);
        try {const result=await this.request('textDocument/completion',{...this.position(model,p),context:{triggerKind:1}});
          return {suggestions:(Array.isArray(result)?result:result?.items||[]).map((item:any)=>this.completion(item,model,p)),incomplete:result?.isIncomplete};
        }catch(e){this.status((e as Error).message);return {suggestions:[]};}
      },
      resolveCompletionItem:async(item:any)=>{
        try{return this.completion(await this.request('completionItem/resolve',item._lsp),item._model,item._position);}catch{return item;}
      }
    }));
    this.disposables.push(monaco.languages.registerSignatureHelpProvider('java',{
      signatureHelpTriggerCharacters:['(', ','],signatureHelpRetriggerCharacters:[','],
      provideSignatureHelp:async(model,p)=>{
        if(!this.ready)return null;
        const result=await this.request('textDocument/signatureHelp',this.position(model,p)).catch(()=>null);
        if(!result)return null;
        return {value:{...result,activeSignature:result.activeSignature??0,activeParameter:result.activeParameter??0,
          signatures:result.signatures.map((s:any)=>({...s,documentation:this.markup(s.documentation),parameters:(s.parameters||[]).map((p:any)=>({...p,documentation:this.markup(p.documentation)}))}))},dispose(){}};
      }
    }));
    this.disposables.push(monaco.languages.registerDefinitionProvider('java',{
      provideDefinition:async(model,p)=>{
        if(!this.ready)return [];
        const result=await this.request('textDocument/definition',this.position(model,p)).catch(()=>null);
        return (Array.isArray(result)?result:result?[result]:[]).map((v:any)=>({uri:monaco.Uri.parse(v.targetUri||v.uri),range:this.range(v.targetSelectionRange||v.range)}));
      }
    }));
    this.disposables.push(monaco.languages.registerHoverProvider('java',{
      provideHover:async(model,p)=>{
        if(!this.ready)return null;
        const result=await this.request('textDocument/hover',this.position(model,p)).catch(()=>null);
        if(!result)return null;
        return {contents:(Array.isArray(result.contents)?result.contents:[result.contents]).map((v:any)=>this.markup(v)!).filter(Boolean),range:result.range?this.range(result.range):undefined};
      }
    }));
  }
  dispose(){for(const d of this.disposables)d.dispose();this.socket.close();}
}
