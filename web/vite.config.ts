import path from "path"
import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"
import tailwindcss from "@tailwindcss/vite"

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          "vendor-react": ["react", "react-dom", "react-router-dom"],
          "vendor-ui": ["@base-ui/react", "cmdk", "sonner"],
          "vendor-xterm": ["@xterm/xterm", "@xterm/addon-fit", "@xterm/addon-web-links"],
          "vendor-markdown": ["react-markdown", "remark-gfm", "remark-breaks"],
        },
      },
    },
  },
  server: {
    host: true,
    proxy: {
      "/api": {
        target: process.env.VITE_API_URL || "http://localhost:3456",
        changeOrigin: true,
        ws: true,
      },
      "/preview": {
        target: process.env.VITE_API_URL || "http://localhost:3456",
        changeOrigin: true,
      },
    },
  },
})
