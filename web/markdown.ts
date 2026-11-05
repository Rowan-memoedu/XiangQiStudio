import { marked } from 'marked';
import DOMPurify from 'dompurify';

let sequence = 0;
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
  const { default: mermaid } = await import('mermaid');
  mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', suppressErrorRendering: true, theme: 'neutral',
    fontFamily: getComputedStyle(document.documentElement).getPropertyValue('--font-body'), flowchart: { htmlLabels: false } });
  for (const block of blocks) {
    if (target.dataset.renderVersion !== version) return;
    try {
      const { svg } = await mermaid.render('diagram-' + (++sequence), block.textContent || '');
      if (target.dataset.renderVersion !== version || !block.parentElement) return;
      const figure = document.createElement('figure'); figure.className = 'markdown-diagram';
      figure.innerHTML = DOMPurify.sanitize(svg, { USE_PROFILES: { svg: true, svgFilters: true } });
      block.parentElement.replaceWith(figure);
    } catch {
      block.parentElement?.classList.add('diagram-error');
      block.parentElement?.setAttribute('title', '图表语法未通过，保留原文');
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
