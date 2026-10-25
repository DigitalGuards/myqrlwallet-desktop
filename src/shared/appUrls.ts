/** Each app surface has its own Chromium origin and storage/worker namespace. */
export const APP_URLS = {
  wallet: 'app://wallet/index.html',
  unlock: 'app://unlock/index.html',
  settings: 'app://settings/index.html',
} as const;

export const STORAGE_MIGRATION_URL = 'app://wallet/storage-migration.html';

/** Permit hash routing while retaining the exact bundled entry point. */
export function isAppDocument(url: string, document: string): boolean {
  return url.split('#')[0] === document;
}
