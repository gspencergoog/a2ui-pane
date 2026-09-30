import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    lib: {
      entry: 'src/embed-main.ts',
      name: 'A2uiEmbed',
      formats: ['iife'],
      fileName: () => 'embed.iife.js',
    },
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2022',
    cssCodeSplit: false,
    minify: 'esbuild',
  },
});
