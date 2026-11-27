import numpy as np, wave
SR = 44100; D = 61.0
N = int(SR * D); t = np.arange(N) / SR
L = np.zeros(N); Rr = np.zeros(N)
rng = np.random.default_rng(7)

def note(f):  # midi -> hz
    return 440 * 2 ** ((f - 69) / 12)

def env(t0, dur, a=0.5, r=1.0):
    e = np.zeros(N); i0 = int(t0 * SR); i1 = min(N, int((t0 + dur + r) * SR))
    tt = (np.arange(i0, i1) - i0) / SR
    e[i0:i1] = np.clip(tt / a, 0, 1) * np.where(tt > dur, np.exp(-(tt - dur) * 4 / r), 1)
    return e

def add(sig, pan=0.0, g=1.0):
    global L, Rr
    L += sig * g * (1 - pan) * 0.5 * 2 ** 0.5
    Rr += sig * g * (1 + pan) * 0.5 * 2 ** 0.5

def pad(t0, dur, midis, g=0.08, bright=0.0):
    e = env(t0, dur, a=1.5, r=2.0)
    i0 = int(t0 * SR); i1 = min(N, int((t0 + dur + 2.5) * SR))
    for m in midis:
        f = note(m)
        for det, pan in ((-0.12, -0.6), (0.0, 0.0), (0.13, 0.6)):
            ff = f * 2 ** (det / 12)
            s = np.zeros(N)
            ph = 2 * np.pi * ff * t[i0:i1] + rng.uniform(0, 6)
            s[i0:i1] = np.sin(ph) + 0.3 * np.sin(2 * ph) * bright + 0.12 * np.sin(3 * ph) * bright
            add(s * e, pan, g / len(midis))

def pluck(t0, m, g=0.12, pan=0.0, decay=2.2):
    f = note(m); i0 = int(t0 * SR); i1 = min(N, i0 + int(SR * 4))
    tt = (np.arange(i0, i1) - i0) / SR
    s = np.zeros(N)
    s[i0:i1] = (np.sin(2 * np.pi * f * tt) + 0.35 * np.sin(4 * np.pi * f * tt) * np.exp(-tt * 3) + 0.15 * np.sin(6 * np.pi * f * tt) * np.exp(-tt * 5)) * np.exp(-tt * decay) * np.clip(tt / 0.005, 0, 1)
    add(s, pan, g)

def chime(t0, m, g=0.06, pan=0.0):
    f = note(m); i0 = int(t0 * SR); i1 = min(N, i0 + int(SR * 5))
    tt = (np.arange(i0, i1) - i0) / SR; s = np.zeros(N)
    s[i0:i1] = (np.sin(2 * np.pi * f * tt) + 0.5 * np.sin(2 * np.pi * f * 2.76 * tt) * np.exp(-tt * 2) + 0.3 * np.sin(2 * np.pi * f * 5.4 * tt) * np.exp(-tt * 4)) * np.exp(-tt * 1.2) * np.clip(tt / 0.003, 0, 1)
    add(s, pan, g)

def noise_sweep(t0, dur, g=0.15, up=True):
    i0 = int(t0 * SR); i1 = min(N, int((t0 + dur) * SR)); n = i1 - i0
    w = rng.normal(0, 1, n); tt = np.linspace(0, 1, n)
    # simple one-pole lowpass with moving cutoff
    out = np.zeros(n); y = 0.0
    cut = (0.02 + 0.5 * tt) if up else (0.5 - 0.48 * tt)
    for i in range(n):
        y += cut[i] * (w[i] - y); out[i] = y
    e = np.sin(np.pi * tt) ** 2
    s = np.zeros(N); s[i0:i1] = out * e
    add(s, 0, g)

def boom(t0, g=0.5):
    i0 = int(t0 * SR); i1 = min(N, i0 + int(SR * 4)); tt = (np.arange(i0, i1) - i0) / SR
    s = np.zeros(N); f = 55 * np.exp(-tt * 1.5) + 30
    s[i0:i1] = np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-tt * 1.4)
    add(s, 0, g)

# --- wind bed (S1-S4, fades by S5)
wn = rng.normal(0, 1, N); y = 0; wind = np.zeros(N); c = 0.01
for i in range(0, N):
    y += c * (wn[i] - y); wind[i] = y
wind *= (0.6 + 0.4 * np.sin(t * 0.5)) * np.clip(1 - (t - 41) / 5, 0, 1)
add(wind, -0.2, 0.9)

