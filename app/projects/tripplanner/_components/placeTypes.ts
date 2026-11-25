import { inMainlandChina } from '@/lib/trip/chinaCoords';
// Single source of truth for place categories, their pins and colours.
// The `category` column in Supabase is free text, so the keys below are the
// stored values. The original four (Restaurant, Café, Hotel, Attraction) are
// kept as-is so every existing place keeps working.

export const CATEGORY_KEYS = [
  'Restaurant',
  'Snacks',
  'Café',
  'Bar',
  'Shopping',
  'Museum',
  'Attraction',
  'Nature',
  'Area',
  'Photobooth',
  'Hotel',
] as const;

export type Category = typeof CATEGORY_KEYS[number];

export interface CategoryConfig {
  label: string;
  emoji: string;
  color: string; // hex, used for chips, pin rings and dots
}

export const CATEGORIES: Record<Category, CategoryConfig> = {
  Restaurant: { label: 'Food',       emoji: '🍜', color: '#ea580c' },
  Snacks:     { label: 'Snacks',     emoji: '🍡', color: '#db2777' },
  Café:       { label: 'Coffee',     emoji: '☕', color: '#a16207' },
  Bar:        { label: 'Bars',       emoji: '🍸', color: '#7c3aed' },
  Shopping:   { label: 'Shopping',   emoji: '🛍️', color: '#0d9488' },
  Museum:     { label: 'Museums',    emoji: '🏛️', color: '#4f46e5' },
  Attraction: { label: 'Sights',     emoji: '🎡', color: '#0284c7' },
  Nature:     { label: 'Nature',     emoji: '🌳', color: '#16a34a' },
  Area:       { label: 'Areas',      emoji: '🏘️', color: '#475569' },
  Photobooth: { label: 'Photobooths', emoji: '📸', color: '#e11d48' },
  Hotel:      { label: 'Hotels',     emoji: '🏨', color: '#0369a1' },
};

// Plain-English guidance, shared by the Claude prompts so AI and UI agree.
export const CATEGORY_GUIDE = `- "Restaurant": sit-down food, noodle shops, dim sum, roast meat, cha chaan teng, street food stalls serving meals
- "Snacks": desserts, bakeries, egg tarts, bubble tea, ice cream, sweet shops, quick snacks
- "Café": coffee shops, specialty coffee, matcha and tea cafés
- "Bar": bars, cocktail bars, wine bars, pubs, izakaya-style drinking spots
- "Shopping": shops, markets, malls, boutiques, souvenir and ceramic stalls
- "Museum": museums and galleries
- "Attraction": sights, viewpoints, temples, landmarks, streets worth seeing, experiences
- "Nature": parks, gardens, beaches, hikes
- "Area": a whole neighbourhood or district to wander (not a single venue)
- "Photobooth": photo booths and photo studios
- "Hotel": hotels and other lodging`;

export function isCategory(value: unknown): value is Category {
  return typeof value === 'string' && (CATEGORY_KEYS as readonly string[]).includes(value);
}

// Older rows store categories in lowercase ("restaurant", "café") or without accents.
const CATEGORY_ALIASES: Record<string, Category> = {
  restaurant: 'Restaurant', food: 'Restaurant',
  snacks: 'Snacks', snack: 'Snacks', dessert: 'Snacks', desserts: 'Snacks', bakery: 'Snacks',
  'café': 'Café', cafe: 'Café', coffee: 'Café',
  bar: 'Bar', bars: 'Bar',
  shopping: 'Shopping', shop: 'Shopping',
  museum: 'Museum', museums: 'Museum',
  attraction: 'Attraction', sight: 'Attraction', sights: 'Attraction',
  nature: 'Nature', park: 'Nature',
  area: 'Area', neighbourhood: 'Area', neighborhood: 'Area',
  photobooth: 'Photobooth',
  hotel: 'Hotel', hotels: 'Hotel',
};

export function normalizeCategory(value: string | null | undefined): Category | null {
  if (!value) return null;
  if (isCategory(value)) return value;
  return CATEGORY_ALIASES[value.trim().toLowerCase()] ?? null;
}

export function getCategory(value: string | null | undefined): CategoryConfig {
  return CATEGORIES[normalizeCategory(value) ?? 'Attraction'];
}

