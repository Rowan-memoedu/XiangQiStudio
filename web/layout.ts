/** IDE-style splitters. Layout belongs to this browser/account, never to project source. */
export function setupLayout(account: string, changed: () => void) {
  const root = document.querySelector<HTMLElement>('#studio')!;
  const key = 'xiangqi-layout:' + account;
  const allowed = ['--preview-width', '--code-height', '--tree-width', '--log-height', '--mobile-preview-height', '--mobile-code-height'];
  try { const saved = JSON.parse(localStorage.getItem(key) || '{}'); for (const name of allowed) if (/^\d+(\.\d+)?(px|%)$/.test(saved[name])) root.style.setProperty(name, saved[name]); } catch { /* Use defaults for an invalid preference. */ }
  const save = () => { const data: Record<string,string> = {}; for (const name of allowed) data[name] = root.style.getPropertyValue(name); localStorage.setItem(key, JSON.stringify(data)); };
  const clamp = (n: number, min: number, max: number) => Math.max(min, Math.min(Math.max(min,max), n));
  for (const handle of root.querySelectorAll<HTMLElement>('[data-split]')) {
    const kind = handle.dataset.split!;
    function update(dx: number, dy: number, origin: DOMRect, parent: DOMRect, mobile: boolean) {
      if (kind === 'columns') root.style.setProperty(mobile ? '--mobile-preview-height' : '--preview-width', mobile ? clamp(origin.height + dy, 420, 1200) + 'px' : clamp((origin.width + dx) / parent.width * 100, 22, 75) + '%');
      if (kind === 'code') root.style.setProperty(mobile ? '--mobile-code-height' : '--code-height', mobile ? clamp(origin.height + dy, 240, 1100) + 'px' : clamp((origin.height + dy) / (parent.height - 44) * 100, 24, 72) + '%');
      if (kind === 'tree') root.style.setProperty('--tree-width', clamp(origin.width + dx, 100, Math.min(420, parent.width - 180)) + 'px');
      if (kind === 'logs') root.style.setProperty('--log-height', clamp(origin.height - dy, 50, parent.height - 310) + 'px');
      changed();
    }
    function geometry() {
      const selector = kind === 'columns' ? '.preview-column' : kind === 'code' ? '.code-area' : kind === 'tree' ? '#tree' : '.console';
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
  document.getElementById('reset-layout')!.onclick = () => { for(const name of allowed)root.style.removeProperty(name);localStorage.removeItem(key);changed(); };
}
