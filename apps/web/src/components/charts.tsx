import { useId, useState } from 'react';

/**
 * Chart primitives for the analytics page.
 *
 * Hand-rolled SVG rather than a charting library: these are three simple forms
 * over at most a few hundred points, and a library would add more bundle than
 * the whole admin panel currently ships.
 *
 * Every chart here is single-series, so colour is constant and *length* carries
 * the magnitude. That is also why there are no legends — with one series the
 * title names it, and a legend box would be noise.
 */

/** The one accent used by every mark; ≥3:1 against the admin surface. */
const SERIES = 'var(--color-blade-500, #2bb7f5)';
const GRID = 'rgba(255, 255, 255, 0.08)';

export interface Point {
  label: string;
  value: number;
  /** Shown in the tooltip in place of the raw number. */
  display: string;
  /**
   * Axis tick, when the full label is too long to sit under a column.
   * Falls back to `label`; deriving one by slicing the label is how an axis
   * ends up reading "26, 26, 26".
   */
  short?: string;
}

/** Rounds only the data end of a bar, so it stays anchored to the baseline. */
function topRoundedPath(x: number, y: number, width: number, height: number, radius: number) {
  const r = Math.min(radius, width / 2, Math.max(0, height));
  if (height <= 0) return '';
  return [
    `M ${x} ${y + height}`,
    `L ${x} ${y + r}`,
    `Q ${x} ${y} ${x + r} ${y}`,
    `L ${x + width - r} ${y}`,
    `Q ${x + width} ${y} ${x + width} ${y + r}`,
    `L ${x + width} ${y + height}`,
    'Z',
  ].join(' ');
}

/**
 * Trend over time. An area under a 2px line — one series, so the fill reads as
 * volume rather than as a second thing to compare against.
 */
export function AreaChart({
  points,
  height = 180,
  emptyMessage = 'No activity in this period.',
}: {
  points: Point[];
  height?: number;
  emptyMessage?: string;
}) {
  const gradientId = useId();
  const [hover, setHover] = useState<number | null>(null);

  if (points.length === 0 || points.every((point) => point.value === 0)) {
    return <p className="text-ink-400 py-8 text-center text-sm">{emptyMessage}</p>;
  }

  const width = 720;
  const padding = { top: 10, right: 8, bottom: 22, left: 8 };
  const plotWidth = width - padding.left - padding.right;
  const plotHeight = height - padding.top - padding.bottom;
  const max = Math.max(...points.map((point) => point.value), 1);

  const x = (index: number) =>
    padding.left +
    (points.length === 1 ? plotWidth / 2 : (index / (points.length - 1)) * plotWidth);
  const y = (value: number) => padding.top + plotHeight - (value / max) * plotHeight;

  const line = points.map((point, index) => `${x(index)},${y(point.value)}`).join(' ');
  const area = `${padding.left},${padding.top + plotHeight} ${line} ${padding.left + plotWidth},${
    padding.top + plotHeight
  }`;

  const active = hover === null ? null : points[hover];

  return (
    <div className="relative">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="w-full"
        role="img"
        aria-label={`Trend across ${points.length} points`}
        onMouseLeave={() => setHover(null)}
      >
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={SERIES} stopOpacity="0.35" />
            <stop offset="100%" stopColor={SERIES} stopOpacity="0.02" />
          </linearGradient>
        </defs>

        {/* Recessive baseline only — a full grid would compete with the data. */}
        <line
          x1={padding.left}
          y1={padding.top + plotHeight}
          x2={padding.left + plotWidth}
          y2={padding.top + plotHeight}
          stroke={GRID}
        />

        <polygon points={area} fill={`url(#${gradientId})`} />
        <polyline
          points={line}
          fill="none"
          stroke={SERIES}
          strokeWidth="2"
          strokeLinejoin="round"
        />

        {active ? (
          <>
            <line
              x1={x(hover as number)}
              y1={padding.top}
              x2={x(hover as number)}
              y2={padding.top + plotHeight}
              stroke={GRID}
            />
            {/* A 2px surface ring keeps the marker readable over the fill. */}
            <circle
              cx={x(hover as number)}
              cy={y(active.value)}
              r="4.5"
              fill={SERIES}
              stroke="var(--color-ink-850, #10131a)"
              strokeWidth="2"
            />
          </>
        ) : null}

        {/* Invisible hit targets, far wider than the marks themselves. */}
        {points.map((point, index) => (
          <rect
            key={point.label}
            x={x(index) - plotWidth / points.length / 2}
            y={padding.top}
            width={Math.max(6, plotWidth / points.length)}
            height={plotHeight}
            fill="transparent"
            onMouseEnter={() => setHover(index)}
          />
        ))}

        <text x={padding.left} y={height - 6} className="fill-ink-400" fontSize="11">
          {points[0]?.label}
        </text>
        <text
          x={padding.left + plotWidth}
          y={height - 6}
          textAnchor="end"
          className="fill-ink-400"
          fontSize="11"
        >
          {points[points.length - 1]?.label}
        </text>
      </svg>

      {active ? (
        <div className="bg-ink-800 border-ink-700 pointer-events-none absolute top-0 right-0 rounded-lg border px-2.5 py-1.5 text-xs">
          <span className="text-ink-300">{active.label}</span>{' '}
          <strong className="text-ink-100">{active.display}</strong>
        </div>
      ) : null}
    </div>
  );
}

