# Değişiklik Geçmişi

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
