import * as monaco from 'monaco-editor';
import { loader } from '@monaco-editor/react';
import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import JsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker';
import CssWorker from 'monaco-editor/esm/vs/language/css/css.worker?worker';
import HtmlWorker from 'monaco-editor/esm/vs/language/html/html.worker?worker';
import TsWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker';

/** Monaco is bundled and its language workers are served by Vite — nothing is fetched from a CDN. */
(self as unknown as { MonacoEnvironment: monaco.Environment }).MonacoEnvironment = {
  getWorker(_id: string, label: string) {
    switch (label) {
      case 'json': return new JsonWorker();
      case 'css': case 'scss': case 'less': return new CssWorker();
      case 'html': case 'handlebars': case 'razor': return new HtmlWorker();
      case 'typescript': case 'javascript': return new TsWorker();
      default: return new EditorWorker();
    }
  },
};

loader.config({ monaco });

// There is no project-wide module graph in the editor, so semantic checks would only produce false errors.
const noSemantic = { noSemanticValidation: true, noSyntaxValidation: false, noSuggestionDiagnostics: true };
monaco.languages.typescript.typescriptDefaults.setDiagnosticsOptions(noSemantic);
monaco.languages.typescript.javascriptDefaults.setDiagnosticsOptions(noSemantic);

monaco.editor.defineTheme('mingle-dark', {
  base: 'vs-dark', inherit: true,
  rules: [
    { token: 'comment', foreground: '5c6379', fontStyle: 'italic' },
    { token: 'keyword', foreground: 'b2a5ff' },
    { token: 'string', foreground: '9fdcc0' },
    { token: 'number', foreground: 'f1c26d' },
    { token: 'type', foreground: '7fc3f5' },
  ],
  colors: {
    'editor.background': '#0e0e0e', 'editor.foreground': '#d8d8d8', 'editorLineNumber.foreground': '#505050',
    'editorLineNumber.activeForeground': '#a0a0a0', 'editor.lineHighlightBackground': '#181818', 'editor.selectionBackground': '#60606066',
    'editorCursor.foreground': '#e0e0e0', 'editorIndentGuide.background1': '#242424', 'editorWidget.background': '#181818',
    'editorWidget.border': '#303030', 'scrollbarSlider.background': '#a0a0a033',
  },
});
monaco.editor.defineTheme('mingle-light', {
  base: 'vs', inherit: true, rules: [{ token: 'keyword', foreground: '5646cf' }],
  colors: { 'editor.background': '#ffffff', 'editor.lineHighlightBackground': '#f3f3f3', 'editorCursor.foreground': '#242424' },
});

export { monaco };
