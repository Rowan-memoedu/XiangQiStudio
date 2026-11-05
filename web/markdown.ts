import { marked } from 'marked';
import DOMPurify from 'dompurify';

let sequence = 0;
let diagramEngine: Promise<typeof import('mermaid')['default']> | undefined;
function getDiagramEngine() {
  return diagramEngine ??= import('mermaid').then(({ default: mermaid }) => {
    // v12 uses the global htmlLabels setting for node labels. SVG sanitization
    // intentionally removes foreignObject, so all diagram labels must be SVG text.
    mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', suppressErrorRendering: true,
      theme: 'neutral', look: 'classic', htmlLabels: false,
      fontFamily: getComputedStyle(document.documentElement).getPropertyValue('--font-body').trim(),
      flowchart: { htmlLabels: false, wrappingWidth: 240, useMaxWidth: false },
      sequence: { useMaxWidth: false }, class: { useMaxWidth: false }, state: { useMaxWidth: false } });
    return mermaid;
  }).catch(error => { diagramEngine = undefined; throw error; });
}
/** Markdown is user content: sanitize before insertion and never enable script URLs. */
export async function renderMarkdown(target: HTMLElement, source: string, diagrams = true) {
  const version = String(++sequence);
  target.dataset.renderVersion = version;
  target.innerHTML = DOMPurify.sanitize(await marked.parse(source, { gfm: true, breaks: false }), {
    USE_PROFILES: { html: true }, FORBID_TAGS: ['style', 'iframe', 'form'], FORBID_ATTR: ['style']
  });
  for (const link of target.querySelectorAll<HTMLAnchorElement>('a[href]')) {
    if (/^https?:/i.test(link.getAttribute('href') || '')) { link.target = '_blank'; link.rel = 'noopener noreferrer'; }
  }
  for (const heading of target.querySelectorAll<HTMLElement>('h1,h2,h3,h4,h5,h6')) {
    heading.id = (heading.textContent || '').trim().toLowerCase().replace(/\s+/g, '-').replace(/[^\p{L}\p{N}_-]/gu, '');
  }
  if (!diagrams) return;
  const blocks = [...target.querySelectorAll<HTMLElement>('pre > code.language-mermaid')];
  if (!blocks.length) return;
  for (const block of blocks) {
    if (target.dataset.renderVersion !== version) return;
    try {
      const mermaid = await getDiagramEngine();
      if (target.dataset.renderVersion !== version || !target.isConnected) return;
      await document.fonts.ready;
      const { svg } = await mermaid.render('diagram-' + (++sequence), block.textContent || '');
      if (target.dataset.renderVersion !== version || !block.parentElement) return;
      const figure = document.createElement('figure'); figure.className = 'markdown-diagram';
      figure.innerHTML = DOMPurify.sanitize(svg, { USE_PROFILES: { svg: true, svgFilters: true } });
      figure.setAttribute('role', 'img'); figure.setAttribute('aria-label', '程序结构与调用关系图');
      const source = document.createElement('details'), summary = document.createElement('summary');
      summary.textContent = '查看 Mermaid 源码'; source.append(summary);
      block.parentElement.replaceWith(figure, source); source.append(block.parentElement!);
    } catch (error) {
      if (target.dataset.renderVersion !== version || !block.isConnected) return;
      block.parentElement?.classList.add('diagram-error');
      const notice = document.createElement('p'); notice.className = 'diagram-error-message';
      notice.textContent = '图表暂时无法显示，原文已保留：' + (error instanceof Error ? error.message : '请刷新后重试');
      block.parentElement?.before(notice);
    }
  }
}

/** Resolve links relative to the open document, without allowing traversal above the project. */
export function projectLink(documentPath: string, href: string): string | null {
  if (/^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(href)) return null;
  const parts = documentPath.split('/'); parts.pop();
  for (const part of decodeURIComponent(href.split('#')[0]).split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') { if (!parts.length) return null; parts.pop(); } else parts.push(part);
  }
  return parts.join('/');
}
