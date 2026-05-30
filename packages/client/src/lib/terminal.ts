// ============================================================================
// xterm.js wrapper (the renderer half of the data path).
//
// Wraps @xterm/xterm + FitAddon + SerializeAddon + WebLinksAddon behind a small
// TerminalHandle so the rest of the client never touches xterm types directly.
// RENDERER: xterm's DOM renderer is the DEFAULT — it draws real <span> text, so
// it is immune to the canvas-readback poisoning (privacy extensions, Brave
// farbling, Chrome fingerprint-defense flags) that paints WebGL/Canvas glyphs as
// solid black blocks, and is fast enough for passthrough TUI. WebGL (with a
// CanvasAddon fallback + onContextLoss handling) is opt-in via `?renderer=webgl`
// or `?renderer=auto` — see resolveRendererMode() / mount().
//
// FLOW-CONTROL CONTRACT (see ARCH §Performance #2): write(bytes, onRendered)
// forwards the xterm write-callback — which fires once the bytes have actually
// been parsed/rendered — back to the caller, so WsClient can run the
// write-callback ACK loop (ACK cumulative *rendered* bytes, never *received*).
// DATA bytes are passed straight to term.write(Uint8Array): never decode at a
// frame boundary (multibyte UTF-8 may be split); xterm buffers partial
// codepoints internally.
//
// LAZY ATTACH (ARCH §Multi-session): dispose() tears the terminal down, freeing
// its WebSocket and — when WebGL is opted into — the GL context (browsers cap
// WebGL contexts ~16/page), so only the focused tab may hold a live terminal.
// ============================================================================

import { Terminal, type ITerminalOptions } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import { CanvasAddon } from '@xterm/addon-canvas';
import { SerializeAddon } from '@xterm/addon-serialize';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';

export interface TerminalDimensions {
  cols: number;
  rows: number;
}

export interface TerminalHandle {
  /** Open xterm into `el`, load addons (WebGL w/ canvas fallback). */
  mount(el: HTMLElement): void;
  /**
   * Write opaque PTY bytes. `onRendered` fires once xterm has rendered them,
   * feeding the WsClient ACK loop. Bytes are NEVER decoded here.
   */
  write(bytes: Uint8Array, onRendered?: () => void): void;
  /** Write a serialized snapshot string (safe-to-decode escape sequences). */
  writeSnapshot(data: string): void;
  /** Fit to the container and return the applied dimensions. */
  fit(): TerminalDimensions;
  /** Compute the dimensions that would fit the container without applying. */
  proposeDimensions(): TerminalDimensions | undefined;
  /** Force a specific size (e.g. the PTY's authoritative size on attach). */
  applySize(cols: number, rows: number): void;
  /** Current terminal grid size. */
  size(): TerminalDimensions;
  /** Keystroke source: xterm `onData` (string) -> UTF-8 bytes. */
  onInput(cb: (bytes: Uint8Array) => void): void;
  /** Grid resize source (raw; caller debounces before sending to server). */
  onResize(cb: (cols: number, rows: number) => void): void;
  /** Serialize current screen+scrollback (for client-side snapshotting). */
  serialize(): string;
  /** Move focus into the terminal. */
  focus(): void;
  /** Tear down: dispose addons + terminal, freeing the WebGL context. */
  dispose(): void;
}

const utf8Encoder = new TextEncoder();

// Glyph-atlas self-heal cadence (see watchGlyphAtlas). After PTY output settles
// we re-rasterize the atlas to repair any glyphs the WebGL/Canvas renderer
// uploaded as black blocks. Debounced so a burst of streaming output triggers
// at most one rebuild on its trailing edge; the max-wait bounds the worst case
// so a long *continuous* stream still heals mid-flight rather than only at EOF.
const ATLAS_REFRESH_DEBOUNCE_MS = 300;
const ATLAS_REFRESH_MAX_WAIT_MS = 1200;

