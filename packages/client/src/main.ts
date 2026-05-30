// ============================================================================
// Client entry — mount the Svelte 5 App into #app (runes mode, mount() API;
// NOT the legacy `new App({ target })` constructor).
// ============================================================================

import { mount } from 'svelte';
import App from './App.svelte';
import './app.css';

const target = document.getElementById('app');
if (!target) {
  throw new Error('#app mount target not found in index.html');
}

const app = mount(App, { target });

export default app;
