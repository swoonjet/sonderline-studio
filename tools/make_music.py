"""Original music beds for the video prototype, synthesised from scratch (no samples, no licences).

    ~/.venvs/audio/bin/python tools/make_music.py

Writes assets/music/<name>.m4a plus assets/music/tracks.json (tempo, bars, mood), which the
video engine uses to cut scenes on the beat.
"""
import json
import pathlib
import subprocess
import tempfile

import numpy as np
from scipy.io import wavfile
from scipy.signal import butter, fftconvolve, sosfilt

SR = 44100
ROOT = pathlib.Path(__file__).resolve().parent.parent
OUT = ROOT / "assets/music"
rng = np.random.default_rng(7)


def hz(midi):
    return 440.0 * 2 ** ((midi - 69) / 12)


def env(n, a, r, sustain=1.0):
    """Attack/release envelope over n samples (seconds for a, r)."""
    e = np.full(n, sustain)
    na, nr = min(n, int(a * SR)), min(n, int(r * SR))
    if na: e[:na] = np.linspace(0, sustain, na)
    if nr: e[-nr:] *= np.linspace(1, 0, nr)
    return e


def lp(x, f, order=2):
    return sosfilt(butter(order, f, "low", fs=SR, output="sos"), x)


def hp(x, f, order=2):
    return sosfilt(butter(order, f, "high", fs=SR, output="sos"), x)


def bp(x, lo, hi):
    return sosfilt(butter(2, [lo, hi], "band", fs=SR, output="sos"), x)


def saw(f, n, harmonics=18):
    t = np.arange(n) / SR
    out = np.zeros(n)
    for k in range(1, harmonics + 1):
        if f * k > 9000: break
        out += np.sin(2 * np.pi * f * k * t) / k
    return out


def pad(notes, dur, cutoff=1400):
    n = int(dur * SR)
    L = np.zeros(n); R = np.zeros(n)
    for m in notes:
        L += saw(hz(m) * 2 ** (-6 / 1200), n) + 0.5 * saw(hz(m) * 2 ** (4 / 1200), n)
        R += saw(hz(m) * 2 ** (6 / 1200), n) + 0.5 * saw(hz(m) * 2 ** (-4 / 1200), n)
    e = env(n, min(0.6, dur / 3), min(0.9, dur / 2))
    return lp(L * e, cutoff) / len(notes), lp(R * e, cutoff) / len(notes)


def pluck(m, dur=0.45, bright=1.0):
    n = int(dur * SR); t = np.arange(n) / SR
    f = hz(m)
    x = np.sin(2 * np.pi * f * t) + 0.35 * bright * np.sin(4 * np.pi * f * t) + 0.12 * bright * np.sin(6 * np.pi * f * t)
    return x * np.exp(-t * 9) * env(n, 0.004, 0.05)


def bell(m, dur=1.6):
    n = int(dur * SR); t = np.arange(n) / SR
    f = hz(m)
    x = np.sin(2 * np.pi * f * t) + 0.4 * np.sin(2 * np.pi * f * 2.76 * t) * np.exp(-t * 3) + 0.2 * np.sin(2 * np.pi * f * 5.4 * t) * np.exp(-t * 6)
    return x * np.exp(-t * 2.2) * env(n, 0.003, 0.2)


def kick(dur=0.32):
    n = int(dur * SR); t = np.arange(n) / SR
    f = 45 + 75 * np.exp(-t * 28)
    ph = 2 * np.pi * np.cumsum(f) / SR
    return np.sin(ph) * np.exp(-t * 11) + 0.15 * rng.standard_normal(n) * np.exp(-t * 300)


def hat(dur=0.05):
    n = int(dur * SR)
    return hp(rng.standard_normal(n), 7000) * np.exp(-np.arange(n) / SR * 90)


def clap():
    n = int(0.22 * SR); t = np.arange(n) / SR
    noise = bp(rng.standard_normal(n), 900, 3200)
    e = np.exp(-t * 22) + sum(np.exp(-(t - d) * 120) * (t >= d) for d in (0.0, 0.011, 0.022))
    return noise * e * 0.6


