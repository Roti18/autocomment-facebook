# Facebook Auto Commenter — Beranda Scroll Mode

Bot auto-comment Facebook yang jalan di **beranda (homepage feed)**.
Alurnya: scroll beranda → scan post → cocokin keyword → comment → lanjut scroll.

Tujuan utama: **menghindari banned** dengan simulasi aktivitas manusia yang natural.

## Cara Kerja

1. Login ke Facebook (manual pertama kali, session disimpan)
2. Buka beranda (web.facebook.com)
3. Scroll feed perlahan (delay random 4-7.5 detik per scroll)
4. Setiap scroll, scan post yang terlihat:
   - Skip post sendiri (by profile URL)
   - Cek apakah mengandung keyword target
   - Kalau cocok: buka post di tab baru
   - Simulasi baca post (20-45 detik)
   - Ketik komentar karakter-per-karakter (human-like typing)
   - Kirim → kalau ditolak, retry tanpa link
   - Cooldown 2-5 menit sebelum comment berikutnya
   - Istirahat 15 menit setiap 4 komentar
5. Lanjut scroll sampai limit atau abis scroll count

## Fitur Anti-Banned

- ✅ **Beranda-based** — bukan masuk grup satu per satu (looks natural)
- ✅ **Character-by-character typing** — 20-80ms per karakter
- ✅ **Reading simulation** — delay 20-45 detik sebelum comment
- ✅ **Random jitter** — semua delay dikalikan 0.8x-1.5x
- ✅ **Long break** — 15 menit istirahat setiap 4 komentar
- ✅ **No-link fallback** — otomatis retry tanpa link kalau ditolak
- ✅ **Cooldown 2-5 menit** antar komentar
- ✅ **Skip own posts** — gak bakal comment post sendiri
- ✅ **Keyword filter** — cuma comment post yang relevan
- ✅ **Stealth init script** — sembunyiin webdriver detection

## Instalasi

```bash
npm install
npx playwright install chromium
```

## Konfigurasi

1. Copy `.env.example` ke `.env` dan isi:
   - `HEADLESS=false` untuk login pertama, `true` setelah session tersimpan
   - `TARGET_KEYWORDS` — keyword yang mau di-target (pisah koma)
   - Atur delay, cooldown, dan limit sesuai kebutuhan

2. (Opsional) `config.json` untuk auto-login:
```json
{
  "email": "nomor_hp_atau_email",
  "password": "password_fb"
}
```

3. Edit `comment_template.txt` — template komentar pake format Spintax `{Halo|Hi} kak, {ready?|masih ada?}`

## Cara Jalanin

```bash
npm start
```

Pertama kali: browser kebuka → login manual → bot deteksi session → jalan otomatis.
Sesi selanjutnya: langsung jalan karena session tersimpan.
