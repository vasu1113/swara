import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { crx } from '@crxjs/vite-plugin';
import manifest from './manifest.config';

export default defineConfig({
  plugins: [react(), crx({ manifest })],
  build: {
    // The worklet is fetched by AudioWorklet.addModule at runtime. Keeping it
    // external (rather than a data URL) gives Chrome a real module URL and a
    // useful load failure when an extension build is misconfigured.
    assetsInlineLimit: 0,
    rollupOptions: {
      output: {
        assetFileNames: (asset) =>
          asset.name?.endsWith('.ts') ? 'assets/[name]-[hash].js' : 'assets/[name]-[hash][extname]',
      },
    },
  },
});
