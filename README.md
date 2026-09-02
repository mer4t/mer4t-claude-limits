<div align="center">

# ✳️ Claude Limits

**Claude Code kullanım limitlerini (5 saatlik oturum ve haftalık) canlı takip eden yerel panel**

[![Latest Release](https://img.shields.io/github/v/release/mer4t/mer4t-claude-limits?label=latest%20release&color=orange)](https://github.com/mer4t/mer4t-claude-limits/releases/latest)
[![Platform](https://img.shields.io/badge/platform-Windows-0078D6?logo=windows&logoColor=white)](#)
[![Node.js](https://img.shields.io/badge/Node.js-%E2%89%A520-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![SEA](https://img.shields.io/badge/packaging-Node%20SEA-000000)](https://nodejs.org/api/single-executable-applications.html)

<img src="screenshots/panel.jpg" alt="Claude Limits paneli" width="500">

</div>

---

## Nedir bu?

Claude Code'un kendi `/usage` komutunun gösterdiği verileri — 5 saatlik oturum limiti ve haftalık limitler (tüm modeller, Opus, Sonnet, bağlı uygulamalar) — sürekli açık kalan küçük bir masaüstü penceresinde canlı gösteren yerel bir panel. Terminale benzer koyu bir tema kullanır; her limitin yüzde durumunu, ne zaman sıfırlanacağını (hem saat hem canlı geri sayım olarak) gösterir.

Claude Code ile aynı uç noktayı (`api.anthropic.com/api/oauth/usage`) makinenizdeki oturum jetonuyla sorgular; jeton hiçbir zaman ağ üzerinden başka bir yere gönderilmez.

**Güncel sürüm:** `v1.0.2` — sürüm geçmişi için [CHANGELOG.md](CHANGELOG.md) dosyasına bakabilirsiniz.

## ✨ Özellikler

| | |
|---|---|
| 📊 **Canlı limit takibi** | Güncel oturum (5 saatlik) + haftalık limitler (tüm modeller, Opus, Sonnet, bağlı uygulamalar) |
| ⏱️ **Çift zaman gösterimi** | Her limit için hem yenilenme saati ("yarın 00:49") hem canlı geri sayım ("4s 24dk sonra") |
| 🔁 **Otomatik yenileme** | 20 saniyede bir; hata durumunda 5 dakikaya kadar otomatik geri çekilir, başarılı istekte sıfırlanır |
| 🛡️ **Hataya dayanıklı** | Bağlantı koptuğunda son bilinen veriler ekranda kalır, ham hata yerine anlaşılır Türkçe mesaj gösterilir |
| 🪟 **Bağımsız uygulama penceresi** | Chrome/Edge varsa adres çubuğu/sekmesiz `--app` penceresi; hiçbiri yoksa varsayılan tarayıcıda sekme |
| 🙈 **Sessiz çalışma** | Çift tıklandığında arka planda konsol penceresi açılmaz; pencere kapatılınca sunucu süreci de otomatik sonlanır |
| 📦 **Tek dosya, taşınabilir** | Node'un Single Executable Application özelliğiyle tek bir `.exe`; kurulum, ek bağımlılık veya yönetici izni gerekmez |
| 🔒 **Gizlilik** | Hiçbir üçüncü taraf servise veri gitmez; tek ağ isteği doğrudan `api.anthropic.com`'a |

## 🚀 Kurulum

1. [Releases](https://github.com/mer4t/mer4t-claude-limits/releases/latest) sayfasından `ClaudeLimits.exe` dosyasını indirin.
2. İstediğiniz bir klasöre kopyalayın (kurulum gerekmez).
3. Çift tıklayın — Chrome veya Edge varsa bağımsız bir uygulama penceresi açılır.

> Uygulama dijital olarak imzalanmamıştır. İlk çalıştırmada Windows SmartScreen bir uyarı gösterebilir; "Ek bilgi" → "Yine de çalıştır" ile devam edebilirsiniz.

### Ön koşul

Panelin veri gösterebilmesi için Claude Code ile makinenizde **en az bir kez** giriş yapmış olmanız gerekir (`~/.claude/.credentials.json` dosyası oluşur). Panel bu dosyayı her sorguda yeniden okur; Claude Code kendi jetonunu yeniledikçe panel de otomatik güncel jetonu kullanır. Jeton yenileme işlemini panel **yapmaz** — bu, Claude Code'un kendi refresh token rotasyonunu bozabilir.

## 💻 Sistem Gereksinimleri

- Windows 10/11
- Chrome veya Edge (önerilir — bağımsız pencere modu için); yoksa varsayılan tarayıcıda normal sekme açılır
- Yönetici izni gerekmez

## 🛠️ Kaynak Koddan Çalıştırma

```bash
git clone https://github.com/mer4t/mer4t-claude-limits.git
cd mer4t-claude-limits
npm start
```

sonra tarayıcıda `http://localhost:4756` açın. Port, `PORT` ortam değişkeniyle değiştirilebilir.

### .exe olarak paketleme

```bash
npm run build
```

`dist/ClaudeLimits.exe` üretilir. `server.js` ve `index.html`, Node'un [Single Executable Application](https://nodejs.org/api/single-executable-applications.html) özelliğiyle tek bir taşınabilir çalıştırılabilir dosyaya gömülür; ek dosyaya ihtiyaç duymaz. Build betiği ayrıca üretilen exe'nin PE `Subsystem` alanını (editbin gerekmeden, doğrudan header patch ile) GUI olarak işaretler, böylece çift tıklandığında konsol penceresi açılmaz.

## 🗂️ Proje Yapısı

```
m4claudelimits/
├── server.js         # Yerel HTTP sunucu: /api/usage proxy'si + uygulama penceresi açma
├── index.html         # Panelin tüm arayüzü (HTML/CSS/JS, tek dosya)
├── build.js           # server.js + index.html -> dist/ClaudeLimits.exe (Node SEA + subsystem patch)
├── sea-config.json     # Node SEA build yapılandırması
└── dist/               # Build çıktısı (git'e dahil değildir)
```

## ⚠️ Bilinen Sınırlamalar

- Build betiği (`build.js`) yalnızca Windows için yazılmıştır; `.exe` üretimi başka bir işletim sisteminde çalışmaz. Kaynak koddan çalıştırma (`npm start`) platform bağımsızdır.
- Chrome veya Edge kurulu değilse bağımsız pencere modu kullanılamaz, panel varsayılan tarayıcıda normal bir sekmede açılır.
- `.exe` dijital olarak imzalanmamıştır; Windows SmartScreen ilk çalıştırmada uyarı gösterebilir.

## 📜 Sürüm Geçmişi

Ayrıntılı sürüm notları için [CHANGELOG.md](CHANGELOG.md) dosyasına bakın.

## 🤝 Katkıda Bulunma

Hata bildirimi veya öneri için lütfen bir [GitHub Issue](https://github.com/mer4t/mer4t-claude-limits/issues) açın.
