import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  plugins: [react()],
  root: '.',
  server: {
    port: 5173,
    open: false,
    proxy: {
      '/voice': {
        target: 'http://127.0.0.1:3847',
        changeOrigin: true,
        configure: (proxy) => {
          // ECONNRESET on SSE streams is expected when pc-agent restarts; suppress the noise.
          proxy.on('error', (err: NodeJS.ErrnoException) => {
            if (err.code === 'ECONNRESET' || err.code === 'ECONNREFUSED') return;
            console.error('[proxy error]', err.message);
          });
        },
      },
      '/auth': {
        target: 'http://127.0.0.1:3847',
        changeOrigin: true,
      },
      '/organization': {
        target: 'http://127.0.0.1:3847',
        changeOrigin: true,
      },
      '/health': {
        target: 'http://127.0.0.1:3847',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    rollupOptions: {
      input: path.resolve(__dirname, 'index.html'),
      output: {
        dir: 'dist',
        entryFileNames: 'listen.js',
        chunkFileNames: 'chunk-[hash].js',
        assetFileNames: '[name].[ext]',
      },
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
});
