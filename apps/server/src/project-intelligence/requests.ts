import { cleanInline, textKey } from './extract.ts';

export type PromptClass =
  | { kind: 'ignore'; reason: string }
  | { kind: 'continue' }
  | { kind: 'request'; title: string; fingerprint: string };

const ACKNOWLEDGEMENT = /^(?:thanks?(?: you)?(?: so much| a lot)?|thx|ty|ok(?:ay)?|great|nice|cool|perfect|awesome|got it|sounds good|lgtm|looks good|good job|well done|nevermind|never mind|no|nope|stop|cancel)\W*$/i;
const CONTINUE = /^(?:(?:ok(?:ay)?|yes|yep|yeah|sure|please)[\s,.!]*)?(?:continue|go on|keep going|proceed|carry on|resume|go ahead|do it|try again|retry|finish(?: it| this| up)?|next(?: step)?|keep at it)(?:\s+(?:please|now|then))?\W*$/i;
const POLITE = /^(?:(?:ok(?:ay)?|so|now|then|next|also|and|alright|great|thanks?)[\s,.!:-]+)*(?:(?:please|pls)[\s,]+)?(?:(?:can|could|would|will) you(?: please)?[\s,]+|i(?:'d| would) like you to[\s,]+|i want you to[\s,]+|i need you to[\s,]+|i need[\s,]+|let'?s[\s,]+|you should[\s,]+|go ahead and[\s,]+)?(?:(?:please|pls)[\s,]+)?/i;
const ACTION = /^(?:add|implement|fix|create|build|refactor|update|write|remove|delete|change|make|migrate|rename|move|improve|optimi[sz]e|configure|set up|setup|support|enable|disable|integrate|port|extract|split|merge|replace|rewrite|convert|upgrade|downgrade|install|wire|hook up|connect|handle|introduce|clean up|cleanup|simplify|document|test|debug|resolve|investigate|patch|ensure|allow|prevent|reduce|increase|use|run|generate|scaffold|deploy|bump|revert|restore|expose|hide|surface|persist|validate|sanitize|log|track|stream|cache|parse|format|lint|review|audit|finish|complete|continue|polish|adjust|tweak|style|redesign|design|draft|plan|apply|commit|push|reorder|sort|filter|support)\b/i;
const INQUIRY = /^(?:what|why|how|where|when|who|which|is|are|was|were|does|do|did|can|could|should|would|will|explain|describe|tell me|show me|list|summari[sz]e|status|progress|any (?:update|progress)|are we|is it|have you|did you)\b/i;
const STATUS = /^(?:status|progress|any (?:updates?|progress)|how(?:'s| is) (?:it|that|this) going|are you (?:done|finished)|is (?:it|that|this) (?:done|finished|working)|where are we|what(?:'s| is| did you)(?: the)? (?:status|progress|done|change[sd]?))\b/i;

/**
 * Decides whether a user message is a unit of work worth tracking. Conservative on purpose: acknowledgements, slash
 * commands and questions about state never create tasks, and a bare "continue" resumes the previous request.
 */
export function classifyPrompt(prompt: string): PromptClass {
  const text = prompt.trim();
  if (!text) return { kind: 'ignore', reason: 'empty' };
  const coordinatorText = text.toLowerCase();
  if (coordinatorText.includes('request from the human in the group conversation:')
    || coordinatorText.includes('your latest delegation batch has returned.')
    || coordinatorText.includes('the statuses below describe native turns;')) {
    return { kind: 'ignore', reason: 'coordinator-delivery' };
  }
  const firstLine = text.split(/\r?\n/).find((line) => line.trim() && !/^```/.test(line.trim()))?.trim() ?? text;
  if (/^\/[\w:-]+(?:\s|$)/.test(firstLine) && !text.includes('\n')) return { kind: 'ignore', reason: 'command' };
  if (ACKNOWLEDGEMENT.test(text) || STATUS.test(text) && text.length < 120) return { kind: 'ignore', reason: 'conversational' };
  if (CONTINUE.test(text)) return { kind: 'continue' };

  const stripped = firstLine.replace(POLITE, '').trim();
  const fullBody = text.replace(POLITE, '').trim();
  const actionable = ACTION.test(stripped);
  const question = INQUIRY.test(stripped) || (/\?\s*$/.test(firstLine) && !actionable);
  if (!actionable && question) return { kind: 'ignore', reason: 'question' };
  // Without an action verb, only substantial statements (a described problem or goal) count as work.
  if (!actionable && text.length < 40) return { kind: 'ignore', reason: 'too-short' };

  const sentence = stripped.split(/(?<=[.!?])\s/)[0] ?? stripped;
  const capitalised = sentence ? sentence[0]!.toUpperCase() + sentence.slice(1) : sentence;
  const title = cleanInline(capitalised.replace(/[.:]\s*$/, ''), 120);
  if (title.length < 3) return { kind: 'ignore', reason: 'too-short' };
  return { kind: 'request', title, fingerprint: textKey(fullBody, Infinity) };
}
