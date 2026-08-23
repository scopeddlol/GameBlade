import {
  LANDING_BLOCK_HINTS,
  LANDING_BLOCK_KINDS,
  LANDING_BLOCK_LABELS,
  LANDING_ICONS,
  resolveTheme,
  type LandingBlock,
  type LandingBlockKind,
  type PublicServerInfo,
  type ThemePreset,
} from '@gameblade/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowDown, ArrowUp, Eye, EyeOff, Plus, RotateCcw, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Icon, IconPicker } from '../../components/icons.js';
import { LandingBlocks } from '../../components/LandingBlocks.js';
import { Badge, Field, FormError, SectionSkeleton, Spinner, Notice } from '../../components/ui.js';
import { themeStyle } from '../../hooks/useTheme.js';
import { api, ApiRequestError } from '../../lib/api.js';

interface LandingResponse {
  blocks: LandingBlock[];
  isCustomised: boolean;
}

interface ThemeResponse {
  preset: ThemePreset;
  accent: string | null;
}

let blockCounter = 0;
function newBlockId(kind: string): string {
  blockCounter += 1;
  return `${kind}-${Date.now().toString(36)}-${blockCounter}`;
}

/** A new block of each kind, with enough in it to look like something. */
function blankBlock(kind: LandingBlockKind): LandingBlock {
  const id = newBlockId(kind);
  switch (kind) {
    case 'hero':
      return {
        id,
        kind,
        visible: true,
        headline: '',
        subheadline: '',
        showDownload: true,
        showRegister: true,
        backgroundUrl: '',
      };
    case 'features':
      return {
        id,
        kind,
        visible: true,
        title: 'What you get',
        items: [{ icon: 'sparkles', title: 'Something good', body: '' }],
      };
    case 'stats':
      return { id, kind, visible: true, title: '', showGameCount: true, items: [] };
    case 'gallery':
      return { id, kind, visible: true, title: 'Screenshots', images: [] };
    case 'text':
      return { id, kind, visible: true, title: '', body: '', align: 'left' };
    case 'cta':
      return {
        id,
        kind,
        visible: true,
        title: 'Get the client',
        body: '',
        showDownload: true,
        showRegister: true,
      };
  }
}

/**
 * Theme and landing-page editing, with the real page rendered beside the form.
 *
 * The preview is the same component the public page uses, wrapped in the theme
 * being edited — not a mock-up of it. A preview built from a second
 * implementation is a preview that lies.
 */
