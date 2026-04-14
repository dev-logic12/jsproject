import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  // GitHub Pages 배포 시 레포명으로 변경
  // 예: base: '/iphone-briefing/'
  base: './',
})
