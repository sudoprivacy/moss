/**
 * CSS Theme Injection - Injects custom CSS into document head
 */

const STYLE_ID = 'moss-custom-css';

/**
 * Apply CSS theme to the document
 */
export const applyCssTheme = (css: string | null): void => {
  const existing = document.getElementById(STYLE_ID);

  if (!css) {
    existing?.remove();
    return;
  }

  // Add !important to all properties to ensure they override existing styles
  const processedCss = css.replace(/([a-zA-Z-]+)\s*:\s*([^;!}]+)(;?)/g, (match, property, value, semicolon) => {
    const trimmedValue = value.trim();
    if (trimmedValue.endsWith('!important')) return match;
    return `${property}: ${trimmedValue} !important;`;
  });

  if (existing) {
    existing.textContent = processedCss;
  } else {
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = processedCss;
    document.head.appendChild(style);
  }
};

/**
 * Get stored CSS theme ID from localStorage
 */
export const getStoredThemeId = (): string | null => {
  try {
    return localStorage.getItem('ui.cssThemeId');
  } catch {
    return null;
  }
};

/**
 * Store CSS theme ID to localStorage
 */
export const setStoredThemeId = (themeId: string): void => {
  try {
    localStorage.setItem('ui.cssThemeId', themeId);
  } catch {
    // ignore
  }
};
