// Shared between page.tsx (main preview) and template-rail.tsx (thumbnails) —
// both scale the same base A4-at-96dpi document via CSS transform: scale(),
// just at different target widths.

export const ZOOM_LEVELS = [50, 65, 75, 90, 100, 110, 125, 150]
export const PREVIEW_BASE_WIDTH = 794
export const PREVIEW_BASE_HEIGHT = 1123
