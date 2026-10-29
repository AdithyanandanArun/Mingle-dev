import { cleanEnv } from '../common.js';

/** Leave credential lookup to Claude Code; an explicit API key takes precedence over OAuth. */
export function claudeEnvironment(base: NodeJS.ProcessEnv): Record<string, string> {
  const apiKey = base.ANTHROPIC_API_KEY?.trim();
  // Capabilities belong to one Mingle run; Claude receives current MCP authorization through explicit HTTP headers.
  const remove = ['OPENAI_API_KEY', 'CODEX_API_KEY', 'MINGLE_TEAM_MCP_TOKEN', 'MINGLE_BROWSER_MCP_TOKEN', 'MINGLE_PROGRESS_MCP_TOKEN', 'RELAY_TEAM_MCP_TOKEN', 'RELAY_BROWSER_MCP_TOKEN', 'RELAY_PROGRESS_MCP_TOKEN'];
  if (apiKey) remove.push('CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_AUTH_TOKEN');
  else remove.push('ANTHROPIC_API_KEY');
  return cleanEnv(base, remove, apiKey ? { ANTHROPIC_API_KEY: apiKey } : {});
}
