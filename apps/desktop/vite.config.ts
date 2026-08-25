import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Tauri serves the built assets from a custom protocol, so relative URLs are
// required and the dev server must use a fixed port it can point at.
export default defineConfig({
  plugins: [react()],
  base: './',
  clearScreen: false,
  server: {
    port: 5174,
    strictPort: true,
    watch: {
      // Ignore Rust build directories to prevent EBUSY errors on Windows
      ignored: ['**/target/**', '**/dist/**'],
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'chrome110',
    sourcemap: false,
  },
});
