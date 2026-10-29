// A site's theme for its assistant app (LU-58): how Usher's cards look under the site's name. Data
// only, from closed lists and checked values: a display name, a logo (a PNG Usher captured from the
// site's own pages), two colours, one typeface from a short list, a corner radius, and which result
// fields the result card shows. Never CSS, never markup. What a card does (its structure, the
// "Usher is asking you, not the agent" mark, unticked consents, the site's wording word for word,
// the pause before submit, the "via Usher" mark) is not in a theme and cannot be.
//
// Contrast is checked here, not trusted: each colour is moved to the nearest one that passes on the
// card it sits on (WCAG 2 ratios), separately for light and dark.

/** The typefaces a theme may name. The stacks are the card's own; a theme names one by id. */
export const TYPEFACES = {
  system: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
  grotesque: '"Helvetica Neue", Helvetica, Arial, sans-serif',
  humanist: '"Segoe UI", "Gill Sans", "Trebuchet MS", Calibri, sans-serif',
  geometric: '"Avenir Next", Avenir, Montserrat, "Century Gothic", Futura, sans-serif',
  rounded: 'ui-rounded, "SF Pro Rounded", "Arial Rounded MT Bold", "Nunito", system-ui, sans-serif',
  serif: '"Iowan Old Style", Charter, "Palatino Linotype", Palatino, Georgia, serif',
} as const;
export type Typeface = keyof typeof TYPEFACES;
export const TYPEFACE_IDS = Object.keys(TYPEFACES) as Typeface[];

/** Corner radii a theme may choose, in CSS pixels. */
export const RADII = [0, 4, 8, 12, 16] as const;
export type Radius = (typeof RADII)[number];

/** Optional parts of the result card. The headline figure is always shown. */
export const RESULT_FIELDS = ['more_facts', 'thumbnail'] as const;
export type ResultField = (typeof RESULT_FIELDS)[number];

/** The largest logo a theme may carry: a PNG of at most this many bytes. */
export const LOGO_MAX_BYTES = 48 * 1024;

export interface SiteTheme {
  /** The site's name as the cards show it. Plain text. */
  name: string;
  /** A PNG captured from the site's own pages, as a data: URL; none for a name alone. */
  logo?: string;
  /** Buttons, the title's full stop, ticks and link underlines. */
  accent: string;
  /** The band at the top of each card that carries the name and logo. */
  second: string;
  typeface: Typeface;
  radius: Radius;
  result_fields: ResultField[];
}

/** The card bodies a theme's colours sit on (cards.ts --card, light and dark). */
export const CARD_SURFACE = { light: '#fffdf8', dark: '#1b1d3d' } as const;
/** Text colours the card may put on a theme's colours. */
const INK = { light: '#191942', dark: '#f1ede3', white: '#ffffff', black: '#12132c' } as const;

const HEX = /^#[0-9a-f]{6}$/;

export interface ThemeProblem {
  field: string;
  message: string;
}

/**
 * Checks a theme from anywhere (the owner's form, the model's choice, storage) and returns it in
 * its one allowed shape, or what is wrong. Unknown fields are dropped, not kept.
 */
