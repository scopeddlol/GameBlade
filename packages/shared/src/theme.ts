/**
 * Themes for the web app and the desktop client.
 *
 * A theme is a complete set of surface steps plus an accent, not a single hue:
 * lightening only the accent on a near-black chrome produces something that
 * reads as broken rather than as light. Both clients consume the same tokens,
 * so a server's look is one setting rather than two that drift.
 */

export const THEME_PRESETS = ['midnight', 'slate', 'carbon', 'nebula', 'daylight'] as const;
export type ThemePreset = (typeof THEME_PRESETS)[number];

/** The surface ramp, darkest (or lightest, for a light theme) to text. */
export interface ThemeTokens {
  ink950: string;
  ink900: string;
  ink850: string;
  ink800: string;
  ink700: string;
  ink600: string;
  ink500: string;
  ink400: string;
  ink300: string;
  ink200: string;
  ink100: string;
  accent400: string;
  accent500: string;
  accent600: string;
  accent700: string;
  /** The second hue in gradients and the active-nav bar. */
  highlight: string;
  /** `dark` or `light`, so form controls and scrollbars match. */
  scheme: 'dark' | 'light';
}

export interface ThemeDefinition {
  id: ThemePreset;
  label: string;
  description: string;
  tokens: ThemeTokens;
}

export const THEMES: Record<ThemePreset, ThemeDefinition> = {
  midnight: {
    id: 'midnight',
    label: 'Midnight',
    description: 'The original. Near-black and blue, so cover art supplies the colour.',
    tokens: {
      ink950: '#07080c',
      ink900: '#0b0d12',
      ink850: '#10131a',
      ink800: '#161a23',
      ink700: '#1f2430',
      ink600: '#2b3242',
      ink500: '#3d465a',
      ink400: '#5b6478',
      ink300: '#8a93a6',
      ink200: '#b8bfcd',
      ink100: '#e2e6ee',
      accent400: '#62d0ff',
      accent500: '#2bb7f5',
      accent600: '#0d92d4',
      accent700: '#0a6fa3',
      highlight: '#7c5cff',
      scheme: 'dark',
    },
  },
  slate: {
    id: 'slate',
    label: 'Slate',
    description: 'Cooler and a shade lighter, with a teal accent. Easier on a bright room.',
    tokens: {
      ink950: '#0d1117',
      ink900: '#12181f',
      ink850: '#171f28',
      ink800: '#1d2732',
      ink700: '#28343f',
      ink600: '#35434f',
      ink500: '#475766',
      ink400: '#657585',
      ink300: '#93a1af',
      ink200: '#c0cad3',
      ink100: '#e8eef3',
      accent400: '#4fd1c5',
      accent500: '#25b3a6',
      accent600: '#118f84',
      accent700: '#0b6d64',
      highlight: '#4f9cf9',
      scheme: 'dark',
    },
  },
  carbon: {
    id: 'carbon',
    label: 'Carbon',
    description: 'Neutral greys and a warm amber accent. No colour cast on artwork.',
    tokens: {
      ink950: '#0a0a0a',
      ink900: '#101010',
      ink850: '#161616',
      ink800: '#1d1d1d',
      ink700: '#282828',
      ink600: '#363636',
      ink500: '#4a4a4a',
      ink400: '#6b6b6b',
      ink300: '#9a9a9a',
      ink200: '#c4c4c4',
      ink100: '#ededed',
      accent400: '#ffb84d',
      accent500: '#f59e0b',
      accent600: '#c97c05',
      accent700: '#9a5f04',
      highlight: '#ff7847',
      scheme: 'dark',
    },
  },
  nebula: {
    id: 'nebula',
    label: 'Nebula',
    description: 'Deep violet with a magenta accent. The loudest of the dark themes.',
    tokens: {
      ink950: '#0a0713',
      ink900: '#100b1c',
      ink850: '#161027',
      ink800: '#1e1633',
      ink700: '#2b2145',
      ink600: '#3b2f5c',
      ink500: '#514279',
      ink400: '#71619b',
      ink300: '#9c8fc0',
      ink200: '#c6bde0',
      ink100: '#ece7f7',
      accent400: '#f472d0',
      accent500: '#e048b4',
      accent600: '#b32d8c',
      accent700: '#8a1f6c',
      highlight: '#8b5cf6',
      scheme: 'dark',
    },
  },
  daylight: {
    id: 'daylight',
    label: 'Daylight',
    description: 'A genuine light theme. The ramp is inverted, not merely brightened.',
    tokens: {
      // Inverted deliberately: ink950 is still "furthest from the text", which
      // for a light theme is the palest surface. Every consumer keeps using the
      // same names and nothing has to know which way round the theme runs.
      // The sidebar sits a step *darker* than the page and cards a step
      // lighter, so the same components keep their depth order.
      ink950: '#eef1f5',
      ink900: '#f7f8fa',
      ink850: '#ffffff',
      ink800: '#eceff4',
      ink700: '#dde2ea',
      ink600: '#c5ccd8',
      ink500: '#9aa4b4',
      ink400: '#6b7688',
      ink300: '#4d5666',
      ink200: '#2c3340',
      ink100: '#10141b',
      accent400: '#0d92d4',
      accent500: '#0a76ad',
      accent600: '#075c87',
      accent700: '#05445f',
      highlight: '#6d4aff',
      scheme: 'light',
    },
  },
};

