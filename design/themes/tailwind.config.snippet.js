// Nocturne Green — Tailwind theme extension.
// Keep tokens.css as the source of truth; this mirrors it for utility classes.

module.exports = {
  theme: {
    extend: {
      colors: {
        bg:      { DEFAULT: '#09101c', lift: '#172a46', ink: '#05070d', panel: '#0b1120' },
        accent:  { DEFAULT: '#72f0b4', soft: '#a5f7d0', ink: '#06120c' },
        text:    { DEFAULT: '#eae8e3', hi: '#ffffff', 2: '#9aa9bd', 3: '#8a99ad', mute: '#7a8da6', faint: '#39445a' },
        warn:    '#e0a83a',
        danger:  '#f0726f',
        info:    '#6fa8f0',
      },
      fontFamily: {
        display: ['Cormorant Garamond', 'Georgia', 'serif'],
        body:    ['DM Sans', 'system-ui', 'sans-serif'],
        mono:    ['DM Mono', 'ui-monospace', 'monospace'],
      },
      fontSize: {
        display: ['104px', { lineHeight: '1.15' }],
        h1: ['48px', { lineHeight: '1.15' }],
        h2: ['34px', { lineHeight: '1.15' }],
        h3: ['22px', { lineHeight: '1.2' }],
        lead: ['17px', { lineHeight: '1.6' }],
        label: ['11px', { letterSpacing: '0.14em' }],
      },
      borderRadius: { sm: '11px', md: '14px', lg: '16px', xl: '20px' },
      borderColor: { DEFAULT: 'rgba(255,255,255,0.07)', strong: 'rgba(255,255,255,0.12)' },
      boxShadow: {
        sm: '0 8px 24px -8px rgba(0,0,0,0.5)',
        md: '0 12px 32px -8px rgba(0,0,0,0.6)',
        lg: '0 16px 48px -12px rgba(0,0,0,0.7)',
        glow: '0 0 24px rgba(114,240,180,0.35)',
        'glow-strong': '0 0 48px rgba(114,240,180,0.45)',
        btn: '0 8px 24px -8px rgba(114,240,180,0.6)',
      },
      backgroundImage: {
        page: 'radial-gradient(circle at 50% -20%, #172a46 0%, #09101c 70%)',
        surface: 'linear-gradient(135deg, rgba(20,27,42,0.75), rgba(10,14,26,0.5))',
      },
      transitionTimingFunction: { DEFAULT: 'cubic-bezier(0.4,0,0.2,1)' },
    },
  },
};