/** Renderer tiers a user (or auto-detection) can pin via `?renderer=`. */
type RendererMode = 'auto' | 'webgl' | 'canvas' | 'dom';
const RENDERER_MODES: readonly string[] = ['auto', 'webgl', 'canvas', 'dom'];
const RENDERER_STORAGE_KEY = 'iagent.renderer';

/** Default renderer when nothing is pinned — see resolveRendererMode. */
const DEFAULT_RENDERER_MODE: RendererMode = 'dom';

/**
 * Resolve the renderer mode. Priority: `?renderer=` query param (persisted for
 * the origin) > a previously-persisted choice > the default ('dom').
 *
 * The DOM renderer is the default on purpose: it renders real <span> text, so
 * it is immune to the canvas-readback poisoning (privacy extensions, Brave
 * farbling, Chrome fingerprint-defense flags) that paints WebGL/Canvas glyphs as
 * black blocks — and for this passthrough-TUI workload its throughput is on par
 * in practice. Opt into GPU rendering with `?renderer=webgl`, or `?renderer=
 * auto` to probe for canvas tampering and take WebGL only when the canvas is
 * clean; the choice persists for the origin.
 */
function resolveRendererMode(): RendererMode {
  try {
    const q = new URLSearchParams(window.location.search).get('renderer');
    if (q && RENDERER_MODES.includes(q)) {
      try {
        window.localStorage.setItem(RENDERER_STORAGE_KEY, q);
      } catch {
        /* storage blocked (private mode) — honor it for this load anyway */
      }
      return q as RendererMode;
    }
    const stored = window.localStorage.getItem(RENDERER_STORAGE_KEY);
    if (stored && RENDERER_MODES.includes(stored)) return stored as RendererMode;
  } catch {
    /* no window/localStorage — fall through to the default */
  }
  return DEFAULT_RENDERER_MODE;
}

/**
 * Probe whether 2D-canvas pixel readback is being tampered with — the signature
 * of privacy / anti-fingerprint tooling (Canvas Blocker-class extensions, Brave
 * farbling, Chrome fingerprint-defense flags). They perturb or blank
 * `getImageData` to defeat fingerprinting, which also corrupts xterm's
 * WebGL/Canvas glyph atlas into all-black cells. We draw a solid opaque fill and
 * require it to read back EXACTLY, twice: any deviation (noise or blanking) or
 * per-call non-determinism means the canvas renderers will produce black blocks,
 * so the caller should use the DOM renderer instead. Source-agnostic by design —
 * it tests the symptom, not which tool caused it.
 */
function canvasReadbackTampered(): boolean {
  try {
    if (typeof document === 'undefined') return false;
    const c = document.createElement('canvas');
    c.width = 20;
    c.height = 8;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    if (!ctx) return false; // no 2D canvas at all: let xterm fall back on its own
    const r = 123;
    const g = 77;
    const b = 200;
    ctx.fillStyle = `rgb(${r}, ${g}, ${b})`;
    ctx.fillRect(0, 0, c.width, c.height);
    const first = ctx.getImageData(0, 0, c.width, c.height).data;
    const second = ctx.getImageData(0, 0, c.width, c.height).data;
    for (let i = 0; i < first.length; i += 4) {
      // Exact-value check: a solid opaque fill reads back exactly on an
      // untampered 2D canvas; perturbation or blanking shows here.
      if (first[i] !== r || first[i + 1] !== g || first[i + 2] !== b || first[i + 3] !== 255) {
        return true;
      }
      // Determinism check: two reads of the same pixels must be identical;
      // per-call randomizers (some farbling modes) trip this instead.
      if (
        first[i] !== second[i] ||
        first[i + 1] !== second[i + 1] ||
        first[i + 2] !== second[i + 2] ||
        first[i + 3] !== second[i + 3]
      ) {
        return true;
      }
    }
    return false;
  } catch {
    return true; // canvas creation/read blocked outright: avoid canvas renderers
  }
}

const TERMINAL_OPTIONS: ITerminalOptions = {
  // Pure-passthrough renderer (ARCH roadmap stage 1): the agent's TUI is our UI.
  allowProposedApi: true,
  cursorBlink: true,
  scrollback: 5000,
  fontFamily:
    'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace',
  fontSize: 13,
  // convertEol stays OFF: the PTY already emits CRLF; we are a faithful sink.
  theme: {
    background: '#0b0e14',
    foreground: '#bfbdb6',
    cursor: '#e6b450',
  },
};

