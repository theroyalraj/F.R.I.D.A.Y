import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const agent = process.env.VITE_DEV_AGENT_TARGET || 'http://127.0.0.1:3847';

export default defineConfig({
  plugins: [react()],
  base: './',
  root: '.',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      input: path.resolve(__dirname, 'index.html'),
    },
  },
  server: {
    port: 5174,
    open: false,
    proxy: {
      '/voice': { target: agent, changeOrigin: true },
      '/health': { target: agent, changeOrigin: true },
      '/openclaw': { target: agent, changeOrigin: true },
    },
  },
});
