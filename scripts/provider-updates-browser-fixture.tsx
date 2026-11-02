import { createRoot } from 'react-dom/client';
import { ProviderUpdates } from '../apps/web/src/components/ProviderUpdates';
import '../apps/web/src/styles/tokens.css';
import '../apps/web/src/styles/base.css';
import '../apps/web/src/styles/ui.css';
import '../apps/web/src/styles/settings.css';
createRoot(document.getElementById('root')!).render(<main style={{ maxWidth: 850, margin: '24px auto', padding: 16 }}>
  <h1>Example provider updates</h1><p>Synthetic CLI versions; no installed provider is modified.</p><ProviderUpdates />
</main>);
