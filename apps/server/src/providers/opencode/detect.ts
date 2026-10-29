import type { AppSettings, ProviderInfo } from '@mingle/contracts';
import { ProviderError, errorMessage } from '../common.js';
import type { ProbeFn } from '../process.js';
import { OPENCODE_DEFAULT_MODEL, OPENCODE_POLICIES, defaultModelEntry, parseNativeCommands, providerIds, readModels, object, type OpencodeMetadata } from './metadata.js';
import { resolveOpencode, safeOpencodeError, withProbeSession, type OpencodeSpawn } from './runtime.js';
import { acpPromptCapabilities } from '../attachments.js';

export interface OpencodeDetectDeps { env?: NodeJS.ProcessEnv; home?: string; probe?: ProbeFn; spawn?: OpencodeSpawn }

function info(partial: Partial<ProviderInfo>): ProviderInfo {
  return { id: 'opencode', name: 'OpenCode', available: false, version: null, executable: null, reason: null, models: [defaultModelEntry()], policies: OPENCODE_POLICIES, ...partial };
}

/**
 * Reads real OpenCode metadata through `opencode acp`: one throwaway native session in a private empty directory, with no prompt.
 * Installed does not mean signed in: the model list is whatever OpenCode itself exposes (including its own hosted free models);
 * provider credentials, quota and network access are validated by OpenCode when a run starts.
 */
export async function detectOpencode(settings: AppSettings, deps: OpencodeDetectDeps = {}): Promise<ProviderInfo> {
  const env = deps.env ?? process.env;
  const found = await resolveOpencode(settings, env, deps.home);
  if (!found.ok) return info({ reason: found.reason });
  const { path, version } = found.executable;
  const base = { executable: path, version };
  // Embedded and test callers that inject only discovery dependencies never launch a real provider.
  if (!deps.spawn && (deps.probe || deps.env || deps.home)) return info({ ...base, reason: 'OpenCode ACP was not probed because provider dependencies were injected.' });
  try {
    const metadata = await withProbeSession(path, { env, ...(deps.spawn ? { spawn: deps.spawn } : {}), timeoutMs: 40_000 }, async (session) => {
      const models = await readModels(session.runtime.conn, session.sessionId, session.selected);
      const commands = parseNativeCommands(await session.commands());
      const mcp = object(session.runtime.capabilities.mcpCapabilities);
      const result: OpencodeMetadata = {
        version: session.runtime.version || version, ...models, commands, providers: providerIds(models.models),
        http: mcp.http === true,
      };
      return { ...result, promptCapabilities: acpPromptCapabilities(session.runtime.capabilities) };
    });
    const count = metadata.models.filter((model) => model.id !== OPENCODE_DEFAULT_MODEL).length;
    if (count === 0) {
      return info({ ...base, version: metadata.version || version, promptCapabilities: metadata.promptCapabilities, reason: `OpenCode ${metadata.version || version} started but reported no models. Run \`"${path}" providers login\` in a terminal, or configure a provider in OpenCode, then Re-check.` });
    }
    const notes = [
      `OpenCode ${metadata.version || version} reported ${count} model${count === 1 ? '' : 's'} from ${metadata.providers.join(', ') || 'its configured providers'}.`,
      'Provider sign-in, quota and network access are checked by OpenCode when a run starts; Mingle never reads OpenCode credential files.',
      metadata.http ? null : 'ACP did not advertise HTTP MCP; Mingle browser, team and progress tools use stdio instead.',
      metadata.unmeasured ? `${metadata.unmeasured} model${metadata.unmeasured === 1 ? '' : 's'} could not be inspected for reasoning variants within the probe budget; those show Native default only.` : null,
      metadata.failures ? `${metadata.failures} model${metadata.failures === 1 ? '' : 's'} did not confirm selection during inspection and show Native default only.` : null,
    ].filter(Boolean).join(' ');
    return info({ ...base, version: metadata.version || version, available: true, models: metadata.models, promptCapabilities: metadata.promptCapabilities, reason: notes });
  } catch (error) {
    const detail = error instanceof ProviderError ? error.message : errorMessage(error);
    return info({ ...base, reason: `OpenCode ${version} is installed at ${path}, but \`opencode acp\` could not report metadata: ${safeOpencodeError(detail, [], 450)}` });
  }
}
