/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        accent: '#10b981',    /* Signal Green */
        highlight: '#f59e0b', /* Alpha Gold */
        muted: '#525252',     /* Carbon Grey */
        danger: '#ef4444',    /* Warning Red */
      },
      fontFamily: {
        inter: ['Inter', 'sans-serif'],
        mono: ['"Roboto Mono"', 'monospace'],
        display: ['"Press Start 2P"', 'cursive'],
      },
    },
  },
  plugins: [],
}
