/**
 * Remove-wallet flow test (src/main/walletRemoval.ts): the destructive flow
 * shared by the renderer IPC handler and the native settings window.
 *
 * Verified here:
 *   - nothing happens before the trusted confirmation; a decline deletes
 *     nothing and throws the cancel error
 *   - the session drops (lock + LOCK_STATE_CHANGED) only when it belongs to
 *     the wallet being removed
 *   - the ciphertext is deleted BEFORE the keychain entry, and a keychain
 *     clear failure does not fail the removal
 *   - the unlock window is raised only when the open session died AND other
 *     wallets remain (never after removing the last wallet)
 *   - no-wallet / unknown-address inputs reject before confirmation
 *
 * The flow is dependency-injected, so this runs under
 * `node --test --import tsx` without the Electron runtime.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { removeWalletFlow, type WalletRemovalDeps } from '../src/main/walletRemoval';

interface Harness {
  deps: WalletRemovalDeps;
  calls: string[];
}

function makeDeps(opts: {
  active?: string | null;
  seeds?: string[];
  sessionAddress?: string | null;
  unlocked?: boolean;
  approve?: boolean;
  hasAnyAfter?: boolean;
  keyVaultFails?: boolean;
}): Harness {
  const calls: string[] = [];
  const seeds = opts.seeds ?? ['Qaaaa'];
  const deps: WalletRemovalDeps = {
    signer: {
      status: () =>
        Promise.resolve({
          unlocked: opts.unlocked ?? false,
          address: opts.sessionAddress ?? null,
        }),
      lock: () => {
        calls.push('signer.lock');
        return Promise.resolve(null);
      },
    },
    keyVault: {
      delete: (address: string) => {
        calls.push(`keyVault.delete:${address}`);
        return opts.keyVaultFails ? Promise.reject(new Error('vault offline')) : Promise.resolve();
      },
    },
    seeds: {
      readByAddress: (address: string) =>
        Promise.resolve(
          seeds.some((s) => s.toLowerCase() === address.toLowerCase()) ? { address } : null,
        ),
      getActive: () => Promise.resolve(opts.active ?? null),
      delete: (address: string) => {
        calls.push(`seeds.delete:${address}`);
        return Promise.resolve();
      },
      hasAny: () => Promise.resolve(opts.hasAnyAfter ?? false),
    },
    confirm: (address: string) => {
      calls.push(`confirm:${address}`);
      return Promise.resolve(opts.approve ?? true);
    },
    emitLockState: (locked: boolean) => {
      calls.push(`emitLockState:${String(locked)}`);
    },
    showUnlock: () => {
      calls.push('showUnlock');
    },
    warn: (message: string) => {
      calls.push(`warn:${message}`);
    },
  };
  return { deps, calls };
}

test('declined confirmation deletes nothing and throws the cancel error', async () => {
  const { deps, calls } = makeDeps({ active: 'Qaaaa', approve: false });
  await assert.rejects(removeWalletFlow(deps), /user rejected wallet removal/);
  assert.deepEqual(calls, ['confirm:Qaaaa']);
});

test('no wallet on the device rejects before any confirmation', async () => {
  const { deps, calls } = makeDeps({ active: null });
  await assert.rejects(removeWalletFlow(deps), /no wallet to remove/);
  assert.deepEqual(calls, []);
});

test('an unknown explicit address rejects before any confirmation', async () => {
  const { deps, calls } = makeDeps({ seeds: ['Qaaaa'] });
  await assert.rejects(removeWalletFlow(deps, 'Qbbbb'), /no such wallet on this device/);
  assert.deepEqual(calls, []);
});

test('removing the unlocked account locks first, deletes seed before keychain, raises unlock when wallets remain', async () => {
  const { deps, calls } = makeDeps({
    active: 'Qaaaa',
    sessionAddress: 'QAAAA', // differs in case from the seed: match is case-insensitive
    unlocked: true,
    hasAnyAfter: true,
  });
  const result = await removeWalletFlow(deps);
  assert.equal(result.address, 'Qaaaa');
  assert.deepEqual(calls, [
    'confirm:Qaaaa',
    'signer.lock',
    'emitLockState:true',
    'seeds.delete:Qaaaa',
    'keyVault.delete:Qaaaa',
    'showUnlock',
  ]);
});

test('removing a background wallet neither locks nor raises the unlock window', async () => {
  const { deps, calls } = makeDeps({
    seeds: ['Qaaaa', 'Qbbbb'],
    active: 'Qaaaa',
    sessionAddress: 'Qaaaa',
    unlocked: true,
    hasAnyAfter: true,
  });
  await removeWalletFlow(deps, 'Qbbbb');
  assert.deepEqual(calls, ['confirm:Qbbbb', 'seeds.delete:Qbbbb', 'keyVault.delete:Qbbbb']);
});

test('removing the LAST wallet does not raise the unlock window', async () => {
  const { deps, calls } = makeDeps({
    active: 'Qaaaa',
    sessionAddress: 'Qaaaa',
    unlocked: true,
    hasAnyAfter: false,
  });
  await removeWalletFlow(deps);
  assert.ok(!calls.includes('showUnlock'));
  assert.ok(calls.includes('seeds.delete:Qaaaa'));
});

test('a keychain clear failure is warned about but does not fail the removal', async () => {
  const { deps, calls } = makeDeps({ active: 'Qaaaa', keyVaultFails: true });
  const result = await removeWalletFlow(deps);
  assert.equal(result.address, 'Qaaaa');
  const seedIdx = calls.indexOf('seeds.delete:Qaaaa');
  const vaultIdx = calls.indexOf('keyVault.delete:Qaaaa');
  assert.ok(seedIdx !== -1 && vaultIdx !== -1 && seedIdx < vaultIdx);
  assert.ok(calls.some((c) => c.startsWith('warn:')));
});
