import { useEffect, useRef, useState } from 'react'
import * as maplibregl from 'maplibre-gl'
import type { Map as MapLibreMap, ExpressionSpecification, GeoJSONSource, MapLayerMouseEvent, StyleSpecification } from 'maplibre-gl'
import type { Feature, FeatureCollection, MultiLineString, Point, Position } from 'geojson'
import { feature } from 'topojson-client'
import type { GeometryCollection, Topology } from 'topojson-specification'
import atlas from 'world-atlas/countries-110m.json'
import 'maplibre-gl/dist/maplibre-gl.css'
import { HERO_MAP_COLORS, MAP_COLORS, MAP_SIGNAL_COLORS, STATIONS, type SignalCountry } from './theme'

type CountryProperties = { name: string }

const topology = atlas as unknown as Topology
const countryObject = topology.objects.countries as GeometryCollection<CountryProperties>
const countries = feature<CountryProperties>(topology, countryObject)
const signalCountries = Object.keys(STATIONS) as SignalCountry[]
const mapLabel = 'World globe. Drag to turn, then click a glowing country. To choose a country with the keyboard, use the country buttons beside the globe.'

const isSignalCountry = (country: string): country is SignalCountry => signalCountries.includes(country as SignalCountry)

type StationProperties = { country: SignalCountry; color: string; selected: boolean }
type RouteProperties = { from: SignalCountry; to: SignalCountry }
type HeroNodeProperties = { country: SignalCountry; role: 'origin' | 'destination' }

const stationCollection = (selected: string | string[], availableCountries: SignalCountry[]): FeatureCollection<Point, StationProperties> => {
  const selectedCountries = Array.isArray(selected) ? selected : [selected]
  return {
  type: 'FeatureCollection',
  features: availableCountries.map((country) => {
    const station = STATIONS[country]
    return {
      type: 'Feature' as const,
      properties: { country, color: MAP_SIGNAL_COLORS[country], selected: selectedCountries.includes(country) },
      geometry: { type: 'Point' as const, coordinates: station.center },
    }
  }),
  }
}

const toRadians = (degrees: number) => degrees * Math.PI / 180
const toDegrees = (radians: number) => radians * 180 / Math.PI

const greatCirclePoints = ([startLongitude, startLatitude]: [number, number], [endLongitude, endLatitude]: [number, number]): Position[] => {
  const startLon = toRadians(startLongitude)
  const startLat = toRadians(startLatitude)
  const endLon = toRadians(endLongitude)
  const endLat = toRadians(endLatitude)
  const start = [Math.cos(startLat) * Math.cos(startLon), Math.cos(startLat) * Math.sin(startLon), Math.sin(startLat)]
  const end = [Math.cos(endLat) * Math.cos(endLon), Math.cos(endLat) * Math.sin(endLon), Math.sin(endLat)]
  const angle = Math.acos(Math.min(1, Math.max(-1, start[0] * end[0] + start[1] * end[1] + start[2] * end[2])))
  if (angle < 0.000001) return [[startLongitude, startLatitude], [endLongitude, endLatitude]]
  if (Math.PI - angle < toRadians(3)) return []
  const angleSine = Math.sin(angle)

  return Array.from({ length: 49 }, (_, index) => {
    const progress = index / 48
    const startWeight = Math.sin((1 - progress) * angle) / angleSine
    const endWeight = Math.sin(progress * angle) / angleSine
    const x = start[0] * startWeight + end[0] * endWeight
    const y = start[1] * startWeight + end[1] * endWeight
    const z = start[2] * startWeight + end[2] * endWeight
    return [toDegrees(Math.atan2(y, x)), toDegrees(Math.atan2(z, Math.hypot(x, y)))]
  })
}

