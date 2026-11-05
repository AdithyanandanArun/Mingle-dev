import type { AppSettings } from '@mingle/contracts';

/** Missing preferences use subtle color; monochrome is an exact opt-out of the scoped palette. */
export function applyAppearance(root: HTMLElement, theme: AppSettings['theme'], colorStyle: AppSettings['colorStyle'] = 'subtle'): void {
  root.dataset.theme = theme;
  root.dataset.colorStyle = colorStyle;
}
