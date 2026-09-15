/**
 * Отключение системной автозамены/автокапитализации/проверки орфографии для текстовых полей.
 * В WKWebView (macOS) без этих атрибутов ввод вроде `account_id` превращается в `Account_id`.
 */
export const NO_AUTOCORRECT = {
  autoCorrect: "off",
  autoCapitalize: "off",
  spellCheck: false,
  autoComplete: "off",
} as const;
