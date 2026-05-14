import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    // admin 用 5174 避开 frontend 的 5173, 这样开发时俩 vite 都能 npm run dev
    port: 5174,
    proxy: {
      // 把 API 调用代理到本地 Backend (省 CORS 麻烦)
      "/auth": "http://127.0.0.1:8088",
      "/api": "http://127.0.0.1:8088",
      "/health": "http://127.0.0.1:8088",
      "/ws": { target: "ws://127.0.0.1:8088", ws: true },
    },
  },
  build: {
    outDir: "dist",
    target: "es2022",
  },
});
