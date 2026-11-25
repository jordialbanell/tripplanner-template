// Server-only Google Places (New) helpers. Never import from a client component:
// it reads GOOGLE_PLACES_API_KEY.
import type { Category } from '@/app/projects/tripplanner/_components/placeTypes';

export interface PlaceHit {
  place_id: string;
  name: string;
  address: string;
  lat: number;
  lng: number;
  city: string;
  country: string;
  neighbourhood: string | null;
  types: string[];
}

interface AddressComponent { longText?: string; types?: string[] }
interface GooglePlace {
  id: string;
  displayName?: { text?: string };
  formattedAddress?: string;
  location?: { latitude: number; longitude: number };
  addressComponents?: AddressComponent[];
  types?: string[];
}

const FIELD_MASK = [
  'places.id',
  'places.displayName',
  'places.formattedAddress',
  'places.location',
  'places.addressComponents',
  'places.types',
].join(',');

function component(components: AddressComponent[], ...types: string[]): string | null {
  for (const t of types) {
    const hit = components.find(c => c.types?.includes(t));
    if (hit?.longText) return hit.longText;
  }
  return null;
}

function toHit(place: GooglePlace): PlaceHit {
  const comps = place.addressComponents || [];
  return {
    place_id: place.id,
    name: place.displayName?.text || '',
    address: place.formattedAddress || '',
    lat: place.location?.latitude ?? 0,
    lng: place.location?.longitude ?? 0,
    city: component(comps, 'locality', 'postal_town', 'administrative_area_level_1') || '',
    country: component(comps, 'country') || '',
    neighbourhood: component(comps, 'neighborhood', 'sublocality_level_1', 'sublocality', 'administrative_area_level_2'),
    types: place.types || [],
  };
}

export async function searchPlaces(textQuery: string, pageSize = 5): Promise<PlaceHit[]> {
  const apiKey = process.env.TRIP_GOOGLE_PLACES_API_KEY;
  if (!apiKey) throw new Error('Google Places API key not configured');

  const res = await fetch('https://places.googleapis.com/v1/places:searchText', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': apiKey,
      'X-Goog-FieldMask': FIELD_MASK,
    },
    body: JSON.stringify({ textQuery, pageSize, languageCode: 'en' }),
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) {
    throw new Error(`Google Places API error: ${res.status} ${await res.text()}`);
  }
  const data = (await res.json()) as { places?: GooglePlace[] };
  return (data.places || []).map(toHit).filter(h => h.lat !== 0 || h.lng !== 0);
}

export function categoryFromTypes(types: string[]): Category | null {
  const has = (...t: string[]) => t.some(x => types.includes(x));
  if (has('museum', 'art_gallery')) return 'Museum';
  if (has('bar', 'night_club', 'pub', 'wine_bar', 'cocktail_bar')) return 'Bar';
  if (has('cafe', 'coffee_shop', 'tea_house')) return 'Café';
  if (has('bakery', 'dessert_shop', 'ice_cream_shop', 'confectionery', 'dessert_restaurant')) return 'Snacks';
  if (has('restaurant', 'food', 'meal_takeaway', 'meal_delivery')) return 'Restaurant';
  if (has('lodging', 'hotel')) return 'Hotel';
  if (has('park', 'national_park', 'garden', 'hiking_area', 'beach')) return 'Nature';
  if (has('shopping_mall', 'store', 'market', 'clothing_store', 'department_store', 'gift_shop')) return 'Shopping';
  if (has('neighborhood', 'sublocality', 'sublocality_level_1', 'locality')) return 'Area';
  if (has('tourist_attraction', 'point_of_interest')) return 'Attraction';
  return null;
}

export interface PlaceReviews {
  summary: string | null;
  reviews: string[];
}

// Google's own short summary plus up to 5 review texts for one place, in English.
// Billed as Place Details "Enterprise + Atmosphere" (1,000 free calls a month).
// Returns null on any failure so callers can fall back.
export async function getPlaceReviews(placeId: string): Promise<PlaceReviews | null> {
  const apiKey = process.env.TRIP_GOOGLE_PLACES_API_KEY;
  if (!apiKey || !placeId) return null;
  try {
    const res = await fetch(`https://places.googleapis.com/v1/places/${encodeURIComponent(placeId)}?languageCode=en`, {
      headers: { 'X-Goog-Api-Key': apiKey, 'X-Goog-FieldMask': 'editorialSummary,reviews' },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
      console.log('[reviews] google error', res.status);
      return null;
    }
    const data = await res.json() as {
      editorialSummary?: { text?: string };
      reviews?: { text?: { text?: string }; originalText?: { text?: string } }[];
    };
    const reviews = (data.reviews || [])
      .map(r => (r.text?.text || r.originalText?.text || '').replace(/\s+/g, ' ').trim())
      .filter(t => t.length > 20)
      .map(t => (t.length > 500 ? `${t.slice(0, 500)}...` : t));
    return { summary: data.editorialSummary?.text?.trim() || null, reviews };
  } catch {
    return null;
  }
}
