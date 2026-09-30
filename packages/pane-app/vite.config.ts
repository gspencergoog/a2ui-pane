import { defineConfig } from 'vite';
import { a2uiDevPlugin } from './src/dev-server.js';

export default defineConfig({
  base: './',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  server: {
    port: 5173,
  },
  plugins: [a2uiDevPlugin()],
});
