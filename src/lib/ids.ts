/** Уникальный идентификатор (вкладки, сессии, запросы). */
export function newId(): string {
  return crypto.randomUUID();
}
