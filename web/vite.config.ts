import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"
import tailwindcss from "@tailwindcss/vite"

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    host: true,
    proxy: {
      "/api": {
        target: "http://localhost:3456",
        changeOrigin: true,
        ws: true,
      },
      "/preview": {
        target: "http://localhost:3456",
        changeOrigin: true,
      },
    },
  },
})