def place(buf, x, at, gain=1.0):
    i = int(at * SR)
    if i >= len(buf): return
    j = min(len(buf), i + len(x))
    buf[i:j] += gain * x[: j - i]


def reverb(x, secs=1.8, wet=0.25):
    n = int(secs * SR); t = np.arange(n) / SR
    ir = lp(rng.standard_normal(n), 5000) * np.exp(-t * 3.2 / secs)
    ir /= np.sqrt(np.sum(ir ** 2))
    return (1 - wet) * x + wet * fftconvolve(x, ir)[: len(x)]


def master(L, R):
    s = np.stack([L, R], 1)
    s = np.tanh(1.2 * s / (np.max(np.abs(s)) + 1e-9))
    rms = np.sqrt(np.mean(s ** 2))
    s *= 10 ** (-17 / 20) / rms                       # ~ -17 dBFS RMS: a bed under voice or silence
    peak = np.max(np.abs(s))
    if peak > 0.89: s *= 0.89 / peak                    # ~ -1 dBFS ceiling
    fade = int(0.02 * SR); s[:fade] *= np.linspace(0, 1, fade)[:, None]
    return s


def track_pulse(bars=32, bpm=120):
    """Minimal, forward: soft four-on-the-floor, side-chained pad, filtered pluck arpeggio."""
    beat = 60 / bpm; bar = 4 * beat; total = bars * bar
    n = int((total + 2) * SR)
    L = np.zeros(n); R = np.zeros(n); drums = np.zeros(n)
    prog = [[57, 64, 67, 71, 74], [53, 60, 64, 67, 72], [48, 55, 59, 64, 67], [55, 62, 67, 69, 74]]   # Am9 Fmaj9 Cmaj7 Gsus
    for b in range(bars):
        chord = prog[(b // 2) % 4]
        if b % 2 == 0:
            pl, pr = pad(chord, 2 * bar + 0.6, cutoff=1100 + 500 * ((b // 8) % 2))
            place(L, pl, b * bar, 0.55); place(R, pr, b * bar, 0.55)
        arp = [chord[i % len(chord)] + 12 for i in (0, 2, 1, 3, 2, 4, 3, 1)]
        if b >= 2:
            for i in range(8):
                p = pluck(arp[i], 0.35, bright=0.6 + 0.4 * (b >= 8))
                place(L, p, b * bar + i * beat / 2, 0.28 if i % 2 else 0.22)
                place(R, p, b * bar + i * beat / 2 + 0.012, 0.22 if i % 2 else 0.28)
        for q in range(4):
            if b >= 4: place(drums, kick(), b * bar + q * beat, 0.9)
            if b >= 8: place(drums, hat(), b * bar + q * beat + beat / 2, 0.18)
        place(L, saw(hz(chord[0] - 12), int(bar * SR), 6) * env(int(bar * SR), 0.01, 0.2), b * bar, 0.18)
        place(R, saw(hz(chord[0] - 12), int(bar * SR), 6) * env(int(bar * SR), 0.01, 0.2), b * bar, 0.18)
    # side-chain: duck the music on every kick from bar 4
    duck = np.ones(n)
    for k in range(4 * 4, bars * 4):
        i = int(k * beat * SR); m = int(0.22 * SR)
        duck[i:i + m] = np.minimum(duck[i:i + m], 0.55 + 0.45 * np.linspace(0, 1, m))
    L = reverb(L * duck); R = reverb(R * duck, wet=0.27)
    L += drums; R += drums
    return master(L, R)[: int(total * SR)], bpm


def track_contour(bars=24, bpm=96):
    """Ambient and patient: wide pads, sparse bells, a soft pulse on the one."""
    beat = 60 / bpm; bar = 4 * beat; total = bars * bar
    n = int((total + 3) * SR)
    L = np.zeros(n); R = np.zeros(n)
    prog = [[50, 57, 62, 64, 69], [46, 53, 58, 62, 65], [43, 50, 55, 57, 62], [45, 52, 57, 61, 64]]  # Dm9-ish, Bbmaj, Gm9, A
    motif = [74, 72, 69, 67, 69, 72]
    for b in range(bars):
        chord = prog[(b // 2) % 4]
        if b % 2 == 0:
            pl, pr = pad(chord, 2 * bar + 1.0, cutoff=900)
            place(L, pl, b * bar, 0.7); place(R, pr, b * bar, 0.7)
        if b >= 2 and b % 2 == 1:
            for i, m in enumerate(motif[: 3 + (b // 4) % 3]):
                bl = bell(m)
                place(L, bl, b * bar + i * beat * 0.75, 0.16); place(R, bl, b * bar + i * beat * 0.75 + 0.02, 0.13)
        if b >= 4:
            place(L, kick(0.5) * 0.5, b * bar, 0.6); place(R, kick(0.5) * 0.5, b * bar, 0.6)
    L = reverb(L, 2.6, 0.35); R = reverb(R, 2.6, 0.38)
    return master(L, R)[: int(total * SR)], bpm


def track_signal(bars=32, bpm=120):
    """Brighter and rhythmic: pentatonic pluck sequence, claps on 2 and 4."""
    beat = 60 / bpm; bar = 4 * beat; total = bars * bar
    n = int((total + 2) * SR)
    L = np.zeros(n); R = np.zeros(n); drums = np.zeros(n)
    prog = [[50, 57, 62, 66, 69], [47, 54, 59, 62, 66], [43, 50, 55, 59, 62], [45, 52, 57, 61, 64]]   # D, Bm, G, A
    seq = [74, 76, 78, 81, 78, 76, 74, 69, 71, 74, 76, 74, 71, 69, 66, 69]
    for b in range(bars):
        chord = prog[(b // 2) % 4]
        if b % 2 == 0:
            pl, pr = pad(chord, 2 * bar + 0.5, cutoff=1600)
            place(L, pl, b * bar, 0.4); place(R, pr, b * bar, 0.4)
        for i in range(16):
            if (i % 3 == 0) or (b >= 8 and i % 4 == 2):
                p = pluck(seq[(i + b) % 16] - (0 if b % 4 < 2 else 2), 0.3, 1.0)
                pan = 0.5 + 0.35 * np.sin(i)
                place(L, p, b * bar + i * beat / 4, 0.22 * (1 - pan) * 2); place(R, p, b * bar + i * beat / 4, 0.22 * pan * 2)
        for q in range(4):
            if b >= 2: place(drums, kick(0.25), b * bar + q * beat, 0.75)
            if b >= 4 and q in (1, 3): place(drums, clap(), b * bar + q * beat, 0.5)
            if b >= 8: place(drums, hat(0.03), b * bar + q * beat + beat / 2, 0.15)
        place(L, saw(hz(chord[0] - 12), int(bar * SR), 5) * env(int(bar * SR), 0.01, 0.15), b * bar, 0.16)
        place(R, saw(hz(chord[0] - 12), int(bar * SR), 5) * env(int(bar * SR), 0.01, 0.15), b * bar, 0.16)
    L = reverb(L, 1.4, 0.22); R = reverb(R, 1.4, 0.24)
    L += drums; R += drums
    return master(L, R)[: int(total * SR)], bpm


TRACKS = {
    "pulse": (track_pulse, "Minimal and forward: soft four-on-the-floor, warm pad, plucked arpeggio"),
    "contour": (track_contour, "Ambient and patient: wide pads, sparse bells, no drums"),
    "signal": (track_signal, "Bright and rhythmic: pentatonic plucks, claps on 2 and 4"),
}


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    meta = {}
    for name, (fn, mood) in TRACKS.items():
        audio, bpm = fn()
        with tempfile.TemporaryDirectory() as tmp:
            wav = pathlib.Path(tmp) / f"{name}.wav"
            wavfile.write(wav, SR, (audio * 32767).astype(np.int16))
            subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", str(wav), "-c:a", "aac", "-b:a", "192k", str(OUT / f"{name}.m4a")], check=True)
        meta[name] = {"file": f"assets/music/{name}.m4a", "bpm": bpm, "seconds": round(len(audio) / SR, 2), "mood": mood,
                      "source": "Original, synthesised for this prototype by tools/make_music.py (no samples)."}
        print(f"{name}: {bpm} bpm, {len(audio) / SR:.1f}s")
    (OUT / "tracks.json").write_text(json.dumps(meta, indent=2) + "\n")


if __name__ == "__main__":
    main()
