/// <reference types="vitest/config" />
import { fileURLToPath, URL } from "node:url"
import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  build: {
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            { name: "solana", test: /node_modules[\\/](@solana|@wallet-standard)/ },
            { name: "react", test: /node_modules[\\/](react|react-dom|react-router|scheduler|@tanstack)[\\/]/ },
            { name: "ui", test: /node_modules[\\/](@base-ui|@floating-ui|sonner|lucide-react)/ },
          ],
        },
      },
    },
  },
  server: { port: 5190, strictPort: false },
  preview: { port: 5191 },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
})
