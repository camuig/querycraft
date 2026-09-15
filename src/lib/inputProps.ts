/**
 * Disables system autocorrect/autocapitalization/spellcheck for text fields.
 * In WKWebView (macOS), without these attributes, typing e.g. `account_id` turns into `Account_id`.
 */
export const NO_AUTOCORRECT = {
  autoCorrect: "off",
  autoCapitalize: "off",
  spellCheck: false,
  autoComplete: "off",
} as const;
