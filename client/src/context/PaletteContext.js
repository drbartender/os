import { createContext, useContext } from 'react';

// Lets any admin surface (Header, the shared Toolbar) open the Cmd/Ctrl+K
// command palette without prop-drilling through the page tree. AdminLayout
// provides the value: { openPalette }.
const PaletteContext = createContext(null);

export function usePalette() {
  const ctx = useContext(PaletteContext);
  if (!ctx) throw new Error('usePalette must be used within AdminLayout');
  return ctx;
}

export default PaletteContext;
