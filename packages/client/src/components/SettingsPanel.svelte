<script lang="ts">
  // ==========================================================================
  // SettingsPanel — a modal dialog for client-side preferences (persisted in the
  // browser via settingsStore; never sent to the server). Opened from the
  // sidebar gear; closed by the ✕, the backdrop, or Escape.
  //
  // First setting: the terminal font size. The control writes settingsStore
  // live, and the focused TerminalView re-fits + resizes its PTY reactively (see
  // TerminalView's nested font-size effect), so the preview is the real terminal.
  // ==========================================================================

  import {
    settingsStore,
    TERMINAL_FONT_SIZE_MIN,
    TERMINAL_FONT_SIZE_MAX,
    TERMINAL_FONT_SIZE_DEFAULT,
  } from '../lib/settings.svelte.js';

  interface Props {
    onClose: () => void;
  }
  const { onClose }: Props = $props();

  const fontSize = $derived(settingsStore.terminalFontSize);

  let dialogEl = $state<HTMLDivElement | null>(null);

  // Move focus into the dialog on open so Escape lands on its keydown handler
  // (the opener — the sidebar gear — would otherwise keep focus, outside the
  // backdrop's bubbling path) and keyboard users are placed in the modal.
  $effect(() => {
    dialogEl?.focus();
  });

  function setFont(px: number): void {
    settingsStore.setTerminalFontSize(px);
  }
</script>

<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
<div
  class="backdrop"
  onclick={onClose}
  onkeydown={(e) => {
    if (e.key === 'Escape') onClose();
  }}
>
  <!-- Stop clicks inside the dialog from bubbling to the backdrop's close. -->
  <div
    class="dialog"
    role="dialog"
    aria-modal="true"
    aria-label="Settings"
    tabindex="-1"
    bind:this={dialogEl}
    onclick={(e) => e.stopPropagation()}
  >
    <header class="dialog__header">
      <h2>Settings</h2>
      <button class="close" aria-label="Close settings" onclick={onClose}>✕</button>
    </header>

    <div class="dialog__body">
      <section class="setting">
        <div class="setting__label">
          <label for="font-size">Terminal font size</label>
          <span class="value">{fontSize}px</span>
        </div>
        <div class="setting__control">
          <button
            class="step"
            aria-label="Decrease font size"
            disabled={fontSize <= TERMINAL_FONT_SIZE_MIN}
            onclick={() => setFont(fontSize - 1)}
          >−</button>
          <input
            id="font-size"
            type="range"
            min={TERMINAL_FONT_SIZE_MIN}
            max={TERMINAL_FONT_SIZE_MAX}
            step="1"
            value={fontSize}
            oninput={(e) => setFont(e.currentTarget.valueAsNumber)}
          />
          <button
            class="step"
            aria-label="Increase font size"
            disabled={fontSize >= TERMINAL_FONT_SIZE_MAX}
            onclick={() => setFont(fontSize + 1)}
          >+</button>
        </div>
        <p class="setting__hint">
          Applies to every session terminal.
          {#if fontSize !== TERMINAL_FONT_SIZE_DEFAULT}
            <button class="reset" onclick={() => setFont(TERMINAL_FONT_SIZE_DEFAULT)}>
              Reset to {TERMINAL_FONT_SIZE_DEFAULT}px
            </button>
          {/if}
        </p>
      </section>
    </div>
  </div>
</div>

<style>
  .backdrop {
    position: fixed;
    inset: 0;
    z-index: 100;
    display: flex;
    align-items: center;
    justify-content: center;
    background: rgba(5, 7, 11, 0.6);
  }
  .dialog {
    width: min(420px, calc(100vw - 32px));
    background: #0e1219;
    border: 1px solid #1c2230;
    border-radius: 8px;
    box-shadow: 0 12px 40px rgba(0, 0, 0, 0.5);
    color: #bfbdb6;
  }
  .dialog:focus {
    outline: none;
  }
  .dialog__header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 12px 14px;
    border-bottom: 1px solid #1c2230;
  }
  .dialog__header h2 {
    margin: 0;
    font: 600 13px ui-monospace, monospace;
    letter-spacing: 0.04em;
    color: #e6b450;
  }
  .close {
    border: none;
    background: transparent;
    color: #5c6773;
    cursor: pointer;
    font-size: 14px;
    line-height: 1;
    padding: 2px 4px;
  }
  .close:hover {
    color: #bfbdb6;
  }
  .dialog__body {
    padding: 14px;
  }
  .setting {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .setting__label {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    font: 12px ui-monospace, monospace;
  }
  .setting__label .value {
    color: #e6b450;
    font-weight: 600;
  }
  .setting__control {
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .setting__control input[type='range'] {
    flex: 1 1 auto;
    accent-color: #e6b450;
    cursor: pointer;
  }
  .step {
    flex: 0 0 auto;
    width: 26px;
    height: 26px;
    border: 1px solid #1c2230;
    border-radius: 4px;
    background: #0b0e14;
    color: #bfbdb6;
    cursor: pointer;
    font-size: 15px;
    line-height: 1;
  }
  .step:hover:not(:disabled) {
    border-color: #2a3340;
  }
  .step:disabled {
    opacity: 0.4;
    cursor: default;
  }
  .setting__hint {
    margin: 0;
    font: 11px ui-monospace, monospace;
    color: #5c6773;
    line-height: 1.5;
  }
  .reset {
    border: none;
    background: transparent;
    color: #8a93a3;
    cursor: pointer;
    font: 11px ui-monospace, monospace;
    padding: 0 0 0 4px;
    text-decoration: underline;
  }
  .reset:hover {
    color: #e6b450;
  }
</style>
