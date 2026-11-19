// Test of de microfoon van je helm-headset werkt in "belstand".
// We sturen het geluid via een echte WebRTC-verbinding (net als bij een gesprek
// in de app later), zodat de telefoon in dezelfde modus komt als bij bellen.
import { useEffect, useRef, useState } from 'react';
import { speak, unlockVoice } from '../lib/voice';
import { IconClose } from './Icons';

type Phase = 'intro' | 'starting' | 'live' | 'recording' | 'playing' | 'error';

interface Props {
  onClose: () => void;
}

// "Standaard"/"Default" bewust niet: op Android kan dat ook de headset zijn
const BUILTIN = /(ingebouwd|built-?in|internal|intern|iphone|telefoon|phone mic|speakerphone|bottom|microfoonarray|microphone array)/i;
const HEADSET = /(bluetooth|headset|hands-?free|handsfree|\bbt\b|helm|helmet|earbud|buds|airpods|sco|hfp)/i;

function deviceKind(label: string): 'headset' | 'builtin' | 'unknown' {
  if (HEADSET.test(label)) return 'headset';
  if (BUILTIN.test(label)) return 'builtin';
  return 'unknown';
}

export function MicTest({ onClose }: Props) {
  const [phase, setPhase] = useState<Phase>('intro');
  const [error, setError] = useState<string | null>(null);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [deviceId, setDeviceId] = useState<string>('');
  const [label, setLabel] = useState('');
  const [level, setLevel] = useState(0);
  const [heard, setHeard] = useState(false); // ooit duidelijk geluid opgevangen
  const [countdown, setCountdown] = useState(0);
  const [echoAnswer, setEchoAnswer] = useState<'yes' | 'no' | null>(null);

  const res = useRef<{
    stream?: MediaStream;
    pc1?: RTCPeerConnection;
    pc2?: RTCPeerConnection;
    remote?: MediaStream;
    ctx?: AudioContext;
    raf?: number;
    sink?: HTMLAudioElement;
    playback?: HTMLAudioElement;
  }>({});

  const stopAll = () => {
    const r = res.current;
    if (r.raf) cancelAnimationFrame(r.raf);
    r.stream?.getTracks().forEach((t) => t.stop());
    r.pc1?.close();
    r.pc2?.close();
    r.ctx?.close().catch(() => {});
    if (r.sink) r.sink.srcObject = null;
    r.playback?.pause();
    res.current = {};
  };

  useEffect(() => stopAll, []);

  const start = async (id?: string) => {
    stopAll();
    setPhase('starting');
    setError(null);
    setHeard(false);
    setEchoAnswer(null);
    unlockVoice();
    try {
      if (!navigator.mediaDevices?.getUserMedia) throw new Error('Deze browser ondersteunt geen microfoon. Gebruik Chrome (Android) of Safari (iPhone).');
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          ...(id ? { deviceId: { exact: id } } : {}),
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          channelCount: 1,
        },
      });
      const track = stream.getAudioTracks()[0];
      res.current.stream = stream;
      setLabel(track.label || 'Onbekende microfoon');
      setDeviceId(track.getSettings().deviceId ?? '');
      const all = await navigator.mediaDevices.enumerateDevices();
      setDevices(all.filter((d) => d.kind === 'audioinput' && d.deviceId !== 'communications'));

      // Echte WebRTC-verbinding binnen de telefoon: zet het toestel in belstand
      const pc1 = new RTCPeerConnection();
      const pc2 = new RTCPeerConnection();
      pc1.onicecandidate = (e) => e.candidate && pc2.addIceCandidate(e.candidate).catch(() => {});
      pc2.onicecandidate = (e) => e.candidate && pc1.addIceCandidate(e.candidate).catch(() => {});
      const remote = new MediaStream();
      pc2.ontrack = (e) => remote.addTrack(e.track);
      pc1.addTrack(track, stream);
      const offer = await pc1.createOffer();
      await pc1.setLocalDescription(offer);
      await pc2.setRemoteDescription(offer);
      const answer = await pc2.createAnswer();
      await pc2.setLocalDescription(answer);
      await pc1.setRemoteDescription(answer);
      // Chrome laat binnenkomend WebRTC-geluid alleen stromen als het aan een (stil) audio-element hangt
      const sink = new Audio();
      sink.muted = true;
      sink.srcObject = remote;
      sink.play().catch(() => {});
      Object.assign(res.current, { pc1, pc2, remote, sink });

      // Niveaumeter op het eigen microfoonsignaal
      const ctx = new AudioContext();
      const src = ctx.createMediaStreamSource(stream);
      const an = ctx.createAnalyser();
      an.fftSize = 1024;
      src.connect(an);
      res.current.ctx = ctx;
      const buf = new Float32Array(an.fftSize);
      let loud = 0;
      const tick = () => {
        an.getFloatTimeDomainData(buf);
        let sum = 0;
        for (const v of buf) sum += v * v;
        const rms = Math.sqrt(sum / buf.length);
        const db = 20 * Math.log10(rms + 1e-8); // -100..0
        const l = Math.max(0, Math.min(1, (db + 60) / 50));
        setLevel((prev) => Math.max(l, prev * 0.85));
        if (l > 0.35) {
          if (++loud > 8) setHeard(true);
        } else loud = Math.max(0, loud - 1);
        res.current.raf = requestAnimationFrame(tick);
      };
      tick();
      setPhase('live');
    } catch (e) {
      const err = e as DOMException;
      setError(
        err.name === 'NotAllowedError'
          ? 'Geen toestemming voor de microfoon. Sta de microfoon toe in je browser (slotje/instellingen naast het adres) en probeer opnieuw.'
          : err.name === 'NotFoundError'
            ? 'Geen microfoon gevonden. Staat je headset aan en verbonden?'
            : err.message || 'Microfoon starten mislukt.',
      );
      setPhase('error');
    }
  };

  // Echotest: 5 seconden opnemen wat er via de "gespreksverbinding" binnenkomt en afspelen
  const echoTest = async () => {
    const r = res.current;
    if (!r.remote || !r.remote.getAudioTracks().length) return;
    setPhase('recording');
    setEchoAnswer(null);
    const rec = new MediaRecorder(r.remote);
    const chunks: Blob[] = [];
    rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    const done = new Promise<void>((ok) => (rec.onstop = () => ok()));
    rec.start();
    for (let s = 5; s > 0; s--) {
      setCountdown(s);
      await new Promise((ok) => setTimeout(ok, 1000));
    }
    rec.stop();
    await done;
    setPhase('playing');
    const audio = new Audio(URL.createObjectURL(new Blob(chunks, { type: rec.mimeType })));
    r.playback = audio;
    audio.onended = () => setPhase('live');
    audio.play().catch(() => setPhase('live'));
  };

  const kind = deviceKind(label);
  const inputs = devices.filter((d) => d.label);

  return (
    <div className="modal" role="dialog" aria-modal="true" aria-label="Helm-microfoon testen">
      <div className="modal-card mic-test">
        <header className="modal-head">
          <h2>Helm-microfoon testen</h2>
          <button className="icon-btn ghost" onClick={() => (stopAll(), onClose())} title="Sluiten">
            <IconClose size={20} />
          </button>
        </header>

        {phase === 'intro' && (
          <>
            <ol className="steps">
              <li>Zet je helm-headset aan en verbind hem via Bluetooth met deze telefoon.</li>
              <li>Zet de helm op (of houd de microfoon bij je mond).</li>
              <li>Tik op <b>Start test</b> en sta de microfoon toe.</li>
            </ol>
            <p className="hint">De app zet je telefoon in "belstand", net als WhatsApp. Pas dan schakelen de meeste headsets hun microfoon in.</p>
            <button className="primary big" onClick={() => start()}>
              Start test
            </button>
          </>
        )}

        {phase === 'starting' && <p className="hint loading-line">Microfoon starten…</p>}

        {phase === 'error' && (
          <>
            <div className="error">{error}</div>
            <button className="primary" onClick={() => start(deviceId || undefined)}>
              Opnieuw proberen
            </button>
          </>
        )}

        {(phase === 'live' || phase === 'recording' || phase === 'playing') && (
          <>
            <div className="mic-device">
              <span className="mic-label">Microfoon in gebruik</span>
              <strong>{label}</strong>
              {inputs.length > 1 && (
                <select className="text-input" value={deviceId} onChange={(e) => start(e.target.value)}>
                  {inputs.map((d) => (
                    <option key={d.deviceId} value={d.deviceId}>
                      {d.label}
                    </option>
                  ))}
                </select>
              )}
            </div>

            <div className="meter" aria-label="Microfoonniveau">
              <div className="meter-fill" style={{ width: `${Math.round(level * 100)}%` }} />
            </div>
            <p className="hint">{heard ? '✓ Geluid ontvangen.' : 'Praat of tik zachtjes op de microfoon: de balk moet uitslaan.'}</p>

            <div className="actions-row">
              <button className="secondary" onClick={echoTest} disabled={phase !== 'live'}>
                {phase === 'recording' ? `Praat nu… ${countdown}` : phase === 'playing' ? 'Afspelen…' : '🎙️ Echotest (5 sec)'}
              </button>
              <button className="secondary" onClick={() => speak('Over 200 meter, rechts afslaan.', true)}>
                🔊 Test navigatiestem
              </button>
            </div>

            {phase === 'live' && res.current.playback && echoAnswer === null && (
              <div className="echo-q">
                <span>Hoorde je jezelf terug in je helm?</span>
                <button className="secondary small" onClick={() => setEchoAnswer('yes')}>
                  Ja
                </button>
                <button className="secondary small" onClick={() => setEchoAnswer('no')}>
                  Nee
                </button>
              </div>
            )}

            <Verdict kind={kind} heard={heard} echo={echoAnswer} />
          </>
        )}
      </div>
    </div>
  );
}

