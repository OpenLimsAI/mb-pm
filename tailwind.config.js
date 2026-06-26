/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        brand: {
          50: '#eff6ff',
          100: '#dbeafe',
          200: '#bfdbfe',
          300: '#93c5fd',
          400: '#60a5fa',
          500: '#3b82f6',
          600: '#2563eb',
          700: '#1d4ed8',
          800: '#1e40af',
          900: '#1e3a8a',
        },
        health: {
          green: '#10b981',
          yellow: '#f59e0b',
          red: '#ef4444',
        },
        load: {
          low: '#10b981',
          mid: '#f59e0b',
          high: '#ef4444',
        },
        ink: {
          900: '#0f172a',
          700: '#334155',
          500: '#64748b',
          300: '#cbd5e1',
          100: '#f1f5f9',
        },
      },
      fontFamily: {
        sans: [
          '"PingFang SC"',
          '"Microsoft YaHei"',
          '-apple-system',
          'BlinkMacSystemFont',
          '"Segoe UI"',
          'Roboto',
          'sans-serif',
        ],
      },
      borderRadius: {
        card: '12px',
      },
      boxShadow: {
        card: '0 1px 3px 0 rgb(0 0 0 / 0.06), 0 1px 2px -1px rgb(0 0 0 / 0.08)',
        'card-hover': '0 4px 12px -2px rgb(0 0 0 / 0.08), 0 2px 4px -1px rgb(0 0 0 / 0.06)',
      },
    },
  },
  plugins: [],
}
