import {defineConfig} from 'vite';
import {viteSingleFile} from 'vite-plugin-singlefile';

// `npm run build` writes one self-contained dist/index.html that opens without a server.
export default defineConfig({
  base: './',
  plugins: [viteSingleFile()],
  worker: {format: 'iife'},
  build: {outDir: 'dist', emptyOutDir: true},
  test: {include: ['tests/**/*.test.js']}
});
