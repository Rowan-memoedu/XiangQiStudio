const panelNames = {preview: '运行画面', code: '项目代码', discussion: '项目问答'};
type PanelId = keyof typeof panelNames;

function setupToolbar(changed: () => void, reportError: (message: string) => void) {
  const toolbar = document.querySelector<HTMLElement>('#workspace-toolbar')!;
  const edge = toolbar.parentElement!;
  const toggle = document.querySelector<HTMLButtonElement>('#toolbar-toggle')!;
  const fullscreen = document.querySelector<HTMLButtonElement>('#page-fullscreen')!;
  let hovering = false;
  let pinned = false;

  function open(show: boolean) {
    toolbar.hidden = !show;
    toggle.setAttribute('aria-expanded', String(show));
  }

  edge.addEventListener('pointerenter', event => {
    if (event.pointerType !== 'mouse') return;
    hovering = true;
    open(true);
  });
  edge.addEventListener('pointerleave', () => {
    hovering = false;
    if (!pinned && !toolbar.querySelector(':focus-visible')) open(false);
  });
  edge.addEventListener('focusout', event => {
    if (!hovering && !pinned && !edge.contains(event.relatedTarget as Node | null)) open(false);
  });
  toggle.onclick = () => {
    pinned = toolbar.hidden;
    open(pinned);
    if (pinned) toolbar.querySelector('button')?.focus();
  };
  document.addEventListener('pointerdown', event => {
    if (!edge.contains(event.target as Node) && !toggle.contains(event.target as Node)) {
      pinned = false;
      open(false);
    }
  });
  document.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || toolbar.hidden || document.querySelector('dialog[open]')) return;
    pinned = false;
    open(false);
    if (edge.contains(event.target as Node)) toggle.focus();
  });

  fullscreen.disabled = !document.fullscreenEnabled;
  fullscreen.title = fullscreen.disabled ? '当前浏览器不支持网页全屏' : '';
  fullscreen.onclick = async () => {
    fullscreen.disabled = true;
    fullscreen.setAttribute('aria-busy', 'true');
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await document.documentElement.requestFullscreen({navigationUI: 'hide'});
      fullscreen.dataset.state = 'success';
    } catch {
      fullscreen.dataset.state = 'error';
      reportError('无法进入或退出网页全屏，请检查浏览器的全屏权限。');
    } finally {
      fullscreen.disabled = false;
      fullscreen.removeAttribute('aria-busy');
    }
  };
  document.addEventListener('fullscreenchange', () => {
    fullscreen.textContent = document.fullscreenElement ? '退出全屏' : '网页全屏';
    fullscreen.setAttribute('aria-pressed', String(Boolean(document.fullscreenElement)));
    changed();
  });
}

