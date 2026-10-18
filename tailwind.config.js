export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      fontFamily: { sans: ['DM Sans', 'sans-serif'], display: ['Manrope', 'sans-serif'] },
      colors: {
        paper: '#f7f8f4',
        ink: '#29382d',
        moss: '#4d684f',
        sage: {
          50: '#f6f8f4',
          100: '#edf2e9',
          200: '#dce6d7',
          300: '#c4d2bc',
          500: '#758b68',
          700: '#4d684f',
          900: '#29382d',
        },
        muted: '#59665b',
      },
      boxShadow: {
        card: '0 4px 18px rgb(41 56 45 / 0.06)',
        dialog: '0 24px 70px rgb(41 56 45 / 0.18)',
      },
    },
  },
  plugins: [],
}