const splitAtAntimeridian = (points: Position[]): Position[][] => {
  if (points.length === 0) return []
  const lines: Position[][] = [[points[0]]]

  for (const point of points.slice(1)) {
    const line = lines[lines.length - 1]
    const previous = line[line.length - 1]
    const longitudeJump = Math.abs(point[0] - previous[0])
    if (Math.abs(longitudeJump - 180) < 0.001) return []
    if (longitudeJump < 180) {
      line.push(point)
      continue
    }

    const boundary = previous[0] > 0 ? 180 : -180
    const adjustedLongitude = point[0] + (previous[0] > 0 ? 360 : -360)
    const crossingProgress = (boundary - previous[0]) / (adjustedLongitude - previous[0])
    const crossingLatitude = previous[1] + (point[1] - previous[1]) * crossingProgress
    line.push([boundary, crossingLatitude])
    lines.push([[-boundary, crossingLatitude], point])
  }

  return lines
}

const routeFeature = (from: SignalCountry, to: SignalCountry): Feature<MultiLineString, RouteProperties> | null => {
  const coordinates = splitAtAntimeridian(greatCirclePoints(STATIONS[from].center, STATIONS[to].center))
  if (coordinates.length === 0) return null
  return {
    type: 'Feature',
    properties: { from, to },
    geometry: { type: 'MultiLineString', coordinates },
  }
}

const routeCollection = (selected: string, availableCountries: SignalCountry[]): FeatureCollection<MultiLineString, RouteProperties> => {
  const anchor = availableCountries.find((country) => country === selected)
  if (!anchor) return { type: 'FeatureCollection', features: [] }

  return {
    type: 'FeatureCollection',
    features: availableCountries.filter((country) => country !== anchor).flatMap((country) => {
      const route = routeFeature(anchor, country)
      return route ? [route] : []
    }),
  }
}

const heroRouteSequence = (availableCountries: SignalCountry[]): FeatureCollection<MultiLineString, RouteProperties> => {
  const preferredPairs: [SignalCountry, SignalCountry][] = [
    ['Portugal', 'Argentina'],
    ['Japan', 'New Zealand'],
    ['Ghana', 'Japan'],
    ['Argentina', 'New Zealand'],
  ]
  return {
    type: 'FeatureCollection',
    features: preferredPairs.flatMap(([from, to]) => {
      if (!availableCountries.includes(from) || !availableCountries.includes(to)) return []
      const route = routeFeature(from, to)
      return route ? [route] : []
    }),
  }
}

const heroNodeCollection = (route?: Feature<MultiLineString, RouteProperties>): FeatureCollection<Point, HeroNodeProperties> => ({
  type: 'FeatureCollection',
  features: route ? ([
    { country: route.properties.from, role: 'origin' as const },
    { country: route.properties.to, role: 'destination' as const },
  ]).map(({ country, role }) => ({
    type: 'Feature' as const,
    properties: { country, role },
    geometry: { type: 'Point' as const, coordinates: STATIONS[country].center },
  })) : [],
})

const emptyPointCollection = (): FeatureCollection<Point> => ({ type: 'FeatureCollection', features: [] })

const trimRoute = (route: Feature<MultiLineString, RouteProperties>, progress: number): Feature<MultiLineString, RouteProperties> => {
  const lines = route.geometry.coordinates
  const segmentCount = lines.reduce((total, line) => total + Math.max(0, line.length - 1), 0)
  let remaining = Math.max(0, Math.min(1, progress)) * segmentCount
  const coordinates: Position[][] = []

  for (const line of lines) {
    if (remaining <= 0 || line.length < 2) break
    const availableSegments = line.length - 1
    const wholeSegments = Math.min(availableSegments, Math.floor(remaining))
    const partial = line.slice(0, wholeSegments + 1)
    const fraction = Math.min(1, remaining - wholeSegments)
    if (wholeSegments < availableSegments && fraction > 0) {
      const start = line[wholeSegments]
      const end = line[wholeSegments + 1]
      partial.push([
        start[0] + (end[0] - start[0]) * fraction,
        start[1] + (end[1] - start[1]) * fraction,
      ])
    }
    if (partial.length === 1) partial.push(partial[0])
    coordinates.push(partial)
    remaining -= availableSegments
  }

  return {
    ...route,
    geometry: { ...route.geometry, coordinates },
  }
}

const routePoint = (route: Feature<MultiLineString, RouteProperties>, progress: number): Position => {
  const drawn = trimRoute(route, Math.max(0.001, progress)).geometry.coordinates
  const lastLine = drawn[drawn.length - 1]
  return lastLine?.[lastLine.length - 1] ?? STATIONS[route.properties.from].center
}

