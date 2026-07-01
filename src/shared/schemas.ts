/**
 * Zod schemas for every value that crosses a process boundary.
 *
 * Defense-in-depth: the renderer is treated as fully untrusted, so the main
 * process validates every IPC argument against these schemas BEFORE acting,
 * and the signer re-validates the subset it receives. Parsing (not just
 * type-asserting) means malformed/oversized/extra-keyed inputs are rejected at
 * the boundary instead of reaching crypto code.
 *
 * zod 4 matches the version used by myqrlwallet-frontend.
 */
import { z } from 'zod';

/** A QRL v2 address: `Q` + 40 hex chars (EIP-55 casing tolerated). */
export const AddressSchema = z
  .string()
  .regex(/^Q[0-9a-fA-F]{40}$/, 'must be a Q-prefixed 20-byte hex address');

/** A wallet.js 51-byte hex extended seed (3-byte descriptor || 48-byte seed). */
export const HexSeedSchema = z
  .string()
  .regex(/^(0x)?[0-9a-fA-F]{102}$/, 'must be a 51-byte hex extended seed');

/** Bare or 0x-prefixed hex of even length. */
const HexSchema = z
  .string()
  .regex(/^(0x)?[0-9a-fA-F]*$/, 'must be hex')
  .refine((s) => (s.startsWith('0x') ? s.length % 2 === 0 : s.length % 2 === 0), 'odd hex length');

/** A non-negative integer-valued decimal string (wei/shor amounts). */
const DecimalAmountSchema = z.string().regex(/^\d+$/, 'must be a base-10 integer string').max(80);

export const FeeLevelSchema = z.enum(['low', 'medium', 'high']);

// ---------------------------------------------------------------------------
// Renderer -> main request payloads
// ---------------------------------------------------------------------------

export const GetBalanceRequestSchema = z.object({ address: AddressSchema }).strict();

export const BuildTransactionRequestSchema = z
  .object({
    from: AddressSchema,
    to: AddressSchema,
    /** Amount in the chain's smallest unit, as a decimal string. */
    value: DecimalAmountSchema,
    feeLevel: FeeLevelSchema.optional().default('medium'),
    /** Optional contract calldata. */
    data: HexSchema.max(2 * 128 * 1024).optional(),
  })
  .strict();

/**
 * A fully-assembled unsigned transaction (output of buildTransaction).
 * QRL v2 uses EIP-1559 type-2 transactions, matching the web wallet
 * (`qrlStore.sendTransaction`): a `maxFeePerGas` / `maxPriorityFeePerGas`
 * pair rather than a legacy `gasPrice`. All amounts are decimal strings in
 * the smallest unit; the signer converts to the hex shape web3 expects.
 */
export const UnsignedTransactionSchema = z
  .object({
    from: AddressSchema,
    to: AddressSchema,
    value: DecimalAmountSchema,
    nonce: z.number().int().nonnegative(),
    gas: DecimalAmountSchema,
    maxFeePerGas: DecimalAmountSchema,
    maxPriorityFeePerGas: DecimalAmountSchema,
    chainId: z.number().int().positive(),
    type: z.literal('0x2').default('0x2'),
    data: HexSchema.optional(),
  })
  .strict();

/**
 * The discriminated signing request. Transactions are the spend path; message
 * and typed-data mirror the wallet's `qrl_signMessage` / `qrl_signTypedData`.
 */
export const SignatureRequestSchema = z
  .discriminatedUnion('kind', [
    z.object({ kind: z.literal('transaction'), tx: UnsignedTransactionSchema }).strict(),
    z.object({ kind: z.literal('message'), messageHex: HexSchema.max(2 * 64 * 1024) }).strict(),
    z
      .object({
        kind: z.literal('typedData'),
        // The wallet computes the digest; we keep the payload opaque here and
        // let the signer's typed-data hasher validate structure. Bounded below.
        payload: z.record(z.string(), z.unknown()),
      })
      .strict(),
  ])
  // Bound the typedData payload so a huge object cannot be pushed across the
  // boundary (the message arm is already byte-bounded above).
  .refine((r) => r.kind !== 'typedData' || JSON.stringify(r.payload).length <= 64 * 1024, {
    message: 'typedData payload too large',
  });

/**
 * Passwords are never logged and never persisted. Bounded to defeat
 * resource-exhaustion via an absurd Argon2 input. Minimum length is enforced
 * at provisioning time, not unlock time (an existing wallet may predate a
 * stricter policy).
 */
export const PasswordSchema = z.string().min(1).max(1024);

/**
 * `password` is optional: omitting it asks main to unlock via a KEK retrieved
 * from the OS keychain (macOS Touch ID / passcode), the defense-in-depth path.
 * `address` selects which wallet to unlock (multi-wallet); omitted = active.
 */