export function validateTheme(input: unknown): { theme: SiteTheme } | { problems: ThemeProblem[] } {
  const problems: ThemeProblem[] = [];
  const t = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const name = typeof t.name === 'string' ? t.name.replace(/[\u0000-\u001f\u007f<>]/g, '').replace(/\s+/g, ' ').trim() : '';
  if (!name) problems.push({ field: 'name', message: 'A display name is needed.' });
  else if (name.length > 60) problems.push({ field: 'name', message: 'The display name is longer than 60 characters.' });
  const colour = (field: 'accent' | 'second') => {
    const v = typeof t[field] === 'string' ? (t[field] as string).trim().toLowerCase() : '';
    const full = /^#[0-9a-f]{3}$/.test(v) ? `#${v[1]}${v[1]}${v[2]}${v[2]}${v[3]}${v[3]}` : v;
    if (!HEX.test(full)) problems.push({ field, message: `${field === 'accent' ? 'The accent' : 'The second colour'} must be a colour like #0b6e6e.` });
    return full;
  };
  const accent = colour('accent');
  const second = colour('second');
  const typeface = t.typeface;
  if (typeof typeface !== 'string' || !(TYPEFACE_IDS as string[]).includes(typeface)) problems.push({ field: 'typeface', message: `The typeface is one of ${TYPEFACE_IDS.join(', ')}.` });
  const radius = typeof t.radius === 'string' ? Number(t.radius) : t.radius;
  if (!(RADII as readonly unknown[]).includes(radius)) problems.push({ field: 'radius', message: `The corner radius is one of ${RADII.join(', ')}.` });
  const fields = Array.isArray(t.result_fields) ? t.result_fields : [];
  if (fields.some((f) => !(RESULT_FIELDS as readonly unknown[]).includes(f))) problems.push({ field: 'result_fields', message: `Result fields are among ${RESULT_FIELDS.join(', ')}.` });
  let logo: string | undefined;
  if (t.logo !== undefined && t.logo !== null && t.logo !== '') {
    const problem = logoProblem(t.logo);
    if (problem) problems.push({ field: 'logo', message: problem });
    else logo = t.logo as string;
  }
  if (problems.length) return { problems };
  return {
    theme: {
      name,
      ...(logo && { logo }),
      accent,
      second,
      typeface: typeface as Typeface,
      radius: radius as Radius,
      result_fields: RESULT_FIELDS.filter((f) => (fields as unknown[]).includes(f)),
    },
  };
}

/** Why a logo isn't allowed, or null: a PNG data URL, small, and really a PNG. */
export function logoProblem(logo: unknown): string | null {
  if (typeof logo !== 'string') return 'The logo must be an image Usher took from your site.';
  const m = /^data:image\/png;base64,([A-Za-z0-9+/]+={0,2})$/.exec(logo);
  if (!m) return 'The logo must be a PNG Usher took from your site.';
  const bytes = Buffer.from(m[1]!, 'base64');
  if (bytes.length > LOGO_MAX_BYTES) return `The logo is larger than ${LOGO_MAX_BYTES / 1024} KB.`;
  if (bytes.length < 24 || bytes.readUInt32BE(0) !== 0x89504e47 || bytes.readUInt32BE(4) !== 0x0d0a1a0a) return 'The logo is not a PNG.';
  return null;
}

// --- Colour -----------------------------------------------------------------------------------

function rgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function hex(r: number, g: number, b: number): string {
  return `#${[r, g, b].map((v) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, '0')).join('')}`;
}

/** WCAG 2 relative luminance. */
export function luminance(colour: string): number {
  const [r, g, b] = rgb(colour).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG 2 contrast ratio, 1 to 21. */
export function contrast(a: string, b: string): number {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p) as [number, number];
  return (x + 0.05) / (y + 0.05);
}

function toHsl(colour: string): [number, number, number] {
  const [r, g, b] = rgb(colour).map((v) => v / 255) as [number, number, number];
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h / 6, s, l];
}
function fromHsl(h: number, s: number, l: number): string {
  if (s === 0) return hex(l * 255, l * 255, l * 255);
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const channel = (t: number) => {
    const u = t < 0 ? t + 1 : t > 1 ? t - 1 : t;
    return 255 * (u < 1 / 6 ? p + (q - p) * 6 * u : u < 1 / 2 ? q : u < 2 / 3 ? p + (q - p) * (2 / 3 - u) * 6 : p);
  };
  return hex(channel(h + 1 / 3), channel(h), channel(h - 1 / 3));
}

/**
 * The colour nearest `colour` (same hue and saturation, lightness moved as little as possible) for
 * which `passes` holds; the colour itself if it already does.
 */
