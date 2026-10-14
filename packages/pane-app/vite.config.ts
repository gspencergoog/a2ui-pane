import { defineConfig, type Plugin } from 'vite';
import { a2uiDevPlugin } from './src/dev-server.js';

function queryPreservingScriptsPlugin(): Plugin {
  return {
    name: 'query-preserving-scripts',
    enforce: 'post',
    transformIndexHtml(html) {
      return html.replace(
        /(<script\b[^>]*src="([^"]+)"[^>]*><\/script>)/g,
        (match, fullTag, src) => {
          if (src.startsWith('http://') || src.startsWith('https://')) {
            return match;
          }
          const isModule = /type=["']module["']/.test(fullTag);
          return `<script>
      (function() {
        var s = document.createElement('script');
        ${isModule ? "s.type = 'module'; s.crossOrigin = '';" : ''}
        s.src = '${src}' + (window.location.search || '');
        document.head.appendChild(s);
      })();
    </script>`;
        },
      );
    },
  };
}

export default defineConfig({
  base: './',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  server: {
    port: 5173,
  },
  plugins: [a2uiDevPlugin(), queryPreservingScriptsPlugin()],
});
