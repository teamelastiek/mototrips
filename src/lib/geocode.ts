// Adressen zoeken via Photon (OpenStreetMap), geen API-sleutel nodig.
import type { LatLng } from './geo';

export interface Place extends LatLng {
  name: string;
  detail: string;
}

interface PhotonFeature {
  geometry: { coordinates: [number, number] };
  properties: Record<string, string | undefined>;
}

function describe(p: PhotonFeature['properties']): { name: string; detail: string } {
  const street = p.street ? `${p.street}${p.housenumber ? ' ' + p.housenumber : ''}` : undefined;
  const name = p.name || street || p.city || p.county || 'Onbekende plek';
  const parts = [p.name && street ? street : undefined, p.city || p.town || p.village, p.state, p.country]
    .filter((x): x is string => !!x && x !== name);
  return { name, detail: [...new Set(parts)].join(', ') };
}

export async function searchPlaces(q: string, near?: LatLng, signal?: AbortSignal): Promise<Place[]> {
  const url = new URL('https://photon.komoot.io/api/');
  url.searchParams.set('q', q);
  url.searchParams.set('limit', '6');
  if (near) {
    url.searchParams.set('lat', near.lat.toFixed(3));
    url.searchParams.set('lon', near.lon.toFixed(3));
  }
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error('Zoeken mislukt');
  const data = await res.json();
  return (data.features as PhotonFeature[]).map((f) => ({
    lon: f.geometry.coordinates[0],
    lat: f.geometry.coordinates[1],
    ...describe(f.properties),
  }));
}

export async function reverseGeocode(p: LatLng): Promise<string> {
  try {
    const url = `https://photon.komoot.io/reverse?lat=${p.lat.toFixed(5)}&lon=${p.lon.toFixed(5)}&limit=1`;
    const res = await fetch(url);
    const data = await res.json();
    const f = data.features?.[0] as PhotonFeature | undefined;
    if (!f) return `${p.lat.toFixed(4)}, ${p.lon.toFixed(4)}`;
    const d = describe(f.properties);
    return d.detail ? `${d.name}, ${d.detail.split(', ')[0]}` : d.name;
  } catch {
    return `${p.lat.toFixed(4)}, ${p.lon.toFixed(4)}`;
  }
}
