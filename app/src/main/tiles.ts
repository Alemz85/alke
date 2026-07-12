import { mkdir, readFile, writeFile } from 'fs/promises'
import { existsSync } from 'fs'
import { join } from 'path'
import { app, net, protocol } from 'electron'

// Local on-disk tile cache for a Leaflet TileLayer pointed at `healthtile://tile/{z}/{x}/{y}`.
// Cache misses are the ONLY outbound network call in the map feature, and they happen here
// in MAIN (outside the renderer CSP) — that's the privacy design. Do not move this to the
// renderer.

const TILE_SCHEME = 'healthtile'
const UPSTREAM_BASE = 'https://a.basemaps.cartocdn.com/dark_all'
const USER_AGENT = 'HealthAnalyticsApp'
const MAX_ZOOM = 20

// 1x1 transparent PNG, served whenever a tile is invalid or unavailable so the map
// degrades to a blank tile instead of a broken image.
const TRANSPARENT_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='
const TRANSPARENT_PNG = Buffer.from(TRANSPARENT_PNG_BASE64, 'base64')

function transparentTileResponse(): Response {
  return new Response(TRANSPARENT_PNG, {
    status: 200,
    headers: { 'content-type': 'image/png' }
  })
}

/**
 * Must be called at top level, before app.whenReady() — Electron requires
 * privileged-scheme registration to happen before the app is ready.
 */
export function registerTileScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: TILE_SCHEME,
      privileges: { standard: true, secure: true, supportFetchAPI: true }
    }
  ])
}

interface TileCoords {
  z: number
  x: number
  y: number
}

// A `standard` scheme URL like healthtile://tile/3/4/2 parses with host "tile" and
// pathname "/3/4/2". Parse the z/x/y out of the pathname robustly (don't trust host).
function parseTileUrl(rawUrl: string): TileCoords | null {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    return null
  }

  const parts = url.pathname.split('/').filter((segment) => segment.length > 0)
  if (parts.length < 3) return null

  const [zStr, xStr, yStr] = parts
  if (!/^\d+$/.test(zStr) || !/^\d+$/.test(xStr) || !/^\d+$/.test(yStr)) return null

  const z = Number.parseInt(zStr, 10)
  const x = Number.parseInt(xStr, 10)
  const y = Number.parseInt(yStr, 10)

  return { z, x, y }
}

// Validates z/x/y are in-range integers. This is also what prevents path traversal,
// since the on-disk cache path is built directly from these integers.
function isValidTile({ z, x, y }: TileCoords): boolean {
  if (!Number.isInteger(z) || !Number.isInteger(x) || !Number.isInteger(y)) return false
  if (z < 0 || z > MAX_ZOOM) return false
  const maxIndex = 2 ** z - 1
  if (x < 0 || x > maxIndex) return false
  if (y < 0 || y > maxIndex) return false
  return true
}

function cachePathFor({ z, x, y }: TileCoords): string {
  return join(app.getPath('userData'), 'map-tiles', String(z), String(x), `${y}.png`)
}

async function handleTileRequest(request: Request): Promise<Response> {
  try {
    const coords = parseTileUrl(request.url)
    if (!coords || !isValidTile(coords)) {
      return transparentTileResponse()
    }

    const cachePath = cachePathFor(coords)

    if (existsSync(cachePath)) {
      try {
        const cached = await readFile(cachePath)
        return new Response(cached, { status: 200, headers: { 'content-type': 'image/png' } })
      } catch (err) {
        console.error('[tiles] cache read failed, falling back to fetch:', err)
      }
    }

    const upstreamUrl = `${UPSTREAM_BASE}/${coords.z}/${coords.x}/${coords.y}.png`
    try {
      const upstreamResponse = await net.fetch(upstreamUrl, {
        headers: { 'User-Agent': USER_AGENT }
      })

      if (!upstreamResponse.ok) {
        return transparentTileResponse()
      }

      const bytes = Buffer.from(await upstreamResponse.arrayBuffer())

      try {
        await mkdir(join(app.getPath('userData'), 'map-tiles', String(coords.z), String(coords.x)), {
          recursive: true
        })
        await writeFile(cachePath, bytes)
      } catch (err) {
        console.error('[tiles] cache write failed (serving tile anyway):', err)
      }

      return new Response(bytes, { status: 200, headers: { 'content-type': 'image/png' } })
    } catch (err) {
      console.error('[tiles] upstream fetch failed:', err)
      return transparentTileResponse()
    }
  } catch (err) {
    console.error('[tiles] unexpected handler error:', err)
    return transparentTileResponse()
  }
}

/**
 * Must be called inside app.whenReady(). Registers the healthtile:// protocol handler
 * using the modern protocol.handle API (Electron >= 25; this app runs Electron 34).
 */
export function setupTileProtocol(): void {
  protocol.handle(TILE_SCHEME, handleTileRequest)
}
