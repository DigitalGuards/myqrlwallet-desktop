// Prints the network values scripts/build-renderer.sh bakes into the renderer,
// one KEY=value line each, for the build profile in QRL_NETWORK_PROFILE
// (testnet by default). They come from the network table in
// src/main/config.ts, the same row main pins and the wallet bridge advertises.
// A profile without both identity pins (mainnet before launch) exits 1.
// Usage: node --import tsx scripts/network-values.mjs
import { NetworkProfileError, rendererNetworkValues } from '../src/main/config.ts';

try {
  for (const [key, value] of rendererNetworkValues(process.env.QRL_NETWORK_PROFILE)) {
    process.stdout.write(`${key}=${value}\n`);
  }
} catch (err) {
  if (!(err instanceof NetworkProfileError)) throw err;
  console.error(`[build-renderer] ERROR: ${err.message}`);
  process.exit(1);
}
