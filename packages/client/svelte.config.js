import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

export default {
  // Svelte 5; vitePreprocess handles <script lang="ts"> via the Vite/esbuild TS pipeline.
  preprocess: vitePreprocess(),
};
