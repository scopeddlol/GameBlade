/**
 * Themes for the web app and the desktop client.
 *
 * A theme is a complete set of surface steps plus an accent, not a single hue:
 * lightening only the accent on a near-black chrome produces something that
 * reads as broken rather than as light. Both clients consume the same tokens,
 * so a server's look is one setting rather than two that drift.
 */

export const THEME_PRESETS = [
  'midnight',
  'slate',
  'carbon',
  'nebula',
  'aurora',
  'ember',
  'moss',
  'oceanic',
  'daylight',
  'parchment',
] as const;
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
  /**
   * Muted text, not a stroke.
   *
   * Every value on this row is chosen to clear 4.5:1 against the *lightest*
   * surface in its own theme — cards sit a step above the page, so text that
   * passes on the page can still fail on a card. The ramp used to be picked by
   * eye and every theme failed, between 2.93:1 and 4.55:1.
   */
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
      ink400: '#7b8497',
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
      ink400: '#81909f',
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
      ink400: '#868686',
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
      ink400: '#8b7db1',
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
  aurora: {
    id: 'aurora',
    label: 'Aurora',
    description: 'Cold blue-green with a mint accent. Reads as night rather than as black.',
    tokens: {
      ink950: '#04100f',
      ink900: '#071815',
      ink850: '#0b201d',
      ink800: '#102a26',
      ink700: '#173832',
      ink600: '#204a43',
      ink500: '#2e6259',
      ink400: '#62988b',
      ink300: '#7fb0a3',
      ink200: '#b4d6cc',
      ink100: '#e3f2ed',
      accent400: '#5eead4',
      accent500: '#22c9ab',
      accent600: '#0f9e85',
      accent700: '#0a7864',
      highlight: '#4f9cf9',
      scheme: 'dark',
    },
  },
  ember: {
    id: 'ember',
    label: 'Ember',
    description: 'Warm charcoal with a burnt-orange accent. Low glare in a dark room.',
    tokens: {
      ink950: '#0f0a08',
      ink900: '#16100c',
      ink850: '#1d1611',
      ink800: '#251c16',
      ink700: '#33261e',
      ink600: '#45342a',
      ink500: '#5d483b',
      ink400: '#9b8174',
      ink300: '#ab9285',
      ink200: '#d3c1b7',
      ink100: '#f2e9e3',
      accent400: '#ff9153',
      accent500: '#f2621f',
      accent600: '#c44711',
      accent700: '#96350c',
      highlight: '#e0b341',
      scheme: 'dark',
    },
  },
  moss: {
    id: 'moss',
    label: 'Moss',
    description: 'Deep green-grey with a lime accent. Quiet behind busy cover art.',
    tokens: {
      ink950: '#080c07',
      ink900: '#0d130b',
      ink850: '#121a0f',
      ink800: '#182114',
      ink700: '#222d1c',
      ink600: '#2f3d27',
      ink500: '#415235',
      ink400: '#7a8d6b',
      ink300: '#8ea07e',
      ink200: '#bfcbb2',
      ink100: '#e9efe2',
      accent400: '#a3e635',
      accent500: '#7cc518',
      accent600: '#5c9a0c',
      accent700: '#437408',
      highlight: '#38bdf8',
      scheme: 'dark',
    },
  },
  oceanic: {
    id: 'oceanic',
    label: 'Oceanic',
    description: 'Deep navy with a coral accent. The warmest of the blue themes.',
    tokens: {
      ink950: '#050b16',
      ink900: '#08111f',
      ink850: '#0c1728',
      ink800: '#111e33',
      ink700: '#182a45',
      ink600: '#22385a',
      ink500: '#2f4c78',
      ink400: '#6a88b4',
      ink300: '#7f9bc4',
      ink200: '#b6c9e2',
      ink100: '#e5edf7',
      accent400: '#ff8f7a',
      accent500: '#f9694f',
      accent600: '#d24630',
      accent700: '#a13320',
      highlight: '#38bdf8',
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
      ink400: '#626c7d',
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
  parchment: {
    id: 'parchment',
    label: 'Parchment',
    description: 'A warm light theme. Paper-toned surfaces with a deep teal accent.',
    tokens: {
      // Inverted the same way Daylight is: ink950 is the palest surface and
      // ink100 the text, so every consumer keeps using the same names.
      ink950: '#efe8dc',
      ink900: '#f8f3ea',
      ink850: '#fffcf6',
      ink800: '#f0e9dd',
      ink700: '#e2d8c7',
      ink600: '#cbbea9',
      ink500: '#a2947e',
      ink400: '#726653',
      ink300: '#554b3b',
      ink200: '#332c22',
      ink100: '#171310',
      accent400: '#12867c',
      accent500: '#0d6b62',
      accent600: '#08514a',
      accent700: '#053a35',
      highlight: '#b4531f',
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
