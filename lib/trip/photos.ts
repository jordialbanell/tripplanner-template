// Browser helpers for place photos (server: app/projects/tripplanner/api/photo).
const ENDPOINT = '/projects/tripplanner/api/photo';

// Phone photos are 3-10 MB: shrink to 1400 px JPEG (a few hundred KB) before uploading.
async function shrink(file: File, max = 1400): Promise<Blob> {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error("Couldn't read that photo"));
      el.src = url;
    });
    const scale = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(img.naturalWidth * scale);
    canvas.height = Math.round(img.naturalHeight * scale);
    canvas.getContext('2d')!.drawImage(img, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>(r => canvas.toBlob(r, 'image/jpeg', 0.85));
    if (!blob) throw new Error("Couldn't read that photo");
    return blob;
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function send(init: RequestInit) {
  const res = await fetch(ENDPOINT, { method: 'POST', ...init });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Photo failed');
  return data;
}

export async function uploadPlacePhoto(placeId: string, file: File): Promise<string> {
  const form = new FormData();
  form.append('placeId', placeId);
  form.append('file', await shrink(file), 'photo.jpg');
  return (await send({ body: form })).photo_url as string;
}

export async function removePlacePhoto(placeId: string): Promise<void> {
  await send({ headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: 'remove', placeId }) });
}

// Google photos for places that have none. Returns placeId -> photo_url ('none' if Google had none).
export async function autoPlacePhotos(placeIds: string[], tripId?: string): Promise<Record<string, string>> {
  if (!placeIds.length) return {};
  const data = await send({
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode: 'auto', placeIds, tripId }),
  });
  return data.results || {};
}
