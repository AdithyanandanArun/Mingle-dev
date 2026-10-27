import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { ArrowLeft, ArrowRight, Check, ChevronRight, CircleHelp, LockKeyhole, RotateCcw, Sparkles, X } from 'lucide-react';
import type { AccountState, ProviderInfo } from '@mingle/contracts';
import { api, errorMessage } from '../../lib/api';
import { PROVIDER_NAMES } from '../../lib/providers';
import { useMingle } from '../../store/store';
import { MingleGlyph, ProviderMark } from '../ui';
import './Onboarding.css';

type Stage = 'welcome' | 'providers' | 'ready';
const STAGES: { id: Stage; label: string }[] = [
  { id: 'welcome', label: 'Welcome' }, { id: 'providers', label: 'Providers' }, { id: 'ready', label: 'Ready' },
];
const POLL_MS = 1_500;

export function Onboarding({ providers, isExampleWorkspace = false, returnFocus, onComplete, onManageProviders }: {
  providers: ProviderInfo[];
  isExampleWorkspace?: boolean;
  returnFocus?: HTMLElement | null;
  onComplete: () => void;
  onManageProviders: () => void;
}) {
  const [stage, setStage] = useState<Stage>('welcome');
  const [account, setAccount] = useState<AccountState | null>(null);
  const [accountError, setAccountError] = useState<string | null>(null);
  const [accountErrorKind, setAccountErrorKind] = useState<'load' | 'sign-in' | null>(null);
  const [accountBusy, setAccountBusy] = useState(false);
  const [completionBusy, setCompletionBusy] = useState(false);
  const [completionError, setCompletionError] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const mounted = useRef(true);
  const completionLock = useRef(false);
  const restoreFocusFrame = useRef<number | null>(null);
  const restoreFocusOnExit = useRef(false);

  const loadAccount = useCallback(async (signal?: AbortSignal) => {
    try {
      const next = await api.account(signal);
      if (!signal?.aborted && mounted.current) {
        setAccount(next);
        setAccountError(null);
        setAccountErrorKind(null);
      }
    } catch (cause) {
      if (!signal?.aborted && mounted.current) {
        setAccountError(errorMessage(cause));
        setAccountErrorKind('load');
      }
    }
  }, []);

  useEffect(() => {
    if (restoreFocusFrame.current !== null) window.cancelAnimationFrame(restoreFocusFrame.current);
    restoreFocusFrame.current = null;
    mounted.current = true;
    const controller = new AbortController();
    void loadAccount(controller.signal);
    const priorFocus = returnFocus ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    return () => {
      mounted.current = false;
      controller.abort();
      if (!restoreFocusOnExit.current) return;
      restoreFocusFrame.current = window.requestAnimationFrame(() => {
        restoreFocusFrame.current = null;
        if (priorFocus && priorFocus !== document.body && priorFocus !== document.documentElement && priorFocus.isConnected && !priorFocus.closest('[inert]')) priorFocus.focus({ preventScroll: true });
        else document.getElementById('main')?.focus({ preventScroll: true });
      });
    };
  }, [loadAccount]);

  useEffect(() => {
    if (account?.status !== 'signing-in' && account?.status !== 'restoring') return;
    let active = true;
    let timer: number | undefined;
    let request: AbortController | null = null;
    const poll = async () => {
      if (!active) return;
      request = new AbortController();
      await loadAccount(request.signal);
      if (active) timer = window.setTimeout(() => void poll(), POLL_MS);
    };
    timer = window.setTimeout(() => void poll(), POLL_MS);
    return () => {
      active = false;
      if (timer !== undefined) window.clearTimeout(timer);
      request?.abort();
    };
  }, [account?.status, loadAccount]);

  useEffect(() => {
    const heading = dialogRef.current?.querySelector<HTMLElement>('[data-onboarding-heading]');
    heading?.focus({ preventScroll: true });
  }, [stage]);

  const complete = async (after?: () => void) => {
    if (completionLock.current) return;
    completionLock.current = true;
    setCompletionBusy(true);
    setCompletionError(null);
    try {
      await api.updateSettings({ onboardingCompletedVersion: 1 });
      await useMingle.getState().refreshNow();
      restoreFocusOnExit.current = !after;
      onComplete();
      after?.();
    } catch (cause) {
      setCompletionError(errorMessage(cause));
    } finally {
      completionLock.current = false;
      if (mounted.current) setCompletionBusy(false);
    }
  };

  const startSignIn = async () => {
    if (!account?.configured || accountBusy) return;
    setAccountBusy(true);
    setAccountError(null);
    setAccountErrorKind(null);
    try {
      const next = await api.accountSignIn();
      if (mounted.current) setAccount(next);
    } catch (cause) {
      if (mounted.current) {
        setAccountError(errorMessage(cause));
        setAccountErrorKind('sign-in');
      }
    } finally { if (mounted.current) setAccountBusy(false); }
  };

  const cancelSignIn = async () => {
    if (accountBusy) return;
    setAccountBusy(true);
    setAccountError(null);
    try {
      const next = await api.accountCancelSignIn();
      if (mounted.current) setAccount(next);
    }
    catch (cause) {
      setAccountError(errorMessage(cause));
      setAccountErrorKind('load');
    } finally { if (mounted.current) setAccountBusy(false); }
  };

  const continueWithoutAccount = () => setStage('providers');
  const currentStage = STAGES.findIndex((item) => item.id === stage);
  const signedIn = account?.status === 'signed-in';
  const displayName = account?.user?.name?.trim() || account?.user?.email?.trim() || 'there';
  const displayError = accountError ?? (account?.status === 'signed-out' ? account.error : null);
  const availableCount = providers.filter((provider) => provider.available).length;

  const trapKeys = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      void complete();
      return;
    }
    if (event.key !== 'Tab' || !dialogRef.current) return;
    const items = [...dialogRef.current.querySelectorAll<HTMLElement>(
      'button:not([disabled]), a[href], input:not([disabled]), [tabindex]:not([tabindex="-1"])',
    )].filter((element) => element.offsetParent !== null);
    if (!items.length) { event.preventDefault(); return; }
    const first = items[0]!;
    const last = items[items.length - 1]!;
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  };

  return <div className="onboarding" onKeyDown={trapKeys}>
    <div className="onboarding__veil" aria-hidden="true" />
    <div className="onboarding__dialog" ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="onboarding-title">
      <header className="onboarding__topbar">
        <div className="onboarding__brand"><span className="onboarding__brandmark"><MingleGlyph size={18} /></span><span>Mingle</span><span className="onboarding__eyebrow">LOCAL WORKSPACE</span></div>
        <nav className="onboarding__progress" aria-label="Onboarding progress">
          {STAGES.map((item, index) => <div className={`onboarding__progress-step${index === currentStage ? ' is-current' : ''}${index < currentStage ? ' is-done' : ''}`} key={item.id} aria-current={index === currentStage ? 'step' : undefined}>
            <span>{index < currentStage ? <Check size={11} /> : index + 1}</span><small>{item.label}</small>
          </div>)}
        </nav>
        <button type="button" className="onboarding__close" aria-label="Skip onboarding and open Mingle" title="Skip setup" disabled={completionBusy} onClick={() => void complete()}><X size={17} /></button>
      </header>

      <div className="onboarding__scroll">
        <div className="onboarding__stage" key={stage}>
          {stage === 'welcome' ? <>
            <section className="onboarding__hero onboarding__hero--welcome">
              <div className="onboarding__intro">
                <div className="onboarding__kicker"><Sparkles size={13} /> A more considered workspace</div>
                <h1 id="onboarding-title" data-onboarding-heading tabIndex={-1}>{signedIn ? <>Good to have you here,<br /><em>{displayName}</em></> : <>Make room for<br /><em>good work.</em></>}</h1>
                <p className="onboarding__lead">{isExampleWorkspace ? 'You’re in the Example workspace, with sample files and idle sessions. Open a project of your own whenever you’re ready.' : 'A quiet place for your projects, coding agents, and the work that connects them. Everything starts here on your device.'}</p>
                <div className="onboarding__trust"><LockKeyhole size={13} /><span>Your workspace stays local. Account sign-in is optional.</span></div>
              </div>
              <OrbitIllustration />
            </section>

            <section className="onboarding__account" aria-label="Optional Mingle account">
              <div className="onboarding__account-icon"><CircleHelp size={17} /></div>
              <div className="onboarding__account-copy">
                <h2>{signedIn ? `Signed in as ${displayName}` : 'Use a Mingle account?'}</h2>
                <p>{signedIn ? 'Your Mingle account is connected on this device. Your workspace remains available locally.' : 'Sign in with Google to save preferences across devices and identify yourself in team projects. You can skip this.'}</p>
                {account?.status === 'signing-in' ? <p className="onboarding__account-status" role="status">Waiting for Google sign-in to finish in your browser…</p> : null}
                {account?.browserError ? <p className="onboarding__account-error" role="status">{account.browserError}</p> : null}
                {account?.status === 'restoring' ? <p className="onboarding__account-status" role="status">Restoring your Mingle account…</p> : null}
                {!account && !accountError ? <p className="onboarding__account-status" role="status">Checking account status…</p> : null}
                {displayError ? <div className="onboarding__account-error" role="alert"><span>{displayError}</span><button type="button" onClick={() => accountErrorKind === 'sign-in' ? void startSignIn() : void loadAccount()} disabled={accountBusy}>{accountErrorKind === 'sign-in' ? 'Retry Google sign-in' : 'Retry account check'}</button></div> : null}
              </div>
              <div className="onboarding__account-action">
                {signedIn ? <span className="onboarding__signed-in"><Check size={14} /> Signed in</span>
                  : account?.status === 'signing-in' ? <button type="button" className="onboarding__button onboarding__button--quiet" disabled={accountBusy} onClick={() => void cancelSignIn()}>{accountBusy ? 'Cancelling…' : 'Cancel sign-in'}</button>
                    : <button type="button" className="onboarding__button onboarding__button--account" disabled={accountBusy || !account?.configured || account?.status === 'restoring'} onClick={() => void startSignIn()}>{accountBusy ? 'Opening Google…' : 'Continue with Google'}<ArrowRight size={14} /></button>}
                {!signedIn && account && !account.configured ? <small>Sign-in isn’t configured for this Mingle device.</small> : null}
              </div>
            </section>

            <section className="onboarding__features" aria-label="Workspace highlights">
              <Feature icon={<span className="onboarding__feature-glyph">01</span>} title="Your projects" description="Keep repositories and sessions together in one calm view." />
              <Feature icon={<span className="onboarding__feature-glyph">02</span>} title="Your agents" description="Use the coding tools already installed on this device." />
              <Feature icon={<span className="onboarding__feature-glyph">03</span>} title="Your pace" description="Work locally, and bring teammates in only when you choose." />
            </section>
          </> : null}

          {stage === 'providers' ? <>
            <section className="onboarding__hero onboarding__hero--compact">
              <div className="onboarding__intro">
                <div className="onboarding__kicker"><span className="onboarding__pulse" /> What’s available here</div>
                <h1 id="onboarding-title" data-onboarding-heading tabIndex={-1}>Your tools,<br /><em>your choice.</em></h1>
                <p className="onboarding__lead">Mingle uses provider installations reported by this device. Nothing is installed or signed in automatically.</p>
              </div>
              <OrbitIllustration compact />
            </section>
            <section className="onboarding__providers" aria-label="Provider availability">
              <div className="onboarding__section-heading"><div><h2>Provider availability</h2><p>Local diagnostics from this Mingle runtime</p></div><span>{availableCount} of {providers.length} available</span></div>
              {providers.length ? <div className="onboarding__provider-grid">{providers.map((provider) => <ProviderCard provider={provider} key={provider.id} />)}</div>
                : <div className="onboarding__empty-provider"><CircleHelp size={17} /><p>No provider availability has been reported by the local runtime yet.</p></div>}
              <div className="onboarding__provider-note"><LockKeyhole size={13} /><p>Available means Mingle detected a local provider runtime. Sign-in and model access are checked separately when you choose to run a session.</p></div>
            </section>
          </> : null}

          {stage === 'ready' ? <section className="onboarding__ready">
            <div className="onboarding__ready-mark"><Check size={26} strokeWidth={1.7} /></div>
            <div className="onboarding__kicker">Your next chapter starts here</div>
            <h1 id="onboarding-title" data-onboarding-heading tabIndex={-1}>A little more room<br />to <em>make things.</em></h1>
            <p className="onboarding__lead">Your local workspace is ready. Provider setup is always available in Settings, and agents run only when you ask them to.</p>
            <div className="onboarding__ready-summary"><span><Check size={14} /> Local projects and conversations</span><span><Check size={14} /> Provider status from this device</span><span><Check size={14} /> No session started during setup</span></div>
          </section> : null}
        </div>
      </div>

      <footer className="onboarding__footer">
        <div className="onboarding__footer-note">{completionError ? <span className="onboarding__completion-error" role="alert">Couldn’t save setup progress: {completionError}</span> : <span>Step {currentStage + 1} of {STAGES.length}</span>}</div>
        <div className="onboarding__footer-actions">
          {stage === 'welcome' ? <>
            <button type="button" className="onboarding__button onboarding__button--primary" onClick={continueWithoutAccount}>{signedIn ? 'Continue' : 'Continue without an account'} <ArrowRight size={15} /></button>
          </> : stage === 'providers' ? <>
            <button type="button" className="onboarding__button onboarding__button--quiet" onClick={() => setStage('welcome')}><ArrowLeft size={14} /> Back</button>
            <button type="button" className="onboarding__button onboarding__button--link" onClick={() => void complete(onManageProviders)}>Manage providers in Settings <ChevronRight size={14} /></button>
            <button type="button" className="onboarding__button onboarding__button--primary" onClick={() => setStage('ready')}>Continue <ArrowRight size={15} /></button>
          </> : <>
            <button type="button" className="onboarding__button onboarding__button--quiet" onClick={() => setStage('providers')}><ArrowLeft size={14} /> Back</button>
            <button type="button" className="onboarding__button onboarding__button--primary" disabled={completionBusy} onClick={() => void complete()}>{completionBusy ? 'Saving…' : 'Enter your workspace'}{completionBusy ? null : <ArrowRight size={15} />}</button>
          </>}
        </div>
      </footer>
      <button type="button" className="onboarding__skip" disabled={completionBusy} onClick={() => void complete()}><RotateCcw size={11} /> Skip setup</button>
      {completionBusy ? <span className="sr-only" role="status" aria-live="polite">Saving onboarding completion…</span> : null}
    </div>
  </div>;
}

