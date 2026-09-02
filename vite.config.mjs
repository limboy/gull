import fs from 'node:fs';
import path from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// pdf.js loads its image decoders (wasm), the standard font data, CMaps, and
// ICC profiles from URLs at runtime. They are served from `/pdfjs/` in dev and
// copied next to the bundle for the packaged app, so the same relative URL
// works in both — see `docs/pdf-rendering.md`.
const PDFJS_DIR = path.resolve(__dirname, 'node_modules/pdfjs-dist');
const PDFJS_ASSET_DIRS = ['wasm', 'standard_fonts', 'cmaps', 'iccs'];

function pdfjsAssets() {
  let isBuild = false;
  return {
    name: 'gull-pdfjs-assets',
    configResolved(config) {
      isBuild = config.command === 'build';
    },
    configureServer(server) {
      server.middlewares.use('/pdfjs', (req, res, next) => {
        const requested = decodeURIComponent((req.url || '').split('?')[0]);
        const target = path.join(PDFJS_DIR, requested);
        const allowed = PDFJS_ASSET_DIRS.some(dir =>
          target.startsWith(path.join(PDFJS_DIR, dir) + path.sep));
        if (!allowed) return next();
        fs.createReadStream(target).on('error', next).pipe(res);
      });
    },
    closeBundle() {
      if (!isBuild) return;
      for (const dir of PDFJS_ASSET_DIRS) {
        fs.cpSync(path.join(PDFJS_DIR, dir), path.resolve(__dirname, 'dist/pdfjs', dir), {
          recursive: true,
        });
      }
    },
  };
}

export default defineConfig({
  base: './',
  plugins: [react(), tailwindcss(), pdfjsAssets()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
  // pdf.js ships an ES module worker, and the production renderer runs from
  // file://, where a worker can only be created from an inlined blob.
  worker: {
    format: 'es',
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        main: path.resolve(__dirname, 'index.html'),
      },
    },
  },
});
