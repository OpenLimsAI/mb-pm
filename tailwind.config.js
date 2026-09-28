/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        brand: {
          50: '#eef9fc',
          100: '#d8f0f6',
          200: '#afe2ed',
          300: '#78cddd',
          400: '#32b7cf',
          500: '#0699ba',
          600: '#087b9c',
          700: '#11617e',
          800: '#23486f',
          900: '#103c58',
        },
        accent: {
          green: '#25774c',
          lime: '#78bf43',
          cyan: '#08b4d1',
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
          900: '#263e4a',
          700: '#405965',
          600: '#536c78',
          500: '#586f7b',
          300: '#cfdbdf',
          100: '#edf1f3',
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
        card: '0 2px 8px rgb(21 77 112 / 0.045)',
        'card-hover': '0 6px 18px rgb(21 77 112 / 0.10)',
      },
    },
  },
  plugins: [],
}
