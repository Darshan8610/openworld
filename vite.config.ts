import { defineConfig } from 'vite';

export default defineConfig({
  // Relative asset URLs: required for the packaged desktop build (app:// scheme)
  // and harmless for the web preview.
  base: './',
  server: {
    host: '0.0.0.0',
    port: 5173,
    allowedHosts: true,
  },
  preview: { host: '0.0.0.0', allowedHosts: true },
  worker: { format: 'es' },
  build: {
    target: 'es2022',
    sourcemap: true,
    // Rapier ships its WASM inlined as base64 (~4.3 MB) and is deliberately
    // loaded as its own lazily-imported chunk, so the limit is raised for it.
    chunkSizeWarningLimit: 4600,
  },
});
