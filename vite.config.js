import { defineConfig } from 'vite';
export default defineConfig({
  base: '/xiangqi/',
  build: { outDir: 'dist', chunkSizeWarningLimit: 1800 },
  server: { proxy: { '/xiangqi/api': {target:'http://127.0.0.1:18790',rewrite:p=>p.replace('/xiangqi','')}, '/xiangqi/ws': {target:'ws://127.0.0.1:18790',ws:true,rewrite:p=>p.replace('/xiangqi','')} } }
});
