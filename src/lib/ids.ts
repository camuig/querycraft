/** Unique identifier (tabs, sessions, queries). */
export function newId(): string {
  return crypto.randomUUID();
}
