'use client';

import { BedDouble } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Map, { Layer, Marker, Popup, Source, type MapRef } from 'react-map-gl/mapbox';
import Supercluster from 'supercluster';
import 'mapbox-gl/dist/mapbox-gl.css';
import { amapLinks, getCategory, googleMapsUrl, type SavedPlace } from '@/app/projects/tripplanner/_components/placeTypes';
import { inMainlandChina, toGcj02, toWgs84 } from '@/lib/trip/chinaCoords';

const MAPBOX_TOKEN = process.env.NEXT_PUBLIC_TRIP_MAPBOX_TOKEN!;

// Area labels (whole neighbourhoods) only appear once you're zoomed in enough to care.
const AREA_LABEL_MIN_ZOOM = 12.5;

export interface FocusRequest {
  lat: number;
  lng: number;
  zoom?: number;
  nonce: number; // bump to re-trigger the same location
}

interface Props {
  places: SavedPlace[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onInfo: (place: SavedPlace) => void;
  fitKey: string;               // when this changes, the map re-fits to `places`
  focus?: FocusRequest | null;
  hidePopup?: boolean;            // highlight the selected pin without opening its card (search results)
  showGeocoder?: boolean;
  fallbackQuery?: string;      // where to look when there are no pins yet, e.g. "Hong Kong"
  hotels?: HotelPin[];         // where you're staying: always shown, never clustered
  popupAction?: { label: string; onClick: (place: SavedPlace) => void } | null; // extra button in a pin's popup
  route?: RoutePoint[] | null;  // the selected day: start, numbered stops, end, joined by a line
  routeDay?: string;
  plannedOn?: globalThis.Map<string, string>; // place id -> "Sat 24": already in the schedule, shown faded            // which day the route belongs to: a new day re-frames, an edit only if needed
  onReady?: () => void;         // the map has loaded and fitted to its places
  me?: { lat: number; lng: number; accuracy: number } | null; // your phone's position: blue dot
  locateStatus?: 'off' | 'asking' | 'on' | 'denied' | 'unavailable';
  onLocate?: () => void;        // turn location on (the browser asks for permission once)
}

export interface RoutePoint { lat: number; lng: number; label: string | null; airport?: boolean } // label null = start/end, not numbered

export interface HotelPin { name: string; lat: number; lng: number }

type Pt = [number, number];

// Frame where most places are. A lone far-away place (e.g. one restaurant out in
// the New Territories) shouldn't zoom the whole map out; it's still there if you pan.
function corePoints(pts: Pt[]): Pt[] {
  if (pts.length < 5) return pts;
  const median = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
  const mLng = median(pts.map(p => p[0]));
  const mLat = median(pts.map(p => p[1]));
  const dist = (p: Pt) => Math.hypot(p[0] - mLng, p[1] - mLat);
  const sorted = pts.map(dist).sort((a, b) => a - b);
  const p75 = sorted[Math.floor(sorted.length * 0.75)];
  const limit = Math.max(p75 * 2.5, 0.01);
  const core = pts.filter(p => dist(p) <= limit);
  return core.length >= 2 ? core : pts;
}

function fitToPlaces(map: MapRef, places: SavedPlace[], animate: boolean) {
  const pts = corePoints(places.filter(p => p.geo).map(p => [p.geo!.lng, p.geo!.lat] as Pt));
  if (pts.length === 0) return;
  if (pts.length === 1) {
    map.flyTo({ center: pts[0], zoom: 15, duration: animate ? 800 : 0 });
    return;
  }
  const lngs = pts.map(p => p[0]);
  const lats = pts.map(p => p[1]);
  map.fitBounds(
    [[Math.min(...lngs), Math.min(...lats)], [Math.max(...lngs), Math.max(...lats)]],
    { padding: 48, maxZoom: 15, duration: animate ? 800 : 0 },
  );
}

// Placeholder view while places load. `stillWanted` is checked after the lookup returns:
// if the real places arrived meanwhile, the placeholder must not override them.
async function centerOnQuery(map: MapRef, query: string, stillWanted: () => boolean) {
  try {
    const res = await fetch(`https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(query)}.json?types=place,region,country&limit=1&access_token=${MAPBOX_TOKEN}`);
    const data = await res.json();
    const center = data?.features?.[0]?.center;
    if (center && stillWanted()) map.jumpTo({ center, zoom: 11 });
  } catch { /* keep default view */ }
}

interface PointProps { id: string; mustGo: number; planned: number; cats: Record<string, number> }
interface ClusterProps { mustGo: number; planned: number; cats: Record<string, number> }

// Stored coordinates in mainland China are Google's GCJ-02 (see chinaCoords).
// China trips use Amap's own map, which is drawn on that same grid and far more detailed there
// than Mapbox: places are drawn as stored, and only your phone's GPS (WGS-84) is converted.
// Elsewhere it's Mapbox (WGS-84); any China places in a mixed list are converted to fit it.
const AMAP_STYLE = {
  version: 8 as const,
  sources: {
    amap: {
      type: 'raster' as const,
      tiles: ['1', '2', '3', '4'].map(n => `https://wprd0${n}.is.autonavi.com/appmaptile?x={x}&y={y}&z={z}&lang=en&size=1&scl=1&style=7`),
      tileSize: 256,
      maxzoom: 18,
      attribution: '© AutoNavi (Amap)',
    },
  },
  layers: [{ id: 'amap', type: 'raster' as const, source: 'amap' }],
};

export function PlacesMap(props: Props) {
  const { places, hotels, route, focus, me } = props;
  const amap = useMemo(() => {
    const pins = places.filter(p => p.geo);
    return pins.length > 0 && pins.filter(p => inMainlandChina(p.geo!.lat, p.geo!.lng)).length * 2 >= pins.length;
  }, [places]);
  const conv = useMemo(() => amap ? places : places.map(p => {
    if (!p.geo) return p;
    const w = toWgs84(p.geo.lat, p.geo.lng);
    return w.lat === p.geo.lat && w.lng === p.geo.lng ? p : { ...p, geo: { ...p.geo, ...w } };
  }), [places, amap]);
  const convHotels = useMemo(() => amap ? hotels : hotels?.map(h => ({ ...h, ...toWgs84(h.lat, h.lng) })), [hotels, amap]);
  const convRoute = useMemo(() => amap ? route : route?.map(r => ({ ...r, ...toWgs84(r.lat, r.lng) })) ?? route, [route, amap]);
  const convFocus = useMemo(() => !amap && focus ? { ...focus, ...toWgs84(focus.lat, focus.lng) } : focus, [focus, amap]);
  const convMe = useMemo(() => amap && me ? { ...me, ...toGcj02(me.lat, me.lng) } : me, [me, amap]);
  return <PlacesMapInner {...props} places={conv} hotels={convHotels} route={convRoute} focus={convFocus} me={convMe} amapBase={amap} />;
}

function PlacesMapInner({ places, selectedId, onSelect, onInfo, fitKey, focus, showGeocoder, fallbackQuery, hotels = [], popupAction, route, routeDay, plannedOn, onReady, me, locateStatus, onLocate, amapBase = false, hidePopup = false }: Props & { amapBase?: boolean }) {
  const mapRef = useRef<MapRef | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const loaded = useRef(false);
  const lastFocus = useRef<FocusRequest | null>(null);
  const placesRef = useRef(places);
  placesRef.current = places;

  const [view, setView] = useState<{ bounds: [number, number, number, number]; zoom: number } | null>(null);

  const mappable = useMemo(() => places.filter(p => p.geo), [places]);
  const byId = useMemo(() => new globalThis.Map(mappable.map(p => [p.id, p])), [mappable]);
  const selected = selectedId ? byId.get(selectedId) ?? null : null;
  const areas = mappable.filter(p => p.category === 'Area');

  // Everything except areas and the selected place gets grouped when pins overlap.
  const index = useMemo(() => {
    const sc = new Supercluster<PointProps, ClusterProps>({
      radius: 44,
      maxZoom: 17,
      map: props => ({ mustGo: props.mustGo, planned: props.planned, cats: { ...props.cats } }),
      reduce: (acc, props) => {
        acc.mustGo += props.mustGo;
        acc.planned += props.planned;
        // Copy before adding: supercluster shares this object between zoom levels.
        const cats = { ...acc.cats };
        for (const [k, v] of Object.entries(props.cats)) cats[k] = (cats[k] ?? 0) + v;
        acc.cats = cats;
      },
    });
    sc.load(mappable
      .filter(p => p.category !== 'Area' && p.id !== selectedId)
      .map(p => ({
        type: 'Feature' as const,
        geometry: { type: 'Point' as const, coordinates: [p.geo!.lng, p.geo!.lat] },
        properties: { id: p.id, mustGo: p.must_go ? 1 : 0, planned: plannedOn?.has(p.id) ? 1 : 0, cats: { [getCategory(p.category).color]: 1 } },
      })));
    return sc;
  }, [mappable, selectedId, plannedOn]);

  const clusters = view ? index.getClusters(view.bounds, Math.floor(view.zoom)) : [];

  const syncView = useCallback(() => {
    const map = mapRef.current;
    if (!map) return;
    const b = map.getBounds();
    if (!b) return;
    setView({ bounds: [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()], zoom: map.getZoom() });
  }, []);

  // Frame the day's route. Switching day always re-frames; adding or moving a stop only moves
  // the map when a stop is out of view, so the zoom stays put while you build a day.
  // Airports are left out of the framing (the line still runs there): they can be an hour away.
  const routeKey = route && route.length >= 2 ? route.map(r => `${r.lat.toFixed(4)},${r.lng.toFixed(4)}`).join('|') : '';
  const framedDay = useRef<string | undefined>(undefined);
  useEffect(() => {
    const map = mapRef.current;
    if (!routeKey || !route || !loaded.current || !map) return;
    if ((containerRef.current?.clientWidth ?? 0) === 0) return;
    const nonAirport = route.filter(r => !r.airport);
    const pts = nonAirport.length ? nonAirport : route;
    const newDay = framedDay.current !== routeDay;
    framedDay.current = routeDay;
    if (!newDay) {
      const b = map.getBounds();
      if (b && pts.every(p => b.contains([p.lng, p.lat]))) return;
    }
    if (pts.length === 1) {
      map.easeTo({ center: [pts[0].lng, pts[0].lat], zoom: Math.max(map.getZoom(), 13), duration: 800 });
      return;
    }
    const lngs = pts.map(r => r.lng);
    const lats = pts.map(r => r.lat);
    map.fitBounds([[Math.min(...lngs), Math.min(...lats)], [Math.max(...lngs), Math.max(...lats)]],
      { padding: 64, maxZoom: 15, duration: 800 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routeKey, routeDay]);
  const routeLine = useMemo(() => (route && route.length >= 2 ? {
    type: 'Feature' as const,
    properties: {},
    geometry: { type: 'LineString' as const, coordinates: route.map(r => [r.lng, r.lat]) },
  } : null), [route]);

  // Re-fit when the caller says the set of places meaningfully changed (trip loaded, filter changed...).
  useEffect(() => {
    // A day route frames itself (see above), so don't override it with all places.
    if (loaded.current && mapRef.current && !routeKey) fitToPlaces(mapRef.current, placesRef.current, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fitKey]);

  useEffect(() => {
    if (!focus) return;
    lastFocus.current = focus;
    if (mapRef.current) {
      mapRef.current.flyTo({ center: [focus.lng, focus.lat], zoom: focus.zoom ?? 16, duration: 900 });
    }
  }, [focus]);

  // "Locate me": fly to the blue dot, or switch location on and fly once the first fix arrives.
  const flyToMe = useRef(false);
  const [locateNote, setLocateNote] = useState<string | null>(null);
  function locate() {
    if (me && mapRef.current) {
      mapRef.current.flyTo({ center: [me.lng, me.lat], zoom: Math.max(mapRef.current.getZoom(), 15), duration: 900 });
      return;
    }
    flyToMe.current = true;
    onLocate?.();
  }
  useEffect(() => {
    if (me && flyToMe.current && mapRef.current) {
      flyToMe.current = false;
      mapRef.current.flyTo({ center: [me.lng, me.lat], zoom: Math.max(mapRef.current.getZoom(), 15), duration: 900 });
    }
  }, [me]);
  useEffect(() => {
    if (!flyToMe.current) return;
    if (locateStatus === 'denied') { flyToMe.current = false; setLocateNote('Location is blocked. Allow it for this site in your browser settings.'); }
    else if (locateStatus === 'unavailable') { flyToMe.current = false; setLocateNote("Couldn't find your location."); }
    else return;
    const t = setTimeout(() => setLocateNote(null), 4000);
    return () => clearTimeout(t);
  }, [locateStatus]);

  // On mobile the map lives behind a tab and starts at 0x0. When it becomes
  // visible, resize it and frame either the requested place or all places.
  useEffect(() => {
    const el = containerRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    let wasHidden = el.clientWidth === 0;
    const ro = new ResizeObserver(() => {
      const map = mapRef.current;
      if (!map || !loaded.current) return;
      const hidden = el.clientWidth === 0 || el.clientHeight === 0;
      if (hidden) { wasHidden = true; return; }
      map.resize();
      if (wasHidden) {
        wasHidden = false;
        const f = lastFocus.current;
        if (f && Date.now() - f.nonce < 3000) {
          map.jumpTo({ center: [f.lng, f.lat], zoom: f.zoom ?? 16 });
        } else {
          fitToPlaces(map, placesRef.current, false);
        }
        syncView();
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [syncView]);

  const onReadyRef = useRef(onReady);
  onReadyRef.current = onReady;
  const handleLoad = useCallback(async () => {
    const map = mapRef.current;
    if (!map) { onReadyRef.current?.(); return; }
    loaded.current = true;
    if (!placesRef.current.some(p => p.geo) && fallbackQuery) {
      await centerOnQuery(map, fallbackQuery, () => !placesRef.current.some(p => p.geo));
      if (placesRef.current.some(p => p.geo)) fitToPlaces(map, placesRef.current, false);
    } else if ((containerRef.current?.clientWidth ?? 0) > 0) {
      fitToPlaces(map, placesRef.current, false);
    }
    syncView();
    if (showGeocoder) {
      const raw = map.getMap();
      const MapboxGeocoder = (await import('@mapbox/mapbox-gl-geocoder')).default;
      await import('@mapbox/mapbox-gl-geocoder/dist/mapbox-gl-geocoder.css');
      raw.addControl(
        new MapboxGeocoder({ accessToken: MAPBOX_TOKEN, mapboxgl: raw.constructor as never, placeholder: 'Search any city...', marker: false }),
        'top-right',
      );
    }
    onReadyRef.current?.();
  }, [showGeocoder, fallbackQuery, syncView]);

  const showAreas = (view?.zoom ?? 0) >= AREA_LABEL_MIN_ZOOM;

  return (
    <div ref={containerRef} className="relative h-full w-full">
    {onLocate && (
      <div className="absolute right-3 top-3 z-10 flex flex-col items-end gap-2">
        <button onClick={locate} aria-label="Show my location" title="Show my location"
          className={`flex h-10 w-10 items-center justify-center rounded-full bg-white shadow-md ring-1 ring-black/5 transition hover:bg-gray-50 ${me ? 'text-sky-500' : 'text-gray-600'}`}>
          {locateStatus === 'asking'
            ? <span className="h-4 w-4 animate-spin rounded-full border-2 border-sky-200 border-t-sky-500" />
            : <svg className="h-5 w-5" viewBox="0 0 24 24" fill={me ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth={1.8} strokeLinejoin="round"><path d="M21 3L3 10.5l7.5 3 3 7.5L21 3z" /></svg>}
        </button>
        {locateNote && <p className="max-w-[220px] rounded-lg bg-gray-900 px-3 py-2 text-xs text-white shadow-lg">{locateNote}</p>}
      </div>
    )}
    <Map
      ref={mapRef}
      mapboxAccessToken={MAPBOX_TOKEN}
      onLoad={handleLoad}
      onMoveEnd={syncView}
      onClick={() => onSelect(null)}
      initialViewState={{ longitude: 103.8198, latitude: 1.3521, zoom: 11 }}
      style={{ width: '100%', height: '100%' }}
      mapStyle={amapBase ? AMAP_STYLE : 'mapbox://styles/mapbox/streets-v12'}
      maxZoom={amapBase ? 18 : 22}
    >
      {/* The selected day's route: straight dashed line in visiting order */}
      {routeLine && (
        <Source id="day-route" type="geojson" data={routeLine}>
          <Layer id="day-route-line" type="line"
            layout={{ 'line-join': 'round', 'line-cap': 'round' }}
            paint={{ 'line-color': '#0f172a', 'line-opacity': 0.6, 'line-width': 3, 'line-dasharray': [1.2, 1.6] }} />
        </Source>
      )}

      {/* Neighbourhood labels sit underneath everything else */}
      {showAreas && areas.map(place => {
        const isSelected = place.id === selectedId;
        return (
          <Marker key={place.id} longitude={place.geo!.lng} latitude={place.geo!.lat} anchor="center" style={{ zIndex: 0 }}
            onClick={e => { e.originalEvent.stopPropagation(); onSelect(place.id); }}>
            <div className={`flex cursor-pointer items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-semibold backdrop-blur-sm ${
              isSelected ? 'bg-sky-500 text-white' : 'bg-white/75 text-slate-600'}`}
              style={{ boxShadow: '0 1px 3px rgba(0,0,0,0.15)' }}>
              {getCategory('Area').emoji} {place.name}{place.must_go && <span className={isSelected ? '' : 'text-amber-500'}>★</span>}
            </div>
          </Marker>
        );
      })}

      {clusters.map(feature => {
        const [lng, lat] = feature.geometry.coordinates;
        const props = feature.properties as (PointProps | (ClusterProps & { cluster: true; cluster_id: number; point_count: number }));

        if ('cluster' in props && props.cluster) {
          const count = props.point_count;
          const size = count < 5 ? 34 : count < 15 ? 40 : 46;
          // Ring shows the mix of categories inside, biggest share first.
          const parts = Object.entries(props.cats).sort((a, b) => b[1] - a[1]);
          let acc = 0;
          const stops = parts.map(([color, n]) => {
            const from = (acc / count) * 360; acc += n;
            return `${color} ${from}deg ${(acc / count) * 360}deg`;
          }).join(', ');
          return (
            <Marker key={`c${props.cluster_id}`} longitude={lng} latitude={lat} anchor="center" style={{ zIndex: 3 }}
              onClick={e => {
                e.originalEvent.stopPropagation();
                const zoom = Math.min(index.getClusterExpansionZoom(props.cluster_id), 17);
                mapRef.current?.flyTo({ center: [lng, lat], zoom, duration: 600 });
              }}>
              <div className="relative cursor-pointer rounded-full p-[3px] shadow-md"
                title={props.planned === count ? 'All already in your schedule' : undefined}
                style={{ width: size, height: size, background: `conic-gradient(${stops})`, opacity: props.planned === count ? 0.4 : 1 }}>
                <div className="flex h-full w-full items-center justify-center rounded-full bg-white text-sm font-bold text-gray-800">{count}</div>
                {props.mustGo > 0 && (
                  <span className="absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-amber-400 px-1 text-[9px] font-bold text-white ring-2 ring-white">★{props.mustGo > 1 ? props.mustGo : ''}</span>
                )}
              </div>
            </Marker>
          );
        }

        const place = byId.get((props as PointProps).id);
        return place ? <Pin key={place.id} place={place} isSelected={false} onSelect={onSelect} plannedOn={plannedOn?.get(place.id)} /> : null;
      })}

      {hotels.map(h => (
        <Marker key={`hotel-${h.lat},${h.lng}`} longitude={h.lng} latitude={h.lat} anchor="center" style={{ zIndex: 4 }}>
          <div title={h.name} aria-label={h.name}
            className="flex h-8 w-8 items-center justify-center rounded-full border-2 border-white bg-gray-900 text-white"
            style={{ boxShadow: '0 2px 6px rgba(0,0,0,0.35)' }}>
            <BedDouble className="h-4 w-4" strokeWidth={1.75} aria-hidden />
          </div>
        </Marker>
      ))}

      {me && (
        <Marker longitude={me.lng} latitude={me.lat} anchor="center" style={{ zIndex: 15 }}>
          <div className="pointer-events-none relative flex h-[18px] w-[18px] items-center justify-center" title="You are here">
            <span className="absolute h-9 w-9 animate-ping rounded-full bg-sky-400/30" style={{ animationDuration: '2.4s' }} />
            <span className="h-[18px] w-[18px] rounded-full border-[3px] border-white bg-sky-500" style={{ boxShadow: '0 1px 4px rgba(0,0,0,0.35)' }} />
          </div>
        </Marker>
      )}

      {selected && selected.category !== 'Area' && <Pin place={selected} isSelected onSelect={onSelect} />}

      {route?.filter(r => r.label).map((r, i) => (
        <Marker key={`route-${i}-${r.lat},${r.lng}`} longitude={r.lng} latitude={r.lat} anchor="bottom" offset={[-15, -26]} style={{ zIndex: 12 }}>
          <div className="pointer-events-none flex h-5 min-w-5 items-center justify-center rounded-full bg-gray-900 px-1 text-[11px] font-bold text-white ring-2 ring-white">
            {r.label}
          </div>
        </Marker>
      ))}

      {selected && selected.geo && !hidePopup && (
        <Popup longitude={selected.geo.lng} latitude={selected.geo.lat} anchor="top" offset={8}
          onClose={() => onSelect(null)} closeOnClick={false} closeButton={false} maxWidth="270px"
          style={{ zIndex: 20 }}>
          <div className="space-y-1.5 p-1">
            <div className="flex items-start justify-between gap-2">
              <p className="text-sm font-semibold leading-snug text-gray-900">
                {selected.must_go && <span className="mr-1 text-amber-500">★</span>}{selected.name}
              </p>
              <button onClick={() => onSelect(null)} aria-label="Close" className="-mr-1 -mt-0.5 rounded-sm p-0.5 text-gray-400 hover:text-gray-600">
                <svg className="h-4 w-4" viewBox="0 0 20 20" fill="currentColor"><path fillRule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clipRule="evenodd" /></svg>
              </button>
            </div>
            <p className="flex items-center gap-1.5 text-xs text-gray-500">
              <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: getCategory(selected.category).color }} />
              {getCategory(selected.category).label}{selected.neighbourhood ? ` · ${selected.neighbourhood}` : ''}
            </p>
            {selected.description
              ? <p className="text-xs leading-relaxed text-gray-600">{selected.description}</p>
              : selected.vibe && <p className="text-xs italic text-gray-400">{selected.vibe}</p>}
            {popupAction && (
              <button onClick={() => popupAction.onClick(selected)}
                className="mt-1 w-full rounded-md bg-sky-500 px-2 py-1.5 text-xs font-semibold text-white hover:bg-sky-600">
                {popupAction.label}
              </button>
            )}
            <div className="flex gap-1.5 pt-1">
              <button onClick={() => onInfo(selected)} className="flex-1 rounded-md bg-gray-900 px-2 py-1.5 text-xs font-medium text-white hover:bg-gray-800">Details</button>
              {(() => {
                // The map draws converted coordinates; Amap wants the original (China grid) ones.
                const amap = amapLinks(amapBase ? selected : { ...selected, geo: { ...selected.geo!, ...toGcj02(selected.geo!.lat, selected.geo!.lng) } });
                return amap ? (
                  <a href={amap.app}
                    className="flex-1 rounded-md border border-gray-200 px-2 py-1.5 text-center text-xs font-medium text-gray-700 hover:bg-gray-50">Amap</a>
                ) : (
                  <a href={googleMapsUrl(selected)} target="_blank" rel="noopener noreferrer"
                    className="flex-1 rounded-md border border-gray-200 px-2 py-1.5 text-center text-xs font-medium text-gray-700 hover:bg-gray-50">Google Maps</a>
                );
              })()}
            </div>
          </div>
        </Popup>
      )}
    </Map>
    </div>
  );
}

function Pin({ place, isSelected, onSelect, plannedOn }: { place: SavedPlace; isSelected: boolean; onSelect: (id: string) => void; plannedOn?: string }) {
  const cat = getCategory(place.category);
  return (
    <Marker longitude={place.geo!.lng} latitude={place.geo!.lat} anchor="bottom"
      style={{ zIndex: isSelected ? 10 : plannedOn ? 2 : place.must_go ? 5 : 4 }}
      onClick={e => { e.originalEvent.stopPropagation(); onSelect(place.id); }}>
      <div className="relative cursor-pointer transition-[transform,opacity]" title={plannedOn ? `Planned: ${plannedOn}` : undefined}
        style={{ transform: isSelected ? 'scale(1.25)' : undefined, opacity: plannedOn && !isSelected ? 0.35 : 1 }}>
        <div
          className="flex h-8 w-8 items-center justify-center rounded-full bg-white text-[17px] leading-none"
          style={{
            border: `2.5px solid ${isSelected ? '#0ea5e9' : cat.color}`,
            boxShadow: '0 2px 6px rgba(0,0,0,0.25)',
            opacity: place.been_here ? 0.6 : 1,
          }}
        >
          {place.emoji || cat.emoji}
        </div>
        {place.must_go && (
          <span className="absolute -right-1.5 -top-1.5 flex h-4 w-4 items-center justify-center rounded-full bg-amber-400 text-[10px] text-white shadow-sm ring-2 ring-white">★</span>
        )}
      </div>
    </Marker>
  );
}
