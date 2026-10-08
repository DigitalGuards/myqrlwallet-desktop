/**
 * A Ledger transport moves one raw APDU to the device and returns the raw
 * response (data plus status word). It carries no protocol knowledge; the
 * QrlLedger client builds and checks every APDU. The development transport is
 * Speculos (speculosTransport.ts); a USB HID transport follows with the
 * device process.
 */
export interface LedgerTransport {
  exchange(apdu: Uint8Array): Promise<Uint8Array>;
}
