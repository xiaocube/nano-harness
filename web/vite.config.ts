import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

// root 定在本目录（web/），构建产物输出到 web/dist，供 Electron 生产模式加载。
// base: './' 使用相对路径——Electron 以 file:// 协议加载页面时必需。
/**
 * 开发模式下放宽 CSP：@vitejs/plugin-react 会往 index.html 注入一段**内联**的
 * 热更新 preamble，而生产 CSP（default-src 'self'，不含 unsafe-inline）会把它拦掉，
 * 表现为 `npm run ui:dev` 打开后 React 根本没挂载。生产构建不动，安全性不受影响。
 */
function devCsp(): Plugin {
  return {
    name: 'nh-dev-csp',
    apply: 'serve',
    transformIndexHtml(html) {
      return html.replace(
        /content="default-src 'self'[^"]*"/,
        `content="default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; frame-src nh-file:; script-src 'self' 'unsafe-inline' 'unsafe-eval'; connect-src 'self' ws: http://localhost:*"`,
      );
    },
  };
}

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  base: './',
  plugins: [react(), devCsp()],
  build: { outDir: 'dist', emptyOutDir: true },
  server: { port: 5173, strictPort: true },
});
