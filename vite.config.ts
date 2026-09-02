import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  base: "./",
  build: {
    outDir: "dist/webview",
    emptyOutDir: false,
    sourcemap: process.argv.includes("--watch"),
    rollupOptions: {
      input: "src/webview/index.html",
      output: {
        entryFileNames: "assets/webview.js",
        chunkFileNames: "assets/webview-[name].js",
        assetFileNames: "assets/webview[extname]"
      }
    }
  }
});
