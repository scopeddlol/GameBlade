import {
  CLIENT_BUTTON_ICONS,
  CLIENT_BUTTON_PLACEMENT,
  type ClientButton,
  type ClientButtonPlacement,
} from '@gameblade/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowDown, ArrowUp, ExternalLink, Plus, Trash2 } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { Icon, IconPicker } from '../../components/icons.js';
import { Badge, EmptyState, Field, FormError, Spinner, RowSkeleton } from '../../components/ui.js';
import { api, ApiRequestError } from '../../lib/api.js';

const PLACEMENT_LABELS: Record<ClientButtonPlacement, string> = {
  sidebar: 'Sidebar',
  home: 'Home tab',
  'game-menu': 'Right-click a game',
};

const PLACEMENT_HINTS: Record<ClientButtonPlacement, string> = {
  sidebar: 'Under the main navigation, always visible.',
  home: 'A row of links on the Home tab.',
  'game-menu': 'In the menu that opens when a player right-clicks any game.',
};

const BLANK = {
  label: '',
  url: '',
  icon: 'link' as (typeof CLIENT_BUTTON_ICONS)[number],
  placement: 'sidebar' as ClientButtonPlacement,
  description: '',
  active: true,
};

/**
 * Operator-defined links the desktop client renders.
 *
 * Links, not actions: the client opens the URL in the player's browser. That
 * boundary is deliberate and worth keeping — anything richer would mean
 * shipping operator-authored behaviour to every player's machine.
 */
