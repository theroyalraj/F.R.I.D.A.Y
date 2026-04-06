import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

/** Split-stack: Listen UI on localhost; API/SSE go to pc-agent (local or ngrok tunnel). */
function agentProxyTarget(mode: string) {
  const rootEnv = path.resolve(__dirname, '..');
  const env = loadEnv(mode, rootEnv, '');
  const raw = (env.PC_AGENT_URL || 'http://127.0.0.1:3847').replace(/\/$/, '');
  return raw;
}

export default defineConfig(({ mode }) => {
  const agentTarget = agentProxyTarget(mode);
  const proxyCommon = { target: agentTarget, changeOrigin: true } as const;
  return {
  plugins: [react()],
  root: '.',
  // Load repo-root .env so VITE_* keys (e.g. mini orb hide) ship with `vite build`.
  envDir: path.resolve(__dirname, '..'),
  server: {
    port: 5173,
    open: false,
    proxy: {
      '/voice': {
        target: agentTarget,
        changeOrigin: true,
        configure: (proxy) => {
          // ECONNRESET on SSE streams is expected when pc-agent restarts; suppress the noise.
          proxy.on('error', (err: NodeJS.ErrnoException) => {
            if (err.code === 'ECONNRESET' || err.code === 'ECONNREFUSED') return;
            console.error('[proxy error]', err.message);
          });
        },
      },
      '/auth': { ...proxyCommon },
      '/organization': { ...proxyCommon },
      '/health': { ...proxyCommon },
      '/integrations': { ...proxyCommon },
      '/settings': { ...proxyCommon },
      '/openclaw': { ...proxyCommon },
      '/todos': { ...proxyCommon },
      '/security': { ...proxyCommon },
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
};
});