class XtermTerminal implements TerminalHandle {
  private term: Terminal | null = null;
  private fitAddon: FitAddon | null = null;
  private webgl: WebglAddon | null = null;
  private canvas: CanvasAddon | null = null;
  private serializeAddon: SerializeAddon | null = null;
  private disposed = false;
  /** Teardown callbacks for listeners registered in mount() (dpr watch, etc). */
  private cleanups: Array<() => void> = [];
  /** Pending debounced atlas-refresh timer + its hard deadline (epoch ms). */
  private atlasRefreshTimer: ReturnType<typeof setTimeout> | null = null;
  private atlasRefreshDeadline = 0;

  mount(el: HTMLElement): void {
    if (this.term) throw new Error('TerminalHandle.mount: already mounted');

    const term = new Terminal(TERMINAL_OPTIONS);
    const fitAddon = new FitAddon();
    const serializeAddon = new SerializeAddon();

    term.loadAddon(fitAddon);
    term.loadAddon(serializeAddon);
    term.loadAddon(new WebLinksAddon());
    term.open(el);

    this.term = term;
    this.fitAddon = fitAddon;
    this.serializeAddon = serializeAddon;

    // Renderer selection. The DOM renderer is the DEFAULT (see
    // resolveRendererMode): real <span> text that no canvas-poisoning tool can
    // turn into black blocks, and fast enough for passthrough TUI. WebGL/Canvas
    // stay opt-in via `?renderer=` for GPU frame-rendering (ARCH §Performance
    // #1); both rasterize glyphs through a 2D-canvas atlas, so `?renderer=auto`
    // probes for canvas tampering (privacy extension, Brave farbling, Chrome
    // fingerprint-defense flag) and takes WebGL only when the canvas is clean.
    // The WebGL/Canvas addons must load AFTER open().
    const mode = resolveRendererMode();
    if (mode === 'webgl') {
      this.tryEnableWebgl();
    } else if (mode === 'canvas') {
      this.tryEnableCanvas();
    } else if (mode === 'dom') {
      // Load no GPU/canvas addon: xterm's built-in DOM renderer stays active.
    } else if (canvasReadbackTampered()) {
      console.warn(
        '[iagent] canvas readback is being tampered with (privacy extension, ' +
          'Brave farbling, or a Chrome fingerprint-defense flag) — using the ' +
          'DOM renderer so glyphs do not paint as black blocks. Override with ' +
          '?renderer=webgl if this is a false positive.',
      );
    } else {
      this.tryEnableWebgl();
    }
    this.fit();
    this.watchGlyphAtlas();
  }

