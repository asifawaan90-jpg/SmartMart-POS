'use client'
import { create } from 'zustand'
import { persist } from 'zustand/middleware'

export type ThemeName = 'classic' | 'modern' | 'ocean' | 'emerald' | 'royal' | 'sunset' | 'dark' | 'rose' | 'amber' | 'teal' | 'indigo' | 'coffee'

export const THEMES: { id: ThemeName; name: string; colors: string[] }[] = [
  { id: 'classic', name: 'Classic', colors: ['#166534', '#efece4', '#b45309'] },
  { id: 'modern', name: 'Modern', colors: ['#0f766e', '#f8fafc', '#f59e0b'] },
  { id: 'ocean', name: 'Ocean', colors: ['#0369a1', '#f0f7fa', '#0891b2'] },
  { id: 'emerald', name: 'Emerald', colors: ['#059669', '#f2faf5', '#84cc16'] },
  { id: 'royal', name: 'Royal', colors: ['#6d28d9', '#f8f6fb', '#d97706'] },
  { id: 'sunset', name: 'Sunset', colors: ['#c2410c', '#fdf6f1', '#f59e0b'] },
  { id: 'dark', name: 'Dark', colors: ['#22c55e', '#0b0d10', '#38bdf8'] },
  { id: 'rose', name: 'Rose', colors: ['#be123c', '#fdf2f5', '#fb7185'] },
  { id: 'amber', name: 'Amber', colors: ['#b45309', '#fffbef', '#f59e0b'] },
  { id: 'teal', name: 'Teal', colors: ['#0d9488', '#effafa', '#2dd4bf'] },
  { id: 'indigo', name: 'Indigo', colors: ['#4f46e5', '#eef1fb', '#818cf8'] },
  { id: 'coffee', name: 'Coffee', colors: ['#7c4517', '#faf6f1', '#c2854f'] },
]

interface ThemeState {
  theme: ThemeName
  setTheme: (t: ThemeName) => void
}

export const useThemeStore = create<ThemeState>()(
  persist(
    (set) => ({
      theme: 'classic',
      setTheme: (theme) => {
        if (typeof document !== 'undefined') {
          document.documentElement.setAttribute('data-theme', theme)
        }
        set({ theme })
      },
    }),
    { name: 'smartmart-theme' }
  )
)

export function applyTheme(t: ThemeName) {
  if (typeof document !== 'undefined') {
    document.documentElement.setAttribute('data-theme', t)
  }
}
