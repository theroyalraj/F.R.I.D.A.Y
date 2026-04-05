import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const host = process.env.TAURI_DEV_HOST ?? 'localhost';

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host,
    hmr: host === 'localhost' ? undefined : { protocol: 'ws', host, port: 1421 },
  },
});