  /**
   * Guard against the WebGL/Canvas glyph-atlas "black block" bug. The GPU glyph
   * atlas is built lazily — each glyph is rasterized into a shared GPU texture
   * the first time it appears. On some driver stacks (notably AMD + ANGLE at
   * HiDPI) a glyph upload intermittently lands as a solid black rectangle and
   * stays black until the atlas is re-rasterized. Three triggers cover the cases:
   *
   *   1. font settle  — `document.fonts.ready`: the monospace font may resolve a
   *      tick after first paint (font-stack fallback still settling).
   *   2. DPR change   — monitor move / browser zoom restyles every cell.
   *   3. live output  — `onWriteParsed`: NEW glyphs are rasterized as the agent
   *      streams output mid-session, so corruption recurs long after boot. We
   *      re-clear on a trailing debounce once the output settles (a one-shot
   *      boot clear is not enough — that was the gap behind the "black blocks
   *      only after dynamic updates, gone on hard refresh" report).
   *
   * Rebuilding the atlas just drops the cached bitmaps; the next render
   * re-rasterizes them from the font, repairing any black blocks.
   */
  private watchGlyphAtlas(): void {
    if (typeof document !== 'undefined' && document.fonts?.ready) {
      document.fonts.ready.then(() => this.rebuildAtlas()).catch(() => {});
    }
    // Re-rasterize after live PTY output settles. onWriteParsed fires only on
    // real incoming data — NOT on the re-render that clearTextureAtlas itself
    // triggers — so this cannot feed back into an endless clear loop.
    const writeSub = this.term?.onWriteParsed(() => this.scheduleAtlasRefresh());
    if (writeSub) this.cleanups.push(() => writeSub.dispose());
    if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
      let lastDpr = window.devicePixelRatio;
      const onResize = (): void => {
        if (window.devicePixelRatio !== lastDpr) {
          lastDpr = window.devicePixelRatio;
          this.rebuildAtlas();
        }
      };
      window.addEventListener('resize', onResize);
      this.cleanups.push(() => window.removeEventListener('resize', onResize));
    }
  }

  /**
   * Debounce an atlas rebuild onto the trailing edge of a burst of PTY output,
   * with a hard max-wait so a long continuous stream still heals mid-flight.
   */
  private scheduleAtlasRefresh(): void {
    if (this.disposed) return;
    const now = Date.now();
    if (this.atlasRefreshTimer == null) {
      this.atlasRefreshDeadline = now + ATLAS_REFRESH_MAX_WAIT_MS;
    } else {
      clearTimeout(this.atlasRefreshTimer);
    }
    const wait = Math.min(ATLAS_REFRESH_DEBOUNCE_MS, Math.max(0, this.atlasRefreshDeadline - now));
    this.atlasRefreshTimer = setTimeout(() => {
      this.atlasRefreshTimer = null;
      this.rebuildAtlas();
    }, wait);
  }

  /** Drop the cached glyph bitmaps so the active renderer re-rasterizes them. */
  private rebuildAtlas(): void {
    if (this.disposed) return;
    try {
      this.webgl?.clearTextureAtlas();
    } catch {
      /* renderer gone */
    }
    try {
      this.canvas?.clearTextureAtlas();
    } catch {
      /* renderer gone */
    }
  }

  private tryEnableWebgl(): void {
    const term = this.term;
    if (!term) return;
    try {
      const webgl = new WebglAddon();
      // onContextLoss: browser dropped the GL context (tab backgrounded, GPU
      // reset, too many contexts). Dispose the addon and fall back to the
      // Canvas renderer (materially faster than the DOM renderer for heavy TUI
      // output — exactly this lost-context path). We do NOT try to recreate
      // WebGL here; on re-focus the lazy-attach path rebuilds the terminal.
      webgl.onContextLoss(() => {
        try {
          webgl.dispose();
        } catch {
          /* already gone */
        }
        if (this.webgl === webgl) this.webgl = null;
        this.tryEnableCanvas();
      });
      term.loadAddon(webgl);
      this.webgl = webgl;
    } catch {
      // WebGL unavailable (no GPU, blocked, context cap hit): the Canvas
      // renderer is the ARCH-specified fallback tier before the DOM renderer.
      this.webgl = null;
      this.tryEnableCanvas();
    }
  }

  /** Canvas-renderer fallback tier (ARCH §Performance #1) below WebGL. */
  private tryEnableCanvas(): void {
    const term = this.term;
    if (!term || this.canvas) return;
    try {
      const canvas = new CanvasAddon();
      term.loadAddon(canvas);
      this.canvas = canvas;
    } catch {
      // Canvas also unavailable: xterm falls back to its DOM renderer. Slower,
      // but correct — never crash.
      this.canvas = null;
    }
  }

  write(bytes: Uint8Array, onRendered?: () => void): void {
    // Opaque bytes straight into xterm; render-callback drives the ACK loop.
    this.term?.write(bytes, onRendered);
  }

  writeSnapshot(data: string): void {
    // Snapshot is a complete escape-sequence string — safe to write as text.
    this.term?.write(data);
  }

  fit(): TerminalDimensions {
    this.fitAddon?.fit();
    return this.size();
  }

  proposeDimensions(): TerminalDimensions | undefined {
    const dims = this.fitAddon?.proposeDimensions();
    if (!dims) return undefined;
    return { cols: dims.cols, rows: dims.rows };
  }

  applySize(cols: number, rows: number): void {
    if (cols > 0 && rows > 0) this.term?.resize(cols, rows);
  }

  size(): TerminalDimensions {
    const term = this.term;
    return { cols: term?.cols ?? 0, rows: term?.rows ?? 0 };
  }

  onInput(cb: (bytes: Uint8Array) => void): void {
    // xterm gives us a string per keystroke/paste; encode to UTF-8 bytes and
    // hand the raw bytes to the wire (server writes them to pty stdin).
    // NOTE (DEFERRED): local-echo / typeahead would render the keystroke in
    // dimmed text here before the server round-trip and reconcile against real
    // output (Mosh-style). Not implemented — pure passthrough for now.
    this.term?.onData((data) => cb(utf8Encoder.encode(data)));
  }

  onResize(cb: (cols: number, rows: number) => void): void {
    this.term?.onResize(({ cols, rows }) => cb(cols, rows));
  }

  serialize(): string {
    return this.serializeAddon?.serialize() ?? '';
  }

  focus(): void {
    this.term?.focus();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.atlasRefreshTimer != null) {
      clearTimeout(this.atlasRefreshTimer);
      this.atlasRefreshTimer = null;
    }
    for (const off of this.cleanups) {
      try {
        off();
      } catch {
        /* ignore */
      }
    }
    this.cleanups = [];
    // Dispose WebGL first to release the GL context promptly, then the term.
    try {
      this.webgl?.dispose();
    } catch {
      /* ignore */
    }
    this.webgl = null;
    try {
      this.canvas?.dispose();
    } catch {
      /* ignore */
    }
    this.canvas = null;
    try {
      this.term?.dispose();
    } catch {
      /* ignore */
    }
    this.term = null;
    this.fitAddon = null;
    this.serializeAddon = null;
  }
}

