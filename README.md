# m4claudelimits

Claude Code kullanım limitlerini (`/usage` komutunun gösterdiği 5 saatlik oturum ve haftalık limitler) canlı olarak takip eden yerel bir panel. Görünüm Claude Code terminaline benzer şekilde tasarlandı; limitlerin yüzde olarak durumunu, ne zaman sıfırlanacağını (hem saat hem geri sayım olarak) sürekli gösterir.

## Nasıl çalışır

Claude Code'un kendisinin de kullandığı `api.anthropic.com/api/oauth/usage` uç noktasını, makinenizdeki `~/.claude/.credentials.json` içindeki oturum jetonuyla sorgular. Jeton hiçbir zaman tarayıcıya gönderilmez, sadece yerel sunucu sürecinde kalır. Jeton yenileme işlemi burada yapılmaz (Claude Code'un kendi refresh token rotasyonunu bozmamak için); dosya her sorguda yeniden okunur, böylece Claude Code kendi jetonunu yeniledikçe panel de otomatik olarak güncelini kullanır.

Kullanmak için önce Claude Code ile en az bir kez giriş yapmış olmanız gerekir.

## Çalıştırma (geliştirme modu)

```bash
npm start
```

sonra tarayıcıda `http://localhost:4756` açın.

## .exe olarak paketleme (Windows)

```bash
npm run build
```

`dist/ClaudeLimits.exe` üretilir. Bu dosya Node'un [Single Executable Application](https://nodejs.org/api/single-executable-applications.html) özelliğiyle tek bir taşınabilir çalıştırılabilir dosyaya paketlenir; `index.html` de içine gömülüdür, ek dosyaya ihtiyaç duymaz.

Çift tıklandığında yerel sunucuyu başlatır ve Chrome (yoksa Edge) varsa adres çubuğu/sekmeler olmadan bağımsız bir uygulama penceresi (`--app` modu) açar; hiçbiri yoksa varsayılan tarayıcıda normal bir sekme açılır. Konsol penceresi açılmaz (build sırasında exe'nin PE subsystem'i GUI olarak işaretlenir) ve uygulama penceresi kapatıldığında arka plandaki sunucu süreci de otomatik sonlanır.

> İmzasız bir derleme olduğu için Windows SmartScreen ilk açılışta uyarı gösterebilir.

## Notlar

- Port varsayılan olarak `4756`; `PORT` ortam değişkeniyle değiştirilebilir.
- Herhangi bir üçüncü taraf servise veri göndermez; tek ağ isteği doğrudan `api.anthropic.com`'a gider.