/** The saved layout holds splitter sizes and collapsed panels for this browser/account. */
export function setupLayout(account: string, changed: () => void, reportError: (message: string) => void) {
  const root = document.querySelector<HTMLElement>('#studio')!;
  const workspace = root.querySelector<HTMLElement>('.workspace')!;
  const codeColumn = root.querySelector<HTMLElement>('.code-column')!;
  const dock = root.querySelector<HTMLElement>('#panel-dock')!;
  const key = 'xiangqi-layout:' + account;
  const allowed = ['--preview-width', '--code-height', '--tree-width', '--log-height', '--mobile-preview-height', '--mobile-code-height'];
  const panelIds = Object.keys(panelNames) as PanelId[];
  const collapsed = new Set<PanelId>();
  let focused: PanelId | undefined;
  try {
    const saved = JSON.parse(localStorage.getItem(key) || '{}');
    for (const name of allowed) {
      if (/^\d+(\.\d+)?(px|%)$/.test(saved[name])) root.style.setProperty(name, saved[name]);
    }
    if (Array.isArray(saved.collapsed)) {
      for (const id of panelIds) if (saved.collapsed.includes(id)) collapsed.add(id);
    }
  } catch { /* Use defaults when browser storage is unavailable. */ }
  function save() {
    const sizes = Object.fromEntries(allowed.map(name => [name, root.style.getPropertyValue(name)]));
    try {
      localStorage.setItem(key, JSON.stringify({...sizes, collapsed: [...collapsed]}));
    } catch { /* The current layout still works without persistence. */ }
  }

  function renderPanels() {
    if (focused) workspace.dataset.focused = focused;
    else delete workspace.dataset.focused;
    const visible = (id: PanelId) => !collapsed.has(id) && (!focused || focused === id);
    for (const id of panelIds) {
      root.querySelector<HTMLElement>(`[data-panel=${id}]`)!.hidden = !visible(id);
      root.querySelector<HTMLButtonElement>(`[data-restore=${id}]`)!.hidden = !collapsed.has(id);
      const maximize = root.querySelector<HTMLButtonElement>(`[data-maximize=${id}]`)!;
      const label = (focused === id ? '还原' : '放大') + panelNames[id];
      maximize.title = label;
      maximize.setAttribute('aria-label', label);
      maximize.setAttribute('aria-pressed', String(focused === id));
    }
    codeColumn.hidden = !visible('code') && !visible('discussion');
    root.querySelector<HTMLElement>('[data-split=columns]')!.hidden = !visible('preview') || codeColumn.hidden;
    root.querySelector<HTMLElement>('[data-split=code]')!.hidden = !visible('code') || !visible('discussion');
    dock.hidden = collapsed.size === 0;
    changed();
  }

  function revealPanel(id: PanelId) {
    const restored = collapsed.delete(id);
    if (!restored && (!focused || focused === id)) return;
    if (focused !== id) focused = undefined;
    save();
    renderPanels();
  }

  for (const id of panelIds) {
    const maximize = root.querySelector<HTMLButtonElement>(`[data-maximize=${id}]`)!;
    const restore = root.querySelector<HTMLButtonElement>(`[data-restore=${id}]`)!;
    maximize.onclick = () => {
      focused = focused === id ? undefined : id;
      renderPanels();
    };
    root.querySelector<HTMLButtonElement>(`[data-collapse=${id}]`)!.onclick = () => {
      collapsed.add(id);
      focused = undefined;
      save();
      renderPanels();
      restore.focus();
    };
    restore.onclick = () => {
      revealPanel(id);
      maximize.focus();
    };
  }
  setupToolbar(changed, reportError);
  const clamp = (n: number, min: number, max: number) => Math.max(min, Math.min(Math.max(min,max), n));
  for (const handle of root.querySelectorAll<HTMLElement>('[data-split]')) {
    const kind = handle.dataset.split!;
    function update(dx: number, dy: number, origin: DOMRect, parent: DOMRect, mobile: boolean) {
      if (kind === 'columns') root.style.setProperty(mobile ? '--mobile-preview-height' : '--preview-width', mobile ? clamp(origin.height + dy, 420, 1200) + 'px' : clamp((origin.width + dx) / parent.width * 100, 22, 75) + '%');
      if (kind === 'code') root.style.setProperty(mobile ? '--mobile-code-height' : '--code-height', mobile ? clamp(origin.height + dy, 240, 1100) + 'px' : clamp((origin.height + dy) / parent.height * 100, 24, 72) + '%');
      if (kind === 'tree') root.style.setProperty('--tree-width', clamp(origin.width + dx, 100, Math.min(420, parent.width - 180)) + 'px');
      if (kind === 'logs') root.style.setProperty('--log-height', clamp(origin.height - dy, 50, parent.height - 310) + 'px');
      changed();
    }
    function geometry() {
      const selector = kind === 'columns' ? '.preview-column' : kind === 'code' ? '.project-panel' : kind === 'tree' ? '#tree' : '.console';
      const node = root.querySelector<HTMLElement>(selector)!;
      return { origin: node.getBoundingClientRect(), parent: node.parentElement!.getBoundingClientRect(), mobile: matchMedia('(max-width:768px)').matches };
    }
    handle.addEventListener('pointerdown', event => {
      event.preventDefault(); const startX = event.clientX, startY = event.clientY, g = geometry();
      handle.setPointerCapture(event.pointerId); document.body.classList.add('resizing'); handle.classList.add('dragging');
      const move = (e: PointerEvent) => update(e.clientX - startX, e.clientY - startY, g.origin, g.parent, g.mobile);
      const end = () => { document.body.classList.remove('resizing'); handle.classList.remove('dragging'); handle.removeEventListener('pointermove',move); handle.removeEventListener('pointerup',end); handle.removeEventListener('pointercancel',end); save(); changed(); };
      handle.addEventListener('pointermove', move); handle.addEventListener('pointerup', end, { once:true }); handle.addEventListener('pointercancel', end, { once:true });
    });
    handle.addEventListener('keydown', event => {
      const delta = event.shiftKey ? 40 : 12; const g = geometry();
      if (!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(event.key)) return;
      event.preventDefault(); update(event.key==='ArrowLeft'?-delta:event.key==='ArrowRight'?delta:0,event.key==='ArrowUp'?-delta:event.key==='ArrowDown'?delta:0,g.origin,g.parent,g.mobile); save();
    });
  }
  document.getElementById('reset-layout')!.onclick = () => {
    for (const name of allowed) root.style.removeProperty(name);
    collapsed.clear();
    focused = undefined;
    save();
    renderPanels();
  };
  renderPanels();
  return revealPanel;
}