// Maps spreadsheet column headers (any language-ish spelling) to a category.
const HEADER_SYNONYMS: [RegExp, Category][] = [
  [/^(bars?|drinks?|pubs?|cocktails?|wine)/i, 'Bar'],
  [/^(coffee|caf[eé]s?|tea)/i, 'Café'],
  [/^(restaurants?|food|eat|dinner|lunch|brunch)/i, 'Restaurant'],
  [/^(snacks?|desserts?|sweets?|bakery|bakeries)/i, 'Snacks'],
  [/^(photo ?booths?|photo)/i, 'Photobooth'],
  [/^(shopping|shops?|stores?|souvenirs?|markets?)/i, 'Shopping'],
  [/^(areas?|neighbou?rhoods?|districts?)/i, 'Area'],
  [/^(muse?u?ms?|musems?|galler(y|ies)|art)/i, 'Museum'],
  [/^(parks?|nature|gardens?|hikes?|beach(es)?)/i, 'Nature'],
  [/^(hotels?|stay|lodging)/i, 'Hotel'],
  [/^(sights?|attractions?|things to do|see)/i, 'Attraction'],
];

export function categoryFromHeader(header: string): Category | null {
  const h = header.trim();
  for (const [re, cat] of HEADER_SYNONYMS) if (re.test(h)) return cat;
  return null;
}

export interface SavedPlace {
  id: string;
  created_at?: string;
  name: string;
  city: string;
  country: string;
  category: string;
  emoji: string | null;
  vibe: string;
  description: string;
  source_handle: string | null;
  geo?: { lat: number; lng: number; address: string | null };
  tags: string[];
  been_here: boolean;
  rating: number | null;
  personal_note: string;
  tiktok_url: string;
  google_place_id: string | null;
  must_go: boolean;
  neighbourhood: string | null;
  research: ResearchResult | null;
  photo_url: string | null; // null = none yet, 'none' = Google had none
}

// Saved output of "Research this place", so it's only paid for once.
export interface ResearchResult {
  worth_visiting: number;
  time_to_spend: string;
  entrance_fee: string;
  summary: string;
  basis: string;
  travel_time_car?: string;
  travel_time_bike?: string;
  travel_time_walk?: string;
  photos?: string[];
  google_maps_url: string;
  researched_at?: string;
  // Extra fields from deeper research
  status?: 'open' | 'closed' | 'moved' | 'unclear';
  status_note?: string | null;
  what_to_order?: string[] | null;
  sources?: string[];
}

export const PRESET_TAGS = ['cowork', 'matcha', 'aesthetic', 'good for dates', 'hidden gem', 'outdoor', 'late night', 'breakfast'];

export function googleMapsUrl(place: Pick<SavedPlace, 'name' | 'google_place_id' | 'geo'>): string {
  const query = encodeURIComponent(place.name);
  if (place.google_place_id) {
    return `https://www.google.com/maps/search/?api=1&query=${query}&query_place_id=${place.google_place_id}`;
  }
  if (place.geo) return `https://www.google.com/maps/search/?api=1&query=${place.geo.lat},${place.geo.lng}`;
  return `https://www.google.com/maps/search/?api=1&query=${query}`;
}

// Countries are free text: compare loosely so "Hong Kong" matches "hong kong ".
export function sameText(a: string | null | undefined, b: string | null | undefined): boolean {
  return (a || '').trim().toLowerCase() === (b || '').trim().toLowerCase();
}

// The place's photo to show, if it has one.
export function placePhoto(place: Pick<SavedPlace, 'photo_url'>): string | null {
  return place.photo_url && place.photo_url !== 'none' ? place.photo_url : null;
}

// Amap (Gaode) links for places in mainland China, where Google Maps doesn't work without a VPN.
// Stored coordinates there are already on Amap's grid (GCJ-02), so dev=0.
// app: opens the Amap app on a phone. web: Amap's page, which offers to open the app.
export function amapLinks(place: Pick<SavedPlace, 'name' | 'geo' | 'city' | 'country'>): { app: string; web: string } | null {
  const china = /^(china|中国|prc|people'?s republic of china)$/i.test((place.country || '').trim());
  const name = encodeURIComponent(place.name);
  if (place.geo) {
    const { lat, lng } = place.geo;
    if (!inMainlandChina(lat, lng)) return null;
    return {
      app: `iosamap://viewMap?sourceApplication=TripPlanner&poiname=${name}&lat=${lat}&lon=${lng}&dev=0`,
      web: `https://uri.amap.com/marker?position=${lng},${lat}&name=${name}&coordinate=gaode&callnative=1`,
    };
  }
  if (!china) return null;
  const city = encodeURIComponent(place.city || '');
  return {
    app: `iosamap://poi?sourceApplication=TripPlanner&name=${name}&dev=0`,
    web: `https://uri.amap.com/search?keyword=${name}&city=${city}&callnative=1`,
  };
}
