'use client';

import { forwardRef } from 'react';
import { getCategory, placePhoto, type SavedPlace } from '@/app/projects/tripplanner/_components/placeTypes';

interface Props {
  place: SavedPlace;
  isSelected: boolean;
  onClick: (place: SavedPlace) => void;
  onInfo: (place: SavedPlace) => void;
  onDelete?: (id: string) => void; // omit to hide the delete button (e.g. in trip view)
  onHover?: (id: string | null) => void;
  isHighlighted?: boolean;
  distance?: string; // "350 m" from where you are, when location is on
}

export const PlaceCard = forwardRef<HTMLDivElement, Props>(function PlaceCard(
  { place, onDelete, onHover, isHighlighted, isSelected, onInfo, onClick, distance },
  ref,
) {
  const cat = getCategory(place.category);
  const photo = placePhoto(place);
  const location = place.neighbourhood || [place.city, place.country].filter(Boolean).join(', ');

  return (
    <div
      ref={ref}
      onMouseEnter={() => onHover?.(place.id)}
      onMouseLeave={() => onHover?.(null)}
      onClick={() => onClick(place)}
      className={`group rounded-xl border bg-white p-3.5 shadow-xs transition cursor-pointer ${
        isSelected ? 'border-sky-500 ring-2 ring-sky-200' : isHighlighted ? 'border-sky-300' : 'border-gray-100 hover:border-gray-200'
      }`}
    >
      <div className="flex items-start gap-3">
        {photo ? (
          <div className="relative mt-0.5 h-14 w-14 shrink-0">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={photo} alt="" loading="lazy" className="h-14 w-14 rounded-lg object-cover" />
            <span className="absolute -bottom-1 -right-1 flex h-5 w-5 items-center justify-center rounded-full bg-white text-[11px] shadow-sm"
              style={{ boxShadow: `0 0 0 1.5px ${cat.color}55` }}>
              {place.emoji || cat.emoji}
            </span>
          </div>
        ) : (
          <div
            className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-lg"
            style={{ background: `${cat.color}14`, boxShadow: `inset 0 0 0 1.5px ${cat.color}55` }}
          >
            {place.emoji || cat.emoji}
          </div>
        )}

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            {place.must_go && <span className="text-amber-500 text-sm shrink-0" title="Must-go">★</span>}
            <h3 className="truncate font-semibold leading-snug text-gray-900">{place.name || 'Untitled place'}</h3>
            {place.been_here && <span className="shrink-0 text-xs text-green-500" title="Been here">✓</span>}
            {place.rating && <span className="shrink-0 text-xs text-yellow-400">{'★'.repeat(place.rating)}</span>}
            {place.research?.status === 'closed' && <span className="shrink-0 rounded-sm bg-red-50 px-1.5 text-[10px] font-semibold text-red-600">CLOSED</span>}
            {place.research?.status === 'moved' && <span className="shrink-0 rounded-sm bg-amber-50 px-1.5 text-[10px] font-semibold text-amber-700">MOVED</span>}
            {place.research?.worth_visiting != null && (
              <span className="ml-auto shrink-0 pl-1 text-[11px] font-semibold text-gray-400" title="Research score">{place.research.worth_visiting}/10</span>
            )}
          </div>
          <p className="mt-0.5 flex items-center gap-1.5 text-xs text-gray-500">
            <span style={{ color: cat.color }} className="font-medium">{cat.label}</span>
            {location && <><span className="text-gray-300">·</span><span className="truncate">{location}</span></>}
            {!place.geo && <><span className="text-gray-300">·</span><span className="text-amber-600">no pin</span></>}
            {distance && <span className="ml-auto shrink-0 pl-1 font-medium text-sky-600">{distance}</span>}
          </p>
          {place.description
            ? <p className="mt-1 text-xs leading-relaxed text-gray-500 line-clamp-2">{place.description}</p>
            : place.vibe && <p className="mt-1 text-xs italic text-gray-400 line-clamp-1">{place.vibe}</p>}
          {(place.source_handle || place.tags?.length > 0) && (
            <div className="mt-1.5 flex flex-wrap items-center gap-1">
              {place.source_handle && <span className="text-xs text-gray-400 mr-1">@{place.source_handle}</span>}
              {place.tags?.map(tag => (
                <span key={tag} className="rounded-full bg-sky-50 px-2 py-0.5 text-[11px] text-sky-600">{tag}</span>
              ))}
            </div>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-1.5">
          <button onClick={e => { e.stopPropagation(); onInfo(place); }} className="rounded-sm p-0.5 text-gray-300 transition hover:text-sky-500" aria-label="More info">
            <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" viewBox="0 0 20 20" fill="currentColor">
              <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a1 1 0 000 2v3a1 1 0 001 1h1a1 1 0 100-2v-3a1 1 0 00-1-1H9z" clipRule="evenodd" />
            </svg>
          </button>
          {onDelete && (
            <button
              onClick={e => {
                e.stopPropagation();
                if (window.confirm(`Delete "${place.name}"? This removes it everywhere.`)) onDelete(place.id);
              }}
              className="rounded-sm p-0.5 text-gray-300 transition hover:text-red-500 md:opacity-0 md:group-hover:opacity-100 md:focus:opacity-100"
              aria-label="Delete place"
            >
              <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" viewBox="0 0 20 20" fill="currentColor">
                <path fillRule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clipRule="evenodd" />
              </svg>
            </button>
          )}
        </div>
      </div>
    </div>
  );
});
