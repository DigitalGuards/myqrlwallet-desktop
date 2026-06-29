import { resolve } from 'node:path';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';

/**
 * electron-vite builds three targets into `out/`:
 *   - main    -> out/main/index.js  + out/main/signer.js  (the utilityProcess)
 *   - preload -> out/preload/index.js  (CJS, sandbox-compatible)
 *   - renderer-> out/renderer/index.html + assets  (loaded via loadFile)
 *
 * `externalizeDepsPlugin` keeps node/native deps (argon2, @theqrl/*, zod) out
 * of the main/preload bundles so they load from node_modules at runtime
 * (and so the native .node files can be asarUnpacked by electron-builder).
 * The renderer is bundled normally (no Node access).
 */
export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: 'out/main',
      rollupOptions: {
        // Two main-side entries: the broker and the isolated signer.
        input: {
          index: resolve(__dirname, 'src/main/index.ts'),
          signer: resolve(__dirname, 'src/signer/index.ts'),
        },
        output: {
          entryFileNames: '[name].js',
        },
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: 'out/preload',
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/preload/index.ts'),
          // Dedicated preload for the native unlock window.
          unlock: resolve(__dirname, 'src/unlock/preload.ts'),
        },
        output: {
          // Sandboxed preloads must be CommonJS.
          format: 'cjs',
          entryFileNames: '[name].js',
        },
      },
    },
  },
  // The MAIN wallet renderer is the real myqrlwallet-frontend, built by its own
  // toolchain via scripts/build-renderer.sh into out/renderer (run by
  // `npm run build`). The ONLY renderer electron-vite builds here is the small,
  // app-owned unlock window (out/unlock), native to the desktop app.
  renderer: {
    root: 'src/unlock',
    plugins: [react()],
    // Relative base so assets resolve under file:// (loadFile).
    base: './',
    build: {
      outDir: resolve(__dirname, 'out/unlock'),
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/unlock/index.html') },
      },
    },
  },
});
