/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        brand: {
          50: 'rgb(var(--forest-brand-50) / <alpha-value>)',
          100: 'rgb(var(--forest-brand-100) / <alpha-value>)',
          200: 'rgb(var(--forest-brand-200) / <alpha-value>)',
          300: 'rgb(var(--forest-brand-300) / <alpha-value>)',
          400: 'rgb(var(--forest-brand-400) / <alpha-value>)',
          500: 'rgb(var(--forest-brand-500) / <alpha-value>)',
          600: 'rgb(var(--forest-brand-600) / <alpha-value>)',
          700: 'rgb(var(--forest-brand-700) / <alpha-value>)',
          800: 'rgb(var(--forest-brand-800) / <alpha-value>)',
          900: 'rgb(var(--forest-brand-900) / <alpha-value>)',
        },
        accent: {
          green: 'var(--workbench-brand)',
          lime: 'var(--workbench-brand)',
          cyan: 'var(--workbench-brand)',
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
          900: 'rgb(var(--forest-ink-900) / <alpha-value>)',
          700: 'rgb(var(--forest-ink-700) / <alpha-value>)',
          600: 'rgb(var(--forest-ink-600) / <alpha-value>)',
          500: 'rgb(var(--forest-ink-500) / <alpha-value>)',
          300: 'rgb(var(--forest-ink-300) / <alpha-value>)',
          100: 'rgb(var(--forest-ink-100) / <alpha-value>)',
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
        card: '0 2px 10px rgb(30 70 107 / 0.025)',
        'card-hover': '0 4px 16px rgb(30 70 107 / 0.06)',
      },
    },
  },
  plugins: [],
}
