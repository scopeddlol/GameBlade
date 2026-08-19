import { resolveTheme, themeCssVariables, type ThemeTokens } from '@gameblade/shared';
import { useEffect } from 'react';

/**
 * Applies a theme's tokens to the document.
 *
 * The app's utilities compile to `var(--color-ink-900)` and friends, so
 * overriding those variables on the root restyles everything already on screen
 * — no re-render, no class swapping, and a preview can drive it live.
 */
export function applyTheme(tokens: ThemeTokens): void {
  const root = document.documentElement;
  for (const [name, value] of Object.entries(themeCssVariables(tokens))) {
    root.style.setProperty(name, value);
  }

  // Form controls and scrollbars follow the scheme, not the palette; without
  // this a light theme keeps dark native widgets.
  root.style.setProperty('color-scheme', tokens.scheme);
  // Status surfaces key off this; they cannot be derived from the ramp.
  root.setAttribute('data-scheme', tokens.scheme);
  document.querySelector('meta[name="color-scheme"]')?.setAttribute('content', tokens.scheme);
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', tokens.ink900);
}

/**
 * Applies a theme to a single element rather than the document.
 *
 * The landing-page editor previews a theme inside a panel while the admin
 * chrome around it stays as it was, which the root-level version cannot do.
 */
export function themeStyle(tokens: ThemeTokens): Record<string, string> {
  return { ...themeCssVariables(tokens), colorScheme: tokens.scheme };
}

/**
 * Keeps the document in step with the server's configured theme.
 *
 * Applied from whatever the public info endpoint reported. Until that arrives
 * the compiled-in defaults are already correct, so there is no flash of
 * unstyled content to guard against.
 */
export function useApplyTheme(tokens: ThemeTokens | undefined): void {
  useEffect(() => {
    if (tokens) applyTheme(tokens);
  }, [tokens]);
}

export { resolveTheme };
