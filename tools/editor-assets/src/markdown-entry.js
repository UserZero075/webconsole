import DOMPurify from 'dompurify';
import hljs from 'highlight.js/lib/core';
import bash from 'highlight.js/lib/languages/bash';
import css from 'highlight.js/lib/languages/css';
import html from 'highlight.js/lib/languages/xml';
import javascript from 'highlight.js/lib/languages/javascript';
import json from 'highlight.js/lib/languages/json';
import python from 'highlight.js/lib/languages/python';
import typescript from 'highlight.js/lib/languages/typescript';
import yaml from 'highlight.js/lib/languages/yaml';
import {marked} from 'marked';

for (const [name, language] of Object.entries({bash, css, html, javascript, json, python, typescript, yaml}))
  hljs.registerLanguage(name, language);

function renderMarkdown(source) {
  const renderer = new marked.Renderer();
  const headingIds = new Map();
  renderer.html = () => '';
  renderer.image = ({text}) => `<span class="markdown-image-placeholder">Imagen: ${escapeText(text || 'sin descripción')}</span>`;
  renderer.checkbox = ({checked}) => `<span class="markdown-task-check" aria-hidden="true">${checked ? '✓' : '○'}</span>`;
  renderer.heading = function ({tokens, depth}) {
    const content = this.parser.parseInline(tokens);
    const plain = content.replace(/<[^>]*>/g, '').replace(/&(?:amp|lt|gt|quot|#39);/g, ' ');
    const base = plain.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
      .replace(/[^\p{L}\p{N}\s-]/gu, '').trim().replace(/[\s-]+/g, '-') || 'section';
    const duplicate = headingIds.get(base) || 0;
    headingIds.set(base, duplicate + 1);
    const id = duplicate ? `${base}-${duplicate}` : base;
    return `<h${depth} id="${escapeAttribute(id)}">${content}</h${depth}>\n`;
  };
  renderer.code = ({text, lang}) => {
    const language = String(lang || '').trim().split(/[\s,]+/)[0].toLowerCase();
    const result = language && hljs.getLanguage(language)
      ? hljs.highlight(text, {language, ignoreIllegals: true}).value : escapeText(text);
    const className = language && hljs.getLanguage(language) ? ` class="hljs language-${escapeAttribute(language)}"` : '';
    return `<pre><code${className}>${result}</code></pre>\n`;
  };
  const raw = marked.parse(String(source || ''), {gfm: true, breaks: false, renderer});
  return DOMPurify.sanitize(raw, {
    USE_PROFILES: {html: true},
    FORBID_TAGS: ['style', 'script', 'iframe', 'object', 'embed', 'svg', 'math', 'form', 'input', 'button', 'video', 'audio'],
    FORBID_ATTR: ['style', 'srcset'],
    ALLOW_DATA_ATTR: false,
  });
}

function escapeText(value) {
  return String(value).replace(/[&<>"']/g, char => ({'&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'}[char]));
}

function escapeAttribute(value) {
  return escapeText(value).replace(/\s/g, '');
}

window.WebConsoleMarkdown = {renderMarkdown};
