import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// 开发态：Vite 5173 提供 UI，/api 反向代理到后端 17890
// 生产态：后端直接托管 dist/ 静态资源
export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:17890',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
})
