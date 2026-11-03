/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        brand: {
          50: '#f0f8f8',
          100: '#e7f3f3',
          200: '#b9e0e2',
          300: '#84c7cc',
          400: '#4aaab3',
          500: '#20949f',
          600: '#087a86',
          700: '#08616c',
          800: '#14505a',
          900: '#18373e',
        },
        accent: {
          green: '#25774c',
          lime: '#087a86',
          cyan: '#20949f',
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
          900: '#18373e',
          700: '#35565c',
          600: '#526d73',
          500: '#5b747a',
          300: '#d7e4e6',
          100: '#f4f7f7',
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
        card: '8px',
      },
      boxShadow: {
        card: '0 1px 2px rgb(24 55 62 / 0.025)',
        'card-hover': '0 2px 6px rgb(24 55 62 / 0.05)',
      },
    },
  },
  plugins: [],
}
