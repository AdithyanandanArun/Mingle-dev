import { createRoot } from 'react-dom/client';
import '../apps/web/src/styles/tokens.css';
import '../apps/web/src/styles/base.css';
import '../apps/web/src/styles/ui.css';
import '../apps/web/src/styles/settings.css';
// Keep the production store's development socket inside this Example fixture.
class ExampleIdleWebSocket {
  static readonly OPEN = 1;
  readyState = 3;
  close() { this.readyState = 3; }
}
Object.defineProperty(window, 'WebSocket', { configurable: true, value: ExampleIdleWebSocket });
const { ProviderUpdates } = await import('../apps/web/src/components/ProviderUpdates');
createRoot(document.getElementById('root')!).render(<main style={{ maxWidth: 850, margin: '24px auto', padding: 16 }}>
  <h1>Example provider updates</h1><p>Synthetic CLI versions; no installed provider is modified.</p><ProviderUpdates />
</main>);
