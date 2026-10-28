import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { TEAM_RECONSENT_EXPLANATION } from '../../../lib/team-consent';
import { TeamReconsentPrompt } from './TeamReconsentPrompt';

it('renders the branch-push explanation and one-click Re-share action', () => {
  const html = renderToStaticMarkup(createElement(TeamReconsentPrompt, { busy: false, onReshare: () => undefined }));

  expect(html.replace(/&#x27;/g, "'")).toContain(TEAM_RECONSENT_EXPLANATION);
  expect(html).toContain('Re-share');
});
