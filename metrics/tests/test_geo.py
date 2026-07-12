"""Pure unit tests for metrics/geo.py — no DB, no network beyond
reverse_geocoder's own bundled offline dataset."""

from metrics.geo import downsample_route, haversine_m, reverse_geocode


def test_haversine_one_degree_latitude_near_equator():
    # 1 degree of latitude is ~111.19-111.7 km depending on location; near
    # the equator it's close to 110.6 km. Use a generous tolerance band
    # around the commonly-cited ~111 km/degree approximation.
    dist = haversine_m(0.0, 0.0, 1.0, 0.0)
    assert 110_000 < dist < 112_000


def test_haversine_zero_distance():
    assert haversine_m(48.8566, 2.3522, 48.8566, 2.3522) == 0.0


def test_downsample_route_empty():
    assert downsample_route([]) == []


def test_downsample_route_under_cap_returns_all():
    points = [{"lat": 41.0 + i * 0.001, "lon": 2.0 + i * 0.001, "elevation_m": 10.0} for i in range(5)]
    result = downsample_route(points, cap=300)
    assert len(result) == 5
    assert [p["seq"] for p in result] == [0, 1, 2, 3, 4]
    assert result[0]["lat"] == points[0]["lat"]
    assert result[-1]["lat"] == points[-1]["lat"]


def test_downsample_route_caps_and_preserves_endpoints():
    # a wiggly path with 1000 points so RDP must actually downsample
    points = []
    for i in range(1000):
        t = i / 1000
        points.append(
            {
                "lat": 41.0 + t * 0.05 + 0.001 * ((i % 7) - 3),
                "lon": 2.0 + t * 0.05,
                "elevation_m": 10.0 + i * 0.01,
            }
        )
    cap = 300
    result = downsample_route(points, cap=cap)
    assert len(result) <= cap
    assert result[0]["lat"] == points[0]["lat"]
    assert result[0]["lon"] == points[0]["lon"]
    assert result[-1]["lat"] == points[-1]["lat"]
    assert result[-1]["lon"] == points[-1]["lon"]
    # re-indexed 0-based, contiguous
    assert [p["seq"] for p in result] == list(range(len(result)))


def test_downsample_route_preserves_a_sharp_turn():
    # an L-shaped route: RDP should keep the corner point even though it's
    # collinear-adjacent to many redundant points on each straight leg.
    points = [{"lat": 41.0, "lon": 2.0 + i * 0.0001, "elevation_m": None} for i in range(50)]
    corner = {"lat": 41.0, "lon": 2.0 + 49 * 0.0001, "elevation_m": None}
    points.append(corner)
    points += [{"lat": 41.0 + i * 0.0001, "lon": corner["lon"], "elevation_m": None} for i in range(1, 50)]
    result = downsample_route(points, cap=10)
    assert len(result) <= 10
    lats = [p["lat"] for p in result]
    lons = [p["lon"] for p in result]
    # the corner's lon (max lon reached) should be represented near the turn
    assert max(lons) >= corner["lon"] - 1e-9
    assert max(lats) >= points[-1]["lat"] - 1e-9


def test_reverse_geocode_empty_input():
    assert reverse_geocode([]) == []


def test_reverse_geocode_japan():
    results = reverse_geocode([(35.6762, 139.6503)])
    assert len(results) == 1
    assert results[0]["country"] == "Japan"
    assert results[0]["city"]


def test_reverse_geocode_spain():
    results = reverse_geocode([(37.3891, -5.9845)])
    assert len(results) == 1
    assert results[0]["country"] == "Spain"
    assert results[0]["city"]


def test_reverse_geocode_italy():
    results = reverse_geocode([(44.4949, 11.3426)])
    assert len(results) == 1
    assert results[0]["country"] == "Italy"
    assert results[0]["city"]


def test_reverse_geocode_batch_preserves_order():
    coords = [(35.6762, 139.6503), (37.3891, -5.9845), (44.4949, 11.3426)]
    results = reverse_geocode(coords)
    assert [r["country"] for r in results] == ["Japan", "Spain", "Italy"]
