import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';

// @iagent/shared is consumed as raw TS (no build step). The Svelte/esbuild pipeline
// transpiles it; we just make sure Vite pre-bundling doesn't try to externalize it.
export default defineConfig({
  plugins: [svelte()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:4517',
        changeOrigin: true,
      },
      '/ws': {
        target: 'ws://127.0.0.1:4517',
        ws: true,
        changeOrigin: true,
      },
    },
  },
  optimizeDeps: {
    // Workspace raw-TS dep: let Vite transpile it in-tree rather than pre-bundle it.
    exclude: ['@iagent/shared'],
  },
});
