import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { Bootstrap } from '@mingle/contracts';
import { ProjectMemory } from '../apps/web/src/components/context/ProjectMemory';
import { useMingle } from '../apps/web/src/store/store';
import '../apps/web/src/styles/tokens.css';
import '../apps/web/src/styles/base.css';
import '../apps/web/src/styles/ui.css';
import '../apps/web/src/styles/app.css';
const boot = { projects: ['example-a', 'example-b'].map((id) => ({ id, name: id, path: `/example/${id}`, isExample: false, createdAt: '2026-11-02' })), sessions: [], messages: [], tasks: [], events: [], approvals: [], plans: [], questions: [], providers: [], settings: {}, version: 'Example fixture', runs: [], toolCalls: [] } as unknown as Bootstrap;
useMingle.setState({ boot, activeProjectId: 'example-a', contextOpen: true });
function Fixture() {
  const [active, setActive] = useState(true);
  return <main style={{ maxWidth: 390, height: '100dvh', margin: 'auto', display: 'flex', flexDirection: 'column' }}><header style={{ padding: 10 }}><h1 style={{ fontSize: 14 }}>Example project memory acceptance</h1><button onClick={() => useMingle.setState({ activeProjectId: 'example-b' })}>Switch example project</button><button onClick={() => setActive(!active)}>Toggle panel</button></header><ProjectMemory active={active} /></main>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
