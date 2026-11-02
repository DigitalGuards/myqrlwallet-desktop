/**
 * The startup gate on the build's network. src/main/index.ts runs it before
 * anything else: before the app registers a protocol, creates a data
 * directory, forks the signer or makes an RPC call.
 */
import type { PinnedNetwork } from './config';

export interface StartupRefusal {
  /** Native error box. Before app ready on Linux it prints to stderr. */
  readonly showErrorBox: (title: string, content: string) => void;
  readonly exit: (code: number) => void;
  readonly log: (message: string) => void;
  readonly title: string;
}

/**
 * The pinned network, or a refusal to start: an error box, exit code 1, and a
 * rethrow, so no later startup code runs even if exit returns first.
 */
export function startupNetwork(
  resolve: () => PinnedNetwork,
  refuse: StartupRefusal,
): PinnedNetwork {
  try {
    return resolve();
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    refuse.log(`[boot] refused to start: ${message}`);
    refuse.showErrorBox(refuse.title, message);
    refuse.exit(1);
    throw err;
  }
}
