import {basicSetup, EditorView} from 'codemirror';
import {EditorState, Compartment} from '@codemirror/state';
import {indentWithTab} from '@codemirror/commands';
import {keymap} from '@codemirror/view';
import {indentUnit} from '@codemirror/language';
import {javascript} from '@codemirror/lang-javascript';
import {json} from '@codemirror/lang-json';
import {html} from '@codemirror/lang-html';
import {css} from '@codemirror/lang-css';
import {python} from '@codemirror/lang-python';
import {yaml} from '@codemirror/lang-yaml';
import {markdown} from '@codemirror/lang-markdown';
import {StreamLanguage} from '@codemirror/language';
import {shell} from '@codemirror/legacy-modes/mode/shell';
import {toml} from '@codemirror/legacy-modes/mode/toml';
import {dockerFile} from '@codemirror/legacy-modes/mode/dockerfile';
import {go} from '@codemirror/legacy-modes/mode/go';
import {rust} from '@codemirror/legacy-modes/mode/rust';
import {sql} from '@codemirror/legacy-modes/mode/sql';
import {NavigationHistory} from './navigation-history.js';

const theme = EditorView.theme({
  '&': {height: '100%', backgroundColor: '#101113', color: '#d4d8d4', fontSize: '13px'},
  '.cm-scroller': {overflow: 'auto', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', lineHeight: '1.65'},
  '.cm-content': {padding: '14px 18px 28px', caretColor: '#8acfb3'},
  '.cm-gutters': {backgroundColor: '#101113', color: '#686b6e', border: 'none'},
  '.cm-activeLine': {backgroundColor: '#ffffff08'},
  '.cm-activeLineGutter': {color: '#c4c7c2'},
  '.cm-selectionBackground, ::selection': {backgroundColor: '#345846 !important'},
  '.cm-cursor, .cm-dropCursor': {borderLeftColor: '#8acfb3'},
  '.cm-focused': {outline: 'none'},
  '.cm-tooltip': {backgroundColor: '#1d1f22', border: '1px solid #383a3e', color: '#e5e6e2'},
}, {dark: true});

function isMarkdownPath(filePath) {
  return /\.(?:md|markdown)$/i.test(String(filePath || ''));
}

function languageForPath(filePath) {
  const name = String(filePath || '').split('/').pop().toLowerCase();
  if (/\.(?:mjs|cjs|js|jsx)$/.test(name)) return javascript({jsx: true});
  if (/\.(?:ts|tsx|mts|cts)$/.test(name)) return javascript({typescript: true, jsx: /\.tsx$/.test(name)});
  if (/\.jsonc?$/.test(name)) return json();
  if (/\.html?$/.test(name)) return html();
  if (/\.css$/.test(name)) return css();
  if (/\.py$/.test(name)) return python();
  if (/\.(?:ya?ml)$/.test(name)) return yaml();
  if (/\.(?:md|markdown)$/.test(name)) return markdown();
  if (/\.(?:sh|bash|zsh|fish)$/.test(name)) return StreamLanguage.define(shell);
  if (/\.toml$/.test(name)) return StreamLanguage.define(toml);
  if (name === 'dockerfile' || name.startsWith('dockerfile.')) return StreamLanguage.define(dockerFile);
  if (/\.go$/.test(name)) return StreamLanguage.define(go);
  if (/\.rs$/.test(name)) return StreamLanguage.define(rust);
  if (/\.sql$/.test(name)) return StreamLanguage.define(sql);
  return [];
}

function createEditor(parent, {doc = '', filePath = '', state = null, onChange = () => {}, onSave = () => {}} = {}) {
  const language = new Compartment();
  const view = new EditorView({
    parent,
    state: state || EditorState.create({
      doc,
      extensions: [
        basicSetup,
        EditorState.tabSize.of(4),
        indentUnit.of('    '),
        language.of(languageForPath(filePath)),
        keymap.of([
          {key: 'Mod-s', run: () => { onSave(); return true; }},
          indentWithTab,
        ]),
        EditorView.updateListener.of(update => {
          if (update.docChanged) onChange(update.state.doc.toString(), update);
          if (update.selectionSet && !update.docChanged) onChange(null, update);
        }),
        theme,
      ],
    }),
  });
  view.setLanguage = filePath => view.dispatch({effects: language.reconfigure(languageForPath(filePath))});
  view.save = onSave;
  return view;
}

window.WebConsoleEditor = {createEditor, languageForPath, isMarkdownPath, NavigationHistory};
