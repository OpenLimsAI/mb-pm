import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// CTO Lite 版固定 5175，避免与 Demo-Lite（5174）/ 基线版（5173）端口冲突
// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5175,
    strictPort: true,  // 端口被占用时报错，不要自动跳到下一个
  },
})