function Verdict({ kind, heard, echo }: { kind: 'headset' | 'builtin' | 'unknown'; heard: boolean; echo: 'yes' | 'no' | null }) {
  if (echo === 'yes' && kind !== 'builtin') {
    return (
      <div className="notice good">
        ✅ <b>Je helm-microfoon werkt in belstand.</b> Praten via de app zou met deze headset moeten lukken.
      </div>
    );
  }
  if (kind === 'builtin') {
    return (
      <div className="notice warn">
        ⚠️ De <b>telefoonmicrofoon</b> wordt gebruikt, niet je helm. Kies je headset in de lijst hierboven als die erbij staat. Staat hij er niet bij: zet de headset uit en aan,
        controleer in de Bluetooth-instellingen van je telefoon dat <b>"Telefoongesprekken"</b> (Android) aan staat voor de headset, en probeer opnieuw.
      </div>
    );
  }
  if (echo === 'yes') {
    return <div className="notice good">✅ Opname en weergave werken. Klinkt het uit je helm? Dan is je headset goed ingesteld.</div>;
  }
  if (echo === 'no') {
    return (
      <div className="notice warn">
        ⚠️ Geen geluid in je helm. Controleer het volume van de headset, en of het geluid misschien uit de telefoon zelf kwam. Op Android: zet bij de headset in de
        Bluetooth-instellingen zowel <b>"Telefoongesprekken"</b> als <b>"Media-audio"</b> aan.
      </div>
    );
  }
  if (kind === 'headset' && heard) {
    return <div className="notice good">✅ Je headset-microfoon vangt geluid op. Doe ook even de echotest om te horen of het geluid in je helm terugkomt.</div>;
  }
  return <p className="hint">Doe de echotest: zeg iets, en luister of je jezelf daarna terughoort in je helm.</p>;
}
