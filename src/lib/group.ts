// Samen rijden: live posities en snelberichten delen binnen een groep.
// Iedereen met de groepscode (uit de uitnodigingslink) kan meedoen.
// Posities gaan via Supabase Realtime "broadcast": ze worden doorgestuurd
// naar de andere rijders en nergens opgeslagen.
import { createClient, type RealtimeChannel, type SupabaseClient } from '@supabase/supabase-js';
import { SUPABASE_KEY, SUPABASE_URL } from './config';
import { distance, type LatLng } from './geo';

export const RIDER_COLORS = ['#3d9bff', '#2fc46b', '#e84aa0', '#a66bff', '#f2c230', '#25c7d9', '#ff5a5a', '#9ad14b'];

export interface Rider {
  id: string;
  name: string;
  color: string;
  pos?: LatLng & { heading: number; speedKmh: number; accuracy?: number };
  /** ms sinds epoch van de laatste positie */
  seenAt: number;
  online: boolean;
  navigating?: boolean;
}

export type QuickKind = 'fuel' | 'pause' | 'wait' | 'trouble' | 'go';
export const QUICK: Record<QuickKind, { icon: string; text: string; spoken: string }> = {
  fuel: { icon: '⛽', text: 'Tanken', spoken: 'wil tanken' },
  pause: { icon: '☕', text: 'Pauze', spoken: 'wil pauzeren' },
  wait: { icon: '✋', text: 'Wacht even', spoken: 'vraagt of je even wacht' },
  trouble: { icon: '⚠️', text: 'Pech!', spoken: 'heeft pech' },
  go: { icon: '👍', text: 'Alles goed', spoken: 'zegt: alles goed' },
};

/** Berichten om een intercomverbinding op te zetten (WebRTC). */
export interface Signal {
  from: string;
  to?: string;
  type: 'hello' | 'here' | 'offer' | 'answer' | 'bye';
  name?: string;
  sdp?: string;
  /** Eerste melding na (her)starten: bestaande verbinding is dan verouderd */
  fresh?: boolean;
}

export interface GroupMessage {
  from: string;
  name: string;
  kind: QuickKind;
  at: number;
}

interface PosPayload {
  id: string;
  name: string;
  color: string;
  lat: number;
  lon: number;
  heading: number;
  speedKmh: number;
  accuracy?: number;
  nav: boolean;
}

export interface GroupEvents {
  onRiders(riders: Rider[]): void;
  onMessage(m: GroupMessage): void;
  onRoute(code: string, from: string): void;
  onStatus(s: 'connecting' | 'connected' | 'error'): void;
}

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export function newGroupCode(): string {
  const a = crypto.getRandomValues(new Uint8Array(6));
  return Array.from(a, (x) => CODE_CHARS[x % CODE_CHARS.length]).join('');
}

export function myRiderId(): string {
  try {
    let id = localStorage.getItem('mototrips.riderId');
    if (!id) {
      id = crypto.randomUUID();
      localStorage.setItem('mototrips.riderId', id);
    }
    return id;
  } catch {
    return crypto.randomUUID();
  }
}

export function colorFor(id: string): string {
  let h = 0;
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return RIDER_COLORS[h % RIDER_COLORS.length];
}

let client: SupabaseClient | null = null;
function getClient() {
  client ??= createClient(SUPABASE_URL, SUPABASE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
    realtime: { params: { eventsPerSecond: 10 } },
  });
  return client;
}

export class GroupRide {
  readonly code: string;
  readonly me: { id: string; name: string; color: string };
  readonly host: boolean;
  routeCode: string | null;
  private channel: RealtimeChannel | null = null;
  private riders = new Map<string, Rider>();
  private ev: GroupEvents;
  private lastSent?: { p: LatLng; t: number };
  private lastFix?: PosPayload;
  private heartbeat?: number;
  private staleTimer?: number;
  private left = false;
  private signalHandler: ((s: Signal) => void) | null = null;