const routeMidpoint = (route: Feature<MultiLineString, RouteProperties>): [number, number] => {
  const points = route.geometry.coordinates.flat()
  const midpoint = points[Math.floor(points.length / 2)] ?? STATIONS[route.properties.from].center
  // Keep the horizon human-readable. Great-circle midpoints can sit near a pole,
  // which makes the planet look like a target instead of a recognizable Earth.
  return [midpoint[0], 16]
}

const heroStyle = (
  availableCountries: SignalCountry[],
  activeRoutes: FeatureCollection<MultiLineString, RouteProperties>,
  routeBeds: FeatureCollection<MultiLineString, RouteProperties>,
): StyleSpecification => ({
  version: 8,
  projection: { type: 'globe' },
  sources: {
    countries: { type: 'geojson', data: countries },
    'connection-beds': { type: 'geojson', data: routeBeds },
    'connection-routes': { type: 'geojson', data: activeRoutes },
    'station-nodes': { type: 'geojson', data: stationCollection([], availableCountries) },
    'active-route-nodes': { type: 'geojson', data: heroNodeCollection() },
    'route-traveler': { type: 'geojson', data: emptyPointCollection() },
  },
  layers: [
    {
      id: 'space',
      type: 'background',
      paint: { 'background-color': 'rgba(7,31,28,0)' },
    },
    {
      id: 'country-glow',
      type: 'line',
      source: 'countries',
      paint: {
        'line-color': HERO_MAP_COLORS.countryGlow,
        'line-width': 2,
        'line-blur': 4,
        'line-opacity': 0.08,
      },
    },
    {
      id: 'countries-fill',
      type: 'fill',
      source: 'countries',
      paint: {
        'fill-color': HERO_MAP_COLORS.land,
        'fill-opacity': 0.96,
        'fill-outline-color': HERO_MAP_COLORS.landOutline,
      },
    },
    {
      id: 'country-borders',
      type: 'line',
      source: 'countries',
      paint: {
        'line-color': HERO_MAP_COLORS.border,
        'line-width': 0.75,
        'line-opacity': 0.16,
      },
    },
    {
      id: 'connection-route-beds',
      type: 'line',
      source: 'connection-beds',
      paint: {
        'line-color': HERO_MAP_COLORS.connection,
        'line-width': 0.8,
        'line-opacity': 0.045,
      },
    },
    {
      id: 'connection-route-glow',
      type: 'line',
      source: 'connection-routes',
      paint: {
        'line-color': HERO_MAP_COLORS.connection,
        'line-width': 9,
        'line-blur': 7,
        'line-opacity': 0.3,
      },
    },
    {
      id: 'connection-route-active',
      type: 'line',
      source: 'connection-routes',
      paint: {
        'line-color': HERO_MAP_COLORS.connection,
        'line-width': 2.6,
        'line-opacity': 0.94,
      },
    },
    {
      id: 'station-nodes-halo',
      type: 'circle',
      source: 'station-nodes',
      paint: {
        'circle-color': HERO_MAP_COLORS.porchLight,
        'circle-radius': 9,
        'circle-blur': 0.68,
        'circle-opacity': 0.26,
      },
    },
    {
      id: 'station-nodes-core',
      type: 'circle',
      source: 'station-nodes',
      paint: {
        'circle-color': HERO_MAP_COLORS.porchLight,
        'circle-radius': 3,
        'circle-stroke-color': HERO_MAP_COLORS.nodeStroke,
        'circle-stroke-width': 0.8,
        'circle-opacity': 0.8,
      },
    },
    {
      id: 'active-route-nodes-halo',
      type: 'circle',
      source: 'active-route-nodes',
      paint: {
        'circle-color': ['case', ['==', ['get', 'role'], 'destination'], HERO_MAP_COLORS.arrival, HERO_MAP_COLORS.porchLight],
        'circle-radius': ['case', ['==', ['get', 'role'], 'destination'], 12, 9],
        'circle-blur': 0.62,
        'circle-opacity': 0.58,
      },
    },
    {
      id: 'active-route-nodes-core',
      type: 'circle',
      source: 'active-route-nodes',
      paint: {
        'circle-color': ['case', ['==', ['get', 'role'], 'destination'], HERO_MAP_COLORS.arrival, HERO_MAP_COLORS.porchLight],
        'circle-radius': 3.5,
        'circle-stroke-color': HERO_MAP_COLORS.nodeStroke,
        'circle-stroke-width': 1.2,
        'circle-opacity': 1,
      },
    },
    {
      id: 'route-traveler-halo',
      type: 'circle',
      source: 'route-traveler',
      paint: {
        'circle-color': '#ffffff',
        'circle-radius': 8,
        'circle-blur': 0.64,
        'circle-opacity': 0.72,
      },
    },
    {
      id: 'route-traveler-core',
      type: 'circle',
      source: 'route-traveler',
      paint: {
        'circle-color': '#ffffff',
        'circle-radius': 2.1,
        'circle-opacity': 1,
      },
    },
  ],
})

