import {
  LANDING_BLOCK_HINTS,
  LANDING_BLOCK_KINDS,
  LANDING_BLOCK_LABELS,
  LANDING_ICONS,
  resolveTheme,
  youtubeId,
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

/** The rhythm settings every block shares, at their defaults. */
const BASE = { visible: true, padding: 'normal', background: 'none', width: 'normal' } as const;

/** A new block of each kind, with enough in it to look like something. */
function blankBlock(kind: LandingBlockKind): LandingBlock {
  const id = newBlockId(kind);
  switch (kind) {
    case 'hero':
      return {
        id,
        kind,
        ...BASE,
        padding: 'roomy',
        eyebrow: '',
        headline: '',
        subheadline: '',
        showDownload: true,
        showRegister: true,
        backgroundUrl: '',
        overlay: 60,
        align: 'left',
        height: 'normal',
      };
    case 'features':
      return {
        id,
        kind,
        ...BASE,
        title: 'What you get',
        subtitle: '',
        columns: 3,
        style: 'card',
        items: [{ icon: 'sparkles', title: 'Something good', body: '' }],
      };
    case 'steps':
      return {
        id,
        kind,
        ...BASE,
        background: 'muted',
        title: 'How it works',
        subtitle: '',
        items: [
          { title: 'Get an invite', body: '' },
          { title: 'Install the client', body: '' },
          { title: 'Play', body: '' },
        ],
      };
    case 'stats':
      return { id, kind, ...BASE, title: '', showGameCount: true, style: 'card', items: [] };
    case 'gallery':
      return { id, kind, ...BASE, title: 'Screenshots', columns: 3, ratio: 'video', images: [] };
    case 'video':
      return { id, kind, ...BASE, title: '', subtitle: '', url: '' };
    case 'quote':
      return { id, kind, ...BASE, quote: '', attribution: '' };
    case 'faq':
      return {
        id,
        kind,
        ...BASE,
        title: 'Questions',
        items: [{ question: 'How do I get an account?', answer: '' }],
      };
    case 'text':
      return { id, kind, ...BASE, title: '', body: '', align: 'left', size: 'normal' };
    case 'divider':
      return { id, kind, ...BASE, padding: 'compact', line: true };
    case 'cta':
      return {
        id,
        kind,
        ...BASE,
        padding: 'roomy',
        title: 'Get the client',
        body: '',
        showDownload: true,
        showRegister: true,
        style: 'card',
      };
  }
}

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
                      <BlockAppearance
                        block={block}
                        onChange={(patch) => update(block.id, patch)}
                      />
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

/** A labelled dropdown, which is most of what these editors are. */
function Choice<T extends string | number>({
  label,
  id,
  value,
  options,
  hint,
  onChange,
}: {
  label: string;
  id: string;
  value: T;
  options: readonly { value: T; label: string }[];
  hint?: string;
  onChange: (value: T) => void;
}) {
  return (
    <Field label={label} htmlFor={id} hint={hint}>
      <select
        id={id}
        className="gb-input"
        value={String(value)}
        onChange={(event) => {
          const picked = options.find((option) => String(option.value) === event.target.value);
          if (picked) onChange(picked.value);
        }}
      >
        {options.map((option) => (
          <option key={String(option.value)} value={String(option.value)}>
            {option.label}
          </option>
        ))}
      </select>
    </Field>
  );
}

const PADDING_OPTIONS = [
  { value: 'compact', label: 'Compact' },
  { value: 'normal', label: 'Normal' },
  { value: 'roomy', label: 'Roomy' },
] as const;

const BACKGROUND_OPTIONS = [
  { value: 'none', label: 'None' },
  { value: 'muted', label: 'Muted band' },
  { value: 'accent', label: 'Accent wash' },
] as const;

const WIDTH_OPTIONS = [
  { value: 'narrow', label: 'Narrow' },
  { value: 'normal', label: 'Normal' },
  { value: 'wide', label: 'Wide' },
] as const;

const COLUMN_OPTIONS = [
  { value: 2, label: 'Two' },
  { value: 3, label: 'Three' },
  { value: 4, label: 'Four' },
] as const;

/**
 * The rhythm controls every section shares.
 *
 * Separated from the kind's own fields because they are a different kind of
 * decision — what a section *says* versus how it sits among its neighbours.
 * Alternating the surface and varying the padding is most of what makes a
 * page read as designed rather than as a stack of boxes, and it is the part an
 * operator cannot get at by editing copy.
 */
function BlockAppearance({
  block,
  onChange,
}: {
  block: LandingBlock;
  onChange: (patch: Partial<LandingBlock>) => void;
}) {
  return (
    <details className="border-ink-800 rounded-lg border">
      <summary className="text-ink-300 cursor-pointer px-3 py-2 text-xs font-medium tracking-wide uppercase">
        Spacing and surface
      </summary>
      <div className="grid gap-3 px-3 pt-1 pb-3 sm:grid-cols-3">
        <Choice
          label="Padding"
          id={`pad-${block.id}`}
          value={block.padding}
          options={PADDING_OPTIONS}
          onChange={(padding) => onChange({ padding } as Partial<LandingBlock>)}
        />
        <Choice
          label="Background"
          id={`bgs-${block.id}`}
          value={block.background}
          options={BACKGROUND_OPTIONS}
          onChange={(background) => onChange({ background } as Partial<LandingBlock>)}
        />
        <Choice
          label="Width"
          id={`w-${block.id}`}
          value={block.width}
          options={WIDTH_OPTIONS}
          onChange={(width) => onChange({ width } as Partial<LandingBlock>)}
        />
      </div>
    </details>
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
          <Field
            label="Eyebrow"
            htmlFor={`e-${block.id}`}
            hint="A short line above the headline. Optional."
          >
            <input
              id={`e-${block.id}`}
              className="gb-input"
              value={block.eyebrow}
              placeholder="Self-hosted, invite only"
              onChange={(event) => onChange({ eyebrow: event.target.value })}
            />
          </Field>
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

          {/* Only worth showing when there is an image to dim. */}
          {block.backgroundUrl ? (
            <Field
              label={`Background dimming — ${block.overlay}%`}
              htmlFor={`ov-${block.id}`}
              hint="Enough that the headline stays readable over the image."
            >
              <input
                id={`ov-${block.id}`}
                type="range"
                min={0}
                max={90}
                step={5}
                className="w-full"
                value={block.overlay}
                onChange={(event) => onChange({ overlay: Number(event.target.value) })}
              />
            </Field>
          ) : null}

          <div className="grid gap-3 sm:grid-cols-2">
            <Choice
              label="Alignment"
              id={`ha-${block.id}`}
              value={block.align}
              options={[
                { value: 'left', label: 'Left' },
                { value: 'center', label: 'Centred' },
              ]}
              onChange={(align) => onChange({ align })}
            />
            <Choice
              label="Height"
              id={`hh-${block.id}`}
              value={block.height}
              options={[
                { value: 'compact', label: 'Compact' },
                { value: 'normal', label: 'Normal' },
                { value: 'tall', label: 'Tall' },
                { value: 'full', label: 'Fills the screen' },
              ]}
              onChange={(height) => onChange({ height })}
            />
          </div>

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
          <Choice
            label="Style"
            id={`cs-${block.id}`}
            value={block.style}
            options={[
              { value: 'card', label: 'Panel' },
              { value: 'banner', label: 'Full width' },
            ]}
            onChange={(style) => onChange({ style })}
          />
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
          <div className="grid gap-3 sm:grid-cols-2">
            <Choice
              label="Alignment"
              id={`a-${block.id}`}
              value={block.align}
              options={[
                { value: 'left', label: 'Left' },
                { value: 'center', label: 'Centred' },
              ]}
              onChange={(align) => onChange({ align })}
            />
            <Choice
              label="Size"
              id={`ts-${block.id}`}
              value={block.size}
              options={[
                { value: 'normal', label: 'Body copy' },
                { value: 'large', label: 'Large' },
              ]}
              onChange={(size) => onChange({ size })}
            />
          </div>
        </>
      );

    case 'features':
      return (
        <>
          <TitleField block={block} onChange={onChange} />
          <SubtitleField block={block} onChange={onChange} />
          <div className="grid gap-3 sm:grid-cols-2">
            <Choice
              label="Columns"
              id={`c-${block.id}`}
              value={block.columns}
              options={COLUMN_OPTIONS}
              onChange={(columns) => onChange({ columns })}
            />
            <Choice
              label="Style"
              id={`fs-${block.id}`}
              value={block.style}
              options={[
                { value: 'card', label: 'Cards' },
                { value: 'plain', label: 'Plain' },
              ]}
              onChange={(style) => onChange({ style })}
            />
          </div>
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
          <Choice
            label="Style"
            id={`ss-${block.id}`}
            value={block.style}
            options={[
              { value: 'card', label: 'Panel' },
              { value: 'plain', label: 'Plain' },
            ]}
            onChange={(style) => onChange({ style })}
          />
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
          <div className="grid gap-3 sm:grid-cols-2">
            <Choice
              label="Columns"
              id={`gc-${block.id}`}
              value={block.columns}
              options={COLUMN_OPTIONS}
              onChange={(columns) => onChange({ columns })}
            />
            <Choice
              label="Shape"
              id={`gr-${block.id}`}
              value={block.ratio}
              hint="Screenshots are 16:9; cover art is not."
              options={[
                { value: 'video', label: 'Widescreen (16:9)' },
                { value: 'wide', label: 'Ultrawide (21:9)' },
                { value: 'square', label: 'Square' },
                { value: 'portrait', label: 'Poster (2:3)' },
              ]}
              onChange={(ratio) => onChange({ ratio })}
            />
          </div>
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

    case 'steps':
      return (
        <>
          <TitleField block={block} onChange={onChange} />
          <SubtitleField block={block} onChange={onChange} />
          {block.items.map((item, index) => (
            <div key={index} className="border-ink-800 space-y-2 rounded-lg border p-2.5">
              <div className="flex gap-2">
                {/* The number the step will actually wear, so reordering the
                    list reads the same here as it does on the page. */}
                <span className="border-ink-700 bg-ink-800 text-blade-400 flex h-9 w-9 shrink-0 items-center justify-center rounded-full border text-sm font-semibold tabular-nums">
                  {index + 1}
                </span>
                <input
                  className="gb-input"
                  value={item.title}
                  aria-label={`Step ${index + 1} title`}
                  placeholder="Step"
                  onChange={(event) => {
                    const items = [...block.items];
                    items[index] = { ...item, title: event.target.value };
                    onChange({ items });
                  }}
                />
                <button
                  type="button"
                  className="gb-btn-danger shrink-0 px-2"
                  aria-label="Remove this step"
                  onClick={() => onChange({ items: block.items.filter((_, i) => i !== index) })}
                >
                  <Trash2 className="h-4 w-4" aria-hidden />
                </button>
              </div>
              <textarea
                className="gb-input min-h-16"
                value={item.body}
                aria-label={`Step ${index + 1} body`}
                placeholder="What happens at this step"
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
            disabled={block.items.length >= 6}
            onClick={() => onChange({ items: [...block.items, { title: 'Next', body: '' }] })}
          >
            <Plus className="h-4 w-4" aria-hidden />
            Add a step
          </button>
        </>
      );

    case 'video': {
      const id = youtubeId(block.url);
      return (
        <>
          <TitleField block={block} onChange={onChange} />
          <SubtitleField block={block} onChange={onChange} />
          <Field
            label="YouTube link"
            htmlFor={`v-${block.id}`}
            hint="A watch, share or embed link, or the bare video id. YouTube only."
          >
            <input
              id={`v-${block.id}`}
              className="gb-input"
              value={block.url}
              placeholder="https://www.youtube.com/watch?v=…"
              onChange={(event) => onChange({ url: event.target.value })}
            />
          </Field>
          {/* Said here rather than left to the preview: a block that renders as
              nothing looks like a bug, and the reason is worth stating. */}
          {block.url && !id ? (
            <p className="gb-note-danger">
              That is not a YouTube link, so nothing will be shown. The page only frames YouTube.
            </p>
          ) : null}
        </>
      );
    }

    case 'quote':
      return (
        <>
          <Field label="Quote" htmlFor={`q-${block.id}`}>
            <textarea
              id={`q-${block.id}`}
              className="gb-input min-h-24"
              value={block.quote}
              onChange={(event) => onChange({ quote: event.target.value })}
            />
          </Field>
          <Field label="Attribution" htmlFor={`qa-${block.id}`} hint="Optional.">
            <input
              id={`qa-${block.id}`}
              className="gb-input"
              value={block.attribution}
              placeholder="Someone who plays here"
              onChange={(event) => onChange({ attribution: event.target.value })}
            />
          </Field>
        </>
      );

    case 'faq':
      return (
        <>
          <TitleField block={block} onChange={onChange} />
          {block.items.map((item, index) => (
            <div key={index} className="border-ink-800 space-y-2 rounded-lg border p-2.5">
              <div className="flex gap-2">
                <input
                  className="gb-input"
                  value={item.question}
                  aria-label="Question"
                  placeholder="Question"
                  onChange={(event) => {
                    const items = [...block.items];
                    items[index] = { ...item, question: event.target.value };
                    onChange({ items });
                  }}
                />
                <button
                  type="button"
                  className="gb-btn-danger shrink-0 px-2"
                  aria-label="Remove this question"
                  onClick={() => onChange({ items: block.items.filter((_, i) => i !== index) })}
                >
                  <Trash2 className="h-4 w-4" aria-hidden />
                </button>
              </div>
              <textarea
                className="gb-input min-h-20"
                value={item.answer}
                aria-label="Answer"
                placeholder="Answer"
                onChange={(event) => {
                  const items = [...block.items];
                  items[index] = { ...item, answer: event.target.value };
                  onChange({ items });
                }}
              />
            </div>
          ))}
          <button
            type="button"
            className="gb-btn-ghost"
            disabled={block.items.length >= 20}
            onClick={() =>
              onChange({ items: [...block.items, { question: 'Another question', answer: '' }] })
            }
          >
            <Plus className="h-4 w-4" aria-hidden />
            Add a question
          </button>
        </>
      );

    case 'divider':
      return (
        <>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={block.line}
              onChange={(event) => onChange({ line: event.target.checked })}
            />
            Draw a rule
          </label>
          <p className="text-ink-400 text-xs">
            How much space it takes is the padding setting below.
          </p>
        </>
      );

    default:
      return null;
  }
}

function SubtitleField({
  block,
  onChange,
}: {
  block: Extract<LandingBlock, { subtitle: string }>;
  onChange: (patch: Partial<LandingBlock>) => void;
}) {
  return (
    <Field label="Subtitle" htmlFor={`st-${block.id}`} hint="One line under the title. Optional.">
      <textarea
        id={`st-${block.id}`}
        className="gb-input min-h-16"
        value={block.subtitle}
        onChange={(event) => onChange({ subtitle: event.target.value } as Partial<LandingBlock>)}
      />
    </Field>
  );
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