export const UnlockRequestSchema = z
  .object({ password: PasswordSchema.optional(), address: AddressSchema.optional() })
  .strict();

/**
 * Import from EITHER a mnemonic or a raw hex extended seed (exactly one).
 * The two are equivalent encodings of the same 51 bytes, so the signer
 * regenerates the mnemonic from a hex-seed import and the stored envelope is
 * identical either way.
 */
export const ImportWalletRequestSchema = z
  .object({
    /** BIP39-style mnemonic; word count validated downstream by wallet.js. */
    mnemonic: z.string().min(1).max(4096).optional(),
    /** Raw 51-byte hex extended seed (the web wallet's "hex seed" import). */
    hexSeed: HexSeedSchema.optional(),
    password: PasswordSchema,
    /** Opt-in: also stash the KEK in the OS keychain (macOS user-presence). */
    useKeychain: z.boolean().optional().default(false),
  })
  .strict()
  .refine((r) => (r.mnemonic === undefined) !== (r.hexSeed === undefined), {
    message: 'provide exactly one of mnemonic or hexSeed',
  });

/** Remove one wallet. Omitted address = the active wallet (back-compat). */
export const RemoveWalletRequestSchema = z
  .object({ address: AddressSchema.optional() })
  .strict()
  .optional();

export const SetActiveWalletRequestSchema = z.object({ address: AddressSchema }).strict();

/** Generate a brand-new wallet inside the signer (no mnemonic supplied). */
export const CreateWalletRequestSchema = z
  .object({
    password: PasswordSchema,
    useKeychain: z.boolean().optional().default(false),
  })
  .strict();

export const SendRawTransactionRequestSchema = z
  .object({ rawTx: z.string().regex(/^0x[0-9a-fA-F]+$/) })
  .strict();

// ---------------------------------------------------------------------------
// main -> renderer response payloads (typed for the renderer's convenience)
// ---------------------------------------------------------------------------

export type GetBalanceRequest = z.infer<typeof GetBalanceRequestSchema>;
export type BuildTransactionRequest = z.infer<typeof BuildTransactionRequestSchema>;
export type UnsignedTransaction = z.infer<typeof UnsignedTransactionSchema>;
export type SignatureRequest = z.infer<typeof SignatureRequestSchema>;
export type UnlockRequest = z.infer<typeof UnlockRequestSchema>;
export type ImportWalletRequest = z.infer<typeof ImportWalletRequestSchema>;
export type CreateWalletRequest = z.infer<typeof CreateWalletRequestSchema>;
export type RemoveWalletRequest = z.infer<typeof RemoveWalletRequestSchema>;
export type SetActiveWalletRequest = z.infer<typeof SetActiveWalletRequestSchema>;
export type SendRawTransactionRequest = z.infer<typeof SendRawTransactionRequestSchema>;
export type FeeLevel = z.infer<typeof FeeLevelSchema>;

/** One provisioned wallet as reported to the renderer (public data only). */
export interface WalletInfo {
  address: string;
  /** Whether this wallet's KEK is currently backed by the OS keychain. */
  keychainBacked: boolean;
}

export interface WalletListResult {
  wallets: WalletInfo[];
  /** The active wallet's address, or null when no wallet exists. */
  active: string | null;
}

export interface BalanceResult {
  address: string;
  /** Balance in the smallest unit, decimal string. */
  balance: string;
}

export interface WalletStatus {
  hasWallet: boolean;
  locked: boolean;
  /** The unlocked session's address, else the active wallet's address. */
  address: string | null;
  /** Epoch ms when the current session auto-locks, or null if locked. */
  unlockExpiresAt: number | null;
  /** Whether the active wallet's KEK is currently backed by the OS keychain. */
  keychainBacked: boolean;
  /** Every provisioned wallet on this device (public data only). */
  wallets: WalletInfo[];
  /** The active wallet's address, or null when no wallet exists. */
  activeAddress: string | null;
}

export interface CreateWalletResult {
  status: WalletStatus;
  /** One-time recovery mnemonic for the user to back up. Never persisted in
   * plaintext; display it once and drop it. The hex seed never leaves the signer. */
  mnemonic: string;
}

export interface SignatureResult {
  kind: SignatureRequest['kind'];
  /** Hex signature (transactions: the signed raw tx; messages: the ML-DSA sig). */
  signature: string;
  /** Hex ML-DSA-87 public key (present for message/typedData). */
  publicKey?: string;
  /** Signer Q-address. */
  signer: string;
  /** SHAKE256 digest that was signed (present for message/typedData). */
  digest?: string;
  /** For transactions: the 0x raw signed tx ready to broadcast. */
  rawTransaction?: string;
}
