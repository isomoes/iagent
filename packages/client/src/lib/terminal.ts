// ============================================================================
// xterm.js wrapper (the renderer half of the data path).
//
// Wraps @xterm/xterm + FitAddon + WebglAddon (with a CanvasAddon fallback +
// onContextLoss handling, then xterm's DOM renderer as the last resort) +
// SerializeAddon + WebLinksAddon behind a small TerminalHandle so the rest of
// the client never touches xterm types directly.
//
// FLOW-CONTROL CONTRACT (see ARCH §Performance #2): write(bytes, onRendered)
// forwards the xterm write-callback — which fires once the bytes have actually
// been parsed/rendered — back to the caller, so WsClient can run the
// write-callback ACK loop (ACK cumulative *rendered* bytes, never *received*).
// DATA bytes are passed straight to term.write(Uint8Array): never decode at a
// frame boundary (multibyte UTF-8 may be split); xterm buffers partial
// codepoints internally.
//
// LAZY ATTACH (ARCH §Multi-session): dispose() tears the terminal down and frees
// the WebGL context — browsers cap WebGL contexts (~16/page), so only the
// focused tab may hold a live terminal.
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

    // WebGL renderer: ~9x faster frame rendering than canvas (GPU glyph atlas).
    // Must be loaded AFTER open(). If context creation throws, or is later
    // lost, fall back to the Canvas renderer (ARCH §Performance #1), and only
    // then to xterm's default DOM renderer — never crash.
    this.tryEnableWebgl();
    this.fit();
    this.watchGlyphAtlas();
  }

  /**
   * Guard against the WebGL/Canvas glyph-atlas "black block" bug. The GPU glyph
   * atlas is built on first paint; if the monospace font resolves a tick later
   * (font-stack fallback still settling) or the device-pixel-ratio changes
   * (monitor move / browser zoom), the cached bitmaps go stale and glyphs paint
   * as solid black rectangles. Rebuilding the atlas re-rasterizes them.
   */
  private watchGlyphAtlas(): void {
    if (typeof document !== 'undefined' && document.fonts?.ready) {
      document.fonts.ready.then(() => this.rebuildAtlas()).catch(() => {});
    }
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
