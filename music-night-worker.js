const SUPABASE_URL = 'https://rqruaqoecvpythbvnozf.supabase.co';

// The anon key is public by design - it is already in index.html, and RLS is
// what actually guards the data. Inlining it keeps token verification off the
// service-role key, which used to be its fallback: one missing setting and the
// most powerful secret ended up on the busiest route.
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJxcnVhcW9lY3ZweXRoYnZub3pmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzYyOTY4OTEsImV4cCI6MjA5MTg3Mjg5MX0.3yw1LEN2mvZMg1PXA_IvE0DmNbh4TXNP2uyWRFFJNQo';

// Only the deployed app talks to this worker. Note that CORS is a browser-side
// control and stops nothing outside a browser, so every route that costs money
// or writes data checks a bearer as well.
const ALLOWED_ORIGIN = 'https://tunemail.app';

// AudD rejects anything larger, and there is no point paying to find out.
const MAX_AUDIO_BYTES = 10 * 1024 * 1024;

// A signed-in user may spend this many recognitions per hour. Sign-up is open,
// so a valid token proves only that somebody made an account - without a cap,
// one throwaway account can drain the paid quota.
const RECOGNIZE_PER_HOUR = 20;

const cors = (origin = ALLOWED_ORIGIN) => ({
  "Access-Control-Allow-Origin": origin,
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Vary": "Origin",
});

const json = (data, status, headers) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { ...headers, "Content-Type": "application/json" },
  });

// Telegram escapes nothing for us. Anything a user typed has to be neutralised
// before it lands in a Markdown payload, or a stray bracket turns into a live
// link and a stray backtick makes Telegram reject the whole message.
function escapeMarkdown(value) {
  return String(value ?? "").replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, "\\$&");
}

// Returns the Supabase user for a bearer token, or null if it is not valid.
async function verifyUser(request, env) {
  const auth = request.headers.get('Authorization') || '';
  if (!auth.startsWith('Bearer ')) return null;

  const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: auth,
    },
  });
  if (!res.ok) return null;

  const user = await res.json().catch(() => null);
  return user && user.id ? user : null;
}

