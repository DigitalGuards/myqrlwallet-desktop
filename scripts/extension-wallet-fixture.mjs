// Public encrypted vector from the pinned frontend's keystoreBackup.test.ts.
export const keystore = {
  version: 1,
  id: '1e198746-9ccd-4815-b1bc-dabe655a3271',
  address: 'Qcfec0cbee560cbd6ed89580204af71448f1fb8c5',
  crypto: {
    ciphertext:
      '8a4d7e503009e1ea9161d1a95472f1b5aa1e217a2c499869d9b9b3cf0ea77e2710cfc30c313917532111a66ceae0f4b6580ddae333664bcc687c2e1feb73874f220c19',
    cipherparams: { iv: '4e0b9d062b34e456c3996646' },
    cipher: 'aes-256-gcm',
    kdf: 'argon2id',
    kdfparams: {
      m: 8192,
      t: 2,
      p: 1,
      dklen: 32,
      salt: '6f02765040f3e6b2fdee34a2c06ecbc9cd31debb52ba75b620023dc7a6b1b7e4',
    },
  },
};