# --- harmony: A minor, sparse (0-20), discovery (20-40), triumph major (41.5-60)
pad(0, 10, [45, 57, 60, 64], 0.10)            # Am
pad(10, 10, [41, 53, 57, 60], 0.10)           # F
pad(20, 10, [43, 55, 59, 62, 66], 0.11, 0.3)  # G(maj7-ish) shimmer
pad(30, 11.5, [40, 52, 56, 59, 64], 0.12, 0.4)  # E (tension)
pad(41.5, 8.5, [41, 53, 57, 60, 65, 69], 0.16, 1.0)  # F major bloom
pad(50, 11, [48, 55, 60, 64, 67, 72], 0.16, 1.0)  # C major resolve

# --- sparse piano motif
mot = [(1.0, 69), (2.5, 72), (4.0, 71), (6.5, 69), (8.0, 64),
       (11.0, 65), (12.5, 69), (14.0, 72), (16.5, 69), (18.0, 67),
       (21.0, 71), (22.0, 74), (23.0, 78), (25.0, 76), (27.0, 74), (28.5, 79),
       (31.0, 76), (32.5, 80), (34.0, 83), (36.0, 81), (38.0, 80), (39.5, 83)]
for tm, m in mot: pluck(tm, m, 0.11, pan=rng.uniform(-0.4, 0.4))

# glow flickers / discovery chimes
for tm in [10.8, 11.6, 12.9, 14.2]: chime(tm, 88 + rng.integers(0, 3), 0.025, rng.uniform(-0.6, 0.6))
for k in range(14): chime(20 + k * 0.7 + rng.uniform(0, 0.3), int(rng.choice([83, 86, 88, 90, 95])), 0.03, rng.uniform(-0.8, 0.8))
chime(33.6, 88, 0.08); chime(33.62, 95, 0.05)  # picking "ting"
for k in range(10): chime(34.5 + k * 0.55, int(rng.choice([86, 88, 91, 93])), 0.025, rng.uniform(-0.8, 0.8))

# --- burst
noise_sweep(39.5, 2.1, 0.35, True)
boom(41.5, 0.55)
for k in range(40): chime(41.5 + rng.uniform(0, 3.5), int(rng.choice([77, 81, 84, 89, 93, 96, 100])), 0.035, rng.uniform(-1, 1))
noise_sweep(41.5, 3.0, 0.18, False)
# triumphant arpeggio
arp = [65, 69, 72, 77, 81, 84]
for k in range(16): pluck(42.0 + k * 0.25, arp[k % 6] - (0 if k < 12 else 0), 0.09, pan=np.sin(k) * 0.5, decay=1.6)
# resolution melody
for tm, m in [(50.5, 72), (51.5, 76), (52.5, 79), (54.0, 84), (56.0, 79), (57.0, 76), (58.0, 72)]: pluck(tm, m, 0.12, decay=1.0)
# birds S6
for k in range(9):
    tb = 47 + k * 1.4 + rng.uniform(0, 0.6); i0 = int(tb * SR); n = int(SR * 0.18); tt = np.arange(n) / SR
    f = 2600 + 900 * np.sin(2 * np.pi * 14 * tt) + rng.uniform(-300, 300)
    s = np.zeros(N); s[i0:i0 + n] = np.sin(2 * np.pi * np.cumsum(f) / SR) * np.sin(np.pi * tt / tt[-1]) ** 2
    add(s, rng.uniform(-0.8, 0.8), 0.025)

# --- simple stereo reverb (feedback delays)
def reverb(x, g=0.35):
    out = x.copy()
    for d, a in ((0.031, 0.5), (0.047, 0.45), (0.071, 0.4), (0.113, 0.35), (0.173, 0.3), (0.251, 0.25)):
        k = int(d * SR); y = np.zeros_like(x); y[k:] = x[:-k] * a
        for _ in range(3):
            y2 = np.zeros_like(y); y2[k:] = y[:-k] * a; y += y2
        out += y * g
    return out
L = reverb(L); Rr = reverb(Rr)
# master fades
fade = np.clip(t / 1.5, 0, 1) * np.clip((D - 0.5 - t) / 2.5, 0, 1)
L *= fade; Rr *= fade
pk = max(np.abs(L).max(), np.abs(Rr).max()); L /= pk / 0.85; Rr /= pk / 0.85
st = np.stack([L, Rr], 1)
st = np.tanh(st * 1.1) / np.tanh(1.1)
with wave.open('music.wav', 'wb') as w:
    w.setnchannels(2); w.setsampwidth(2); w.setframerate(SR)
    w.writeframes((st * 32767).astype('<i2').tobytes())
print('ok')
