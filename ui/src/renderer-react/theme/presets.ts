/**
 * CSS Theme Presets - Simplified migration from sudowork
 */

export interface ICssTheme {
  id: string;
  name: string;
  css: string;
}

export const DEFAULT_THEME_ID = 'default';

/**
 * Default theme - no custom CSS
 */
export const DEFAULT_THEME: ICssTheme = {
  id: 'default',
  name: '默认',
  css: '',
};

/**
 * Grid Theme - Subtle grid background pattern
 */
export const GRID_THEME: ICssTheme = {
  id: 'grid-theme',
  name: '网格',
  css: `
/* Grid Theme */
html, body, .app-shell {
  background-color: var(--background);
}

.app-shell {
  background-image:
    linear-gradient(rgba(var(--foreground-rgb, 0, 0, 0), 0.05) 1px, transparent 1px),
    linear-gradient(90deg, rgba(var(--foreground-rgb, 0, 0, 0), 0.05) 1px, transparent 1px);
  background-size: 40px 40px;
  background-attachment: fixed;
}

[data-theme='dark'] .app-shell {
  background-image:
    linear-gradient(rgba(255, 255, 255, 0.05) 1px, transparent 1px),
    linear-gradient(90deg, rgba(255, 255, 255, 0.05) 1px, transparent 1px);
}
  `.trim(),
};

/**
 * Dot Theme - Subtle dot pattern
 */
export const DOT_THEME: ICssTheme = {
  id: 'dot-theme',
  name: '圆点',
  css: `
/* Dot Theme */
html, body, .app-shell {
  background-color: var(--background);
}

.app-shell {
  background-image: radial-gradient(rgba(var(--foreground-rgb, 0, 0, 0), 0.08) 1px, transparent 1px);
  background-size: 20px 20px;
  background-attachment: fixed;
}

[data-theme='dark'] .app-shell {
  background-image: radial-gradient(rgba(255, 255, 255, 0.06) 1px, transparent 1px);
}
  `.trim(),
};

/**
 * Gradient Theme - Subtle gradient background
 */
export const GRADIENT_THEME: ICssTheme = {
  id: 'gradient-theme',
  name: '渐变',
  css: `
/* Gradient Theme */
html, body, .app-shell {
  background: var(--background);
}

.app-shell {
  background: linear-gradient(135deg, var(--background) 0%, var(--secondary) 100%);
}

[data-theme='dark'] .app-shell {
  background: linear-gradient(135deg, var(--background) 0%, var(--secondary) 100%);
}
  `.trim(),
};

export const PRESET_THEMES: ICssTheme[] = [
  DEFAULT_THEME,
  GRID_THEME,
  DOT_THEME,
  GRADIENT_THEME,
];