/** Magnitude by month. Columns, because months are a small ordered set. */
export function ColumnChart({
  points,
  height = 160,
  emptyMessage = 'Nothing recorded yet.',
}: {
  points: Point[];
  height?: number;
  emptyMessage?: string;
}) {
  const [hover, setHover] = useState<number | null>(null);

  if (points.length === 0) {
    return <p className="text-ink-400 py-8 text-center text-sm">{emptyMessage}</p>;
  }

  const width = 720;
  const padding = { top: 10, right: 8, bottom: 24, left: 8 };
  const plotWidth = width - padding.left - padding.right;
  const plotHeight = height - padding.top - padding.bottom;
  const max = Math.max(...points.map((point) => point.value), 1);

  const slot = plotWidth / points.length;
  // A 2px surface gap between adjacent fills, so columns never merge.
  const barWidth = Math.min(96, Math.max(4, slot - 2 - Math.min(18, slot * 0.35)));

  return (
    <div className="relative">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="w-full"
        role="img"
        aria-label="Monthly totals"
        onMouseLeave={() => setHover(null)}
      >
        <line
          x1={padding.left}
          y1={padding.top + plotHeight}
          x2={padding.left + plotWidth}
          y2={padding.top + plotHeight}
          stroke={GRID}
        />

        {points.map((point, index) => {
          const barHeight = (point.value / max) * plotHeight;
          const x = padding.left + index * slot + (slot - barWidth) / 2;
          const y = padding.top + plotHeight - barHeight;
          return (
            <g key={point.label} onMouseEnter={() => setHover(index)}>
              <rect
                x={padding.left + index * slot}
                y={padding.top}
                width={slot}
                height={plotHeight}
                fill="transparent"
              />
              <path
                d={topRoundedPath(x, y, barWidth, barHeight, 4)}
                fill={SERIES}
                opacity={hover === null || hover === index ? 1 : 0.55}
              />
              {points.length <= 12 ? (
                <text
                  x={x + barWidth / 2}
                  y={height - 8}
                  textAnchor="middle"
                  className="fill-ink-400"
                  fontSize="10"
                >
                  {point.short ?? point.label}
                </text>
              ) : null}
            </g>
          );
        })}
      </svg>

      {hover !== null && points[hover] ? (
        <div className="bg-ink-800 border-ink-700 pointer-events-none absolute top-0 right-0 rounded-lg border px-2.5 py-1.5 text-xs">
          <span className="text-ink-300">{points[hover]?.label}</span>{' '}
          <strong className="text-ink-100">{points[hover]?.display}</strong>
        </div>
      ) : null}
    </div>
  );
}

