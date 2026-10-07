import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

// root 定在本目录（web/），构建产物输出到 web/dist，供 Electron 生产模式加载。
// base: './' 使用相对路径——Electron 以 file:// 协议加载页面时必需。
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  base: './',
  plugins: [react()],
  build: { outDir: 'dist', emptyOutDir: true },
  server: { port: 5173, strictPort: true },
});
