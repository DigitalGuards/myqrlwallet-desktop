// Runs the main-process modules of one Node process on a pinned test mainnet.
// Their './config' import resolves to a shim that re-exports the real
// src/main/config.ts and serves pinnedNetwork() from the real selectNetwork
// with a table whose mainnet row carries test pins. NETWORKS keeps its null
// mainnet pins.
import { URL } from 'node:url';

const config = JSON.stringify(new URL('../src/main/config.ts', import.meta.url).href);
const shim = `import { NETWORKS, NetworkProfileError, selectNetwork } from ${config};
export * from ${config};
const table = {
  ...NETWORKS,
  mainnet: { ...NETWORKS.mainnet, chainId: 7, genesisHash: '0x${'ab'.repeat(32)}' },
};
const selection = selectNetwork('mainnet', table);
export function pinnedNetwork() {
  if (selection.network === null) throw new NetworkProfileError(selection.error);
  return selection.network;
}`;

export function resolve(specifier, context, nextResolve) {
  if (specifier === './config' && context.parentURL?.includes('/src/main/'))
    return { url: 'data:text/javascript,' + encodeURIComponent(shim), shortCircuit: true };
  return nextResolve(specifier, context);
}
