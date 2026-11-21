import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import type { Plugin } from 'vite'

function rendererCsp(): Plugin {
  return {
    name: 'pingo-csp',
    transformIndexHtml(_html, { server }) {
      const policy = [
        "default-src 'none'",
        server ? "script-src 'self' 'unsafe-inline'" : "script-src 'self'",
        server ? "style-src 'self' 'unsafe-inline'" : "style-src 'self'",
        "img-src 'self' data:",
        'media-src blob:',
        "base-uri 'none'",
        "form-action 'none'",
        ...(server ? ["connect-src 'self' ws://127.0.0.1:*"] : []),
      ].join('; ')

      return [
        {
          tag: 'meta',
          attrs: { 'http-equiv': 'Content-Security-Policy', content: policy },
          injectTo: 'head-prepend',
        },
      ]
    },
  }
}

export default defineConfig({
  main: {},
  preload: {},
  renderer: {
    build: { minify: true },
    server: { host: '127.0.0.1' },
    plugins: [rendererCsp(), react()],
  },
})
