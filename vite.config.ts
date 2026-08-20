import react from "@vitejs/plugin-react";
import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vite";

export default defineConfig({
  // 使用相对资源路径，兼容 GitHub Pages 的子目录部署地址。
  base: "./",
  plugins: [react()],
  resolve: {
    // 统一使用 @/ 从项目根目录导入协议模块。
    alias: { "@": fileURLToPath(new URL(".", import.meta.url)) },
  },
});
