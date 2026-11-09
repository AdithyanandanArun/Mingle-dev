import { create } from 'zustand';
import { api, errorMessage } from '../lib/api';
import { basename, languageFor } from '../lib/format';
import { useMingle } from './store';

export interface EditorTab {
  key: string;
  projectId: string;
  sessionId: string | null;
  path: string;
  label: string;
  language: string;
  original: string;
  draft: string;
  status: 'loading' | 'ready' | 'error';
  error: string | null;
  saving: boolean;
  saveError?: string | null;
}

interface EditorState {
  tabs: EditorTab[];
  open(projectId: string, sessionId: string | null, path: string): void;
  edit(key: string, draft: string): void;
  close(key: string): void;
  reload(key: string): Promise<void>;
  save(key: string): Promise<boolean>;
}

export const tabKey = (projectId: string, sessionId: string | null, path: string): string => `${sessionId ? `s:${sessionId}` : `p:${projectId}`}::${path}`;
export const isDirty = (t: EditorTab): boolean => t.status === 'ready' && t.draft !== t.original;

export const useEditor = create<EditorState>((set, get) => {
  const loads = new Map<string, symbol>();
  const lifetimes = new Map<string, symbol>();
  const update = (key: string, patch: Partial<EditorTab>): void =>
    set((s) => ({ tabs: s.tabs.map((t) => (t.key === key ? { ...t, ...patch } : t)) }));

  const load = async (tab: EditorTab): Promise<void> => {
    const request = Symbol();
    loads.set(tab.key, request);
    update(tab.key, { status: 'loading', error: null });
    try {
      const doc = await api.readFile(tab.projectId, tab.path, tab.sessionId);
      if (loads.get(tab.key) !== request) return;
      update(tab.key, { status: 'ready', original: doc.content, draft: doc.content, error: null });
    } catch (e) {
      if (loads.get(tab.key) === request) update(tab.key, { status: 'error', error: errorMessage(e) });
    } finally { if (loads.get(tab.key) === request) loads.delete(tab.key); }
  };

  return {
    tabs: [],
    open(projectId, sessionId, path) {
      const key = tabKey(projectId, sessionId, path);
      if (!get().tabs.some((t) => t.key === key)) {
        lifetimes.set(key, Symbol());
        const tab: EditorTab = {
          key, projectId, sessionId, path, label: basename(path), language: languageFor(path),
          original: '', draft: '', status: 'loading', error: null, saving: false,
        };
        set((s) => ({ tabs: [...s.tabs, tab] }));
        void load(tab);
      }
      useMingle.getState().setCenterTab(key);
    },
    edit: (key, draft) => update(key, { draft }),
    close(key) {
      const tab = get().tabs.find((t) => t.key === key);
      if (!tab) return;
      if (isDirty(tab) && !window.confirm(`Discard unsaved changes to ${tab.path}?`)) return;
      loads.delete(key); lifetimes.delete(key);
      set((s) => ({ tabs: s.tabs.filter((t) => t.key !== key) }));
      const relay = useMingle.getState();
      if (relay.centerTab === key) {
        const rest = get().tabs;
        relay.setCenterTab(rest.length ? rest[rest.length - 1]!.key : 'session');
      }
    },
    async reload(key) {
      const tab = get().tabs.find((t) => t.key === key);
      if (!tab || tab.saving) return;
      if (isDirty(tab) && !window.confirm(`Discard unsaved changes to ${tab.path} and reload from disk?`)) return;
      await load(tab);
    },
    async save(key) {
      const tab = get().tabs.find((t) => t.key === key);
      if (!tab || tab.status !== 'ready' || tab.saving) return false;
      const lifetime = lifetimes.get(key);
      const content = tab.draft;
      update(key, { saving: true, saveError: null });
      try {
        await api.writeFile(tab.projectId, tab.path, content, tab.sessionId);
        if (lifetimes.get(key) !== lifetime || !get().tabs.some((t) => t.key === key)) return false;
        update(key, { saving: false, original: content, saveError: null });
        useMingle.getState().toast('success', `Saved ${tab.path}`);
        return true;
      } catch (e) {
        if (lifetimes.get(key) !== lifetime || !get().tabs.some((t) => t.key === key)) return false;
        update(key, { saving: false, saveError: errorMessage(e) });
        useMingle.getState().toast('error', `Could not save ${tab.path}: ${errorMessage(e)}`);
        return false;
      }
    },
  };
});

window.addEventListener('beforeunload', (e) => {
  if (useEditor.getState().tabs.some(isDirty)) e.preventDefault();
});
