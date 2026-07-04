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
          // Dedicated preloads for the native unlock + settings windows.
          unlock: resolve(__dirname, 'src/unlock/preload.ts'),
          settings: resolve(__dirname, 'src/settings/preload.ts'),
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
  // `npm run build`). The only renderers electron-vite builds here are the two
  // small, app-owned native windows: unlock (out/unlock) and settings
  // (out/settings). Multi-page build rooted at src/ so each page keeps its
  // directory (out/<page>/index.html, matching the loadFile paths in
  // src/main/unlockWindow.ts and src/main/settingsWindow.ts); shared assets
  // land in out/assets with per-page relative references (base './').
  renderer: {
    root: 'src',
    plugins: [react()],
    // Relative base so assets resolve under file:// (loadFile).
    base: './',
    build: {
      // This output only ever runs in Electron 42's bundled Chromium 148, so pin
      // the target there: vite 7 changed the default build target (from 'modules'
      // to a broad browser baseline) and the explicit pin avoids that drift.
      target: 'chrome148',
      outDir: resolve(__dirname, 'out'),
      // out/ also holds the main + preload bundles built earlier in the same
      // electron-vite run; NEVER let the renderer build empty it.
      emptyOutDir: false,
      rollupOptions: {
        input: {
          unlock: resolve(__dirname, 'src/unlock/index.html'),
          settings: resolve(__dirname, 'src/settings/index.html'),
        },
      },
    },
  },
});
