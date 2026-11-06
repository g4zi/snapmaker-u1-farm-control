# U1 Farm Control

**Snapmaker U1** 3D yazıcılar için Windows masaüstü baskı çiftliği kontrol paneli.
Birden fazla yazıcıyı tek ekrandan izleyin; uygulamayı küçültünce her yazıcı saatin yanındaki
sistem tepsisinde canlı yüzde gösteren bir ikon olarak kalır.

> *A Windows print-farm dashboard for Snapmaker U1 printers with live progress in the system tray,
> camera view, filament unload and print controls. UI is in Turkish — see [English](#english) below.*

![Ekran görüntüsü](docs/screenshot.png)

## Özellikler

- **Tepsi ikonları** — her yazıcı için saatin yanında ayrı ikon; içinde baskı yüzdesi yazar,
  arka plan ilerledikçe dolar. Renk durumu gösterir (yeşil yazdırıyor, turuncu duraklatıldı,
  mavi ✓ bitti, kırmızı hata, gri çevrimdışı). Üzerine gelince kalan süre ve dosya adı görünür.

  ![Tepsi ikonları](docs/tray-icons.png)

- **Canlı kamera** — stok firmware'de dahili kamera kendiliğinden yayın yapmaz; uygulama
  kamerayı otomatik uyandırır ve görüntüyü gösterir (~1 kare/sn).
- **Baskı bilgisi** — ilerleme, kalan süre, tahmini bitiş saati, katman, filament kullanımı,
  anlık hız, dilimleyici önizlemesi.
- **4 takım kafası** — her kafanın filament rengi/türü, sıcaklığı ve aktif kafa.
- **Filament çıkarma** — tek kafadan, seçili kafalardan ya da hepsinden; yazıcının kendi
  çıkarma akışını kullanır.
- **Kontroller** — duraklat / devam / iptal, kabin ışığı, hız-akış-fan ayarı, sıcaklık ayarı,
  ısıtıcıları kapatma, acil stop.
- **Dosyalar ve geçmiş** — yazıcıdaki G-code dosyalarından baskı başlatma, geçmiş baskılar.
- **Bildirimler** — baskı bitti, duraklatıldı, hata, bağlantı koptu.
- Windows ile birlikte tepside gizli başlatma seçeneği.

## Kurulum

[Releases](../../releases) sayfasından son sürümü indirin:

- `U1-Farm-Control-Setup-x.y.z.exe` — kurulum sihirbazı
- `U1-Farm-Control-Portable-x.y.z.exe` — kurulum gerektirmeyen tek dosya

İlk açılışta **Ayarlar** penceresi açılır; yazıcılarınızın yerel ağdaki IP adreslerini girin.

> Kurulum dosyası dijital olarak imzalı olmadığı için Windows SmartScreen uyarı verebilir:
> **Ek bilgi → Yine de çalıştır**.

### Gereksinimler

- Windows 10 / 11 (x64)
- Snapmaker U1 (stok firmware ile test edildi, sürüm `2.0.0.205`)
- Bilgisayar ve yazıcılar aynı yerel ağda olmalı. Uygulama yazıcıya doğrudan bağlanır
  (Moonraker API, port `7125`); bulut ya da hesap gerekmez.

## Kaynaktan çalıştırma

[Node.js](https://nodejs.org/) 20+ gerekir.

```bash
git clone https://github.com/<kullanici-adi>/u1-farm-control.git
cd u1-farm-control
npm install
npm start
```

Windows kurulum dosyası üretmek için:

```bash
npm run dist
```

Çıktılar `dist/` klasörüne yazılır. Depoya `v1.2.3` biçiminde bir etiket gönderildiğinde
GitHub Actions kurulum dosyalarını derleyip otomatik olarak bir Release oluşturur.

## Nasıl çalışır

| Ne | Nasıl |
|---|---|
| Durum | 2 saniyede bir `GET /printer/objects/query` (Moonraker) |
| Kamera | Websocket üzerinden `camera.start_monitor` (`{"domain":"lan"}`) çağrısı 8 sn'de bir tekrarlanır; kareler `/server/files/camera/monitor.jpg` adresinden okunur |
| Filament çıkarma | `AUTO_FEEDING_BATCH` ile `AUTO_FEEDING EXTRUDER=n UNLOAD=1 STAGE=prepare/doing` — yazıcının ekranının kullandığı akış |
| Tepsi ikonu | Arayüzde canvas ile çizilip Electron `Tray` ikonuna aktarılır |

Kod yapısı:

```
main.js            Electron ana süreç: yoklama, tepsi, bildirimler, yazıcı komutları
preload.js         Arayüz ↔ ana süreç köprüsü
renderer/          Panel arayüzü (HTML / CSS / JS, framework yok)
assets/            Uygulama ikonu
```

Ayarlar `%APPDATA%\U1 Farm Control\config.json` dosyasında saklanır.

## Uyarı

Bu proje Snapmaker ile bağlantılı değildir ve resmi değildir. Kullandığı komutlar stok
firmware'den okunmuştur; firmware güncellemeleri davranışı değiştirebilir. Filament çıkarma,
acil stop gibi işlemler yazıcınızı fiziksel olarak hareket ettirir — kendi sorumluluğunuzda kullanın.

## Lisans

[MIT](LICENSE)

---

## English

**U1 Farm Control** is a Windows desktop dashboard for a farm of Snapmaker U1 printers.

- One tray icon per printer next to the clock, showing live print percentage and state color
- Live camera (wakes the stock U1 camera automatically via `camera.start_monitor`)
- Progress, remaining time, ETA, layers, filament, speed and slicer thumbnail
- All 4 toolheads with filament colors and temperatures
- Filament unload per head, for selected heads or for all heads
- Pause / resume / cancel, chamber light, speed / flow / fan, temperatures, emergency stop
- File browser with "print" button, print history, desktop notifications

Download the installer or portable exe from [Releases](../../releases), or run from source with
`npm install && npm start`. On first launch, add your printers' LAN IP addresses in Settings.
Talks directly to the printer's Moonraker API on port 7125; no cloud account is needed.

Not affiliated with Snapmaker. Use at your own risk.
