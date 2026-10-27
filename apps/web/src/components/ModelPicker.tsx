import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type Ref } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown, Search, X } from 'lucide-react';
import type { Provider, ProviderInfo, ProviderModel } from '@mingle/contracts';
import { cx } from '../lib/format';
import { providerModelChoices, PROVIDER_NAMES } from '../lib/providers';
import { usePresence } from '../lib/motion';
import { ProviderMark } from './ui';
import './model-picker.css';

const SEARCH_LIMIT = 8;
const FOCUSABLE = 'button:not([disabled]),input:not([disabled]),[tabindex]:not([tabindex="-1"])';

export interface ModelSelection { provider: Provider; model: string }

type ModelOption = ProviderModel & { isSavedUnknown: boolean };

function providerName(provider: ProviderInfo | undefined, id: Provider): string {
  return provider?.name ?? PROVIDER_NAMES[id];
}

/**
 * Provider-aware model selection for the composer and group configuration.
 * Catalog model names and capabilities come from the live ProviderInfo snapshot;
 * the only non-catalog row is the exact model already saved on the configuration.
 */
export function ModelPicker({
  id,
  label = 'Model',
  value,
  providers,
  onChange,
  disabled = false,
  lockProvider = false,
  className,
  title,
  triggerRef,
  openRequest,
  placement = 'top',
}: {
  id?: string;
  label?: string;
  value: ModelSelection;
  providers: ProviderInfo[];
  onChange: (selection: ModelSelection) => void;
  disabled?: boolean;
  lockProvider?: boolean;
  className?: string;
  title?: string;
  triggerRef?: Ref<HTMLButtonElement>;
  openRequest?: number;
  placement?: 'top' | 'bottom';
}) {
  const popupId = useId();
  const listId = `${popupId}-models`;
  const anchor = useRef<HTMLButtonElement>(null);
  const popup = useRef<HTMLDivElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const typeahead = useRef({ text: '', at: 0 });
  const handledOpenRequest = useRef(0);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<{ left: number; top: number; width: number; maxHeight: number } | null>(null);
  const [layoutRevision, setLayoutRevision] = useState(0);
  const [activeProviderId, setActiveProviderId] = useState<Provider>(value.provider);
  const [activeModelId, setActiveModelId] = useState(value.model);
  const [query, setQuery] = useState('');
  const effectiveOpen = open && !disabled;
  const { present, closing } = usePresence(effectiveOpen);

  const catalogProviders = useMemo(() => {
    if (providers.some((provider) => provider.id === value.provider)) return providers;
    // Keep a saved selection visible if bootstrap has not reported its provider yet.
    return [...providers, {
      id: value.provider,
      name: PROVIDER_NAMES[value.provider],
      available: false,
      version: null,
      executable: null,
      reason: 'Provider metadata is not available in the current catalog.',
      models: [],
      policies: [],
    }];
  }, [providers, value.provider]);

  const currentProvider = catalogProviders.find((provider) => provider.id === value.provider);
  const selectedModel = currentProvider?.models.find((model) => model.id === value.model || model.aliases?.includes(value.model));
  const selectedModelId = selectedModel?.id ?? value.model;
  const selectedModelName = selectedModel?.name ?? value.model;
  const activeProvider = catalogProviders.find((provider) => provider.id === activeProviderId) ?? currentProvider ?? catalogProviders[0];

  const modelOptions = useMemo<ModelOption[]>(() => {
    if (!activeProvider) return [];
    const reportedModels = activeProvider.models;
    return providerModelChoices(activeProvider, activeProvider.id === value.provider ? value.model : undefined).map((model) => {
      const isReported = reportedModels.some((reported) => reported.id === model.id || reported.aliases?.includes(model.id));
      const nativeDefault = (activeProvider.id === 'antigravity' || activeProvider.id === 'opencode')
        && model.id === 'default' && reportedModels.length === 0;
      return { ...model, isSavedUnknown: activeProvider.id === value.provider && model.id === selectedModelId && !isReported && !nativeDefault };
    });
  }, [activeProvider, selectedModelId, value.model, value.provider]);

  const matchingModels = useMemo(() => {
    const text = query.trim().toLocaleLowerCase();
    if (!text) return modelOptions;
    return modelOptions.filter((model) => `${model.name} ${model.id} ${activeProvider?.name ?? ''}`.toLocaleLowerCase().includes(text));
  }, [activeProvider?.name, modelOptions, query]);
  const searchable = modelOptions.length > SEARCH_LIMIT;
  const allowedProviders = catalogProviders.filter((provider) => !lockProvider || provider.id === value.provider);
  const providerIsLocked = lockProvider && activeProviderId !== value.provider;
  const modelSelectionDisabled = (model: ModelOption) => disabled || providerIsLocked
    || (!activeProvider?.available && !(activeProvider?.id === value.provider && model.id === selectedModelId));
  const modelDisabledReason = (model: ModelOption) => {
    if (disabled) return 'Model settings are currently locked.';
    if (providerIsLocked) return 'The provider cannot change for this configuration.';
    if (activeProvider && !activeProvider.available && !(activeProvider.id === value.provider && model.id === selectedModelId)) {
      return activeProvider.reason ?? `${activeProvider.name} is unavailable.`;
    }
    return undefined;
  };

  const show = () => {
    if (disabled || catalogProviders.length === 0) return;
    setActiveProviderId(value.provider);
    setActiveModelId(selectedModelId);
    setQuery('');
    setPosition(null);
    setOpen(true);
  };

  useLayoutEffect(() => {
    if (!effectiveOpen || !anchor.current || !popup.current) return;
    const rect = anchor.current.getBoundingClientRect();
    const width = Math.min(444, window.innerWidth - 20);
    popup.current.style.width = `${width}px`;
    const previousMaxHeight = popup.current.style.maxHeight;
    popup.current.style.maxHeight = 'none';
    const contentHeight = popup.current.scrollHeight;
    popup.current.style.maxHeight = previousMaxHeight;
    const availableAbove = Math.max(0, rect.top - 12);
    const availableBelow = Math.max(0, window.innerHeight - rect.bottom - 12);
    const useTop = placement === 'top'
      ? availableAbove >= Math.min(300, availableBelow) || availableBelow < 280
      : availableBelow < Math.min(300, availableAbove);
    const available = useTop ? availableAbove : availableBelow;
    const maxHeight = Math.max(160, Math.min(440, available));
    const height = Math.min(contentHeight, maxHeight);
    setPosition({
      left: Math.max(10, Math.min(rect.left, window.innerWidth - width - 10)),
      top: useTop ? Math.max(10, rect.top - height - 8) : Math.min(window.innerHeight - height - 10, rect.bottom + 8),
      width,
      maxHeight,
    });
  }, [effectiveOpen, placement, activeProviderId, matchingModels.length, searchable, layoutRevision]);

  useEffect(() => {
    if (!effectiveOpen || !position || popup.current?.contains(document.activeElement)) return;
    const frame = requestAnimationFrame(() => {
      if (!effectiveOpen || popup.current?.contains(document.activeElement)) return;
      if (searchable) {
        searchInput.current?.focus({ preventScroll: true });
        return;
      }
      const preferred = matchingModels.find((model) => model.id === activeModelId && !modelSelectionDisabled(model))
        ?? matchingModels.find((model) => !modelSelectionDisabled(model));
      const item = preferred ? popup.current?.querySelector<HTMLElement>(`[data-model-id="${CSS.escape(preferred.id)}"]`) : null;
      item?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [effectiveOpen, position, searchable, activeProviderId]);

  useEffect(() => {
    if (!effectiveOpen) return;
    const outside = (event: PointerEvent) => {
      if (!anchor.current?.contains(event.target as Node) && !popup.current?.contains(event.target as Node)) setOpen(false);
    };
    const reposition = (event: Event) => {
      if (event.target instanceof Node && popup.current?.contains(event.target)) return;
      setLayoutRevision((revision) => revision + 1);
    };
    document.addEventListener('pointerdown', outside);
    window.addEventListener('resize', reposition);
    window.addEventListener('scroll', reposition, true);
    return () => {
      document.removeEventListener('pointerdown', outside);
      window.removeEventListener('resize', reposition);
      window.removeEventListener('scroll', reposition, true);
    };
  }, [effectiveOpen]);

  useEffect(() => { if (disabled) setOpen(false); }, [disabled]);

  useEffect(() => {
    if (!openRequest || openRequest === handledOpenRequest.current || disabled) return;
    handledOpenRequest.current = openRequest;
    anchor.current?.focus();
    show();
  }, [openRequest, disabled]);

  useEffect(() => {
    if (!effectiveOpen) return;
    const preferred = matchingModels.find((model) => model.id === (activeProviderId === value.provider ? selectedModelId : activeModelId) && !modelSelectionDisabled(model))
      ?? matchingModels.find((model) => !modelSelectionDisabled(model));
    setActiveModelId(preferred?.id ?? matchingModels[0]?.id ?? '');
  }, [activeProviderId, effectiveOpen, matchingModels, selectedModelId, value.provider]);

  const close = (restoreFocus = true) => {
    setOpen(false);
    if (restoreFocus) requestAnimationFrame(() => anchor.current?.focus({ preventScroll: true }));
  };

  const chooseModel = (model: ModelOption) => {
    if (modelSelectionDisabled(model)) return;
    close();
    if (activeProvider && (activeProvider.id !== value.provider || model.id !== selectedModelId)) {
      onChange({ provider: activeProvider.id, model: model.id });
    }
  };

  const focusModel = (id: string) => {
    setActiveModelId(id);
    popup.current?.querySelector<HTMLElement>(`[data-model-id="${CSS.escape(id)}"]`)?.focus({ preventScroll: true });
  };

  const switchProvider = (provider: ProviderInfo) => {
    if (disabled || (lockProvider && provider.id !== value.provider) || (!provider.available && provider.id !== value.provider)) return;
    if (provider.id === activeProviderId) return;
    setActiveProviderId(provider.id);
    setQuery('');
  };

  const keyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close();
      return;
    }
    if (event.key === 'Tab' && popup.current) {
      const focusables = Array.from(popup.current.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((element) =>
        element.tabIndex >= 0 && element.getAttribute('aria-disabled') !== 'true'
        && element.getClientRects().length > 0 && window.getComputedStyle(element).visibility !== 'hidden');
      const first = focusables[0];
      const last = focusables.at(-1);
      if (event.shiftKey && document.activeElement === first && last) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last && first) { event.preventDefault(); first.focus(); }
      return;
    }

    const target = event.target as HTMLElement;
    if (target.matches('[data-provider-id]')) {
      const eligible = allowedProviders.filter((provider) => provider.available || provider.id === value.provider);
      const current = eligible.findIndex((provider) => provider.id === activeProviderId);
      const offset = event.key === 'ArrowDown' ? 1 : event.key === 'ArrowUp' ? -1 : 0;
      if (offset || event.key === 'Home' || event.key === 'End') {
        event.preventDefault();
        const index = event.key === 'Home' ? 0 : event.key === 'End' ? eligible.length - 1 : (current + offset + eligible.length) % eligible.length;
        const provider = eligible[index];
        if (provider) {
          switchProvider(provider);
          requestAnimationFrame(() => popup.current?.querySelector<HTMLElement>(`[data-provider-id="${provider.id}"]`)?.focus());
        }
      }
      return;
    }

    const activeModels = matchingModels.filter((model) => !modelSelectionDisabled(model));
    if (target === searchInput.current) {
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        const first = activeModels[0];
        if (first) focusModel(first.id);
      }
      return;
    }
    const current = activeModels.findIndex((model) => model.id === activeModelId);
    if (target.matches('[data-model-id]')) {
      if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
        const eligible = allowedProviders.filter((provider) => provider.available || provider.id === value.provider);
        const providerIndex = eligible.findIndex((provider) => provider.id === activeProviderId);
        const step = event.key === 'ArrowRight' ? 1 : -1;
        const next = eligible[(providerIndex + step + eligible.length) % eligible.length];
        if (next) {
          event.preventDefault();
          switchProvider(next);
          return;
        }
      }
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'Home' || event.key === 'End') {
        event.preventDefault();
        if (!activeModels.length) return;
        const nextIndex = event.key === 'Home' ? 0 : event.key === 'End' ? activeModels.length - 1
          : (current + (event.key === 'ArrowDown' ? 1 : -1) + activeModels.length) % activeModels.length;
        const next = activeModels[nextIndex];
        if (next) focusModel(next.id);
        return;
      }
      if (event.key === 'Enter' && target.matches('[data-model-id]')) {
        const item = matchingModels.find((model) => model.id === target.dataset.modelId);
        if (item) { event.preventDefault(); chooseModel(item); }
        return;
      }
      if (event.key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey && target !== searchInput.current) {
        const now = Date.now();
        typeahead.current = { text: (now - typeahead.current.at < 700 ? typeahead.current.text : '') + event.key.toLocaleLowerCase(), at: now };
        const found = activeModels.find((model) => model.name.toLocaleLowerCase().startsWith(typeahead.current.text));
        if (found) { event.preventDefault(); focusModel(found.id); }
      }
    }
  };

  const unavailableProviderReason = activeProvider && !activeProvider.available ? activeProvider.reason ?? `${activeProvider.name} is unavailable.` : null;
  const triggerText = selectedModelName || label;
  const triggerTitle = title ?? (lockProvider ? 'Provider changes are locked for this configuration.' : undefined);

  return <>
    <button id={id} ref={(element) => {
      anchor.current = element;
      if (typeof triggerRef === 'function') triggerRef(element);
      else if (triggerRef) triggerRef.current = element;
    }} type="button" role="combobox" aria-label={label} aria-haspopup="listbox" aria-expanded={effectiveOpen}
      aria-controls={effectiveOpen ? listId : undefined} className={cx('model-picker__trigger', className)} disabled={disabled || catalogProviders.length === 0}
      title={triggerTitle} onClick={() => effectiveOpen ? close(false) : show()}
      onKeyDown={(event) => {
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          if (!effectiveOpen) show();
          return;
        }
        if (event.key === 'Escape' && effectiveOpen) { event.preventDefault(); close(); }
      }}>
      <span className="model-picker__trigger-copy"><span>{triggerText}</span><small>{providerName(currentProvider, value.provider)}</small></span>
      <ChevronDown size={13} aria-hidden="true" />
    </button>
    {present ? createPortal(
      <div ref={popup} role="dialog" aria-label="Choose a model" aria-hidden={closing || undefined} inert={closing}
        className={cx('model-picker__popup', closing && 'is-closing')} style={position ?? {}} onKeyDown={keyDown}>
        <div className="model-picker__rail" role="tablist" aria-label="Providers">
          {catalogProviders.map((provider) => {
            const locked = lockProvider && provider.id !== value.provider;
            const unavailable = !provider.available && provider.id !== value.provider;
            const disabledProvider = disabled || locked || unavailable;
            const reason = locked ? 'Provider changes are locked for this configuration.' : unavailable ? provider.reason ?? `${provider.name} is unavailable.` : undefined;
            return <button key={provider.id} type="button" role="tab" data-provider-id={provider.id}
              tabIndex={provider.id === activeProviderId && !disabledProvider ? 0 : -1}
              aria-selected={provider.id === activeProviderId} aria-controls={listId} aria-disabled={disabledProvider || undefined}
              disabled={disabledProvider} title={reason ? `${provider.name} — ${reason}` : provider.name}
              aria-label={`${provider.name}${reason ? ` — unavailable: ${reason}` : ''}`}
              className={cx('model-picker__provider', provider.id === activeProviderId && 'is-active', disabledProvider && 'is-disabled')}
              onClick={() => switchProvider(provider)}>
              <ProviderMark provider={provider.id} size={22} />
            </button>;
          })}
        </div>
        <section className="model-picker__content" aria-label={`${activeProvider?.name ?? 'Provider'} models`}>
          <div className="model-picker__head">
            <div className="model-picker__heading"><strong>{activeProvider?.name ?? 'Models'}</strong><span>{modelOptions.length ? `${modelOptions.length} model${modelOptions.length === 1 ? '' : 's'}` : 'No reported models'}</span></div>
            {searchable ? <label className="model-picker__search">
              <Search size={14} aria-hidden="true" />
              <input ref={searchInput} type="search" aria-label="Search models" placeholder="Search models" value={query}
                onChange={(event) => setQuery(event.target.value)} />
              {query ? <button type="button" aria-label="Clear model search" title="Clear search" onClick={() => { setQuery(''); searchInput.current?.focus(); }}><X size={13} aria-hidden="true" /></button> : null}
            </label> : null}
          </div>
          {lockProvider && catalogProviders.length > 1 ? <p className="model-picker__notice">Provider changes are locked for this conversation.</p> : null}
          {unavailableProviderReason ? <p className="model-picker__notice model-picker__notice--warn" role="status">Unavailable: {unavailableProviderReason}</p> : null}
          {modelOptions.length ? <div id={listId} className="model-picker__models" role="listbox" aria-label="Models" aria-busy={false} key={activeProvider?.id}>
            {matchingModels.length ? matchingModels.map((model) => {
              const isSelected = activeProvider?.id === value.provider && model.id === selectedModelId;
              const disabledReason = modelDisabledReason(model);
              return <button key={model.id} type="button" role="option" data-model-id={model.id} tabIndex={model.id === activeModelId && !disabledReason ? 0 : -1}
                aria-selected={isSelected} aria-disabled={Boolean(disabledReason) || undefined}
                title={disabledReason ?? (model.isSavedUnknown ? 'Saved selection; this model is not in the current provider catalog.' : undefined)}
                className={cx('model-picker__model', isSelected && 'is-selected', model.id === activeModelId && 'is-active', disabledReason && 'is-disabled')}
                onMouseMove={() => { if (!disabledReason) setActiveModelId(model.id); }} onClick={() => chooseModel(model)}>
                <span className="model-picker__model-copy"><strong>{model.name}</strong><small>{activeProvider?.name ?? providerName(undefined, value.provider)}</small>
                  {model.isSavedUnknown ? <small className="model-picker__model-note">Saved selection · not in current catalog</small> : null}
                  {disabledReason ? <small className="model-picker__model-note">Unavailable · {disabledReason}</small> : null}
                </span>
                {isSelected ? <Check size={16} aria-hidden="true" /> : null}
              </button>;
            }) : <p className="model-picker__empty" role="status">No models match “{query}”.</p>}
          </div> : <p className="model-picker__empty" role="status">No model options are reported for this provider.</p>}
          <div className="model-picker__foot"><span>Models reported by the provider</span>{query ? <button type="button" onClick={() => { setQuery(''); searchInput.current?.focus(); }}>Clear search</button> : null}</div>
        </section>
      </div>, document.body,
    ) : null}
  </>;
}