// Per-user hourly counter. RECOGNIZE_KV is optional: when the namespace is not
// bound the worker still works, it just cannot rate-limit.
async function overRecognizeLimit(env, userId) {
  if (!env.RECOGNIZE_KV) return false;
  const key = `recognize:${userId}`;
  const used = parseInt((await env.RECOGNIZE_KV.get(key)) || '0', 10);
  if (used >= RECOGNIZE_PER_HOUR) return true;
  await env.RECOGNIZE_KV.put(key, String(used + 1), { expirationTtl: 3600 });
  return false;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: cors() });
    }

    // POST /recognize - proxies to AudD with the token from the secrets, so the
    // paid token never reaches the client. index.html is public; a token in it
    // is a token anyone can spend.
    if (request.method === "POST" && url.pathname === "/recognize") {
      const fail = (status, error) => json({ status: "error", error }, status, cors());

      if (!env.AUDD_TOKEN) return fail(500, "Recognition is not configured");

      const user = await verifyUser(request, env);
      if (!user) return fail(401, "Sign in to identify songs");

      if (await overRecognizeLimit(env, user.id)) {
        return fail(429, "Too many songs identified in the last hour");
      }

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
        headers: { ...cors(), "Content-Type": "application/json" },
      });
    }

    // POST /feedback-notify - sends the Telegram notification.
    // The client already sends a bearer; before, this route ignored it, so
    // anyone could push arbitrary text into the owner's chat.
    if (request.method === "POST" && url.pathname === "/feedback-notify") {
      const user = await verifyUser(request, env);
      if (!user) return json({ error: "Unauthorized" }, 401, cors());

      let body;
      try {
        body = await request.json();
      } catch {
        return json({ error: "Bad request" }, 400, cors());
      }

      const { feedback_id, type, message, user_name, app } = body;
      if (app !== "music-night") return json({ error: "Bad request" }, 400, cors());
      if (!/^[a-f0-9-]{36}$/.test(String(feedback_id || ""))) {
        return json({ error: "Bad request" }, 400, cors());
      }

      const typeEmoji = { bug: "🔧", idea: "💡", other: "💬" }[type] || "💬";
      // The id goes FIRST: the regex on the way back takes the first match, and
      // everything below this line is text the user controls.
      const text =
        `\`id:${feedback_id}\`\n${typeEmoji} *Tunemail Feedback*\n\n` +
        `👤 ${escapeMarkdown(user_name)}\n📝 ${escapeMarkdown(message)}`;

      try {
        const tg = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_TOKEN}/sendMessage`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id: env.TELEGRAM_CHAT_ID,
            text,
            parse_mode: "MarkdownV2",
          }),
        });
        // A rejected send used to pass silently and the feedback vanished.
        if (!tg.ok) return json({ error: "Notification failed" }, 502, cors());
      } catch {
        return json({ error: "Notification failed" }, 502, cors());
      }

      return new Response("OK", { status: 200, headers: cors() });
    }

    // POST /telegram-webhook - takes replies from Telegram back into Supabase.
    // This route writes with the service-role key, so it must be certain the
    // request really came from Telegram: the secret token is set when the
    // webhook is registered, and Telegram sends it on every update.
    if (request.method === "POST" && url.pathname === "/telegram-webhook") {
      if (!env.TELEGRAM_WEBHOOK_SECRET) return new Response("Not configured", { status: 500 });
      if (request.headers.get("X-Telegram-Bot-Api-Secret-Token") !== env.TELEGRAM_WEBHOOK_SECRET) {
        return new Response("Forbidden", { status: 403 });
      }

      let update;
      try {
        update = await request.json();
      } catch {
        return new Response("OK", { status: 200 });
      }

      const message = update.message;
      if (!message || !message.reply_to_message) return new Response("OK", { status: 200 });

      // Second gate: only the owner's own chat may answer.
      if (String(message.chat?.id) !== String(env.TELEGRAM_CHAT_ID)) {
        return new Response("Forbidden", { status: 403 });
      }

      const originalText = message.reply_to_message.text || "";
      const match = originalText.match(/^`?id:([a-f0-9-]{36})/m);
      if (!match) return new Response("OK", { status: 200 });

      const feedbackId = match[1];
      // Photo, voice and sticker replies carry no .text - the caption is the
      // next best thing, and with neither there is nothing to deliver.
      const replyText = message.text || message.caption;
      if (!replyText) {
        await notifyOwner(env, "That reply had no text, so nothing was sent. Reply in words.");
        return new Response("OK", { status: 200 });
      }

      let updated = [];
      try {
        const res = await fetch(`${SUPABASE_URL}/rest/v1/feedback?id=eq.${feedbackId}`, {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
            "apikey": env.SUPABASE_KEY,
            "Authorization": `Bearer ${env.SUPABASE_KEY}`,
            // return=representation so a PATCH that matched nothing is visible:
            // PostgREST answers 204 either way, which used to read as success.
            "Prefer": "return=representation",
          },
          body: JSON.stringify({
            reply: replyText,
            replied_at: new Date().toISOString(),
            read_by_user: false,
          }),
        });
        if (res.ok) updated = await res.json().catch(() => []);
      } catch {
        updated = [];
      }

      await notifyOwner(
        env,
        updated.length ? "Reply sent to user" : "That feedback no longer exists, nothing was sent."
      );
      return new Response("OK", { status: 200 });
    }

    return new Response("Not found", { status: 404, headers: cors() });
  },
};

async function notifyOwner(env, text) {
  try {
    await fetch(`https://api.telegram.org/bot${env.TELEGRAM_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text }),
    });
  } catch {
    /* the confirmation is a convenience; losing it must not fail the request */
  }
}