const colorExpression = (selected: string, availableCountries: SignalCountry[], availableColor?: string): ExpressionSpecification => {
  const match: unknown[] = ['match', ['get', 'name']]
  for (const country of signalCountries) {
    if (availableCountries.includes(country)) match.push(country, availableColor ?? MAP_SIGNAL_COLORS[country])
  }
  match.push(MAP_COLORS.emptyLand)

  if (!selected || selected === 'Anywhere') return match as ExpressionSpecification
  if (!isSignalCountry(selected) || !availableCountries.includes(selected)) return match as ExpressionSpecification
  return [
    'case',
    ['==', ['get', 'name'], selected],
    MAP_COLORS.selectedLand,
    match,
  ] as unknown as ExpressionSpecification
}

export function WorldPicker({ selected, availableCountries, onSelect }: { selected: string; availableCountries: SignalCountry[]; onSelect: (country: string) => void }) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const mapRef = useRef<MapLibreMap | null>(null)
  const onSelectRef = useRef(onSelect)
  const [mapLoaded, setMapLoaded] = useState(false)

  useEffect(() => {
    onSelectRef.current = onSelect
  }, [onSelect])

  useEffect(() => {
    if (!containerRef.current) return

    const map = new maplibregl.Map({
      container: containerRef.current,
      attributionControl: false,
      center: [5, 18],
      zoom: 1.6,
      minZoom: 0.55,
      maxZoom: 4.2,
      maxPitch: 0,
      dragRotate: true,
      pitchWithRotate: false,
      renderWorldCopies: false,
      style: {
        version: 8,
        projection: { type: 'globe' },
        sources: {
          countries: {
            type: 'geojson',
            data: countries,
          },
          'connection-routes': {
            type: 'geojson',
            data: routeCollection('', availableCountries),
          },
          'station-nodes': {
            type: 'geojson',
            data: stationCollection('', availableCountries),
          },
        },
        layers: [
          {
            id: 'space',
            type: 'background',
            paint: { 'background-color': 'rgba(7,31,28,0)' },
          },
          {
            id: 'country-glow',
            type: 'line',
            source: 'countries',
            paint: {
              'line-color': MAP_COLORS.countryGlow,
              'line-width': 3,
              'line-blur': 5,
              'line-opacity': 0.18,
            },
          },
          {
            id: 'countries-fill',
            type: 'fill',
            source: 'countries',
            paint: {
              'fill-color': colorExpression('', availableCountries),
              'fill-opacity': 0.96,
              'fill-outline-color': MAP_COLORS.landOutline,
            },
          },
          {
            id: 'country-borders',
            type: 'line',
            source: 'countries',
            paint: {
              'line-color': MAP_COLORS.border,
              'line-width': 0.8,
              'line-opacity': 0.5,
            },
          },
          {
            id: 'connection-routes-glow',
            type: 'line',
            source: 'connection-routes',
            paint: {
              'line-color': MAP_COLORS.connection,
              'line-width': 5,
              'line-blur': 7,
              'line-opacity': 0.2,
            },
          },
          {
            id: 'connection-routes-line',
            type: 'line',
            source: 'connection-routes',
            paint: {
              'line-color': MAP_COLORS.connection,
              'line-width': 1.35,
              'line-opacity': 0.72,
              'line-dasharray': [2, 2.4],
            },
          },
          {
            id: 'station-nodes-halo',
            type: 'circle',
            source: 'station-nodes',
            paint: {
              'circle-color': ['get', 'color'],
              'circle-radius': ['case', ['get', 'selected'], 13, 9],
              'circle-blur': 0.55,
              'circle-opacity': 0.42,
            },
          },
          {
            id: 'station-nodes-core',
            type: 'circle',
            source: 'station-nodes',
            paint: {
              'circle-color': ['get', 'color'],
              'circle-radius': ['case', ['get', 'selected'], 6, 4],
              'circle-stroke-color': MAP_COLORS.nodeStroke,
              'circle-stroke-width': ['case', ['get', 'selected'], 2.5, 1.5],
              'circle-opacity': 1,
            },
          },
        ],
      },
    })

    mapRef.current = map
    setMapLoaded(false)
    map.getCanvas().setAttribute('aria-label', mapLabel)
    map.once('load', () => {
      if (mapRef.current !== map) return
      map.setSky({
        'sky-color': MAP_COLORS.sky,
        'horizon-color': MAP_COLORS.horizon,
        'fog-color': MAP_COLORS.fog,
        'fog-ground-blend': 0.25,
        'horizon-fog-blend': 0.82,
        'sky-horizon-blend': 0.75,
        'atmosphere-blend': 0.88,
      })
      setMapLoaded(true)
    })
    map.on('error', (event) => console.warn('[world receiver]', event.error ?? event))

    map.on('click', 'countries-fill', (event: MapLayerMouseEvent) => {
      const country = event.features?.[0]?.properties?.name
      if (typeof country === 'string') onSelectRef.current(country)
    })
    map.on('click', 'station-nodes-core', (event: MapLayerMouseEvent) => {
      const country = event.features?.[0]?.properties?.country
      if (typeof country === 'string') onSelectRef.current(country)
    })
    map.on('mouseenter', 'countries-fill', () => {
      map.getCanvas().style.cursor = 'crosshair'
    })
    map.on('mouseleave', 'countries-fill', () => {
      map.getCanvas().style.cursor = 'grab'
    })

    return () => {
      map.remove()
      mapRef.current = null
    }
  }, [])

  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    const apply = () => {
      if (mapRef.current !== map) return
      if (!map.getLayer('countries-fill')) return
      map.setPaintProperty('countries-fill', 'fill-color', colorExpression(selected, availableCountries))
      ;(map.getSource('connection-routes') as GeoJSONSource | undefined)?.setData(routeCollection(selected, availableCountries))
      ;(map.getSource('station-nodes') as GeoJSONSource | undefined)?.setData(stationCollection(selected, availableCountries))
      const center = isSignalCountry(selected) ? STATIONS[selected].center : undefined
      const camera = {
        center: center ?? [5, 18],
        zoom: center ? 1.85 : 1.6,
      } as const
      if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) map.jumpTo(camera)
      else map.flyTo({ ...camera, duration: 900, essential: false })
    }
    // Wait for the one-time 'load' event (tracked as state so this effect
    // re-runs); once the style is up, always apply the latest selection
    // directly — a `once('load', …)` registered after load has fired would
    // silently drop the update.
    if (mapLoaded) apply()
  }, [availableCountries, mapLoaded, selected])

  return (
    <div className={`world-picker ${selected !== 'Anywhere' ? 'has-selection' : ''}`}>
      <div className="world-picker__map" ref={containerRef} />
      <div className="world-picker__hint">Drag the globe · choose a glowing place</div>
    </div>
  )
}