  constructor(code: string, name: string, host: boolean, routeCode: string | null, ev: GroupEvents) {
    this.code = code;
    const id = myRiderId();
    this.me = { id, name, color: colorFor(id) };
    this.host = host;
    this.routeCode = routeCode;
    this.ev = ev;
  }

  async connect() {
    this.ev.onStatus('connecting');
    const sb = getClient();
    const name = `mototrips-ride-${this.code}`;
    // Een eerder (nog niet helemaal gesloten) kanaal met dezelfde naam eerst opruimen,
    // anders geeft de client dat oude, al geabonneerde kanaal terug.
    const olds = sb.getChannels().filter((o) => o.topic === `realtime:${name}`);
    if (olds.length) await Promise.all(olds.map((o) => sb.removeChannel(o).catch(() => {})));
    if (this.left) return;
    const ch = sb.channel(name, {
      config: { broadcast: { self: false, ack: false }, presence: { key: this.me.id, enabled: true } },
    });
    this.channel = ch;

    ch.on('broadcast', { event: 'pos' }, ({ payload }) => this.onPos(payload as PosPayload));
    // Intercom: verbindingsgegevens tussen twee telefoons (alleen voor mij bedoeld)
    ch.on('broadcast', { event: 'rtc' }, ({ payload }) => {
      const s = payload as Signal;
      if (s.from !== this.me.id && (!s.to || s.to === this.me.id)) this.signalHandler?.(s);
    });
    ch.on('broadcast', { event: 'msg' }, ({ payload }) => {
      const m = payload as GroupMessage;
      if (m.from !== this.me.id) this.ev.onMessage(m);
    });
    ch.on('broadcast', { event: 'route' }, ({ payload }) => {
      const p = payload as { code: string; from: string };
      if (p.from === this.me.id) return;
      this.routeCode = p.code;
      this.ev.onRoute(p.code, p.from);
    });
    // Wie er online is (ook als ze nog geen positie hebben gestuurd)
    ch.on('presence', { event: 'sync' }, () => {
      const state = ch.presenceState<{ id: string; name: string; color: string }>();
      const online = new Set<string>();
      for (const [key, metas] of Object.entries(state)) {
        const meta = metas[0];
        if (!meta || key === this.me.id) continue;
        online.add(key);
        const r = this.riders.get(key);
        if (r) {
          r.online = true;
          r.name = meta.name;
        } else this.riders.set(key, { id: key, name: meta.name, color: meta.color, seenAt: Date.now(), online: true });
      }
      for (const r of this.riders.values()) r.online = online.has(r.id);
      this.emitRiders();
    });
    ch.on('presence', { event: 'join' }, ({ key }) => {
      if (key === this.me.id) return;
      // Nieuwkomer: de organisator stuurt de actuele route, iedereen zijn positie
      if (this.host && this.routeCode) this.sendRoute(this.routeCode);
      if (this.lastFix) this.broadcast('pos', this.lastFix);
    });

    ch.subscribe(async (status) => {
      if (status === 'SUBSCRIBED') {
        await ch.track({ id: this.me.id, name: this.me.name, color: this.me.color });
        this.ev.onStatus('connected');
        if (this.lastFix) this.broadcast('pos', this.lastFix);
      } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
        this.ev.onStatus('error');
      }
    });

