import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  build: { sourcemap: false },
  server: { headers: { 'Referrer-Policy': 'no-referrer' } },
  preview: { headers: { 'Referrer-Policy': 'no-referrer' } }
});
