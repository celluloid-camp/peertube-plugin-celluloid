/** Plugin setting key: base URL of the Celluloid instance. */
export const SETTING_CELLULOID_URL = "celluloid-url";

/** Video form field / stored key: the linked Celluloid project (id or URL). */
export const FIELD_CELLULOID_PROJECT = "celluloid-project";

/** Storage key for a given video's linked project. */
export function projectStorageKey(videoUuid: string): string {
  return `${FIELD_CELLULOID_PROJECT}-${videoUuid}`;
}
