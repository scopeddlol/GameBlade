import { THEMES, THEME_PRESETS, resolveTheme, type ThemePreset } from '@gameblade/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Field, FormError, Notice, SectionSkeleton, Spinner } from '../../components/ui.js';
import { applyTheme } from '../../hooks/useTheme.js';
import { api, ApiRequestError } from '../../lib/api.js';

interface ThemeResponse {
  preset: ThemePreset;
  accent: string | null;
}

/**
 * Picking the colours the whole install wears.
 *
 * The panel around the form follows the choice live, so it is judged in situ
 * rather than through a small window of it — and reverts the moment you leave
 * without saving, so an experiment cannot follow you around the admin panel
 * for the rest of the session.
 */
export function AdminThemePage() {
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [preset, setPreset] = useState<ThemePreset | null>(null);
  const [accent, setAccent] = useState<string>('');

  const themeQuery = useQuery({
    queryKey: ['admin', 'theme'],
    queryFn: () => api.get<ThemeResponse>('/admin/theme'),
  });

  // Seeded from the query in an effect rather than inside `queryFn`. Doing it
  // in the fetcher looks equivalent and is not: react-query only calls the
  // fetcher on a cache miss, so coming back to this page within the stale
  // window left the form seeded with nothing and the page stuck.
  const saved = themeQuery.data;
  useEffect(() => {
    if (!saved) return;
    setPreset(saved.preset);
    setAccent(saved.accent ?? '');
  }, [saved]);

  const tokens = resolveTheme(preset ?? 'midnight', accent || null);
  const themeKey = JSON.stringify(tokens);

  // Keyed on the serialised tokens rather than the object: `resolveTheme`
  // returns a fresh one every render, which would re-run this on every
  // keystroke anywhere on the page.
  useEffect(() => {
    if (preset === null) return;
    applyTheme(JSON.parse(themeKey) as typeof tokens);
  }, [themeKey, preset]);

  // Leaving without saving puts back whatever the server actually has. Without
  // this, trying three themes and navigating away left the panel wearing the
  // last one tried until the next full page load.
  useEffect(
    () => () => {
      const stored = queryClient.getQueryData<ThemeResponse>(['admin', 'theme']);
      if (stored) applyTheme(resolveTheme(stored.preset, stored.accent));
    },
    [queryClient],
  );

  const save = useMutation({
    mutationFn: () => api.put('/admin/theme', { preset, accent: accent || null }),
    onSuccess: async () => {
      setError(null);
      setNotice('Theme saved.');
      await queryClient.invalidateQueries({ queryKey: ['admin', 'theme'] });
      await queryClient.invalidateQueries({ queryKey: ['public', 'info'] });
    },
    onError: (caught) =>
      setError(caught instanceof ApiRequestError ? caught.message : 'Could not save the theme.'),
  });

  if (preset === null) return <SectionSkeleton rows={3} />;

  return (
    <div className="gb-page">
      <FormError message={error} />
      <Notice message={notice} />

      <section className="gb-card space-y-4 p-5">
        <h2 className="text-sm font-semibold tracking-wide uppercase">Preset</h2>

        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {THEME_PRESETS.map((id) => {
            const definition = THEMES[id];
            const isActive = preset === id;
            return (
              <button
                key={id}
                type="button"
                onClick={() => setPreset(id)}
                aria-pressed={isActive}
                className={`rounded-xl border p-3 text-left transition-colors ${
                  isActive ? 'border-blade-500' : 'border-ink-700 hover:border-ink-600'
                }`}
              >
                <span className="flex items-center gap-2">
                  {/* Swatches drawn from the preset itself, so what is shown is
                      what will be applied. */}
                  {[
                    definition.tokens.ink900,
                    definition.tokens.ink800,
                    definition.tokens.ink700,
                    definition.tokens.accent500,
                    definition.tokens.highlight,
                  ].map((colour) => (
                    <span
                      key={colour}
                      className="border-ink-700 h-5 w-5 rounded-full border"
                      style={{ background: colour }}
                    />
                  ))}
                </span>
                <span className="mt-2 block text-sm font-medium">{definition.label}</span>
                <span className="text-ink-400 block text-xs">{definition.description}</span>
              </button>
            );
          })}
        </div>

        <Field
          label="Accent colour"
          htmlFor="accent"
          hint="Optional. Replaces the preset's accent; the lighter and darker steps are derived from it."
        >
          <div className="flex flex-wrap items-center gap-2">
            <input
              id="accent"
              type="color"
              className="border-ink-700 bg-ink-850 h-10 w-14 shrink-0 rounded-lg border"
              value={accent || tokens.accent500}
              onChange={(event) => setAccent(event.target.value)}
              aria-label="Pick an accent colour"
            />
            <input
              className="gb-input font-mono"
              value={accent}
              placeholder={THEMES[preset].tokens.accent500}
              onChange={(event) => setAccent(event.target.value)}
            />
            {accent ? (
              <button type="button" className="gb-btn-ghost shrink-0" onClick={() => setAccent('')}>
                Use the preset&rsquo;s
              </button>
            ) : null}
          </div>
        </Field>

        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            className="gb-btn-primary"
            onClick={() => save.mutate()}
            disabled={save.isPending}
          >
            {save.isPending ? <Spinner className="h-4 w-4" /> : null}
            Save theme
          </button>
          <p className="text-ink-500 text-xs">
            The panel is already wearing it. Leaving without saving puts it back.
          </p>
        </div>
      </section>
    </div>
  );
}
