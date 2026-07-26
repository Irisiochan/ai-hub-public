import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const webVersion =
  process.env.AI_HUB_WEB_VERSION
  ?? process.env.GITHUB_SHA?.slice(0, 12)
  ?? 'dev';

export default defineConfig({
  plugins: [react()],
  define: { __AI_HUB_WEB_VERSION__: JSON.stringify(webVersion) },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: process.env.HUB_API ?? 'http://127.0.0.1:3900',
        changeOrigin: true,
      },
    },
  },
});
