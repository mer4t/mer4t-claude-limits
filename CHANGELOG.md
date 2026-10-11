# Değişiklik Geçmişi

## Yayımlanmamış

Kapsamlı kod incelemesinde bulunan hatalar ve iyileştirmeler:

- **macOS'ta Chrome yoksa** (Safari vb.) panel varsayılan tarayıcıda açıldıktan sonra sunucu süreci sekme kapatılınca da arka planda sonsuza kadar çalışıyordu ve uygulama bir daha açılamıyordu. Artık sayfa kapanınca (ya da birkaç dakika hiçbir sayfa açık değilse) sunucu kendini kapatıyor.
- **macOS'ta önceki oturumdan kalan Chrome** süreci, yeni açılan sunucunun hemen kapanmasına (pencerenin "bağlantı reddedildi" göstermesine) yol açıyordu. Artık açılışta bu artık süreç kapatılıyor, tarayıcı isteği başka bir sürece devrederse sunucu kapanmıyor.
- Birden fazla panel penceresi açıkken biri kapatılınca diğeri de kapanıyordu; artık son pencere kapanınca kapanıyor.
- **Güvenlik:** yerel sunucu artık yalnızca `127.0.0.1`/`localhost` adresli ve aynı kaynaktan gelen istekleri kabul ediyor (DNS rebinding ve başka sitelerin paneli kapatması/API'ye istek attırması engellendi). Sayfaya Content-Security-Policy ve çerçeveleme koruması eklendi; kartlar `innerHTML` yerine DOM ile oluşturuluyor.
- Varsayılan port başka bir uygulama tarafından kullanılıyorsa artık o uygulamaya pencere açılmıyor, sonraki portlar deneniyor. Geçersiz `PORT` değeri çökme yerine uyarıyla varsayılana dönüyor.
- Yenileme aralığı 20 sn'den 60 sn'ye çıkarıldı; pencere gizliyken sorgu yapılmıyor, bir limit sıfırlandığı anda ayrıca yenileniyor. "Şimdi yenile"ye art arda basmak artık aynı anda birden fazla istek göndermiyor; sunucu da kısa süreli önbellekle aynı anda gelen istekleri tek API çağrısında birleştiriyor.
- macOS'ta Keychain her sorguda değil, 10 dakikada bir (veya jeton geçersizleşince) okunuyor. Süresi geçmiş jetonla API'ye istek atılmıyor; 401 alınınca Claude Code'un yenilediği jeton bir kez daha deneniyor.
- Geçersiz tarih ("Invalid Date", "NaNdk sonra"), JSON olmayan sunucu/API cevapları ve hiç veri yokken gösterilen "son bilinen veriler" metni düzeltildi. "son güncelleme" süresi dakika/saat olarak gösteriliyor.
- `CLAUDE_CONFIG_DIR` ortam değişkeni artık masaüstü panelde de dikkate alınıyor: jeton okuma ve API mantığı VS Code eklentisiyle ortak (`vscode-extension/src/usage.js`).
- Build artık Node 20.12'den eski sürümleri reddediyor: bu sürümlerde build "başarılı" görünüp uygulama açılışta çöküyordu (`node:sea` modülü yok). Gereken Node sürümü `>=20.12` olarak güncellendi.
- Build: `postject` sürümü sabitlendi, macOS uygulamasına ikon eklendi. Sunucu testleri (`npm test`), GitHub Actions CI ve kök dizine LICENSE eklendi.

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
