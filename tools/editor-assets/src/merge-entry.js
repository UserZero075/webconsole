import {MergeView} from '@codemirror/merge';
import {EditorState} from '@codemirror/state';
import {EditorView} from '@codemirror/view';
import {basicSetup} from 'codemirror';
import {structuredPatch} from 'diff';

const theme = EditorView.theme({
  '&': {height: '100%', backgroundColor: '#101113', color: '#d4d8d4', fontSize: '12px'},
  '.cm-scroller': {fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', lineHeight: '1.6'},
  '.cm-content': {padding: '10px 12px'},
  '.cm-gutters': {backgroundColor: '#101113', color: '#686b6e', border: 'none'},
  '.cm-activeLine': {backgroundColor: '#ffffff08'},
  '.cm-focused': {outline: 'none'},
}, {dark: true});

function mountMerge(parent, {original, modified, language = []}) {
  return new MergeView({
    a: {doc: original, extensions: [basicSetup, language, theme, EditorState.readOnly.of(true), EditorView.editable.of(false)]},
    b: {doc: modified, extensions: [basicSetup, language, theme, EditorState.readOnly.of(true), EditorView.editable.of(false)]},
    parent,
    orientation: 'a-b',
    revertControls: false,
    highlightChanges: true,
    gutter: true,
  });
}

function mountUnified(parent, {original, modified, originalLabel, modifiedLabel}) {
  const root = document.createElement('div');
  root.className = 'unified-diff';
  const patch = structuredPatch(originalLabel || 'base', modifiedLabel || 'working tree',
    original, modified, '', '', {context: 3});
  if (!patch.hunks.length) {
    const empty = document.createElement('div');
    empty.className = 'unified-empty';
    empty.textContent = 'No hay diferencias de texto.';
    root.append(empty);
  }
  for (const hunk of patch.hunks) {
    const heading = document.createElement('div');
    heading.className = 'unified-hunk';
    heading.textContent = `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`;
    root.append(heading);
    let oldLine = hunk.oldStart;
    let newLine = hunk.newStart;
    for (const line of hunk.lines) {
      const marker = line[0];
      if (marker === '\\') continue;
      const row = document.createElement('div');
      row.className = `unified-line ${marker === '+' ? 'added' : marker === '-' ? 'removed' : 'context'}`;
      const oldNumber = document.createElement('span');
      oldNumber.className = 'unified-number';
      oldNumber.textContent = marker === '+' ? '' : String(oldLine++);
      const newNumber = document.createElement('span');
      newNumber.className = 'unified-number';
      newNumber.textContent = marker === '-' ? '' : String(newLine++);
      const sign = document.createElement('span');
      sign.className = 'unified-sign';
      sign.textContent = marker;
      const content = document.createElement('code');
      content.textContent = line.slice(1);
      row.append(oldNumber, newNumber, sign, content);
      root.append(row);
    }
  }
  parent.replaceChildren(root);
  return {destroy: () => root.remove()};
}

function mountResponsiveMerge(parent, options) {
  if (window.matchMedia?.('(max-width: 650px)').matches || window.innerWidth <= 650)
    return mountUnified(parent, {
      ...options,
      originalLabel: options.originalLabel || 'Versión anterior',
      modifiedLabel: options.modifiedLabel || 'Versión nueva',
    });
  return mountMerge(parent, options);
}

window.WebConsoleMerge = {mountMerge, mountResponsiveMerge, mountUnified};
