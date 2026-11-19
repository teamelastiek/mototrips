// App-instellingen (per toestel bewaard).

export interface AppSettings {
  mapStyle: 'auto' | 'light' | 'dark';
  /** Hoeveel km je met een volle tank haalt */
  fuelRangeKm: number;
  showSpeedLimit: boolean;
  speedWarning: boolean;
  recordRides: boolean;
  /** Naam die je groepsgenoten zien */
  riderName: string;
  /** Waarschuwen als iemand zo ver (km) achter raakt */
  groupGapKm: number;
}

const KEY = 'mototrips.settings';
const DEFAULTS: AppSettings = {
  mapStyle: 'auto',
  fuelRangeKm: 220,
  showSpeedLimit: true,
  speedWarning: true,
  recordRides: true,
  riderName: '',
  groupGapKm: 2,
};

let cache: AppSettings | null = null;
const listeners = new Set<(s: AppSettings) => void>();

export function getSettings(): AppSettings {
  if (cache) return cache;
  try {
    const old = localStorage.getItem('mototrips.mapstyle'); // oude instelling overnemen
    cache = { ...DEFAULTS, ...(old ? { mapStyle: old as AppSettings['mapStyle'] } : {}), ...JSON.parse(localStorage.getItem(KEY) || '{}') };
  } catch {
    cache = { ...DEFAULTS };
  }
  return cache!;
}

export function updateSettings(patch: Partial<AppSettings>) {
  cache = { ...getSettings(), ...patch };
  try {
    localStorage.setItem(KEY, JSON.stringify(cache));
  } catch {
    /* negeren */
  }
  listeners.forEach((l) => l(cache!));
}

export function onSettings(l: (s: AppSettings) => void) {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}
