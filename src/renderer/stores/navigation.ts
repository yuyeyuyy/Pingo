import { create } from 'zustand'

export type Page = 'home' | 'question-bank' | 'statistics' | 'settings'

interface Navigation {
  page: Page
  navigate(page: Page): void
}

export const useNavigation = create<Navigation>((set) => ({
  page: 'home',
  navigate: (page) => set({ page }),
}))