/** A hex colour, or null when the preset's own accent should be used. */
export function resolveTheme(preset: ThemePreset, accentOverride?: string | null): ThemeTokens {
  const base = (THEMES[preset] ?? THEMES.midnight).tokens;
  if (!accentOverride || !/^#[0-9a-fA-F]{6}$/.test(accentOverride)) return base;

  // An override supplies the mid step; the lighter and darker ones are derived
  // so hover, focus and gradient states keep working without asking an operator
  // to pick four related colours by hand.
  return {
    ...base,
    accent400: shade(accentOverride, 0.22),
    accent500: accentOverride,
    accent600: shade(accentOverride, -0.18),
    accent700: shade(accentOverride, -0.34),
  };
}

/** Lightens (positive) or darkens (negative) a hex colour by a fraction. */
export function shade(hex: string, amount: number): string {
  const value = hex.replace('#', '');
  const channels = [0, 2, 4].map((offset) => parseInt(value.slice(offset, offset + 2), 16));

  const adjusted = channels.map((channel) => {
    const target = amount >= 0 ? 255 : 0;
    return Math.round(channel + (target - channel) * Math.abs(amount));
  });

  return `#${adjusted.map((channel) => channel.toString(16).padStart(2, '0')).join('')}`;
}

/**
 * The CSS custom properties a theme sets.
 *
 * Both clients apply these to the document root at run time. The web app's
 * utilities compile to `var(--color-ink-900)` and the desktop's stylesheet
 * reads `--ink-900`, so each name is emitted in both spellings rather than
 * making one of them translate.
 */
export function themeCssVariables(tokens: ThemeTokens): Record<string, string> {
  const steps: Array<[string, string]> = [
    ['ink-950', tokens.ink950],
    ['ink-900', tokens.ink900],
    ['ink-850', tokens.ink850],
    ['ink-800', tokens.ink800],
    ['ink-700', tokens.ink700],
    ['ink-600', tokens.ink600],
    ['ink-500', tokens.ink500],
    ['ink-400', tokens.ink400],
    ['ink-300', tokens.ink300],
    ['ink-200', tokens.ink200],
    ['ink-100', tokens.ink100],
    ['blade-400', tokens.accent400],
    ['blade-500', tokens.accent500],
    ['blade-600', tokens.accent600],
    ['blade-700', tokens.accent700],
  ];

  const variables: Record<string, string> = {};
  for (const [name, value] of steps) {
    variables[`--color-${name}`] = value;
    variables[`--${name}`] = value;
  }
  variables['--violet'] = tokens.highlight;
  variables['--color-highlight'] = tokens.highlight;
  return variables;
}
