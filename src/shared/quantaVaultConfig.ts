/** Main-owned deployment hints. Empty until a deployment is independently verified. */
export interface QuantaVaultConfig {
  readonly multiSendCallOnly: Readonly<Record<string, readonly string[]>>;
}

export const QUANTA_VAULT_CONFIG: QuantaVaultConfig = { multiSendCallOnly: {} };
export const QRL_ZERO_ADDRESS = `Q${'0'.repeat(128)}`;
