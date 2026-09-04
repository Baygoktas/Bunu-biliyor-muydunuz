export default {
  // Manuel tetiklemek veya test etmek için HTTP rotası
  async fetch(request, env) {
    const result = await processAndPost(env);
    return new Response(JSON.stringify(result, null, 2), {
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  },

  // Zamanlanmış görev (Cron Trigger)
  async scheduled(event, env, ctx) {
    ctx.waitUntil(processAndPost(env));
  },
};

async function processAndPost(env) {
  // Rastgele Türkçe veya İngilizce kaynağından seç
  const useTurkish = Math.random() < 0.5;
  let fact = null;

  if (useTurkish) {
    fact = await fetchTurkishFact(env);
    if (!fact) fact = await fetchEnglishFact(env);
  } else {
    fact = await fetchEnglishFact(env);
    if (!fact) fact = await fetchTurkishFact(env);
  }

  if (!fact) {
    return { success: false, message: "Paylaşılacak yeni/benzersiz içerik bulunamadı." };
  }

  // HTML Etiketlerini temizle
  let cleanText = cleanHtml(fact.text);

  // İngilizce içerikse Türkçe'ye çevir
  if (fact.lang === "en") {
    cleanText = await translateToTurkish(cleanText, env);
  }

  // Görseldeki şablona birebir uygun mesaj formatı
  const message = `💡 <b>BUNU BİLİYOR MUYDUNUZ?</b>\n\n👀 ${cleanText}\n\n🔎 <b>Kaynak:</b> <a href="${fact.url}">Vikipedi</a>`;

  let telegramRes;
  if (fact.imageUrl) {
    telegramRes = await sendPhoto(env, fact.imageUrl, message);
    // Görsel yükleme başarısız olursa metin olarak tekrar dene
    if (!telegramRes.ok) {
      telegramRes = await sendMessage(env, message);
    }
  } else {
    telegramRes = await sendMessage(env, message);
  }

  if (telegramRes.ok) {
    // 30 gün boyunca aynı içeriğin tekrar paylaşılmasını engelle
    await env.KV_POSTED.put(fact.id, "true", { expirationTtl: 60 * 60 * 24 * 30 });
    return { success: true, factId: fact.id, text: cleanText };
  }

  return { success: false, error: telegramRes };
}

// Türkçe Vikipedi'den günün "Biliyor muydunuz?" verisini çeker
async function fetchTurkishFact(env) {
  try {
    const date = new Date();
    const mm = String(date.getMonth() + 1).padStart(2, "0");
    const dd = String(date.getDate()).padStart(2, "0");
    const yyyy = date.getFullYear();

    const res = await fetch(`https://api.wikimedia.org/feed/v1/wikipedia/tr/featured/${yyyy}/${mm}/${dd}`, {
      headers: { "User-Agent": "TelegramBot/1.0 (info@example.com)" },
    });

    if (!res.ok) return null;
    const data = await res.json();
    const items = data.onthisday || [];

    for (const item of items) {
      const id = "tr_" + hashString(item.text);
      const isSent = await env.KV_POSTED.get(id);
      if (!isSent) {
        const page = item.pages?.[0];
        return {
          id,
          lang: "tr",
          text: item.text,
          url: page?.content_urls?.desktop?.page || "https://tr.wikipedia.org",
          imageUrl: page?.thumbnail?.source || null,
        };
      }
    }
  } catch (e) {
    console.error("TR Fact Error:", e);
  }
  return null;
}

// İngilizce Wikipedia 'Did You Know' (DYK) verisini çeker
async function fetchEnglishFact(env) {
  try {
    const date = new Date();
    const mm = String(date.getMonth() + 1).padStart(2, "0");
    const dd = String(date.getDate()).padStart(2, "0");
    const yyyy = date.getFullYear();

    const res = await fetch(`https://api.wikimedia.org/feed/v1/wikipedia/en/featured/${yyyy}/${mm}/${dd}`, {
      headers: { "User-Agent": "TelegramBot/1.0 (info@example.com)" },
    });

    if (!res.ok) return null;
    const data = await res.json();
    const items = data.onthisday || [];

    for (const item of items) {
      const id = "en_" + hashString(item.text);
      const isSent = await env.KV_POSTED.get(id);
      if (!isSent) {
        const page = item.pages?.[0];
        return {
          id,
          lang: "en",
          text: item.text,
          url: page?.content_urls?.desktop?.page || "https://en.wikipedia.org",
          imageUrl: page?.thumbnail?.source || null,
        };
      }
    }
  } catch (e) {
    console.error("EN Fact Error:", e);
  }
  return null;
}

// Cloudflare AI ile İngilizce metni Türkçe'ye aktarma
async function translateToTurkish(text, env) {
  try {
    const response = await env.AI.run("@cf/meta/m2m100-1.2b", {
      text: text,
      source_lang: "english",
      target_lang: "turkish",
    });
    return response.translated_text || text;
  } catch (err) {
    console.error("Translation Error:", err);
    return text;
  }
}

async function sendMessage(env, text) {
  const url = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`;
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: env.TELEGRAM_CHAT_ID,
      text: text,
      parse_mode: "HTML",
      disable_web_page_preview: false,
    }),
  });
  return response.json();
}

async function sendPhoto(env, photoUrl, caption) {
  const url = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendPhoto`;
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: env.TELEGRAM_CHAT_ID,
      photo: photoUrl,
      caption: caption,
      parse_mode: "HTML",
    }),
  });
  return response.json();
}

function cleanHtml(str) {
  return str.replace(/<[^>]*>?/gm, "").trim();
}

function hashString(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = (hash << 5) - hash + str.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash).toString(36);
}
