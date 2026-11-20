// Locatietoestemming: status opvragen, netjes vragen en uitleg per toestel.
import type { LatLng } from './geo';

export type LocState = 'granted' | 'prompt' | 'denied' | 'unknown' | 'unsupported';

export class LocationError extends Error {
  denied: boolean;
  constructor(message: string, denied: boolean) {
    super(message);
    this.denied = denied;
  }
}

export async function locationState(): Promise<LocState> {
  if (!('geolocation' in navigator)) return 'unsupported';
  try {
    const s = await navigator.permissions?.query({ name: 'geolocation' as PermissionName });
    return s ? (s.state as LocState) : 'unknown';
  } catch {
    return 'unknown';
  }
}

/** Volgt veranderingen in de toestemming (bijv. na aanzetten in de instellingen). */
export function watchLocationState(cb: (s: LocState) => void): () => void {
  let status: PermissionStatus | null = null;
  let stopped = false;
  const on = () => status && cb(status.state as LocState);
  navigator.permissions
    ?.query({ name: 'geolocation' as PermissionName })
    .then((s) => {
      if (stopped) return;
      status = s;
      s.addEventListener('change', on);
    })
    .catch(() => {});
  return () => {
    stopped = true;
    status?.removeEventListener('change', on);
  };
}

/** Vraagt de positie op; toont zo nodig de toestemmingsvraag van de telefoon. */
export function requestLocation(timeout = 15000): Promise<LatLng> {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new LocationError('Locatie wordt niet ondersteund in deze browser', false));
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lon: p.coords.longitude }),
      (e) =>
        reject(
          e.code === 1
            ? new LocationError('Geen toestemming voor locatie', true)
            : new LocationError('Locatie niet beschikbaar. Staat locatie/GPS aan op je telefoon?', false),
        ),
      { enableHighAccuracy: true, timeout, maximumAge: 30000 },
    );
  });
}

/** Opent het uitlegvenster vanaf elke plek in de app. */
export function openLocationHelp() {
  window.dispatchEvent(new Event('mototrips-location-help'));
}

export type Platform = 'ios' | 'android' | 'samsung' | 'desktop';

export function detectPlatform(): Platform {
  const ua = navigator.userAgent;
  if (/iPad|iPhone|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) return 'ios';
  if (/SamsungBrowser/.test(ua)) return 'samsung';
  if (/Android/.test(ua)) return 'android';
  return 'desktop';
}

export function isInstalledApp(): boolean {
  return (
    window.matchMedia?.('(display-mode: standalone)').matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}

/** Stappen om locatie (weer) aan te zetten, voor dit toestel en deze browser. */
export function locationSteps(p: Platform = detectPlatform(), installed = isInstalledApp()): string[] {
  const ua = navigator.userAgent;
  if (p === 'ios') {
    const chrome = /CriOS/.test(ua);
    const steps = [
      'Open de app Instellingen → Privacy en beveiliging → Locatievoorzieningen en zet die aan.',
      chrome
        ? 'Scrol in die lijst naar Chrome en kies "Bij gebruik van app".'
        : 'Scrol in die lijst naar "Safari-websites", kies "Bij gebruik van app" en zet "Nauwkeurige locatie" aan.',
    ];
    if (!chrome) steps.push('Ga terug naar Instellingen → Apps → Safari → Locatie en kies "Vraag" of "Sta toe".');
    if (!installed && !chrome)
      steps.push('In Safari: tik op het pagina-icoon links in de adresbalk → Website-instellingen → Locatie → Sta toe.');
    return steps;
  }
  if (p === 'samsung') {
    return [
      'Veeg vanaf de bovenkant omlaag en zet Locatie aan.',
      'In Samsung Internet: tik op ☰ → Instellingen → Sites en downloads → Sitemachtigingen → Locatie, en sta deze site toe.',
      'Controleer ook: Instellingen → Apps → Samsung Internet → Machtigingen → Locatie → "Alleen toestaan tijdens gebruik".',
    ];
  }
  if (p === 'android') {
    return [
      'Veeg vanaf de bovenkant omlaag en zet Locatie aan.',
      installed
        ? 'Houd het MotoTrips-icoon op je beginscherm ingedrukt → ⓘ App-info → Machtigingen → Locatie → Toestaan.'
        : 'In Chrome: tik op het icoontje links van het webadres → Rechten (of Machtigingen) → Locatie → Toestaan.',
      'Controleer ook: Instellingen → Apps → Chrome → Machtigingen → Locatie → "Alleen toestaan tijdens gebruik".',
    ];
  }
  return [
    'Klik op het icoontje links van het webadres → Locatie → Toestaan.',
    'Staat locatie uit in je computerinstellingen (Windows: Instellingen → Privacy en beveiliging → Locatie)? Zet het daar aan.',
  ];
}
