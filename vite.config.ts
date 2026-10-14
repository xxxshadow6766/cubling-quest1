import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The dev game server always runs on port 3000 (see the dev:server script).
const backend = `http://localhost:${process.env.DEV_SERVER_PORT || 3000}`;

export default defineConfig({
  root: 'client',
  plugins: [react()],
  server: {
    port: 5173,
    host: true,
    fs: { allow: ['..'] },
    // In development the game server runs separately; proxy keeps everything same-origin
    // so the HttpOnly guest cookie works for both HTTP and WebSocket requests.
    proxy: {
      '/api': backend,
      '/socket.io': { target: backend, ws: true },
    },
  },
  build: {
    outDir: '../dist/client',
    emptyOutDir: true,
    chunkSizeWarningLimit: 1500,
  },
});
