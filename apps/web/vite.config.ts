import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(({ mode }) => {
  const apiProxy = loadEnv(mode, ".", "DEV_").DEV_API_PROXY;
  return {
    plugins: [react()],
    server: apiProxy
      ? { proxy: { "/api": { target: apiProxy, changeOrigin: true } } }
      : undefined,
  };
});
