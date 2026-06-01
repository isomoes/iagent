// ============================================================================
// Settings store — Svelte 5 runes module ($state), persisted in localStorage.
//
// Client-only UI preferences that survive reloads but never touch the server:
//   • terminalFontSize — xterm font size (px) applied to every session terminal
//   • sidebarCollapsed — whether the session-list sidebar is folded to a rail
//
// Mirrors workspaces.svelte.ts: a plain module singleton (no component effect
// scope), so persistence is an explicit #save() written eagerly on every
// mutation under a single versioned key.
// ============================================================================

const STORAGE_KEY = 'iagent.settings.v1';

/** Terminal font-size bounds + default (default mirrors TERMINAL_OPTIONS). */
export const TERMINAL_FONT_SIZE_MIN = 8;
export const TERMINAL_FONT_SIZE_MAX = 32;
export const TERMINAL_FONT_SIZE_DEFAULT = 13;

interface Persisted {
  terminalFontSize: number;
  sidebarCollapsed: boolean;
}

function storage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null; // access can throw (privacy modes); degrade to in-memory.
  }
}

/** Clamp + round a font size to a whole, in-range px value. */
function clampFontSize(px: number): number {
  if (!Number.isFinite(px)) return TERMINAL_FONT_SIZE_DEFAULT;
  return Math.min(TERMINAL_FONT_SIZE_MAX, Math.max(TERMINAL_FONT_SIZE_MIN, Math.round(px)));
}

function load(): Persisted {
  const empty: Persisted = {
    terminalFontSize: TERMINAL_FONT_SIZE_DEFAULT,
    sidebarCollapsed: false,
  };
  const ls = storage();
  if (!ls) return empty;
  try {
    const raw = ls.getItem(STORAGE_KEY);
    if (!raw) return empty;
    const parsed = JSON.parse(raw) as Partial<Persisted>;
    return {
      terminalFontSize:
        typeof parsed.terminalFontSize === 'number'
          ? clampFontSize(parsed.terminalFontSize)
          : TERMINAL_FONT_SIZE_DEFAULT,
      sidebarCollapsed: parsed.sidebarCollapsed === true,
    };
  } catch {
    return empty;
  }
}

class SettingsStore {
  terminalFontSize = $state(TERMINAL_FONT_SIZE_DEFAULT);
  sidebarCollapsed = $state(false);

  constructor() {
    const p = load();
    this.terminalFontSize = p.terminalFontSize;
    this.sidebarCollapsed = p.sidebarCollapsed;
  }

  #save(): void {
    const ls = storage();
    if (!ls) return;
    const data: Persisted = {
      terminalFontSize: this.terminalFontSize,
      sidebarCollapsed: this.sidebarCollapsed,
    };
    try {
      ls.setItem(STORAGE_KEY, JSON.stringify(data));
    } catch {
      // quota / disabled storage: keep running with the in-memory copy.
    }
  }

  /** Set the terminal font size (clamped to the supported range). */
  setTerminalFontSize(px: number): void {
    const next = clampFontSize(px);
    if (next === this.terminalFontSize) return;
    this.terminalFontSize = next;
    this.#save();
  }

  setSidebarCollapsed(collapsed: boolean): void {
    if (collapsed === this.sidebarCollapsed) return;
    this.sidebarCollapsed = collapsed;
    this.#save();
  }

  toggleSidebar(): void {
    this.setSidebarCollapsed(!this.sidebarCollapsed);
  }
}

/** Singleton settings store shared across the component tree. */
export const settingsStore = new SettingsStore();
