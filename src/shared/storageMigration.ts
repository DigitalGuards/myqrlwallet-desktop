export const STORAGE_MIGRATION_CHANNEL = 'storage:migrate-v1';
export const LEGACY_STORAGE_MIGRATION_URL = 'file:///qrlwallet-storage-migration.html';
export type StorageEntries = [string, string][];

export function isStorageEntries(value: unknown): value is StorageEntries {
  return (
    Array.isArray(value) &&
    value.every(
      (entry: unknown) =>
        Array.isArray(entry) &&
        entry.length === 2 &&
        typeof entry[0] === 'string' &&
        typeof entry[1] === 'string',
    )
  );
}
