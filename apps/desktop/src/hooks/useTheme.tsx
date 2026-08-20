import {
  resolveTheme,
  themeCssVariables,
  THEMES,
  type PublicServerInfo,
  type ThemePreset,
  type ThemeTokens,
} from '@gameblade/shared';
import { useQuery } from '@tanstack/react-query';
import { useEffect } from 'react';
import { ipc, type ClientSettings } from '../lib/ipc.js';

/**
 * Writes a theme's tokens onto the document.
 *
 * The whole stylesheet is written against `--ink-*` and `--blade-*`, so setting
 * those on the root restyles everything already on screen — no re-render, no
 * class swapping, and a settings preview can drive it live.
 */
export function applyTheme(tokens: ThemeTokens): void {
  const root = document.documentElement;
  for (const [name, value] of Object.entries(themeCssVariables(tokens))) {
    root.style.setProperty(name, value);
  }

  // Native scrollbars and form controls follow the scheme rather than the
  // palette; without this a light theme keeps dark widgets inside it.
  root.style.setProperty('color-scheme', tokens.scheme);
  // Status surfaces key off this: danger and success cannot be derived from
  // the surface ramp, and the dark ones are illegible on a light theme.
  root.setAttribute('data-scheme', tokens.scheme);
}

/** A theme's variables scoped to one element, for a preview swatch. */
export function themeStyle(tokens: ThemeTokens): Record<string, string> {
  return { ...themeCssVariables(tokens), colorScheme: tokens.scheme };
}

/**
 * Resolves which theme actually applies.
 *
 * A local choice wins over the server's. The operator sets the look of their
 * archive and most players never touch it, but a player who does should not
 * have their machine restyled the next time the operator changes their mind.
 */
export function effectiveTheme(
  settings: Pick<ClientSettings, 'themePreset' | 'themeAccent'> | undefined,
  serverTokens: ThemeTokens | undefined,
): ThemeTokens {
  const preset = settings?.themePreset;
  if (preset && preset in THEMES) {
    return resolveTheme(preset as ThemePreset, settings?.themeAccent ?? null);
  }
  return serverTokens ?? THEMES.midnight.tokens;
}

/**
 * Keeps the window in step with whichever theme wins.
 *
 * Both inputs are query-backed, so changing either — the operator saving a new
 * server theme, or the user picking one in Settings — repaints without a
 * reload.
 */
export function useTheme(enabled: boolean): void {
  const infoQuery = useQuery({
    queryKey: ['public', 'info'],
    queryFn: () => ipc.get<PublicServerInfo>('/public/info'),
    enabled,
    staleTime: 5 * 60_000,
  });

  const settingsQuery = useQuery({
    queryKey: ['settings'],
    queryFn: () => ipc.getSettings(),
    enabled,
  });

  // Serialised rather than compared by identity: `resolveTheme` builds a fresh
  // object on every render, so an identity check would reapply on every pass.
  const serialized = JSON.stringify(
    effectiveTheme(settingsQuery.data, infoQuery.data?.theme?.tokens),
  );

  useEffect(() => {
    applyTheme(JSON.parse(serialized) as ThemeTokens);
  }, [serialized]);
}