export function AdminLandingPage() {
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [blocks, setBlocks] = useState<LandingBlock[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const landingQuery = useQuery({
    queryKey: ['admin', 'landing'],
    queryFn: () => api.get<LandingResponse>('/admin/landing'),
  });

  // The theme is not edited here, only worn by the preview so what is shown is
  // what a visitor would actually see.
  const themeQuery = useQuery({
    queryKey: ['admin', 'theme'],
    queryFn: () => api.get<ThemeResponse>('/admin/theme'),
  });

  const infoQuery = useQuery({
    queryKey: ['public', 'info'],
    queryFn: () => api.get<PublicServerInfo>('/public/info'),
  });

  // Seeded in an effect rather than inside `queryFn`: react-query only calls
  // the fetcher on a cache miss, so seeding there left the editor empty — and
  // the page stuck on its loader — whenever you came back inside the stale
  // window. `saved` is the query's own object, so this runs when the server's
  // answer changes and not on every render.
  const saved = landingQuery.data;
  useEffect(() => {
    if (saved) setBlocks(saved.blocks);
  }, [saved]);

  const tokens = resolveTheme(
    themeQuery.data?.preset ?? 'midnight',
    themeQuery.data?.accent ?? null,
  );

  const fail = (caught: unknown) =>
    setError(caught instanceof ApiRequestError ? caught.message : 'Could not save.');

  const saveLanding = useMutation({
    mutationFn: () => api.put('/admin/landing', { blocks: blocks ?? [] }),
    onSuccess: async () => {
      setError(null);
      setNotice('Landing page saved.');
      await queryClient.invalidateQueries({ queryKey: ['admin', 'landing'] });
      await queryClient.invalidateQueries({ queryKey: ['public', 'info'] });
    },
    onError: fail,
  });

  const resetLanding = useMutation({
    mutationFn: () => api.post<LandingResponse>('/admin/landing/reset'),
    onSuccess: async (data) => {
      setBlocks(data.blocks);
      setNotice('Reverted to the built-in page.');
      await queryClient.invalidateQueries({ queryKey: ['public', 'info'] });
    },
    onError: fail,
  });

  if (blocks === null) return <SectionSkeleton rows={4} />;

  const update = (id: string, patch: Partial<LandingBlock>) =>
    setBlocks(
      (current) =>
        current?.map((block) =>
          block.id === id ? ({ ...block, ...patch } as LandingBlock) : block,
        ) ?? null,
    );

  const move = (index: number, delta: number) => {
    const target = index + delta;
    if (!blocks || target < 0 || target >= blocks.length) return;
    const next = [...blocks];
    const [moved] = next.splice(index, 1);
    if (moved) next.splice(target, 0, moved);
    setBlocks(next);
  };

  return (
    <div className="space-y-4">
      {landingQuery.data?.isCustomised ? (
        <p>
          <Badge tone="info">Customised</Badge>
        </p>
      ) : null}

      <FormError message={error} />
      <Notice message={notice} />

      {/* ---------------------------------------------------- landing page */}
      <div className="grid gap-4 xl:grid-cols-[minmax(0,26rem)_minmax(0,1fr)]">
        <div className="space-y-4">
          <section className="gb-card space-y-3 p-5">
            <h2 className="text-sm font-semibold tracking-wide uppercase">Sections</h2>

            <ol className="space-y-2">
              {blocks.map((block, index) => (
                <li key={block.id}>
                  <div
                    className={`flex items-center gap-1.5 rounded-lg border px-2.5 py-2 ${
                      selectedId === block.id ? 'border-blade-500' : 'border-ink-700'
                    }`}
                  >
                    <button
                      type="button"
                      className="min-w-0 flex-1 text-left text-sm"
                      onClick={() => setSelectedId(selectedId === block.id ? null : block.id)}
                    >
                      <span className={block.visible ? '' : 'text-ink-500 line-through'}>
                        {LANDING_BLOCK_LABELS[block.kind]}
                      </span>
                    </button>

                    <button
                      type="button"
                      className="gb-btn-ghost px-2 py-1"
                      aria-label={block.visible ? 'Hide this section' : 'Show this section'}
                      onClick={() => update(block.id, { visible: !block.visible })}
                    >
                      {block.visible ? (
                        <Eye className="h-4 w-4" aria-hidden />
                      ) : (
                        <EyeOff className="h-4 w-4" aria-hidden />
                      )}
                    </button>
                    <button
                      type="button"
                      className="gb-btn-ghost px-2 py-1"
                      aria-label="Move up"
                      disabled={index === 0}
                      onClick={() => move(index, -1)}
                    >
                      <ArrowUp className="h-4 w-4" aria-hidden />
                    </button>
                    <button
                      type="button"
                      className="gb-btn-ghost px-2 py-1"
                      aria-label="Move down"
                      disabled={index === blocks.length - 1}
                      onClick={() => move(index, 1)}
                    >
                      <ArrowDown className="h-4 w-4" aria-hidden />
                    </button>
                    <button
                      type="button"
                      className="gb-btn-danger px-2 py-1"
                      aria-label="Delete this section"
                      onClick={() => {
                        if (!confirm(`Delete the ${LANDING_BLOCK_LABELS[block.kind]} section?`))
                          return;
                        setBlocks((current) =>
                          (current ?? []).filter((entry) => entry.id !== block.id),
                        );
                        if (selectedId === block.id) setSelectedId(null);
                      }}
                    >
                      <Trash2 className="h-4 w-4" aria-hidden />
                    </button>
                  </div>

                  {selectedId === block.id ? (
                    <div className="border-ink-700 mt-2 space-y-3 rounded-lg border p-3">
                      <BlockEditor block={block} onChange={(patch) => update(block.id, patch)} />
                    </div>
                  ) : null}
                </li>
              ))}
            </ol>

            <div className="border-ink-800 space-y-2 border-t pt-3">
              <p className="gb-label">Add a section</p>
              <div className="flex flex-wrap gap-1.5">
                {LANDING_BLOCK_KINDS.map((kind) => (
                  <button
                    key={kind}
                    type="button"
                    className="gb-chip"
                    title={LANDING_BLOCK_HINTS[kind]}
                    onClick={() => {
                      const block = blankBlock(kind);
                      setBlocks((current) => [...(current ?? []), block]);
                      setSelectedId(block.id);
                    }}
                  >
                    <Plus className="mr-1 inline h-3 w-3" aria-hidden />
                    {LANDING_BLOCK_LABELS[kind]}
                  </button>
                ))}
              </div>
            </div>

            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                className="gb-btn-primary"
                onClick={() => saveLanding.mutate()}
                disabled={saveLanding.isPending}
              >
                {saveLanding.isPending ? <Spinner className="h-4 w-4" /> : null}
                Save landing page
              </button>
              <button
                type="button"
                className="gb-btn-ghost"
                onClick={() => {
                  if (!confirm('Throw away your changes and go back to the built-in page?')) return;
                  resetLanding.mutate();
                }}
              >
                <RotateCcw className="h-4 w-4" aria-hidden />
                Reset
              </button>
            </div>
          </section>
        </div>

        {/* The real page, in the theme being edited. */}
        <section className="gb-card overflow-hidden">
          <header className="border-ink-800 flex items-center gap-2 border-b px-4 py-2.5">
            <h2 className="text-sm font-semibold tracking-wide uppercase">Preview</h2>
            <span className="text-ink-500 ml-auto text-xs">Live, and not clickable</span>
          </header>
          <div
            className="bg-ink-900 max-h-[70vh] overflow-y-auto"
            style={themeStyle(tokens)}
            // Purely a rendering of the page; nothing inside should navigate.
            aria-label="Landing page preview"
          >
            <LandingBlocks blocks={blocks} context={{ info: infoQuery.data, interactive: false }} />
          </div>
        </section>
      </div>
    </div>
  );
}

/** The fields for whichever block is open. */
function BlockEditor({
  block,
  onChange,
}: {
  block: LandingBlock;
  onChange: (patch: Partial<LandingBlock>) => void;
}) {
  switch (block.kind) {
    case 'hero':
      return (
        <>
          <Field label="Headline" htmlFor={`h-${block.id}`} hint="Blank uses the server name.">
            <input
              id={`h-${block.id}`}
              className="gb-input"
              value={block.headline}
              onChange={(event) => onChange({ headline: event.target.value })}
            />
          </Field>
          <Field label="Subheadline" htmlFor={`s-${block.id}`} hint="Blank uses the tagline.">
            <textarea
              id={`s-${block.id}`}
              className="gb-input min-h-20"
              value={block.subheadline}
              onChange={(event) => onChange({ subheadline: event.target.value })}
            />
          </Field>
          <Field label="Background image URL" htmlFor={`bg-${block.id}`} hint="Optional.">
            <input
              id={`bg-${block.id}`}
              className="gb-input"
              value={block.backgroundUrl}
              onChange={(event) => onChange({ backgroundUrl: event.target.value })}
            />
          </Field>
          <ButtonToggles block={block} onChange={onChange} />
        </>
      );

    case 'cta':
      return (
        <>
          <TitleField block={block} onChange={onChange} />
          <Field label="Body" htmlFor={`b-${block.id}`}>
            <textarea
              id={`b-${block.id}`}
              className="gb-input min-h-20"
              value={block.body}
              onChange={(event) => onChange({ body: event.target.value })}
            />
          </Field>
          <ButtonToggles block={block} onChange={onChange} />
        </>
      );

    case 'text':
      return (
        <>
          <TitleField block={block} onChange={onChange} />
          <Field
            label="Body"
            htmlFor={`b-${block.id}`}
            hint="Blank lines start a new paragraph. Text only — no HTML."
          >
            <textarea
              id={`b-${block.id}`}
              className="gb-input min-h-32"
              value={block.body}
              onChange={(event) => onChange({ body: event.target.value })}
            />
          </Field>
          <Field label="Alignment" htmlFor={`a-${block.id}`}>
            <select
              id={`a-${block.id}`}
              className="gb-input"
              value={block.align}
              onChange={(event) => onChange({ align: event.target.value as 'left' | 'center' })}
            >
              <option value="left">Left</option>
              <option value="center">Centred</option>
            </select>
          </Field>
        </>
      );

    case 'features':
      return (
        <>
          <TitleField block={block} onChange={onChange} />
          {block.items.map((item, index) => (
            <div key={index} className="border-ink-800 space-y-2 rounded-lg border p-2.5">
              <div className="flex gap-2">
                {/* The mark the card will actually wear, beside the name it
                    labels — picking one from a list of slugs means guessing. */}
                <span className="border-ink-700 bg-ink-800 text-blade-400 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border">
                  <Icon name={item.icon} className="h-5 w-5" />
                </span>
                <input
                  className="gb-input"
                  value={item.title}
                  aria-label="Card title"
                  placeholder="Title"
                  onChange={(event) => {
                    const items = [...block.items];
                    items[index] = { ...item, title: event.target.value };
                    onChange({ items });
                  }}
                />
                <button
                  type="button"
                  className="gb-btn-danger shrink-0 px-2"
                  aria-label="Remove this card"
                  onClick={() => onChange({ items: block.items.filter((_, i) => i !== index) })}
                >
                  <Trash2 className="h-4 w-4" aria-hidden />
                </button>
              </div>
              <IconPicker
                value={item.icon}
                options={LANDING_ICONS}
                label="Card icon"
                onChange={(icon) => {
                  const items = [...block.items];
                  items[index] = { ...item, icon: icon as typeof item.icon };
                  onChange({ items });
                }}
              />
              <textarea
                className="gb-input min-h-16"
                value={item.body}
                aria-label="Card body"
                placeholder="Body"
                onChange={(event) => {
                  const items = [...block.items];
                  items[index] = { ...item, body: event.target.value };
                  onChange({ items });
                }}
              />
            </div>
          ))}
          <button
            type="button"
            className="gb-btn-ghost"
            disabled={block.items.length >= 12}
            onClick={() =>
              onChange({
                items: [...block.items, { icon: 'sparkles', title: 'New card', body: '' }],
              })
            }
          >
            <Plus className="h-4 w-4" aria-hidden />
            Add a card
          </button>
        </>
      );

    case 'stats':
      return (
        <>
          <TitleField block={block} onChange={onChange} />
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={block.showGameCount}
              onChange={(event) => onChange({ showGameCount: event.target.checked })}
            />
            Show the live game count
          </label>
          {block.items.map((item, index) => (
            <div key={index} className="flex gap-2">
              <input
                className="gb-input"
                value={item.value}
                aria-label="Value"
                placeholder="42"
                onChange={(event) => {
                  const items = [...block.items];
                  items[index] = { ...item, value: event.target.value };
                  onChange({ items });
                }}
              />
              <input
                className="gb-input"
                value={item.label}
                aria-label="Label"
                placeholder="Label"
                onChange={(event) => {
                  const items = [...block.items];
                  items[index] = { ...item, label: event.target.value };
                  onChange({ items });
                }}
              />
              <button
                type="button"
                className="gb-btn-danger shrink-0 px-2"
                aria-label="Remove this stat"
                onClick={() => onChange({ items: block.items.filter((_, i) => i !== index) })}
              >
                <Trash2 className="h-4 w-4" aria-hidden />
              </button>
            </div>
          ))}
          <button
            type="button"
            className="gb-btn-ghost"
            disabled={block.items.length >= 8}
            onClick={() => onChange({ items: [...block.items, { label: 'Label', value: '0' }] })}
          >
            <Plus className="h-4 w-4" aria-hidden />
            Add a stat
          </button>
        </>
      );

    case 'gallery':
      return (
        <>
          <TitleField block={block} onChange={onChange} />
          {block.images.map((image, index) => (
            <div key={index} className="flex gap-2">
              <input
                className="gb-input"
                value={image.url}
                aria-label="Image URL"
                placeholder="https://…"
                onChange={(event) => {
                  const images = [...block.images];
                  images[index] = { ...image, url: event.target.value };
                  onChange({ images });
                }}
              />
              <input
                className="gb-input"
                value={image.caption}
                aria-label="Caption"
                placeholder="Caption"
                onChange={(event) => {
                  const images = [...block.images];
                  images[index] = { ...image, caption: event.target.value };
                  onChange({ images });
                }}
              />
              <button
                type="button"
                className="gb-btn-danger shrink-0 px-2"
                aria-label="Remove this image"
                onClick={() => onChange({ images: block.images.filter((_, i) => i !== index) })}
              >
                <Trash2 className="h-4 w-4" aria-hidden />
              </button>
            </div>
          ))}
          <button
            type="button"
            className="gb-btn-ghost"
            disabled={block.images.length >= 12}
            onClick={() => onChange({ images: [...block.images, { url: '', caption: '' }] })}
          >
            <Plus className="h-4 w-4" aria-hidden />
            Add an image
          </button>
        </>
      );

    default:
      return null;
  }
}

function TitleField({
  block,
  onChange,
}: {
  block: Extract<LandingBlock, { title: string }>;
  onChange: (patch: Partial<LandingBlock>) => void;
}) {
  return (
    <Field label="Title" htmlFor={`t-${block.id}`} hint="Leave blank to omit the heading.">
      <input
        id={`t-${block.id}`}
        className="gb-input"
        value={block.title}
        onChange={(event) => onChange({ title: event.target.value } as Partial<LandingBlock>)}
      />
    </Field>
  );
}

function ButtonToggles({
  block,
  onChange,
}: {
  block: Extract<LandingBlock, { showDownload: boolean }>;
  onChange: (patch: Partial<LandingBlock>) => void;
}) {
  return (
    <div className="space-y-1.5">
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={block.showDownload}
          onChange={(event) =>
            onChange({ showDownload: event.target.checked } as Partial<LandingBlock>)
          }
        />
        Download button
      </label>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={block.showRegister}
          onChange={(event) =>
            onChange({ showRegister: event.target.checked } as Partial<LandingBlock>)
          }
        />
        Sign-up button (only shows when self-registration is on)
      </label>
    </div>
  );
}
