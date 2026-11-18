import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const target = new URL(process.env.PULSO_WORKER_ORIGIN ?? 'http://127.0.0.1:8787')
  if (target.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname) ||
    target.username || target.password || target.pathname !== '/' || target.search || target.hash) {
    throw new Error('PULSO_WORKER_ORIGIN debe ser un origen HTTP de loopback.')
  }
  return {
    plugins: [react()],
    // El sandbox no carga el .env del proyecto operativo.
    envDir: mode === 'pulso-local' ? false : undefined,
    server: { proxy: { '^/api/pulso(?:\\?|$)': {
      target: target.origin, changeOrigin: true,
      configure(proxy) {
        proxy.on('proxyReq', (outgoing, incoming) => {
          // Traducir solo un Origin propio; conservar el rechazo de orígenes ajenos.
          if (incoming.headers.origin === `http://${incoming.headers.host}`) {
            outgoing.setHeader('Origin', target.origin)
          }
        })
      },
    } } },
    preview: { proxy: {} },
  }
})
