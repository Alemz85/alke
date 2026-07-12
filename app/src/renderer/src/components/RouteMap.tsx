import { useEffect, type ReactElement } from 'react'
import { MapContainer, Polyline, TileLayer, useMap } from 'react-leaflet'
import type { LatLngBoundsExpression, LatLngTuple } from 'leaflet'
import type { RoutePoint, WorkoutGeo } from '@shared/types'
import 'leaflet/dist/leaflet.css'
import './RouteMap.css'

export interface RouteMapProps {
  route: RoutePoint[]
  geo: WorkoutGeo | null
}

// Locally-cached CARTO dark tiles served by the healthtile:// protocol
// registered in Electron main (see app/src/main/index.ts) — no network calls,
// CSP already allows healthtile: in img-src.
const TILE_URL = 'healthtile://tile/{z}/{x}/{y}'
const TILE_ATTRIBUTION = '&copy; OpenStreetMap contributors &copy; CARTO'

function locationLabel(geo: WorkoutGeo | null): string | null {
  if (!geo) return null
  const { city, country, admin } = geo
  if (city && country) {
    // Only append admin (state/region) when it adds information beyond the city name.
    if (admin && admin !== city) return `${city}, ${admin}, ${country}`
    return `${city}, ${country}`
  }
  return city ?? country ?? null
}

// Fits the map viewport to the route's bounds once, after the map mounts.
function FitBounds({ bounds }: { bounds: LatLngBoundsExpression }): null {
  const map = useMap()
  useEffect(() => {
    map.fitBounds(bounds, { padding: [16, 16] })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map])
  return null
}

export function RouteMap({ route, geo }: RouteMapProps): ReactElement | null {
  if (route.length === 0) return null

  const positions: LatLngTuple[] = route.map((p) => [p.lat, p.lon])
  const bounds: LatLngBoundsExpression = positions

  const label = locationLabel(geo)

  return (
    <div className="route-map">
      {label && <div className="route-map-label">{label}</div>}
      <div className="route-map-container">
        <MapContainer
          center={positions[0]}
          zoom={13}
          scrollWheelZoom={false}
          className="route-map-leaflet"
        >
          <TileLayer url={TILE_URL} maxZoom={20} attribution={TILE_ATTRIBUTION} />
          <Polyline positions={positions} pathOptions={{ className: 'route-line' }} />
          <FitBounds bounds={bounds} />
        </MapContainer>
      </div>
    </div>
  )
}
