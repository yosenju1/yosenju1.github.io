"""Build 6 clean clips + final cut with captions, dips and music."""
import subprocess, os, sys, glob
import numpy as np
from PIL import Image, ImageDraw, ImageFont, ImageFilter

W, H, FPS = 1080, 1920, 24
HERE = os.path.dirname(os.path.abspath(__file__))
OUT = sys.argv[1]
os.makedirs(OUT, exist_ok=True)
FB = '/usr/share/fonts/truetype/crosextra/Caladea-Bold.ttf'
FI = '/usr/share/fonts/truetype/crosextra/Caladea-Italic.ttf'

def run(cmd):
    print(' '.join(cmd[:6]), '...'); subprocess.run(cmd, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

# ---------- 1. clean clips ----------
names = ['01_hutan_yang_layu', '02_cahaya_misterius', '03_penemuan', '04_memetik_buah', '05_keajaiban', '06_hutan_hidup_kembali']
for i, n in enumerate(names):
    run(['ffmpeg', '-y', '-framerate', str(FPS), '-i', f'{HERE}/frames/s{i+1}/%05d.jpg',
         '-vf', f'scale={W}:{H}:flags=lanczos', '-c:v', 'libx264', '-preset', 'slow', '-crf', '17',
         '-pix_fmt', 'yuv420p', '-movflags', '+faststart', f'{OUT}/{n}.mp4'])

# ---------- 2. captions ----------
def wrap(draw, text, font, maxw):
    words, lines, cur = text.split(), [], ''
    for w in words:
        t = (cur + ' ' + w).strip()
        if draw.textlength(t, font=font) <= maxw: cur = t
        else: lines.append(cur); cur = w
    lines.append(cur); return lines

def caption_img(text, size=58, font=FI, y_center=0.80, spacing=1.28, title=False):
    img = Image.new('RGBA', (W, H), (0, 0, 0, 0)); d = ImageDraw.Draw(img)
    f = ImageFont.truetype(font, size)
    lines = wrap(d, text, f, W - 2 * 110)
    lh = size * spacing; y0 = H * y_center - lh * len(lines) / 2
    # soft shadow layer
    sh = Image.new('RGBA', (W, H), (0, 0, 0, 0)); ds = ImageDraw.Draw(sh)
    for k, ln in enumerate(lines):
        tw = d.textlength(ln, font=f); x = (W - tw) / 2; y = y0 + k * lh
        ds.text((x, y + 3), ln, font=f, fill=(0, 0, 0, 230))
    sh = sh.filter(ImageFilter.GaussianBlur(9 if not title else 14))
    img = Image.alpha_composite(sh, img); d = ImageDraw.Draw(img)
    for k, ln in enumerate(lines):
        tw = d.textlength(ln, font=f); x = (W - tw) / 2; y = y0 + k * lh
        if title: d.text((x, y), ln, font=f, fill=(255, 236, 200, 255), stroke_width=1, stroke_fill=(120, 70, 30, 255))
        else: d.text((x, y), ln, font=f, fill=(255, 250, 240, 255))
    if title:  # small ornament line
        d.line([(W / 2 - 150, y0 + len(lines) * lh + 24), (W / 2 + 150, y0 + len(lines) * lh + 24)], fill=(255, 200, 130, 200), width=3)
    return np.asarray(img).astype(np.float32) / 255.0

CAPS = [  # (t0, t1, image)
    (0.6, 4.6, caption_img('BUAH KRISTAL TERAKHIR', 96, FB, 0.30, title=True)),
    (5.0, 9.6, caption_img('Dulu, hutan ini penuh warna. Kini, semuanya mulai layu… dan sunyi.')),
    (10.9, 19.4, caption_img('Tapi di balik semak, ada sesuatu yang masih bersinar.')),
    (21.0, 29.4, caption_img('Buah kristal terakhir. Konon, di dalamnya tersimpan jantung hutan.')),
    (31.0, 39.4, caption_img('Dengan hati-hati, ia memetiknya. Hangat, seperti matahari pagi.')),
    (43.0, 49.5, caption_img('Lalu cahaya itu pecah… dan hutan pun bernapas kembali.')),
    (50.7, 54.9, caption_img('Satu buah telah pergi, tapi sebutir benih tertinggal.')),
    (55.2, 58.6, caption_img('Dan harapan pun tumbuh lagi.', 66)),
]
FADE = 0.5
def cap_alpha(t, t0, t1):
    return min(1, max(0, (t - t0) / FADE), max(0, (t1 - t) / FADE)) if t0 <= t <= t1 else 0

def dip(t):  # dip-to-black at cuts + intro/outro fade
    g = min(1.0, t / 1.2) * min(1.0, max(0.0, (60 - t) / 2.0))
    for c, w in ((10, 0.18), (20, 0.18), (30, 0.18)):
        if abs(t - c) < w: g *= abs(t - c) / w
    return g

# ---------- 3. final ----------
frames = []
for i in range(6): frames += sorted(glob.glob(f'{HERE}/frames/s{i+1}/*.jpg'))
p = subprocess.Popen(['ffmpeg', '-y', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', f'{W}x{H}', '-r', str(FPS), '-i', '-',
                      '-i', f'{HERE}/music.wav', '-map', '0:v', '-map', '1:a', '-c:v', 'libx264', '-preset', 'slow', '-crf', '18',
                      '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k', '-shortest', '-movflags', '+faststart',
                      f'{OUT}/Buah_Kristal_Terakhir_FINAL.mp4'], stdin=subprocess.PIPE, stderr=subprocess.DEVNULL)
for k, fpath in enumerate(frames):
    t = k / FPS
    im = np.asarray(Image.open(fpath).convert('RGB').resize((W, H), Image.LANCZOS)).astype(np.float32) / 255.0
    for t0, t1, cap in CAPS:
        a = cap_alpha(t, t0, t1)
        if a > 0:
            al = cap[..., 3:4] * a
            im = im * (1 - al) + cap[..., :3] * al
    im *= dip(t)
    p.stdin.write((np.clip(im, 0, 1) * 255).astype(np.uint8).tobytes())
    if k % 120 == 0: print('final', k, len(frames))
p.stdin.close(); p.wait()
print('done')
