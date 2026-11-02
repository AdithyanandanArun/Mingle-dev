import type { AppSettings, Provider, ProviderInfo, ProviderModel } from '@mingle/contracts';

export const PROVIDER_NAMES: Record<Provider, string> = {
  codex: 'Codex',
  claude: 'Claude',
  antigravity: 'Antigravity',
  opencode: 'OpenCode',
};

export type ProviderModelSetting = 'defaultCodexModel' | 'defaultClaudeModel' | 'defaultAntigravityModel' | 'defaultOpencodeModel';

/** `none` omits an effort override; it does not claim an unreported reasoning capability. */
export function reasoningEffortChoices(model: ProviderModel | undefined): NonNullable<ProviderModel['reasoningEfforts']> {
  return model?.reasoningEfforts?.length ? model.reasoningEfforts : [{
    id: 'none', label: 'Native/default',
    description: model?.reasoningEfforts ? 'This model reports no effort control.' : 'Effort capabilities are unreported. Let the provider choose its default.',
  }];
}

export const providerModelSetting = (provider: Provider): ProviderModelSetting => ({
  codex: 'defaultCodexModel',
  claude: 'defaultClaudeModel',
  antigravity: 'defaultAntigravityModel',
  opencode: 'defaultOpencodeModel',
} satisfies Record<Provider, ProviderModelSetting>)[provider];

/** These runtimes accept the `default` model id to keep their own native model selection. */
export const usesNativeModelDefault = (provider: Provider): boolean => provider === 'antigravity' || provider === 'opencode';
const NATIVE_DEFAULT_NAME: Partial<Record<Provider, string>> = { antigravity: 'Antigravity default', opencode: 'OpenCode default' };

export function defaultProviderModel(provider: Provider, settings: AppSettings): string {
  const value = settings[providerModelSetting(provider)];
  return value ?? (usesNativeModelDefault(provider) ? 'default' : '');
}

/** Uses only discovered native models; the `default` sentinel keeps the runtime's own selection and its reported name. */
export function providerModelChoices(info: ProviderInfo | undefined, current?: string): ProviderModel[] {
  const nativeName = info ? NATIVE_DEFAULT_NAME[info.id] : undefined;
  const choices = [...(info?.models ?? [])];
  // Fallback names apply only when the runtime has not reported metadata for its default model.
  if (nativeName && choices.length === 0) choices.push({ id: 'default', name: nativeName });
  if (current && !choices.some((model) => model.id === current || model.aliases?.includes(current))) {
    choices.unshift({ id: current, name: nativeName && current === 'default' ? nativeName : current });
  }
  return choices;
}