export function nearestPassing(colour: string, passes: (c: string) => boolean): string {
  if (passes(colour)) return colour;
  const [h, s, l] = toHsl(colour);
  for (let step = 1; step <= 100; step++) {
    for (const dl of [-step / 100, step / 100]) {
      const nl = l + dl;
      if (nl < 0 || nl > 1) continue;
      const c = fromHsl(h, s, nl);
      if (passes(c)) return c;
    }
  }
  return passes(INK.black) ? INK.black : INK.white;
}

/** The text colour (of the card's own) with the most contrast on `background`. */
function inkOn(background: string, mode: 'light' | 'dark'): string {
  const options = mode === 'light' ? [INK.white, INK.light] : [INK.black, INK.dark];
  return options.sort((a, b) => contrast(b, background) - contrast(a, background))[0]!;
}

export interface ThemeTokens {
  /** Buttons, ticks, the title's full stop: at least 3:1 on the card, with text on it at 4.5:1. */
  accent: string;
  accent_ink: string;
  /** The band: its text at 4.5:1. */
  band: string;
  band_ink: string;
}

/** The colours a card uses for a theme in one mode, each moved until it passes. */
export function themeTokens(theme: Pick<SiteTheme, 'accent' | 'second'>, mode: 'light' | 'dark'): ThemeTokens {
  const surface = CARD_SURFACE[mode];
  const accent = nearestPassing(theme.accent, (c) => contrast(c, surface) >= 3 && contrast(c, inkOn(c, mode)) >= 4.5);
  const band = nearestPassing(theme.second, (c) => contrast(c, inkOn(c, mode)) >= 4.5);
  return { accent, accent_ink: inkOn(accent, mode), band, band_ink: inkOn(band, mode) };
}

/**
 * What a card receives in a tool result's structuredContent (as `theme`): the theme resolved to
 * tokens. The card checks every value again against the same closed lists before using it, so a
 * result that carries anything else changes nothing.
 */
export interface CardTheme {
  name: string;
  logo?: string;
  light: ThemeTokens;
  dark: ThemeTokens;
  typeface: Typeface;
  radius: Radius;
  result_fields: ResultField[];
}

export function cardTheme(theme: SiteTheme): CardTheme {
  return {
    name: theme.name,
    ...(theme.logo && { logo: theme.logo }),
    light: themeTokens(theme, 'light'),
    dark: themeTokens(theme, 'dark'),
    typeface: theme.typeface,
    radius: theme.radius,
    result_fields: theme.result_fields,
  };
}

/** The closest typeface on the list for a font family name a site uses. */
export function typefaceFor(family: string): Typeface {
  // The first family is the one the site asked for; the rest are fallbacks.
  const f = (family.split(',')[0] ?? '').trim().replace(/^["']|["']$/g, '').toLowerCase();
  if (/^(system-ui|-apple-system|blinkmacsystemfont|ui-sans-serif|sans-serif)$/.test(f)) return 'system';
  if (/rounded|nunito|quicksand|varela|comfortaa|baloo/.test(f)) return 'rounded';
  if (/avenir|montserrat|futura|century gothic|poppins|gotham|proxima|raleway|josefin|manrope|dm sans|outfit|urbanist/.test(f)) return 'geometric';
  if (/gill|segoe|trebuchet|calibri|open sans|source sans|lato|frutiger|myriad|noto sans|fira sans|pt sans/.test(f)) return 'humanist';
  if (/helvetica|arial|inter|roboto|neue|graphik|aktiv|univers|work sans|ibm plex sans/.test(f)) return 'grotesque';
  if (/serif|georgia|times|garamond|palatino|charter|merriweather|playfair|lora|baskerville|caslon|iowan/.test(f) && !/sans/.test(f)) return 'serif';
  return 'system';
}

/** The radius on the list closest to a site's own, in pixels. */
export function radiusFor(px: number): Radius {
  if (!Number.isFinite(px) || px >= 999) return 16;
  return RADII.reduce((best, r) => (Math.abs(r - px) < Math.abs(best - px) ? r : best), RADII[0]);
}
