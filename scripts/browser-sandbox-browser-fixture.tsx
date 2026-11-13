import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { BrowserDiscovery } from '@mingle/contracts';
import { BrowserSandboxCard } from '../apps/web/src/components/browser/BrowserSandboxCard';
import '../apps/web/src/styles/tokens.css';
import '../apps/web/src/styles/base.css';
import '../apps/web/src/styles/ui.css';
import '../apps/web/src/styles/browser.css';

const discovery: BrowserDiscovery = {
  sources: [], managedAvailable: true, managedExecutable: '/example/chromium', installing: false,
  notices: [], embeddedAvailable: false,
  sandbox: { userNamespacesRestricted: true, profileInstalled: false, canInstallProfile: true, managedReady: false, manualFix: 'Example instructions A (never executed)' },
  systemBrowsers: [{ id: 'example', name: 'Example browser', executable: '/example/browser', sandboxReady: true }],
};

function Example() {
  const [value, setValue] = useState(discovery);
  return <main style={{ padding: 20, maxWidth: 650 }}>
    <p>Example sandbox setup · no browser installation or commands</p>
    <button onClick={() => setValue({ ...value, sandbox: { ...value.sandbox!, manualFix: 'Example instructions B (never executed)' } })}>Change example instructions</button>
    <BrowserSandboxCard discovery={value} refresh={async () => {}}
      onUseBrowser={async () => { throw new Error('Example browser selection failed. Try another browser.'); }} />
  </main>;
}
createRoot(document.getElementById('root')!).render(<Example />);
