// Replaced by the Pages workflow with date/time and commit, e.g. "20.10.2026 21:15 · a1b2c3d".
export const VERSION = '__VERSION__';
export const versionText = () => (VERSION.startsWith('__') ? 'lokal/Entwicklung' : VERSION);
