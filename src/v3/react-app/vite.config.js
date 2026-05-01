import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const proxyTarget = process.env.VITE_PROXY_TARGET || 'http://127.0.0.1:8001'

export default defineConfig({
  plugins: [react()],
  base: './',  // Relative paths work for both dev (port 3000) and production (/agents/ route)
  build: {
    outDir: '../../../static/v3',
    emptyOutDir: true,
  },
  server: {
    port: 3000,
    strictPort: true,
    host: '0.0.0.0',  // Listen on all interfaces for Docker
    proxy: {
      // Main App (trading floor, WebSocket, scenes) - port 8001
      '/trading-floor': {
        target: proxyTarget,
        ws: true,
        changeOrigin: true,
        configure: (proxy, _options) => {
          proxy.on('error', (err, _req, _res) => {
            // Suppress harmless ECONNABORTED errors (closed connections)
            if (err?.code === 'ECONNABORTED' || err?.message?.includes('write')) {
              return; // Don't log closed connection errors
            }
            console.log('proxy error', err);
          });
          proxy.on('proxyReqWs', (proxyReq, req, socket) => {
            // Only log WebSocket connections, not errors
            socket.on('error', (socketErr) => {
              if (socketErr?.code !== 'ECONNABORTED') {
                console.log('WebSocket socket error:', socketErr.message);
              }
            });
          });
        },
      },
      // Admin API routes - port 8001
      '/api/admin': {
        target: proxyTarget,
        changeOrigin: true,
      },
      // Static assets (like gossip_quotes.json)
      '/static': {
        target: proxyTarget,
        changeOrigin: true,
      },
      // Agents routes and static assets - port 8001
      '/agents': {
        target: proxyTarget,
        changeOrigin: true,
      },
      // Dynamic Gossip Quotes
      '/gossip_quotes.json': {
        target: proxyTarget,
        changeOrigin: true,
      },
      // General API - port 8001
      '/api': {
        target: proxyTarget,
        changeOrigin: true,
      },
    },
  },
})
