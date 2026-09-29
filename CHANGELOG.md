# Değişiklik Geçmişi

## v1.1.0 - 2026-09-29

macOS desteği ve güvenlik/sağlamlık düzeltmeleri:

- **macOS desteği:** oturum jetonu Claude Code'un Keychain kaydından (`Claude Code-credentials`) okunuyor, bulunamazsa `~/.claude/.credentials.json` dosyasına bakılıyor. Chrome/Edge/Brave/Chromium `--app` penceresiyle açılıyor, hiçbiri yoksa `open` ile varsayılan tarayıcı kullanılıyor.
- `npm run build` macOS'ta `dist/ClaudeLimits.app` üretiyor (SEA + ad-hoc imza, Terminal penceresi ve Dock ikonu olmadan).
- macOS'ta Chrome son pencere kapanınca kapanmadığı için panel, pencere kapanırken sunucuya haber veriyor; sunucu kısa bir bekleme sonrası tarayıcı sürecini de kapatıp sonlanıyor.
- Bozuk bir `Host` başlığıyla gelen isteğin sunucuyu çökertmesi düzeltildi; beklenmedik istek hataları artık süreci düşürmüyor, 500 dönüyor.
- Yerel sunucu artık yalnızca `127.0.0.1`'i dinliyor (önceden aynı ağdaki cihazlar da erişebiliyordu).
- Arayüzde API'den gelen değerler HTML'e yazılmadan önce kaçış karakterlerine çevriliyor.
- Windows build'inde boşluk içeren klasör yollarında `postject` adımının bozulması düzeltildi.
- README ve yorumlardaki küçük hatalar düzeltildi.

## v1.0.2 - 2026-09-02

Kullanıcıdan gelen geri bildirim üzerine çözülen sorun: `.exe` çalıştırıldığında arka planda bir konsol (cmd benzeri) penceresi açılıyor ve uygulama penceresi kapatılsa bile süreç arka planda çalışmaya devam ediyordu.

- Build sırasında exe'nin PE `Subsystem` alanı GUI olarak işaretleniyor (editbin yerine doğrudan header patch) → artık hiçbir konsol penceresi açılmıyor.
- Konsol olmadan çalışırken `console.log`/`console.error` çağrılarının çökmeye yol açmaması için güvenli hale getirildi.
- Uygulama penceresi kapatıldığında arka plandaki sunucu süreci de otomatik sonlanıyor (önceden görev yöneticisinde sürekli kalıyordu).
- `/api/usage` isteğine 10 saniyelik timeout eklendi (ağ takılmasında sonsuza kadar beklemesin diye).

## v1.0.1 - 2026-09-02

Kapsamlı testler sonucu bulunan sorunlar düzeltildi:

- Bozuk/eksik kimlik dosyası durumlarında net Türkçe hata mesajları (önce ham JS hatası sızdırılıyordu)
- Aynı porta ikinci kopya başlatıldığında (örneğin `.exe`'ye yanlışlıkla iki kez tıklamak) artık çökmüyor; var olan pencereyi tekrar önplana getirip sessizce çıkıyor
- Anthropic tarafında rate limit (429) oluştuğunda anlaşılır mesaj + ön tarafta otomatik geri çekilme (20sn → 5dk tavan, başarılı istekte sıfırlanır)
- `.exe` uygulama penceresinin ilk açılış boyutu düzeltildi (480x680 → 700x620)

## v1.0.0 - 2026-09-02

İlk sürüm.

- Terminal temalı web arayüzü, `/usage` ile aynı veriyi gösterir
- 20 saniyede bir otomatik yenilenir, geri sayımlar canlı çalışır
- `dist/ClaudeLimits.exe`: çift tıkla, bağımsız uygulama penceresi açılır (Chrome/Edge `--app` modu)
- Kaynak koddan çalıştırmak için: `npm start`
