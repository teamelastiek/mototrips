// Intercom: praten met je groepsgenoten via de helm-headset.
// Elke twee telefoons maken een directe WebRTC-verbinding (net als WhatsApp-bellen).
// Het groepskanaal wordt alleen gebruikt om de verbinding op te zetten.
//
// Zuinig ingesteld: mono spraak, ±24 kbit/s, en bij stilte wordt (bijna) niets
// verstuurd (DTX). Een "open lijn": gewoon praten, met een knop om te dempen.
import type { GroupRide, Signal } from './group';
import { getSettings } from './settings';
import { audioCtx } from './voice';

export type PeerState = 'connecting' | 'connected' | 'failed';

export interface PeerInfo {
  id: string;
  name: string;
  state: PeerState;
  speaking: boolean;
}

export interface IntercomEvents {
  onPeers(peers: PeerInfo[]): void;
  /** Voor gesproken meldingen: verbonden, verbinding kwijt, lukt niet */
  onEvent(kind: 'connected' | 'lost' | 'failed' | 'left', name: string): void;
  /** Praat ik zelf (microfoon vangt geluid op)? */
  onLocalSpeaking?(speaking: boolean): void;
}

function iceServers(): RTCIceServer[] {
  const s = getSettings();
  const list: RTCIceServer[] = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun.cloudflare.com:3478'] }];
  if (s.turnUrl.trim()) {
    list.push({ urls: s.turnUrl.split(/[\s,]+/).filter(Boolean), username: s.turnUser || undefined, credential: s.turnPass || undefined });
  }
  return list;
}

/** Opus afstemmen op spraak: mono, lage bitrate, DTX (stilte = geen data) en foutcorrectie. */
export function tuneOpus(sdp: string): string {
  const m = sdp.match(/a=rtpmap:(\d+) opus\/48000(\/2)?/i);
  if (!m) return sdp;
  const pt = m[1];
  const want: Record<string, string> = {
    minptime: '10',
    useinbandfec: '1',
    usedtx: '1',
    stereo: '0',
    'sprop-stereo': '0',
    maxaveragebitrate: '24000',
  };
  const re = new RegExp(`a=fmtp:${pt} ([^\\r\\n]*)`);
  const build = (existing: string) => {
    const kv = new Map<string, string>();
    for (const part of existing.split(';')) {
      const [k, v] = part.split('=');
      if (k?.trim()) kv.set(k.trim(), (v ?? '').trim());
    }
    for (const [k, v] of Object.entries(want)) kv.set(k, v);
    return [...kv].map(([k, v]) => `${k}=${v}`).join(';');
  };
  if (re.test(sdp)) return sdp.replace(re, (_, p: string) => `a=fmtp:${pt} ${build(p)}`);
  return sdp.replace(m[0], `${m[0]}\r\na=fmtp:${pt} ${build('')}`);
}

