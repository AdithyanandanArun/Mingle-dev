import { createRoot } from 'react-dom/client';
import type { Session } from '@mingle/contracts';
import { BrowserPane } from '../apps/web/src/components/browser/BrowserPane';
import { useBrowserStore } from '../apps/web/src/store/browser';
import { useMingle } from '../apps/web/src/store/store';
import '../apps/web/src/styles/tokens.css';
import '../apps/web/src/styles/base.css';
import '../apps/web/src/styles/ui.css';
import '../apps/web/src/styles/browser.css';

const session = { id: 'example-float', name: 'Example browser', projectId: 'example-project' } as Session;
let popoutOpen = false;
let popoutClosed: ((sessionId: string) => void) | undefined;

window.mingleBrowserDesktop = {
  chooseCredentialStore: async () => false,
  credentialStoreState: async () => null,
  restartForCredentialStore: async () => false,
  openPopout: async () => { popoutOpen = true; return true; },
  isPopoutOpen: async () => popoutOpen,
  focusPopout: async () => popoutOpen,
  dockPopout: async () => false,
  onPopoutClosed: (listener) => { popoutClosed = listener; return () => { popoutClosed = undefined; }; },
  embedded: {
    show: async () => { document.body.dataset.nativeShown = 'true'; return true; },
    hide: async () => { delete document.body.dataset.nativeShown; return true; },
  },
};

function Example() {
  const open = useMingle((s) => s.contextOpen && s.contextTab === 'browser');
  return <>
    <h1>Example browser workspace</h1>
    <button type="button" onClick={() => useBrowserStore.getState().requestOpen(session.id)}>Example agent opens browser</button>
    <button type="button" onClick={() => { popoutOpen = false; popoutClosed?.(session.id); }}>Example desktop window closes</button>
    <aside aria-label="Example browser sidebar" hidden={!open} style={{ width: 'min(420px, 100%)', height: 340 }}>
      <BrowserPane session={session} active={open} />
    </aside>
  </>;
}

useMingle.setState({ contextOpen: false, contextTab: 'files' });
// Simulate an open notification delivered before React mounts the session viewer.
useBrowserStore.getState().requestOpen(session.id);
createRoot(document.getElementById('root')!).render(<Example />);
