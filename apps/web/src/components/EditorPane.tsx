import { useEffect } from 'react';
import Editor from '@monaco-editor/react';
import { RefreshCw, Save, FileWarning } from 'lucide-react';
import './monacoSetup';
import { useMingle } from '../store/store';
import { isDirty, useEditor } from '../store/editor';
import { Button, EmptyState, IconButton, InlineError, MOD, Spinner, isMac } from './ui';

export default function EditorPane({ tabKey }: { tabKey: string }) {
  const tab = useEditor((s) => s.tabs.find((t) => t.key === tabKey));
  const theme = useMingle((s) => s.boot?.settings.theme ?? 'dark');
  const sessionName = useMingle((s) => (tab?.sessionId ? s.boot?.sessions.find((x) => x.id === tab.sessionId)?.name : undefined));

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's' && useMingle.getState().centerTab === tabKey) {
        e.preventDefault();
        void useEditor.getState().save(tabKey);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [tabKey]);

  if (!tab) return <EmptyState title="File closed" />;
  const dirty = isDirty(tab);

  return (
    <div className="editor">
      <div className="editor__bar">
        <span className="editor__path" title={tab.path}>{tab.path}</span>
        <span className="chip">{tab.sessionId ? (sessionName ? `${sessionName} scope` : 'session scope') : 'project scope'}</span>
        <span className="chip chip--mono">{tab.language}</span>
        <span className="spacer" />
        <IconButton label="Reload from disk" onClick={() => void useEditor.getState().reload(tab.key)} disabled={tab.status === 'loading' || tab.saving} why={tab.saving ? 'Wait for the save to finish' : 'Loading'}><RefreshCw size={14} /></IconButton>
        <Button size="sm" variant="primary" busy={tab.saving} disabled={!dirty || tab.status !== 'ready'} why={tab.status !== 'ready' ? 'File is not loaded' : 'No unsaved changes'} onClick={() => void useEditor.getState().save(tab.key)}>
          <Save size={13} /> Save <span className="kbdline">{isMac ? `${MOD}S` : `${MOD}+S`}</span>
        </Button>
      </div>
      {tab.saveError ? <div className="editor__save-error"><InlineError onRetry={() => void useEditor.getState().save(tab.key)}>Could not save {tab.path}: {tab.saveError}. Your changes are still in the editor.</InlineError></div> : null}
      <div className="editor__body">
        {tab.status === 'loading' ? <div className="editor__state"><Spinner label="Loading file" /></div> : null}
        {tab.status === 'error' ? (
          <EmptyState icon={<FileWarning size={20} />} title="Can't open this file" action={<Button onClick={() => void useEditor.getState().reload(tab.key)}>Try again</Button>}>{tab.error}</EmptyState>
        ) : null}
        {tab.status === 'ready' ? (
          <Editor
            path={tab.key} language={tab.language} value={tab.draft} theme={theme === 'light' ? 'mingle-light' : 'mingle-dark'}
            onChange={(v) => useEditor.getState().edit(tab.key, v ?? '')}
            loading={<div className="editor__state"><Spinner label="Starting editor" /></div>}
            options={{
              minimap: { enabled: false }, fontFamily: 'JetBrains Mono, ui-monospace, SF Mono, Menlo, Consolas, monospace', fontSize: 13, lineHeight: 21,
              padding: { top: 14, bottom: 14 }, scrollBeyondLastLine: false, smoothScrolling: true, automaticLayout: true, renderLineHighlight: 'line',
              tabSize: 2, bracketPairColorization: { enabled: true }, fontLigatures: true, overviewRulerBorder: false, wordWrap: tab.language === 'markdown' || tab.language === 'plaintext' ? 'on' : 'off',
            }}
          />
        ) : null}
      </div>
    </div>
  );
}
