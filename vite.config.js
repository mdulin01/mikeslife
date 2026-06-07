import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Build stamp (US Eastern) injected at build time so the footer can show a build number.
const build = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hour12: false,
}).format(new Date()).replace(',', '');

export default defineConfig({
  plugins: [react()],
  define: { __BUILD__: JSON.stringify(build) },
});
