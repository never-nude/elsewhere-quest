export const BRAND_COLORS = {
  phosphor: '#ffd85a',
  tuning: '#33c9c1',
  postmark: '#ff6d52',
  radioMagenta: '#f45fa6',
  airmailBlue: '#6674d8',
} as const

export const STATIONS = {
  Portugal: { color: BRAND_COLORS.phosphor, center: [-8, 39.5] as [number, number] },
  Ghana: { color: BRAND_COLORS.tuning, center: [-1.2, 7.9] as [number, number] },
  Japan: { color: BRAND_COLORS.postmark, center: [138, 37] as [number, number] },
  Argentina: { color: BRAND_COLORS.radioMagenta, center: [-64, -34] as [number, number] },
  'New Zealand': { color: BRAND_COLORS.airmailBlue, center: [172, -41] as [number, number] },
} as const

export type SignalCountry = keyof typeof STATIONS

// Brightened variants for fills on the night-indigo globe, where the base
// brand colors (especially the periwinkle) sink into the dark land.
export const MAP_SIGNAL_COLORS: Record<SignalCountry, string> = {
  Portugal: '#ffdd70',
  Ghana: '#40ded4',
  Japan: '#ff8266',
  Argentina: '#ff74b5',
  'New Zealand': '#95a1f5',
}

export const MAP_COLORS = {
  emptyLand: '#2c3564',
  selectedLand: '#fff3d6',
  landOutline: '#141a3d',
  border: '#5a66b0',
  countryGlow: '#6674d8',
  connection: '#59e0d6',
  nodeStroke: '#fff6e3',
  sky: '#0a0e22',
  horizon: '#7d88e7',
  fog: '#39448f',
} as const

export const HERO_MAP_COLORS = {
  land: '#242e59',
  landOutline: '#242e59',
  border: '#5f6aad',
  countryGlow: '#6674d8',
  connection: '#59e0d6',
  porchLight: '#ffc966',
  arrival: '#ff8a6b',
  nodeStroke: '#fff6e3',
  sky: '#060915',
  horizon: '#6d7ade',
  fog: '#2a3572',
} as const