function Feature({ icon, title, description }: { icon: ReactNode; title: string; description: string }) {
  return <article className="onboarding__feature"><span className="onboarding__feature-icon" aria-hidden="true">{icon}</span><div><h3>{title}</h3><p>{description}</p></div></article>;
}

function ProviderCard({ provider }: { provider: ProviderInfo }) {
  const label = PROVIDER_NAMES[provider.id] ?? provider.name;
  return <article className={`onboarding__provider${provider.available ? ' is-available' : ''}`} data-provider={provider.id}>
    <div className="onboarding__provider-icon"><ProviderMark provider={provider.id} size={20} /></div>
    <div className="onboarding__provider-main"><h3>{label}</h3><p>{provider.available ? (provider.version ? `Available · ${provider.version}` : 'Available on this device') : 'Needs setup'}</p>{!provider.available && provider.reason ? <small>{provider.reason}</small> : null}</div>
    <span className="onboarding__provider-state"><i aria-hidden="true" />{provider.available ? 'Available' : 'Not available'}</span>
  </article>;
}

function OrbitIllustration({ compact = false }: { compact?: boolean }) {
  return <div className={`onboarding__orbit${compact ? ' is-compact' : ''}`} aria-hidden="true">
    <div className="onboarding__orbit-glow" />
    <svg viewBox="0 0 360 320" fill="none">
      <ellipse cx="180" cy="160" rx="146" ry="55" transform="rotate(-28 180 160)" />
      <ellipse cx="180" cy="160" rx="146" ry="55" transform="rotate(35 180 160)" />
      <circle cx="180" cy="160" r="104" />
      <path d="M36 223C94 178 154 132 228 85c33-21 65-32 93-36" />
      <circle className="onboarding__orbit-dot onboarding__orbit-dot--one" cx="75" cy="111" r="5" />
      <circle className="onboarding__orbit-dot onboarding__orbit-dot--two" cx="295" cy="212" r="4" />
      <circle className="onboarding__orbit-dot onboarding__orbit-dot--three" cx="276" cy="62" r="3" />
    </svg>
    <div className="onboarding__orbit-center"><MingleGlyph size={28} /></div>
    <span className="onboarding__orbit-node onboarding__orbit-node--one"><i /></span>
    <span className="onboarding__orbit-node onboarding__orbit-node--two"><i /></span>
    <span className="onboarding__orbit-node onboarding__orbit-node--three"><i /></span>
    <div className="onboarding__orbit-caption"><span>YOUR WORKSPACE</span><i /><span>IN MOTION</span></div>
  </div>;
}
