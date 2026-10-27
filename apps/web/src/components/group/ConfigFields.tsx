import type { AgentConfiguration, Provider } from '@mingle/contracts';
import { useMingle } from '../../store/store';
import {
  POLICY_DESCRIPTION, effortChoices, modelOf, normalizeConfig, policyChoices, policyLabel, providerAvailability, providerName, tierChoices,
} from '../../lib/groups';
import { Field } from '../ui';
import { SelectMenu } from '../SelectMenu';
import { ModelPicker } from '../ModelPicker';

/** One agent's provider, model, effort, permissions and service tier, offering only what each provider currently advertises. */
export function ConfigFields({ value, onChange, idPrefix, lockProvider = false, disabled = false, legend }: {
  value: AgentConfiguration; onChange: (next: AgentConfiguration) => void; idPrefix: string; lockProvider?: boolean; disabled?: boolean; legend?: string;
}) {
  const providers = useMingle((s) => s.boot?.providers);
  const settings = useMingle((s) => s.boot?.settings);
  const info = providers?.find((provider) => provider.id === value.provider);
  const model = modelOf(info, value.model);
  const efforts = effortChoices(model);
  const tiers = tierChoices(model);
  const policies = policyChoices(info, model);
  const availability = providers ? providerAvailability(providers, value.provider) : { available: false, reason: 'Provider status is loading.' };

  if (!providers || !settings) return null;
  const patch = (change: Partial<AgentConfiguration>) => onChange(normalizeConfig({ ...value, ...change }, providers, settings));
  const policyOptions = policies;

  return (
    <fieldset className="cfg" disabled={disabled}>
      {legend ? <legend className="sr-only">{legend}</legend> : null}
      <div className="cfg__grid">
        <Field label="Model" htmlFor={`${idPrefix}-model`}>
          <ModelPicker id={`${idPrefix}-model`} label="Model" value={{ provider: value.provider, model: model?.id ?? value.model }} providers={providers}
            disabled={disabled} lockProvider={lockProvider} className="cfg__model-picker"
            onChange={({ provider, model: modelId }) => patch({ provider: provider as Provider, model: modelId })} />
        </Field>
        <Field label="Reasoning effort" htmlFor={`${idPrefix}-effort`}>
          <SelectMenu id={`${idPrefix}-effort`} label="Reasoning effort" value={value.effort} disabled={disabled || efforts.length === 0}
            displayValue={efforts.length ? efforts.some((item) => item.id === value.effort) ? undefined : 'Not available' : 'Native/default'}
            options={efforts.map((item) => ({ value: item.id, label: item.label, badge: item.id === model?.defaultReasoningEffort ? 'Default' : undefined, description: item.description }))}
            onChange={(next) => patch({ effort: next })} />
        </Field>
        <Field label="Permissions" htmlFor={`${idPrefix}-policy`}>
          <SelectMenu id={`${idPrefix}-policy`} label="Permissions" value={value.policy} disabled={disabled || policies.length === 0}
            displayValue={policies.length ? policies.includes(value.policy) ? undefined : 'Not available' : 'Native/default'}
            options={policyOptions.map((item) => ({ value: item, label: policyLabel(item), description: POLICY_DESCRIPTION[item] }))}
            onChange={(next) => patch({ policy: next as AgentConfiguration['policy'] })} />
        </Field>
        <Field label="Service tier" htmlFor={`${idPrefix}-tier`}>
          <SelectMenu id={`${idPrefix}-tier`} label="Service tier" value={value.serviceTier} disabled={disabled || tiers.length === 0}
            displayValue={tiers.length ? tiers.some((item) => item.id === value.serviceTier) ? undefined : 'Not available' : 'Native/default'}
            options={tiers.map((item) => ({ value: item.id, label: item.label, badge: item.id === (model?.defaultServiceTier ?? 'standard') ? 'Default' : undefined, description: item.id === 'standard' ? undefined : item.description }))}
            onChange={(next) => patch({ serviceTier: next })} />
        </Field>
      </div>
      <p className={availability.available ? 'cfg__status' : 'cfg__status is-warn'} role="status">
        <i aria-hidden="true" />{availability.available ? `${providerName(value.provider)} is available${info?.version ? ` · ${info.version}` : ''}.` : `${providerName(value.provider)} is unavailable: ${availability.reason}`}
      </p>
    </fieldset>
  );
}