/** Create a fresh terminal wrapper. Call mount(el) to open it. */
export function createTerminal(): TerminalHandle {
  return new XtermTerminal();
}

// Mirrors the .terminal-host padding (see TerminalView.svelte) so the offscreen
// probe subtracts the same insets the live terminal will, keeping the measured
// grid in step with the eventual fit.
const HOST_PADDING_CSS = '6px 8px';

/**
 * Measure how many cols/rows a terminal area of `widthPx`×`heightPx` (the
 * border-box the live `.terminal-host` will occupy) would fit, using xterm's
 * OWN metrics so the result matches the real fit. Mounts a throwaway,
 * offscreen Terminal + FitAddon (no WebGL — pure measurement), reads
 * proposeDimensions(), and tears it down.
 *
 * Used to spawn the server PTY at the real viewport size from the start, rather
 * than booting the agent at the 80×24 server default and resizing after attach
 * (which makes the agent's first paint tiny). Returns null if it can't measure;
 * callers should fall back to the server default.
 */
export function measureGrid(widthPx: number, heightPx: number): TerminalDimensions | null {
  if (typeof document === 'undefined') return null;
  if (!(widthPx > 0) || !(heightPx > 0)) return null;

  const host = document.createElement('div');
  host.style.cssText =
    `position:fixed;left:-99999px;top:0;box-sizing:border-box;visibility:hidden;` +
    `width:${Math.floor(widthPx)}px;height:${Math.floor(heightPx)}px;padding:${HOST_PADDING_CSS};`;
  document.body.appendChild(host);

  const term = new Terminal(TERMINAL_OPTIONS);
  const fit = new FitAddon();
  term.loadAddon(fit);
  let dims: TerminalDimensions | null = null;
  try {
    term.open(host);
    const proposed = fit.proposeDimensions();
    if (proposed && proposed.cols > 0 && proposed.rows > 0) {
      dims = { cols: proposed.cols, rows: proposed.rows };
    }
  } catch {
    dims = null;
  } finally {
    try {
      term.dispose();
    } catch {
      /* ignore */
    }
    host.remove();
  }
  return dims;
}