/**
 * Ranked magnitude with long labels — horizontal, because game titles do not
 * fit under a column and rotated axis labels are unreadable.
 */
export function RankedBars({
  points,
  limit,
  emptyMessage = 'Nothing recorded yet.',
}: {
  points: Point[];
  /** Trims the tail; the ranking is what matters, not the long list. */
  limit?: number;
  emptyMessage?: string;
}) {
  if (points.length === 0) {
    return <p className="text-ink-400 py-6 text-center text-sm">{emptyMessage}</p>;
  }

  // Scaled against the whole series, not the visible slice, so trimming the
  // list never rescales the bars that stay.
  const max = Math.max(...points.map((point) => point.value), 1);
  const shown = limit ? points.slice(0, limit) : points;

  return (
    <ol className="space-y-1.5">
      {shown.map((point) => (
        <li key={point.label} className="space-y-1">
          <div className="flex items-baseline justify-between gap-3 text-[13px]">
            <span className="text-ink-200 min-w-0 truncate">{point.label}</span>
            {/* Value is text-token ink, never the series colour. */}
            <span className="text-ink-400 shrink-0 text-xs">{point.display}</span>
          </div>
          <div className="bg-ink-800 h-1.5 overflow-hidden rounded-full">
            <div
              className="h-full rounded-full"
              style={{
                width: `${Math.max(2, (point.value / max) * 100)}%`,
                background: SERIES,
              }}
            />
          </div>
        </li>
      ))}
    </ol>
  );
}

/**
 * One ratio against a limit.
 *
 * Colour shifts to a status hue as the limit approaches, but the percentage is
 * always spelled out beside it — state is never carried by colour alone.
 */
export function Meter({
  label,
  used,
  limit,
  usedDisplay,
  limitDisplay,
}: {
  label: string;
  used: number;
  limit: number;
  usedDisplay: string;
  limitDisplay: string;
}) {
  const fraction = limit > 0 ? Math.min(1, used / limit) : 0;
  const percent = Math.round(fraction * 100);
  const tone =
    percent >= 100 ? '#e34948' : percent >= 80 ? '#eda100' : 'var(--color-blade-500, #2bb7f5)';

  return (
    <li className="space-y-1">
      <div className="flex items-baseline justify-between gap-3 text-sm">
        <span className="text-ink-200 min-w-0 truncate">{label}</span>
        <span className="text-ink-400 shrink-0 text-xs">
          {usedDisplay} / {limitDisplay} · {percent}%
        </span>
      </div>
      <div
        className="bg-ink-800 h-2 overflow-hidden rounded-full"
        role="meter"
        aria-valuenow={percent}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={`${label} allowance used`}
      >
        <div
          className="h-full rounded-full"
          style={{ width: `${Math.max(2, fraction * 100)}%`, background: tone }}
        />
      </div>
    </li>
  );
}

/**
 * A headline number. Not a one-bar chart.
 *
 * `dense` trades the breathing room for rows on screen — on a page of a dozen
 * panels the padding is what pushes half of them below the fold.
 */
export function StatTile({
  label,
  value,
  hint,
  dense = false,
}: {
  label: string;
  value: string;
  hint?: string;
  dense?: boolean;
}) {
  return (
    <div className={dense ? 'gb-card px-3 py-2.5' : 'gb-card p-4'}>
      <p className="text-ink-400 text-[11px] font-medium tracking-wide uppercase">{label}</p>
      <p
        className={
          dense
            ? 'text-lg font-semibold tracking-tight tabular-nums'
            : 'mt-1 text-2xl font-semibold tracking-tight tabular-nums'
        }
      >
        {value}
      </p>
      {hint ? <p className="text-ink-500 text-xs">{hint}</p> : null}
    </div>
  );
}