/** Wacht tot alle netwerkroutes verzameld zijn: dan hoeft er maar één bericht heen en weer. */
function waitIce(pc: RTCPeerConnection, ms = 2500): Promise<void> {
  if (pc.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((ok) => {
    const t = setTimeout(done, ms);
    function done() {
      clearTimeout(t);
      pc.removeEventListener('icegatheringstatechange', check);
      ok();
    }
    function check() {
      if (pc.iceGatheringState === 'complete') done();
    }
    pc.addEventListener('icegatheringstatechange', check);
  });
}

interface Peer {
  id: string;
  name: string;
  pc: RTCPeerConnection;
  audio: HTMLAudioElement;
  state: PeerState;
  speaking: boolean;
  analyser?: AnalyserNode;
  failedAt?: number;
  everConnected: boolean;
}

function levelOf(an: AnalyserNode, buf: Float32Array<ArrayBuffer>): number {
  an.getFloatTimeDomainData(buf);
  let s = 0;
  for (const v of buf) s += v * v;
  return Math.sqrt(s / buf.length);
}

export class Intercom {
  private group: GroupRide;
  private ev: IntercomEvents;
  private local: MediaStream | null = null;
  private localAnalyser?: AnalyserNode;
  private peers = new Map<string, Peer>();
  private helloTimer?: number;
  private levelTimer?: number;
  private stopped = false;
  muted = false;

  constructor(group: GroupRide, ev: IntercomEvents) {
    this.group = group;
    this.ev = ev;
  }

  private get me() {
    return this.group.me;
  }

  async start() {
    this.local = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
    });
    if (this.stopped) {
      this.local.getTracks().forEach((t) => t.stop());
      return;
    }
    const ctx = audioCtx();
    if (ctx) {
      this.localAnalyser = ctx.createAnalyser();
      this.localAnalyser.fftSize = 512;
      ctx.createMediaStreamSource(this.local).connect(this.localAnalyser);
    }
    this.group.onSignal((s) => this.onSignal(s));
    this.hello(true);
    // Elke 20 s opnieuw melden: zo vinden laatkomers en herstelde verbindingen elkaar
    this.helloTimer = window.setInterval(() => {
      this.hello();
      // Mislukte verbindingen die al een minuut niet herstellen: opruimen
      for (const p of this.peers.values()) if (p.state === 'failed' && p.failedAt && Date.now() - p.failedAt > 60000) this.closePeer(p.id, false);
    }, 20000);
    this.levelTimer = window.setInterval(() => this.measure(), 250);
  }

  private hello(fresh = false) {
    this.group.sendSignal({ type: 'hello', name: this.me.name, ...(fresh ? { fresh: true } : {}) });
  }

  /** Wie mag de verbinding starten? Altijd de rijder met het "kleinste" id, zo bellen ze elkaar niet tegelijk. */
  private iCall(other: string) {
    return this.me.id < other;
  }

  private onSignal(s: Signal) {
    if (this.stopped) return;
    const existing = this.peers.get(s.from);
    // Nieuwe verbinding nodig: nog geen, mislukt, of de ander is net (opnieuw) begonnen
    const needs = !existing || existing.state === 'failed' || !!s.fresh;
    switch (s.type) {
      case 'hello':
        if (needs) {
          if (this.iCall(s.from)) this.call(s.from, s.name ?? 'Rijder');
          else this.group.sendSignal({ type: 'here', to: s.from, name: this.me.name });
        }
        break;
      case 'here':
        if (needs && this.iCall(s.from)) this.call(s.from, s.name ?? 'Rijder');
        break;
      case 'offer':
        if (s.sdp) this.answer(s.from, s.name ?? existing?.name ?? 'Rijder', s.sdp);
        break;
      case 'answer':
        if (existing && s.sdp && existing.pc.signalingState === 'have-local-offer') {
          existing.pc.setRemoteDescription({ type: 'answer', sdp: s.sdp }).catch(() => this.markFailed(existing));
        }
        break;
      case 'bye':
        if (existing) this.closePeer(s.from, true); // bewust uitgezet door de ander
        break;
    }
  }

  private makePeer(id: string, name: string): Peer {
    this.closePeer(id, false);
    const pc = new RTCPeerConnection({ iceServers: iceServers() });
    const audio = new Audio();
    audio.autoplay = true;
    const peer: Peer = { id, name, pc, audio, state: 'connecting', speaking: false, everConnected: false };
    this.peers.set(id, peer);
    for (const t of this.local?.getAudioTracks() ?? []) pc.addTrack(t, this.local!);

    pc.ontrack = (e) => {
      const stream = e.streams[0] ?? new MediaStream([e.track]);
      audio.srcObject = stream;
      audio.play().catch(() => {});
      const ctx = audioCtx();
      if (ctx) {
        peer.analyser = ctx.createAnalyser();
        peer.analyser.fftSize = 512;
        ctx.createMediaStreamSource(stream).connect(peer.analyser);
      }
    };
    pc.onconnectionstatechange = () => {
      const st = pc.connectionState;
      if (st === 'connected') {
        const first = !peer.everConnected || peer.state !== 'connected';
        peer.state = 'connected';
        peer.failedAt = undefined;
        if (first) this.ev.onEvent('connected', peer.name);
        peer.everConnected = true;
      } else if (st === 'failed') {
        this.markFailed(peer);
      } else if (st === 'disconnected') {
        peer.state = 'connecting'; // vaak tijdelijk (tunnel, wisselende zendmast)
      }
      this.emit();
    };
    this.emit();
    return peer;
  }

  private markFailed(peer: Peer) {
    if (peer.state === 'failed') return;
    peer.state = 'failed';
    peer.failedAt = Date.now();
    this.ev.onEvent(peer.everConnected ? 'lost' : 'failed', peer.name);
    this.emit();
  }

  private async call(id: string, name: string) {
    const peer = this.makePeer(id, name);
    try {
      const offer = await peer.pc.createOffer();
      await peer.pc.setLocalDescription({ type: 'offer', sdp: tuneOpus(offer.sdp ?? '') });
      await waitIce(peer.pc);
      if (this.peers.get(id) !== peer) return;
      this.group.sendSignal({ type: 'offer', to: id, name: this.me.name, sdp: peer.pc.localDescription?.sdp });
      // Geen antwoord binnen 15 s? Dan telt het als mislukt (wordt later opnieuw geprobeerd)
      setTimeout(() => {
        if (this.peers.get(id) === peer && peer.state === 'connecting' && !peer.everConnected) this.markFailed(peer);
      }, 15000);
    } catch {
      this.markFailed(peer);
    }
  }

  private async answer(id: string, name: string, sdp: string) {
    const peer = this.makePeer(id, name);
    try {
      await peer.pc.setRemoteDescription({ type: 'offer', sdp });
      const ans = await peer.pc.createAnswer();
      await peer.pc.setLocalDescription({ type: 'answer', sdp: tuneOpus(ans.sdp ?? '') });
      await waitIce(peer.pc);
      if (this.peers.get(id) !== peer) return;
      this.group.sendSignal({ type: 'answer', to: id, name: this.me.name, sdp: peer.pc.localDescription?.sdp });
    } catch {
      this.markFailed(peer);
    }
  }

  private closePeer(id: string, announce: boolean) {
    const p = this.peers.get(id);
    if (!p) return;
    this.peers.delete(id);
    p.pc.ontrack = null;
    p.pc.onconnectionstatechange = null;
    p.pc.close();
    p.audio.srcObject = null;
    if (announce && p.everConnected) this.ev.onEvent('left', p.name);
    this.emit();
  }

  private lastLocalSpeaking = false;
  private buf = new Float32Array(512);
  private measure() {
    let changed = false;
    for (const p of this.peers.values()) {
      const speaking = !!p.analyser && p.state === 'connected' && levelOf(p.analyser, this.buf) > 0.02;
      if (speaking !== p.speaking) {
        p.speaking = speaking;
        changed = true;
      }
    }
    if (changed) this.emit();
    if (this.localAnalyser && this.ev.onLocalSpeaking) {
      const me = !this.muted && levelOf(this.localAnalyser, this.buf) > 0.03;
      if (me !== this.lastLocalSpeaking) {
        this.lastLocalSpeaking = me;
        this.ev.onLocalSpeaking(me);
      }
    }
  }

  private emit() {
    this.ev.onPeers(
      [...this.peers.values()].map((p) => ({ id: p.id, name: p.name, state: p.state, speaking: p.speaking })).sort((a, b) => a.name.localeCompare(b.name)),
    );
  }

  setMuted(m: boolean) {
    this.muted = m;
    for (const t of this.local?.getAudioTracks() ?? []) t.enabled = !m;
  }

  stop() {
    if (this.stopped) return;
    this.stopped = true;
    clearInterval(this.helloTimer);
    clearInterval(this.levelTimer);
    this.group.sendSignal({ type: 'bye' });
    this.group.onSignal(null);
    for (const id of [...this.peers.keys()]) this.closePeer(id, false);
    this.local?.getTracks().forEach((t) => t.stop());
    this.local = null;
  }
}
