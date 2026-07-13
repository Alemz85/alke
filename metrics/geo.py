"""Offline reverse-geocoding helpers for workout start coordinates.

Pure and dependency-light on purpose: only stdlib math + reverse_geocoder (an
offline kd-tree over GeoNames cities1000 that ships its own data). NO supabase
import here so scripts/importers (e.g. the RunKeeper importer, which reuses
downsample_route) can import this module without pulling in DB plumbing.
"""

from __future__ import annotations

import math

# ISO-3166-1 alpha2 -> human-readable name. A broad common set; unknown codes
# fall back to the raw code rather than raising.
_COUNTRY_NAMES: dict[str, str] = {
    "SG": "Singapore",
    "ES": "Spain",
    "IT": "Italy",
    "US": "United States",
    "GB": "United Kingdom",
    "IE": "Ireland",
    "FR": "France",
    "DE": "Germany",
    "PT": "Portugal",
    "NL": "Netherlands",
    "BE": "Belgium",
    "LU": "Luxembourg",
    "CH": "Switzerland",
    "AT": "Austria",
    "DK": "Denmark",
    "SE": "Sweden",
    "NO": "Norway",
    "FI": "Finland",
    "IS": "Iceland",
    "PL": "Poland",
    "CZ": "Czechia",
    "SK": "Slovakia",
    "HU": "Hungary",
    "RO": "Romania",
    "BG": "Bulgaria",
    "GR": "Greece",
    "HR": "Croatia",
    "SI": "Slovenia",
    "EE": "Estonia",
    "LV": "Latvia",
    "LT": "Lithuania",
    "MT": "Malta",
    "CY": "Cyprus",
    "AD": "Andorra",
    "MC": "Monaco",
    "CA": "Canada",
    "MX": "Mexico",
    "BR": "Brazil",
    "AR": "Argentina",
    "CL": "Chile",
    "CO": "Colombia",
    "PE": "Peru",
    "AU": "Australia",
    "NZ": "New Zealand",
    "JP": "Japan",
    "KR": "South Korea",
    "CN": "China",
    "HK": "Hong Kong",
    "TW": "Taiwan",
    "TH": "Thailand",
    "VN": "Vietnam",
    "PH": "Philippines",
    "ID": "Indonesia",
    "MY": "Malaysia",
    "IN": "India",
    "AE": "United Arab Emirates",
    "SA": "Saudi Arabia",
    "IL": "Israel",
    "TR": "Turkey",
    "ZA": "South Africa",
    "EG": "Egypt",
    "MA": "Morocco",
    "RU": "Russia",
    "UA": "Ukraine",
}

EARTH_RADIUS_M = 6_371_000.0


def country_name(cc: str | None) -> str | None:
    """Alpha2 country code -> human-readable name, falling back to the raw
    code when unknown (never raises, never silently drops the field)."""
    if not cc:
        return None
    return _COUNTRY_NAMES.get(cc.upper(), cc)