    // Elke 15 s positie herhalen (ook stilstaand), zodat anderen zien dat je er nog bent
    this.heartbeat = window.setInterval(() => {
      if (this.lastFix && Date.now() - (this.lastSent?.t ?? 0) > 14000) this.forceSend();
    }, 5000);
    // Verouderde posities grijs maken
    this.staleTimer = window.setInterval(() => this.emitRiders(), 10000);
  }

  private onPos(p: PosPayload) {
    if (p.id === this.me.id) return;
    const r = this.riders.get(p.id) ?? { id: p.id, name: p.name, color: p.color, seenAt: 0, online: true };
    r.name = p.name;
    r.color = p.color;
    r.pos = { lat: p.lat, lon: p.lon, heading: p.heading, speedKmh: p.speedKmh, accuracy: p.accuracy };
    r.navigating = p.nav;
    r.seenAt = Date.now();
    r.online = true;
    this.riders.set(p.id, r);
    this.emitRiders();
  }

  private emitRiders() {
    this.ev.onRiders([...this.riders.values()].sort((a, b) => a.name.localeCompare(b.name)));
  }

  private broadcast(event: string, payload: unknown) {
    this.channel?.send({ type: 'broadcast', event, payload }).catch(() => {});
  }

  /**
   * Eigen positie delen. Zuinig: alleen als je ≥20 m verplaatst bent en
   * minstens 2,5 s na de vorige keer (stilstaand: via de hartslag elke 15 s).
   */
  sendPosition(p: LatLng & { heading: number; speedKmh: number; accuracy?: number }, navigating: boolean) {
    this.lastFix = {
      id: this.me.id,
      name: this.me.name,
      color: this.me.color,
      lat: +p.lat.toFixed(6),
      lon: +p.lon.toFixed(6),
      heading: Math.round(p.heading),
      speedKmh: Math.round(p.speedKmh),
      accuracy: p.accuracy ? Math.round(p.accuracy) : undefined,
      nav: navigating,
    };
    const now = Date.now();
    const ls = this.lastSent;
    if (ls && (now - ls.t < 2500 || distance(ls.p, p) < 20)) return;
    this.forceSend();
  }

  private forceSend() {
    if (!this.lastFix) return;
    this.lastSent = { p: { lat: this.lastFix.lat, lon: this.lastFix.lon }, t: Date.now() };
    this.broadcast('pos', this.lastFix);
  }

  /** Intercom-signalering versturen (aan één rijder, of aan iedereen zonder 'to'). */
  sendSignal(s: Omit<Signal, 'from'>) {
    this.broadcast('rtc', { ...s, from: this.me.id });
  }

  onSignal(fn: ((s: Signal) => void) | null) {
    this.signalHandler = fn;
  }

  sendMessage(kind: QuickKind) {
    this.broadcast('msg', { from: this.me.id, name: this.me.name, kind, at: Date.now() } satisfies GroupMessage);
  }

  sendRoute(code: string) {
    this.routeCode = code;
    this.broadcast('route', { code, from: this.me.id });
  }

  async leave() {
    this.left = true;
    clearInterval(this.heartbeat);
    clearInterval(this.staleTimer);
    if (this.channel) {
      await this.channel.untrack().catch(() => {});
      await getClient().removeChannel(this.channel).catch(() => {});
    }
    this.channel = null;
  }
}

/** Een rijder die langer dan 60 s niets stuurde, telt als 'verouderd'. */
export const isStale = (r: Rider) => !r.pos || Date.now() - r.seenAt > 60000;

// ---------------- groep onthouden (na herladen automatisch terug) ----------------
const KEY = 'mototrips.group';
export interface StoredGroup {
  code: string;
  host: boolean;
  routeCode: string | null;
  at: number;
}
export function storeGroup(g: StoredGroup | null) {
  try {
    if (g) localStorage.setItem(KEY, JSON.stringify(g));
    else localStorage.removeItem(KEY);
  } catch {
    /* negeren */
  }
}
export function loadStoredGroup(): StoredGroup | null {
  try {
    const g = JSON.parse(localStorage.getItem(KEY) || 'null') as StoredGroup | null;
    // Na 12 uur vervalt een groepsrit
    return g && Date.now() - g.at < 12 * 3600 * 1000 ? g : null;
  } catch {
    return null;
  }
}

export function groupInviteUrl(code: string, routeCode: string | null) {
  return `${location.origin}${location.pathname}#g=${code}${routeCode ? `&r=${routeCode}` : ''}`;
}

/** Leest een groepscode uit de URL (#g=CODE), zonder de hash weg te halen. */
export function groupCodeFromUrl(): string | null {
  const m = location.hash.match(/[#&]g=([A-Z0-9]{6})/i);
  return m ? m[1].toUpperCase() : null;
}
