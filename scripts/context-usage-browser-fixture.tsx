import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { Session } from '@mingle/contracts';
import '../apps/web/src/styles/tokens.css';
import '../apps/web/src/styles/base.css';
import '../apps/web/src/styles/ui.css';

async function mount() {
  class IdleSocket { static OPEN = 1; readyState = 3; close() {} }
  Object.defineProperty(window, 'WebSocket', { configurable: true, value: IdleSocket });
  const { ContextUsage } = await import('../apps/web/src/components/composer/ContextUsage');
  const { useMingle } = await import('../apps/web/src/store/store');
  useMingle.setState({ connection: 'online' });
  function Example() {
    const [percent, setPercent] = useState<number | null>(75);
    const [id, setId] = useState('one');
    const [busy, setBusy] = useState(false);
    const session = { id, provider: 'codex', model: 'example', providerSessionId: `native-${id}`, status: busy ? 'running' : 'idle',
      ...(percent === null ? {} : { contextUsage: { usedTokens: Math.round(percent * 10), contextWindow: 1000, estimated: false, source: 'Example provider', updatedAt: '2026-11-15T00:00:00Z', provider: 'codex', model: 'example', providerSessionId: `native-${id}` } }),
    } as Session;
    return <main style={{ padding: 20 }}>
      <p>Example context workspace · no provider calls</p>
      <div>{[0, 70, 70.1, 90, 90.1].map(value => <button key={value} onClick={() => setPercent(value)}>Set {value}%</button>)}
        <button onClick={() => setPercent(null)}>Unreported</button><button onClick={() => setId(value => value === 'one' ? 'two' : 'one')}>Switch conversation</button>
        <button onClick={() => setBusy(value => !value)}>Toggle busy</button></div>
      <textarea aria-label="Example draft" defaultValue="Keep this unsent draft" />
      <div style={{ position: 'fixed', right: 20, bottom: 20 }}><ContextUsage session={session} /></div>
    </main>;
  }
  createRoot(document.getElementById('root')!).render(<Example />);
}
void mount();