def haversine_m(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Great-circle distance between two lat/lon points, in meters."""
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlambda = math.radians(lon2 - lon1)
    a = math.sin(dphi / 2) ** 2 + math.cos(phi1) * math.cos(phi2) * math.sin(dlambda / 2) ** 2
    return 2 * EARTH_RADIUS_M * math.asin(min(1.0, math.sqrt(a)))


def _get(point, key, default=None):
    """Read `key` off a route point that may be a dict or an attribute-bearing
    object, so downsample_route works with either representation."""
    if isinstance(point, dict):
        return point.get(key, default)
    return getattr(point, key, default)


def _perp_distances(points: list, lat0: float, lon0: float) -> list[float]:
    """Perpendicular planar distance (in meters) of each point from the
    chord connecting the first and last point, with longitude scaled by
    cos(mean latitude) so the projection is locally planar/isotropic."""
    lats = [_get(p, "lat") for p in points]
    lons = [_get(p, "lon") for p in points]
    cos_lat = math.cos(math.radians(lat0))

    def xy(lat, lon):
        return ((lon - lon0) * cos_lat, lat - lat0)

    x0, y0 = xy(lats[0], lons[0])
    x1, y1 = xy(lats[-1], lons[-1])
    dx, dy = x1 - x0, y1 - y0
    seg_len2 = dx * dx + dy * dy

    out = []
    for lat, lon in zip(lats, lons):
        x, y = xy(lat, lon)
        if seg_len2 == 0:
            dist_deg = math.hypot(x - x0, y - y0)
        else:
            # perpendicular distance from point to the (x0,y0)-(x1,y1) line
            dist_deg = abs(dy * x - dx * y + x1 * y0 - y1 * x0) / math.sqrt(seg_len2)
        # convert degrees-equivalent planar distance to meters (1 deg lat ~ 111_320 m)
        out.append(dist_deg * 111_320.0)
    return out


def _rdp_indices(points: list, lat0: float, lon0: float, epsilon_m: float) -> list[int]:
    """Ramer-Douglas-Peucker: return the indices of points to KEEP for the
    given epsilon (meters), always keeping first and last."""
    n = len(points)
    if n <= 2:
        return list(range(n))

    keep = [False] * n
    keep[0] = keep[-1] = True
    stack = [(0, n - 1)]
    while stack:
        start, end = stack.pop()
        if end - start < 2:
            continue
        segment = points[start : end + 1]
        dists = _perp_distances(segment, lat0, lon0)
        # never re-measure against the segment's own endpoints
        local_max_i = max(range(1, len(segment) - 1), key=lambda i: dists[i], default=None)
        if local_max_i is None:
            continue
        max_dist = dists[local_max_i]
        if max_dist > epsilon_m:
            global_i = start + local_max_i
            keep[global_i] = True
            stack.append((start, global_i))
            stack.append((global_i, end))
    return [i for i, k in enumerate(keep) if k]


def downsample_route(points: list, cap: int = 300) -> list[dict]:
    """Ramer-Douglas-Peucker downsample of a route to AT MOST `cap` points,
    preserving the first/last point and the shape's turns (not every-Nth
    sampling). `points` is a list of dicts/objects each exposing `lat`, `lon`
    and optionally `elevation_m`. Longitude is scaled by cos(mean latitude)
    for a locally planar perpendicular-distance measure. Epsilon is found by
    binary search to land at <= cap points. Returns a list of dicts
    `{seq, lat, lon, elevation_m}`, re-indexed 0-based.

    This is the SHARED helper the RunKeeper importer also uses — keep the
    signature stable.
    """
    if not points:
        return []
    n = len(points)
    if n <= cap:
        return [
            {
                "seq": i,
                "lat": _get(p, "lat"),
                "lon": _get(p, "lon"),
                "elevation_m": _get(p, "elevation_m"),
            }
            for i, p in enumerate(points)
        ]

    lats = [_get(p, "lat") for p in points]
    lat0 = sum(lats) / len(lats)
    lon0 = _get(points[0], "lon")

    # binary search epsilon (meters) until the kept-point count is <= cap
    lo, hi = 0.0, 100_000.0
    best_indices = list(range(n))
    for _ in range(40):
        mid = (lo + hi) / 2
        indices = _rdp_indices(points, lat0, lon0, mid)
        if len(indices) <= cap:
            best_indices = indices
            hi = mid
        else:
            lo = mid
        if hi - lo < 1e-6:
            break

    # guard: pathological epsilon search still over cap (extremely unlikely) —
    # fall back to an even stride over the RDP-preferred indices.
    if len(best_indices) > cap:
        stride = math.ceil(len(best_indices) / cap)
        trimmed = best_indices[::stride]
        if trimmed[-1] != best_indices[-1]:
            trimmed.append(best_indices[-1])
        best_indices = trimmed

    return [
        {
            "seq": seq,
            "lat": _get(points[i], "lat"),
            "lon": _get(points[i], "lon"),
            "elevation_m": _get(points[i], "elevation_m"),
        }
        for seq, i in enumerate(best_indices)
    ]


def reverse_geocode(coords: list[tuple[float, float]]) -> list[dict]:
    """Offline reverse-geocode a batch of (lat, lon) coordinates to
    `{city, admin, country}` dicts (country is a human-readable name, not a
    code). Calls reverse_geocoder.search() ONCE for the whole batch — it
    forks/prints on first import, so per-point calls would be wasteful and
    noisy. Empty input returns []."""
    if not coords:
        return []

    import reverse_geocoder as rg

    results = rg.search(list(coords))
    return [
        {
            "city": r.get("name") or None,
            "admin": r.get("admin1") or None,
            "country": country_name(r.get("cc")),
        }
        for r in results
    ]
