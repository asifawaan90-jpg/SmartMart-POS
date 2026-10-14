'use client'

import { useMemo } from 'react'
import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { api } from '@/lib/client'
import { translate, isRtlLang, type Lang } from '@/lib/i18n'

/**
 * Task 50 — per-device language preference.
 * Task 54 — account-wide language: the chosen language ALSO follows the
 * account (saved into the business settings as `lang`), so after an app
 * update, a reinstall, or signing in on a NEW device the app comes back in
 * the SAME language instead of resetting to English ("language changed
 * after update"). A device that explicitly picks a language still keeps its
 * own choice (hasChosen) — several staff can share one device, each in
 * their own language.
 *
 * Persisted locally under 'smartmart-lang'.
 */
interface LangState {
  lang: Lang
  hasChosen: boolean
  setLang: (l: Lang) => void
  adoptAccount: (l: Lang) => void
}

const VALID: Lang[] = ['en', 'ur', 'ar', 'hi', 'bn', 'tr', 'fr', 'es']

/** Fire-and-forget: record the account-wide default (all roles may save ONLY lang). */
function syncLangToServer(lang: Lang) {
  api('/api/settings', { method: 'PUT', body: { settings: { lang } } }).catch(() => { /* device-only fallback */ })
}

export const useLangStore = create<LangState>()(
  persist(
    (set) => ({
      lang: 'en',
      hasChosen: false,
      setLang: (lang) => {
        set({ lang, hasChosen: true })
        applyDocumentLang(lang)
        syncLangToServer(lang)
      },
      // Boot-time adoption of the account default (new device / after the
      // local store was cleared). Does NOT count as a device choice and is
      // never pushed back to the server.
      adoptAccount: (lang) => {
        if (!VALID.includes(lang)) return
        set({ lang })
        applyDocumentLang(lang)
      },
    }),
    { name: 'smartmart-lang' }
  )
)

/** Push the language + writing direction onto <html> (RTL for Urdu/Arabic). */
export function applyDocumentLang(lang: Lang) {
  if (typeof document === 'undefined') return
  document.documentElement.lang = lang
  document.documentElement.dir = isRtlLang(lang) ? 'rtl' : 'ltr'
}

export type TFn = ((key: string, vars?: Record<string, string | number>) => string) & {
  lang: Lang
  rtl: boolean
}

/**
 * Convenience hook: returns a memoized t() bound to the current language.
 * `t('nav.pos')` → "POS Terminal" · `t('dash.subtitle', { shop: name })`
 * substitutes {placeholders}. Missing keys fall back to English.
 * `t.lang` / `t.rtl` expose the active language and direction.
 */
export function useT(): TFn {
  const lang = useLangStore(s => s.lang)
  return useMemo(() => {
    const t = ((key: string, vars?: Record<string, string | number>) => translate(lang, key, vars)) as TFn
    t.lang = lang
    t.rtl = isRtlLang(lang)
    return t
  }, [lang])
}