export function AdminClientPage() {
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState(BLANK);
  const [editingId, setEditingId] = useState<string | null>(null);

  const buttonsQuery = useQuery({
    queryKey: ['admin', 'client-buttons'],
    queryFn: () => api.get<ClientButton[]>('/admin/client-buttons'),
  });

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['admin', 'client-buttons'] });

  const fail = (caught: unknown) =>
    setError(caught instanceof ApiRequestError ? caught.message : 'Could not save that button.');

  const saveMutation = useMutation({
    mutationFn: () => {
      const body = {
        label: form.label,
        url: form.url,
        icon: form.icon,
        placement: form.placement,
        description: form.description || null,
        active: form.active,
        sortOrder: editingId
          ? (buttons.find((button) => button.id === editingId)?.sortOrder ?? 0)
          : buttons.length,
      };
      return editingId
        ? api.put<ClientButton>(`/admin/client-buttons/${editingId}`, body)
        : api.post<ClientButton>('/admin/client-buttons', body);
    },
    onSuccess: () => {
      setError(null);
      setForm(BLANK);
      setEditingId(null);
      void invalidate();
    },
    onError: fail,
  });

  const removeMutation = useMutation({
    mutationFn: (id: string) => api.delete(`/admin/client-buttons/${id}`),
    onSuccess: invalidate,
    onError: fail,
  });

  const reorderMutation = useMutation({
    mutationFn: (ids: string[]) => api.post('/admin/client-buttons/reorder', { ids }),
    onSuccess: invalidate,
    onError: fail,
  });

  const buttons = buttonsQuery.data ?? [];

  /** Reorders within a placement — order only means anything inside one group. */
  const move = (button: ClientButton, delta: number) => {
    const group = buttons.filter((entry) => entry.placement === button.placement);
    const index = group.findIndex((entry) => entry.id === button.id);
    const target = index + delta;
    if (target < 0 || target >= group.length) return;

    const next = [...group];
    const [moved] = next.splice(index, 1);
    if (moved) next.splice(target, 0, moved);
    reorderMutation.mutate(next.map((entry) => entry.id));
  };

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <p className="text-ink-300 text-sm">
        Add your own links to the desktop client — a Discord invite, a wiki, a support page. They
        open in the player&rsquo;s browser.
      </p>

      <FormError message={error} />

      <form
        className="gb-card space-y-4 p-5"
        onSubmit={(event: FormEvent) => {
          event.preventDefault();
          saveMutation.mutate();
        }}
      >
        <h2 className="text-sm font-semibold tracking-wide uppercase">
          {editingId ? 'Edit button' : 'Add a button'}
        </h2>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Label" htmlFor="btnLabel">
            <input
              id="btnLabel"
              className="gb-input"
              maxLength={40}
              value={form.label}
              onChange={(e) => setForm({ ...form, label: e.target.value })}
              placeholder="Our Discord"
              required
            />
          </Field>

          {/* Picked by looking at it: a dropdown of names asks an operator to
              know what "life-buoy" looks like before they can choose it. */}
          <IconPicker
            id="btnIcon"
            value={form.icon}
            options={CLIENT_BUTTON_ICONS}
            onChange={(icon) => setForm({ ...form, icon: icon as typeof form.icon })}
          />
        </div>

        <Field label="Link" htmlFor="btnUrl" hint="Must start with http:// or https://">
          <input
            id="btnUrl"
            type="url"
            className="gb-input"
            value={form.url}
            onChange={(e) => setForm({ ...form, url: e.target.value })}
            placeholder="https://discord.gg/…"
            required
          />
        </Field>

        <Field label="Where it shows" htmlFor="btnPlacement" hint={PLACEMENT_HINTS[form.placement]}>
          <select
            id="btnPlacement"
            className="gb-input"
            value={form.placement}
            onChange={(e) =>
              setForm({ ...form, placement: e.target.value as ClientButtonPlacement })
            }
          >
            {CLIENT_BUTTON_PLACEMENT.map((placement) => (
              <option key={placement} value={placement}>
                {PLACEMENT_LABELS[placement]}
              </option>
            ))}
          </select>
        </Field>

        <Field label="Tooltip" htmlFor="btnDescription" hint="Optional.">
          <input
            id="btnDescription"
            className="gb-input"
            maxLength={160}
            value={form.description}
            onChange={(e) => setForm({ ...form, description: e.target.value })}
            placeholder="Chat with other players"
          />
        </Field>

        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={form.active}
            onChange={(e) => setForm({ ...form, active: e.target.checked })}
          />
          Visible in the client
        </label>

        <div className="flex gap-2">
          <button type="submit" className="gb-btn-primary" disabled={saveMutation.isPending}>
            {saveMutation.isPending ? (
              <Spinner className="h-4 w-4" />
            ) : (
              <Plus className="h-4 w-4" />
            )}
            {editingId ? 'Save changes' : 'Add button'}
          </button>
          {editingId ? (
            <button
              type="button"
              className="gb-btn-ghost"
              onClick={() => {
                setEditingId(null);
                setForm(BLANK);
              }}
            >
              Cancel
            </button>
          ) : null}
        </div>
      </form>

      {buttonsQuery.isLoading ? (
        <RowSkeleton rows={3} />
      ) : buttons.length === 0 ? (
        <EmptyState
          title="No custom buttons yet"
          message="Add one above and it appears in the desktop client the next time it loads."
        />
      ) : (
        CLIENT_BUTTON_PLACEMENT.map((placement) => {
          const group = buttons.filter((button) => button.placement === placement);
          if (group.length === 0) return null;

          return (
            <section key={placement} className="space-y-2">
              <h2 className="text-ink-300 text-xs font-medium tracking-wide uppercase">
                {PLACEMENT_LABELS[placement]}
              </h2>
              <div className="divide-ink-700/70 gb-card divide-y">
                {group.map((button, index) => (
                  <div
                    key={button.id}
                    // Wraps rather than overflowing: with an icon preview, a
                    // label and five controls this row does not fit a phone.
                    className="flex flex-wrap items-center gap-3 px-4 py-3"
                  >
                    {/* The same mark the client will draw, so the list reads as
                        a preview of the sidebar rather than as a table of URLs. */}
                    <span className="border-ink-700 bg-ink-800 text-ink-200 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border">
                      <Icon name={button.icon} />
                    </span>
                    <div className="min-w-[8rem] flex-1">
                      <p className="flex items-center gap-2 text-sm font-medium">
                        {button.label}
                        {button.active ? null : <Badge tone="neutral">Hidden</Badge>}
                      </p>
                      <p className="text-ink-400 truncate text-xs">{button.url}</p>
                    </div>

                    <a
                      className="gb-btn-ghost"
                      href={button.url}
                      target="_blank"
                      rel="noreferrer noopener"
                      aria-label={`Open ${button.label}`}
                    >
                      <ExternalLink className="h-4 w-4" aria-hidden />
                    </a>
                    <button
                      type="button"
                      className="gb-btn-ghost"
                      onClick={() => move(button, -1)}
                      disabled={index === 0}
                      aria-label="Move up"
                    >
                      <ArrowUp className="h-4 w-4" aria-hidden />
                    </button>
                    <button
                      type="button"
                      className="gb-btn-ghost"
                      onClick={() => move(button, 1)}
                      disabled={index === group.length - 1}
                      aria-label="Move down"
                    >
                      <ArrowDown className="h-4 w-4" aria-hidden />
                    </button>
                    <button
                      type="button"
                      className="gb-btn-ghost"
                      onClick={() => {
                        setEditingId(button.id);
                        setForm({
                          label: button.label,
                          url: button.url,
                          icon: button.icon as typeof BLANK.icon,
                          placement: button.placement,
                          description: button.description ?? '',
                          active: button.active,
                        });
                      }}
                    >
                      Edit
                    </button>
                    <button
                      type="button"
                      className="gb-btn-danger"
                      aria-label={`Delete ${button.label}`}
                      onClick={() => {
                        if (!confirm(`Delete the "${button.label}" button?`)) return;
                        removeMutation.mutate(button.id);
                      }}
                    >
                      <Trash2 className="h-4 w-4" aria-hidden />
                    </button>
                  </div>
                ))}
              </div>
            </section>
          );
        })
      )}
    </div>
  );
}
