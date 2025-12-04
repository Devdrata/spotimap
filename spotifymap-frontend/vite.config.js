import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vitejs.dev/config/
export default defineConfig({
    plugins: [react()],
    server: {
        host: '127.0.0.1',
        port: 5173,
        proxy: {
            '/api': {
                target: 'http://127.0.0.1:5000', // Redirects /api requests to Python
                changeOrigin: true,
                rewrite: (path) => path.replace(/^\/api/, '') // Removes /api prefix before sending to Python
            }
        }
    }
})