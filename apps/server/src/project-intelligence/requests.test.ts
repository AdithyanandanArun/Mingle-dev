import { expect, it } from 'vitest';
import { classifyPrompt } from './requests.ts';

it('does not create request tasks from coordinator prompt boilerplate or returned status deliveries', () => {
  expect(classifyPrompt('Request from the human in the group conversation:\nFix the login bug.'))
    .toEqual({ kind: 'ignore', reason: 'coordinator-delivery' });
  expect(classifyPrompt('Your latest delegation batch has returned. Check team_members and team_inbox.'))
    .toEqual({ kind: 'ignore', reason: 'coordinator-delivery' });
});

it('continues tracking ordinary user requests', () => {
  expect(classifyPrompt('Fix the login bug.').kind).toBe('request');
});
