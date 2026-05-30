/// <reference types="svelte" />
/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_IAGENT_TOKEN?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
