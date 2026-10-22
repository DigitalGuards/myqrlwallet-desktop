/** Exports of the pinned 1.4.3 summariser loaded by the inventory tooling. */
export const baselineRevision: string;
export const root: string;
export function loadBaseline(): Pick<
  typeof import('../src/main/confirmSummary'),
  'summariseSignatureRequest' | 'wrapDetailText' | 'SIGNATURE_APPROVAL_NOTE'
>;
