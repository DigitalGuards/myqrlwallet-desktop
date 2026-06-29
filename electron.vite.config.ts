import { resolve } from 'node:path';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';

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
        input: { index: resolve(__dirname, 'src/preload/index.ts') },
        output: {
          // Sandboxed preloads must be CommonJS.
          format: 'cjs',
          entryFileNames: '[name].js',
        },
      },
    },
  },
  // No `renderer` target here: the renderer is the real myqrlwallet-frontend,
  // built by its own toolchain via scripts/build-renderer.sh into out/renderer
  // (run by `npm run build`). electron-vite only builds main + preload.
});
