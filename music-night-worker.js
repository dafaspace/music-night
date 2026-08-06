const SUPABASE_URL = 'https://rqruaqoecvpythbvnozf.supabase.co';

// Only the deployed app may spend recognition credits.
const ALLOWED_ORIGIN = 'https://dafaspace.github.io';

// AudD rejects anything larger, and there is no point paying to find out.
const MAX_AUDIO_BYTES = 10 * 1024 * 1024;

// Returns the Supabase user for a bearer token, or null if it is not valid.
async function verifyUser(request, env) {
  const auth = request.headers.get('Authorization') || '';
  if (!auth.startsWith('Bearer ')) return null;

  const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: {
      apikey: env.SUPABASE_ANON_KEY || env.SUPABASE_KEY,
      Authorization: auth,
    },
  });
  if (!res.ok) return null;

  const user = await res.json().catch(() => null);
  return user && user.id ? user : null;
}

export default {
  async fetch(request, env, ctx) {
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    };

    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: url.pathname === "/recognize"
          ? { ...corsHeaders, "Access-Control-Allow-Origin": ALLOWED_ORIGIN }
          : corsHeaders,
      });
    }

    // POST /recognize — проксирует запрос в AudD, подставляя токен из секретов.
    // Токен не должен попадать в клиент: index.html публичен, и утёкшим
    // токеном чужие люди тратят нашу квоту.
    if (request.method === "POST" && url.pathname === "/recognize") {
      const recogCors = {
        "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
      };
      const fail = (status, error) =>
        new Response(JSON.stringify({ status: "error", error }), {
          status,
          headers: { ...recogCors, "Content-Type": "application/json" },
        });

      if (!env.AUDD_TOKEN) return fail(500, "Recognition is not configured");

      const user = await verifyUser(request, env);
      if (!user) return fail(401, "Sign in to identify songs");

      let file;
      try {
        file = (await request.formData()).get("file");
      } catch {
        return fail(400, "Could not read the recording");
      }
      if (!file || typeof file === "string") return fail(400, "No recording sent");
      if (file.size === 0) return fail(400, "The recording is empty");
      if (file.size > MAX_AUDIO_BYTES) return fail(413, "The recording is too long");

      const outgoing = new FormData();
      outgoing.append("file", file, "recording.webm");
      outgoing.append("api_token", env.AUDD_TOKEN);
      outgoing.append("return", "apple_music,spotify,deezer");

      let auddRes;
      try {
        auddRes = await fetch("https://api.audd.io/", { method: "POST", body: outgoing });
      } catch {
        return fail(502, "Could not reach the recognition service");
      }

      const body = await auddRes.text();
      return new Response(body, {
        status: auddRes.ok ? 200 : 502,
        headers: { ...recogCors, "Content-Type": "application/json" },
      });
    }

    // POST /feedback-notify — отправляет уведомление в Telegram
    if (request.method === "POST" && url.pathname === "/feedback-notify") {
      try {
        const body = await request.json();
        const { feedback_id, type, message, user_name, app } = body;

        if (app !== "music-night") {
          return new Response("Wrong app", { status: 400, headers: corsHeaders });
        }

        const typeEmoji = { bug: "🔧", idea: "💡", other: "💬" }[type] || "💬";
        const text = `${typeEmoji} *Music Night Feedback*\n\n👤 ${user_name}\n📝 ${message}\n\n\`id:${feedback_id}\``;

        await fetch(`https://api.telegram.org/bot${env.TELEGRAM_TOKEN}/sendMessage`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id: env.TELEGRAM_CHAT_ID,
            text,
            parse_mode: "Markdown",
          }),
        });

        return new Response("OK", { status: 200, headers: corsHeaders });
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
    }

    // POST /telegram-webhook — получает ответы из Telegram и сохраняет в Supabase
    if (request.method === "POST" && url.pathname === "/telegram-webhook") {
      try {
        const update = await request.json();
        const message = update.message;

        if (!message || !message.reply_to_message) {
          return new Response("OK", { status: 200 });
        }

        // Извлекаем feedback_id из оригинального сообщения
        const originalText = message.reply_to_message.text || "";
        const match = originalText.match(/id:([a-f0-9-]{36})/);
        if (!match) {
          return new Response("OK", { status: 200 });
        }

        const feedbackId = match[1];
        const replyText = message.text;

        // Обновляем запись в Supabase
        const res = await fetch(`${SUPABASE_URL}/rest/v1/feedback?id=eq.${feedbackId}`, {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
            "apikey": env.SUPABASE_KEY,
            "Authorization": `Bearer ${env.SUPABASE_KEY}`,
            "Prefer": "return=minimal",
          },
          body: JSON.stringify({
            reply: replyText,
            replied_at: new Date().toISOString(),
            read_by_user: false,
          }),
        });

        if (res.ok) {
          // Подтверждение в Telegram
          await fetch(`https://api.telegram.org/bot${env.TELEGRAM_TOKEN}/sendMessage`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              chat_id: env.TELEGRAM_CHAT_ID,
              text: "✅ Reply sent to user!",
            }),
          });
        }

        return new Response("OK", { status: 200 });
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), { status: 500 });
      }
    }

    return new Response("Not found", { status: 404, headers: corsHeaders });
  },
};
