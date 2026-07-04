/**
 * The destructive remove-wallet flow, shared by the renderer IPC handler
 * (IPC.REMOVE_WALLET) and the native settings window. Both entry points gate
 * on the same trusted, main-drawn confirmation dialog; the flow never deletes
 * anything without it.
 *
 * Dependency-injected so the ordering invariants are unit-testable without
 * Electron: confirm before any side effect; drop the signer session only when
 * it belongs to the wallet being removed; delete the ciphertext BEFORE the
 * keychain entry (a bare KEK with no matching ciphertext is useless, so the
 * wallet is unrecoverable even if the keychain clear then fails); raise the
 * unlock window only when the open session died and other wallets remain.
 */

export interface WalletRemovalDeps {
  signer: {
    status(): Promise<{ unlocked: boolean; address: string | null }>;
    lock(): Promise<unknown>;
  };
  keyVault: { delete(address: string): Promise<void> };
  seeds: {
    readByAddress(address: string): Promise<{ address: string } | null>;
    getActive(): Promise<string | null>;
    delete(address: string): Promise<void>;
    hasAny(): Promise<boolean>;
  };
  /** The trusted main-drawn confirmation. Resolves false on cancel. */
  confirm(address: string): Promise<boolean>;
  emitLockState(locked: boolean): void;
  showUnlock(): void;
  /** Non-fatal problem reporter (keychain clear failure). */
  warn(message: string): void;
}

const sameAccount = (a: string | null | undefined, b: string | null | undefined): boolean =>
  typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();

/**
 * Remove one wallet (the active one when `targetAddress` is omitted). Throws
 * 'user rejected wallet removal' on a declined confirmation; callers treat
 * that as a silent cancel. Returns the removed address.
 */
export async function removeWalletFlow(
  deps: WalletRemovalDeps,
  targetAddress?: string,
): Promise<{ address: string }> {
  const target = targetAddress ?? (await deps.seeds.getActive());
  if (!target) throw new Error('no wallet to remove');
  const seed = await deps.seeds.readByAddress(target);
  if (!seed) throw new Error('no such wallet on this device');
  const approved = await deps.confirm(seed.address);
  if (!approved) throw new Error('user rejected wallet removal');
  // Drop the session only when it belongs to the wallet being removed;
  // removing a background wallet must not lock the one in use.
  const st = await deps.signer.status();
  const sessionWasTarget = st.unlocked && sameAccount(st.address, seed.address);
  if (sessionWasTarget) {
    await deps.signer.lock();
    deps.emitLockState(true);
  }
  // Ciphertext first, keychain second (see module doc). Log, do not swallow,
  // a keychain clear failure.
  await deps.seeds.delete(seed.address);
  await deps.keyVault.delete(seed.address).catch((err: unknown) => {
    deps.warn(
      `removeWallet: keychain clear failed: ${err instanceof Error ? err.message : 'error'}`,
    );
  });
  // Single-window lock invariant: if the open session died and other wallets
  // remain, the app is now locked, so raise the native unlock window for the
  // (self-healed) active wallet. After removing the LAST wallet there is
  // nothing to unlock and the renderer's create/import flow shows instead.
  if (sessionWasTarget && (await deps.seeds.hasAny())) deps.showUnlock();
  return { address: seed.address };
}