export function HeroGlobe({ availableCountries }: { availableCountries: SignalCountry[] }) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const mapRef = useRef<MapLibreMap | null>(null)
  const firstRoute = heroRouteSequence(availableCountries).features[0]
  const [activeRoute, setActiveRoute] = useState<RouteProperties | null>(firstRoute?.properties ?? null)
  const [isReady, setIsReady] = useState(false)
  const [captionVisible, setCaptionVisible] = useState(false)
  const countriesKey = availableCountries.join('|')

  useEffect(() => {
    if (!containerRef.current) return

    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    const narrowScreen = window.matchMedia('(max-width: 640px)').matches
    const heroZoom = narrowScreen ? 1.5 : 1.85
    const heroRoutes = heroRouteSequence(availableCountries)
    const currentRoute = heroRoutes.features[0]
    const emptyRoutes: FeatureCollection<MultiLineString, RouteProperties> = { type: 'FeatureCollection', features: [] }
    const initialCenter = currentRoute ? routeMidpoint(currentRoute) : [-20, 18] as [number, number]

    setActiveRoute(currentRoute?.properties ?? null)
    setIsReady(false)
    setCaptionVisible(false)

    const map = new maplibregl.Map({
      container: containerRef.current,
      attributionControl: false,
      center: initialCenter,
      zoom: heroZoom,
      minZoom: 0.7,
      maxZoom: 2.4,
      maxPitch: 0,
      dragRotate: false,
      pitchWithRotate: false,
      interactive: false,
      renderWorldCopies: false,
      style: heroStyle(availableCountries, reducedMotion && currentRoute ? { type: 'FeatureCollection', features: [currentRoute] } : emptyRoutes, heroRoutes),
    })

    mapRef.current = map
    const canvas = map.getCanvas()
    canvas.setAttribute('tabindex', '-1')
    canvas.setAttribute('aria-hidden', 'true')
    canvas.style.pointerEvents = 'none'

    const routeData = (route?: Feature<MultiLineString, RouteProperties>): FeatureCollection<MultiLineString, RouteProperties> => ({
      type: 'FeatureCollection',
      features: route ? [route] : [],
    })
    const travelerData = (position?: Position): FeatureCollection<Point> => ({
      type: 'FeatureCollection',
      features: position ? [{ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: position } }] : [],
    })

    let animationFrame = 0
    let previousFrame = performance.now()
    let timeline = 0
    let routeIndex = -1
    let lastRouteProgress = -1
    let nodesShown = false
    let captionShown = false
    let visible = true
    let styleReady = false
    const cycleDuration = 12_000

    const animate = (now: number) => {
      animationFrame = window.requestAnimationFrame(animate)
      if (!visible || document.hidden || !styleReady || heroRoutes.features.length === 0) {
        previousFrame = now
        return
      }
      if (now - previousFrame < 34) return
      const elapsed = Math.min(now - previousFrame, 60)
      previousFrame = now
      timeline += elapsed

      const nextRouteIndex = Math.floor(timeline / cycleDuration) % heroRoutes.features.length
      const phase = timeline % cycleDuration
      const route = heroRoutes.features[nextRouteIndex]

      if (nextRouteIndex !== routeIndex) {
        routeIndex = nextRouteIndex
        lastRouteProgress = -1
        nodesShown = false
        captionShown = false
        setActiveRoute(route.properties)
        setCaptionVisible(false)
        ;(map.getSource('connection-routes') as GeoJSONSource | undefined)?.setData(emptyRoutes)
        ;(map.getSource('active-route-nodes') as GeoJSONSource | undefined)?.setData(heroNodeCollection())
        ;(map.getSource('route-traveler') as GeoJSONSource | undefined)?.setData(emptyPointCollection())
        map.setPaintProperty('connection-route-active', 'line-opacity', 0.94)
        map.setPaintProperty('connection-route-glow', 'line-opacity', 0.22)
        map.setPaintProperty('active-route-nodes-halo', 'circle-opacity', 0.58)
        map.setPaintProperty('active-route-nodes-core', 'circle-opacity', 1)
        map.easeTo({ center: routeMidpoint(route), zoom: heroZoom, duration: 2200, essential: false })
      }

      if (phase >= 1500 && !nodesShown) {
        nodesShown = true
        ;(map.getSource('active-route-nodes') as GeoJSONSource | undefined)?.setData(heroNodeCollection(route))
      }

      const routeProgress = Math.max(0, Math.min(1, (phase - 3000) / 2000))
      if (routeProgress > 0 && Math.abs(routeProgress - lastRouteProgress) >= 0.012) {
        lastRouteProgress = routeProgress
        ;(map.getSource('connection-routes') as GeoJSONSource | undefined)?.setData(routeData(trimRoute(route, routeProgress)))
        ;(map.getSource('route-traveler') as GeoJSONSource | undefined)?.setData(routeProgress < 1 ? travelerData(routePoint(route, routeProgress)) : emptyPointCollection())
      }

      if (phase >= 5200 && !captionShown) {
        captionShown = true
        setCaptionVisible(true)
      }

      if (phase >= 5200 && phase <= 6500) {
        const arrivalPulse = Math.sin(((phase - 5200) / 1300) * Math.PI)
        map.setPaintProperty('active-route-nodes-halo', 'circle-radius', [
          'case',
          ['==', ['get', 'role'], 'destination'],
          12 + arrivalPulse * 7,
          9,
        ])
      }

      const fade = Math.max(0, Math.min(1, (phase - 9300) / 2100))
      if (fade > 0) {
        map.setPaintProperty('connection-route-active', 'line-opacity', 0.94 * (1 - fade))
        map.setPaintProperty('connection-route-glow', 'line-opacity', 0.22 * (1 - fade))
        map.setPaintProperty('active-route-nodes-halo', 'circle-opacity', 0.58 * (1 - fade))
        map.setPaintProperty('active-route-nodes-core', 'circle-opacity', 1 - fade)
        if (fade > 0.35 && captionShown) {
          captionShown = false
          setCaptionVisible(false)
        }
      }

      if (phase > 2400) {
        const center = map.getCenter()
        map.setCenter([center.lng - elapsed * 0.00225, center.lat])
      }
    }

    const applySky = () => {
      if (mapRef.current !== map) return
      map.setSky({
        'sky-color': HERO_MAP_COLORS.sky,
        'horizon-color': HERO_MAP_COLORS.horizon,
        'fog-color': HERO_MAP_COLORS.fog,
        'fog-ground-blend': 0.12,
        'horizon-fog-blend': 0.74,
        'sky-horizon-blend': 0.66,
        'atmosphere-blend': 0.82,
      })
      styleReady = true
      setIsReady(true)
      if (currentRoute && reducedMotion) {
        ;(map.getSource('active-route-nodes') as GeoJSONSource | undefined)?.setData(heroNodeCollection(currentRoute))
        ;(map.getSource('connection-routes') as GeoJSONSource | undefined)?.setData(routeData(currentRoute))
        map.jumpTo({ center: routeMidpoint(currentRoute), zoom: heroZoom })
        setActiveRoute(currentRoute.properties)
        setCaptionVisible(true)
      } else if (!reducedMotion) {
        previousFrame = performance.now()
        animationFrame = window.requestAnimationFrame(animate)
      }
    }
    const handleError = (event: { error?: unknown }) => console.warn('[hero globe]', event.error ?? event)
    const observer = typeof IntersectionObserver === 'undefined'
      ? null
      : new IntersectionObserver(([entry]) => {
        visible = entry?.isIntersecting ?? true
        previousFrame = performance.now()
      }, { threshold: 0.12 })

    map.once('load', applySky)
    map.on('error', handleError)
    observer?.observe(containerRef.current)

    return () => {
      window.cancelAnimationFrame(animationFrame)
      observer?.disconnect()
      map.off('load', applySky)
      map.off('error', handleError)
      map.remove()
      mapRef.current = null
    }
  }, [countriesKey])

  const routeLabel = activeRoute
    ? `${activeRoute.from} and ${activeRoute.to} are connected`
    : availableCountries.length > 0
      ? `Someone in ${availableCountries[0]} is awake`
      : 'The world is quiet'

  return (
    <div className={`hero-globe ${isReady ? 'is-ready' : ''} ${captionVisible ? 'is-caption-visible' : ''}`} role="img" aria-label={`A slowly moving globe. ${routeLabel}.`}>
      <div className="hero-globe__map" ref={containerRef} />
      <div className="hero-globe__vignette" aria-hidden="true" />
      <div className="hero-route-caption" aria-hidden="true">
        <span>{activeRoute ? `${activeRoute.from} ↔ ${activeRoute.to}` : 'Around the world'}</span>
        <strong>{activeRoute ? 'Two people are awake at once.' : 'Someone interesting is awake.'}</strong>
      </div>
    </div>
  )
}
