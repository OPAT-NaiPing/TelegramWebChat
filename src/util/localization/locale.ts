import { FALLBACK_LANG_CODE, SERVER_ACCOUNT_DEFAULT_LANG_CODE } from '../../config';

const LOCALE_OVERRIDES: Record<string, string> = {
  [SERVER_ACCOUNT_DEFAULT_LANG_CODE]: 'zh-Hans',
  'zh-hans': 'zh-Hans',
  'zh-cn': 'zh-CN',
  'zh-tw': 'zh-TW',
};

export function normalizeIntlLocale(langCode?: string) {
  if (!langCode) return FALLBACK_LANG_CODE;

  const normalized = LOCALE_OVERRIDES[langCode.toLowerCase()] || langCode;
  try {
    return Intl.getCanonicalLocales(normalized)[0] || FALLBACK_LANG_CODE;
  } catch {
    return FALLBACK_LANG_CODE;
  }
}
