// PCA Name Check Bot — Cloudflare Worker + Telegram
// Games come live from the store's Firestore "games" collection, filtered with the same rules as the
// store's own Name Check. Each game entry is checked through its OWN provider only (G2Bulk or FazerCards).
// Secrets: BOT_TOKEN, WEBHOOK_SECRET.
// Optional: KV binding named STATE (remembers each chat's last game), secret FIREBASE_API_KEY.
// Access control (optional variables, comma-separated IDs; send /id to the bot to get yours):
//   OWNER_IDS      user IDs allowed to use the bot in private chat (others get a "group only" notice)
//   ALLOWED_CHATS  group chat IDs where the bot works (other groups are ignored)
// Optional variable:
//   RATE_LIMIT     checks per user per minute (default 3). Owners are exempt.
//   ANTISPAM       set to "off" to disable group moderation (forwards, links, rude words, floods -> warning / mute / ban)
//   LINKFILTER     set to "off" to let members post links (default: links are deleted)
//   ALLOWED_LINKS  comma-separated domains members may still post, e.g. youtube.com,facebook.com
//   STORE_URL      store link for the "Store ဝင်ရန်" button (or set it from the bot: /setstore https://...)
//   ICON_COPY / ICON_DONE / ICON_REJECT / ICON_STORE   optional premium (custom) emoji IDs shown on those buttons (needs the bot owner to have Telegram Premium)
// Everything below is managed from inside the bot (owner in private chat, or group admins in the group):
//   /adminhelp lists the commands: welcome, captcha, FAQ auto-reply, store link, "order done" message, rude words, stats.
// KV (STATE) is optional, but auto-delete, the 1-hour result memory, warnings, welcome edits, rude-word list and /stats need it.
//   Auto-delete also needs a cron trigger in wrangler.toml:  [triggers]  crons = ["*/5 * * * *"]
//   (without the cron it still runs, but only while the group is active)
// Order log: pressing Done on a group result card saves admin / game / ID / time (KV "ord:...", kept 30 days).
//   /orders = today's finished orders, /orders 1 = yesterday, /orders <ID> = search an ID (30 days). It never blocks anything.
// "Not done" reminder: a result card that still has no Done after 30 minutes pings the group admins (KV "pend:...").
//   Needs the cron trigger (or group traffic, the bot sweeps at most once a minute) and KV.
// /warns /unwarn /unban: see a member's strikes, remove them, lift mute / ban. Needs KV.
// Settings kept in KV ("cfg:set") and changed from the bot, no code edit needed (see /adminhelp -> Settings):
//   /set (rate, autodel, pending, mute, antispam, linkfilter, links, copyid, summary, summaryhour), /maint on|off,
//   /addalias, /seticon + /emojiid (premium emoji on buttons), /summary (daily report to the owner), /addcmd (your own commands).

const G2 = "https://api.g2bulk.com/v1";
const FAZER_URL = "https://fazercards-functions.pca-game-store.workers.dev/fazercard-validate";
const FS_PROJECT = "pca-game-store";
const FS_KEY = "AIzaSyA2mwdZ2tAoZ3_6HNl43fUSi9t_ZkRita4"; // public web key, same one the store page uses
const FS_FIELDS = [
  "name", "serverName", "order", "g2bulkCode", "fazercardCategoryId", "fazercardFields",
  "serverIdRequired", "playerIdRequired", "fulfillProvider", "g2bulkVoucherCategory",
  "fazercardGiftCategoryId", "fazercardServerMode", "fazercardServerOptions",
  "g2bulkServerMode", "g2bulkServerOptions",
];

const CHECK_TTL_MS = 5 * 60 * 1000;   // "not found" answers are remembered this long
const VALID_TTL_MS = 60 * 60 * 1000;  // found players are remembered for 1 hour (memory + KV)
const AUTODEL_MS = 60 * 60 * 1000;    // bot cards in groups are deleted after 1 hour
const WELCOME_TTL_MS = 10 * 60 * 1000;
let KV = null;                        // set per request from env.STATE
let ENV_G = null;                     // last env (used by the provider health tracker)
let LAST_SWEEP = 0;
const RATE_MAX = 3;                   // checks per user per window
const RATE_WINDOW_MS = 60 * 1000;

/* ---------- Settings kept in KV ("cfg:set"): changed from the bot with /set /addalias /maint /seticon /addcmd ---------- */
let S = {};                           // current settings (refreshed at the start of every request)
let CFG = { t: 0, v: {} };
const num = (v, d) => (Number(v) > 0 ? Number(v) : d);
async function getCfg(env) {
  if (!env.STATE) return {};
  if (Date.now() - CFG.t < 30 * 1000) return CFG.v;
  const v = await env.STATE.get("cfg:set", "json").catch(() => null);
  CFG = { t: Date.now(), v: v && typeof v === "object" ? v : {} };
  return CFG.v;
}
async function saveCfg(env, fn) {
  const cur = (await env.STATE.get("cfg:set", "json").catch(() => null)) || {};
  fn(cur);
  await env.STATE.put("cfg:set", JSON.stringify(cur));
  S = cur;
  CFG = { t: Date.now(), v: cur };
}
const autodelMs = () => num(S.autodel, 60) * 60 * 1000;
const pendingMs = () => (S.pending === "off" ? 0 : num(S.pending, 30) * 60 * 1000);
const muteSec = () => num(S.mute, 60) * 60;
const flagOff = (env, k, e) => (S[k] !== undefined ? S[k] === "off" : String(env[e] || "").toLowerCase() === "off");
// key: [label, default, type, hint]
const SETTINGS = {
  rate: ["တစ်မိနစ်ကို စစ်ခွင့် (ကြိမ်)", "3", "num", "ဥပမာ: /set rate 5"],
  autodel: ["Group card auto-delete (မိနစ်)", "60", "num", "ဥပမာ: /set autodel 30"],
  pending: ["Done မနှိပ်ရင် သတိပေးချိန် (မိနစ်)", "30", "numoff", "ဥပမာ: /set pending 20 (ပိတ်ရန် off)"],
  mute: ["၃ ကြိမ်ပြည့်ရင် Mute ကြာချိန် (မိနစ်)", "60", "num", "ဥပမာ: /set mute 120"],
  antispam: ["Group moderation (forward/link/rude/flood)", "on", "onoff", "/set antispam on|off"],
  linkfilter: ["Link ဖျက်ခြင်း", "on", "onoff", "/set linkfilter on|off"],
  links: ["ခွင့်ပြုတဲ့ link domain (, နဲ့ခြား)", "", "text", "ဥပမာ: /set links youtube.com,facebook.com (ရှင်းရန် /set links reset)"],
  copyid: ["Copy ID ခလုတ် (public = လူတိုင်း၊ restricted = ပို့တဲ့သူ + admin ပဲ)", "public", "enum:public,restricted", "/set copyid public|restricted"],
  summary: ["နေ့စဉ် စာရင်းချုပ် (Owner ဆီ)", "on", "onoff", "/set summary on|off"],
  idprefix: ["Group မှာ ID(Server) ပုံစံ သို့ 'id' ရှေ့ခံမှ စစ်မလား (on = စစ်၊ off = ဂဏန်းတွေ့သမျှ စစ်)", "on", "onoff", "/set idprefix on|off"],
  rich: ["Rich message (Bot API 10.3: table + ခလုတ်) သုံးမလား — ဈေးနှုန်းမှာ", "on", "onoff", "/set rich on|off (app ဗားရှင်းဟောင်းမှာ မမြင်ရရင် off)"],
  pay: ["Payment auto-reply (KPay/Wave ... မေးရင် ဖြေမလား)", "on", "onoff", "/set pay on|off"],
  dmopen: ["Customer တွေ DM မှာ Bot သုံးခွင့် (on = ရ၊ off = Owner ပဲ)", "on", "onoff", "/set dmopen on|off"],
  dmhours: ["DM ဖွင့်ချိန် (မြန်မာ နာရီ) ဥပမာ 9-22 — ပြင်ပရင် away စာပို့", "", "text", "ဥပမာ: /set dmhours 9-22 (ရှင်းရန် /set dmhours reset)"],
  offmsg: ["DM ပိတ်ချိန် away စာ (ဗလာ = မူလစာ)", "", "text", "ဥပမာ: /set offmsg ည ၁၀ နာရီကနေ မနက် ၉ နာရီထိ ပိတ်ပါတယ်"],
  summaryhour: ["စာရင်းချုပ်ပို့မယ့် နာရီ (မြန်မာ 0-23)", "21", "hour", "ဥပမာ: /set summaryhour 22"],
};
function parseSetting(k, v) {
  const t = SETTINGS[k][2];
  const x = String(v).trim();
  if (t === "text") return x.slice(0, 300);
  const low = x.toLowerCase();
  if (t === "onoff") return low === "on" || low === "off" ? low : null;
  if (t === "numoff" && low === "off") return "off";
  if (t.startsWith("enum:")) return t.slice(5).split(",").includes(low) ? low : null;
  if (!/^\d+$/.test(x)) return null;
  const n = Number(x);
  if (t === "hour") return n <= 23 ? String(n) : null;
  return n >= 1 && n <= 1440 ? String(n) : null;
}
const RESERVED_CMDS = [
  "start", "help", "id", "reload", "setwelcome", "welcome", "captcha", "addword", "delword", "words", "stats", "addfaq", "delfaq",
  "faqs", "setstore", "setdone", "adminhelp", "orders", "warns", "unwarn", "unban", "addalias", "delalias", "aliases", "settings",
  "set", "maint", "seticon", "emojiid", "summary", "addcmd", "delcmd", "cmds", "hidegame", "showgame", "announce", "groups", "lock", "unlock",
  "post", "posts", "delpost", "addchannel", "delchannel", "channels", "pay",
];
const FULL_PERMS = {
  can_send_messages: true, can_send_audios: true, can_send_documents: true, can_send_photos: true, can_send_videos: true,
  can_send_video_notes: true, can_send_voice_notes: true, can_send_polls: true, can_send_other_messages: true, can_add_web_page_previews: true,
};
const NO_PERMS = Object.fromEntries(Object.keys(FULL_PERMS).map((k) => [k, false]));
// Maintenance: switched on by hand (/maint on) -> every check answers the maintenance text (owners can still test).
const DEFAULT_MAINT = "🛠 ခဏ ပြုပြင်နေပါတယ်၊ ခဏနေမှ ပြန်စမ်းပါ။";
const MAINT_SEEN = new Map();
const SEEN_GRP = new Set();
async function maintBlock(env, chat) {
  if (S.maint !== "on") return false;
  if (idList(env.OWNER_IDS).includes(String(env.uid))) return false;
  if (Date.now() - (MAINT_SEEN.get(chat) || 0) > 30 * 1000) {
    MAINT_SEEN.set(chat, Date.now());
    await sendCard(env, chat, tplHtml(S.maintMsg || DEFAULT_MAINT), {}, 10 * 60 * 1000);
  }
  return true;
}

// Server ID -> region table (G2Bulk games only). Add confirmed ranges here.
const SERVER_REGION_MAP = {
  // mlbb: [{ from: 13000, to: 13999, region: "Myanmar" }],
};

// The "Menu" button next to the text box (works for everyone, no /start needed) + the command list behind it.
// Runs by itself once after a deploy (KV flag cfg:menu:v1); /setup runs it again.
let MENU_SET = false;
async function ensureMenu(env, force = false) {
  if (!force && (MENU_SET || !env.STATE)) return;
  MENU_SET = true;
  if (!force && (await env.STATE.get("cfg:menu:v1").catch(() => null))) return;
  const a = await tg(env, "setMyCommands", { commands: [
    { command: "start", description: "📋 Menu ဖွင့်ရန်" },
    { command: "help", description: "ℹ️ အကူအညီ" },
  ] }).catch(() => null);
  const b = await tg(env, "setChatMenuButton", { menu_button: { type: "commands" } }).catch(() => null);
  if (env.STATE && a?.ok && b?.ok) await env.STATE.put("cfg:menu:v1", "1").catch(() => {});
  return { commands: a, menu_button: b };
}

/* ---------- Key-value storage: Cloudflare D1 (replaces KV when a D1 binding named DB exists) ----------
   Same get/put/delete/list behaviour the bot already uses, so nothing else in this file changes.
   D1 free plan allows ~100,000 writes/day (KV only 1,000), so the "limit reached" problem goes away.
   Without a DB binding the bot keeps using the old KV (STATE) exactly as before. */
let NC_READY = false;
function d1Kv(db) {
  const ready = async () => {
    if (NC_READY) return;
    await db.prepare("CREATE TABLE IF NOT EXISTS nc_kv (k TEXT PRIMARY KEY, v TEXT, meta TEXT, exp INTEGER)").run();
    NC_READY = true;
  };
  return {
    init: ready,
    async get(key, type) {
      await ready();
      const r = await db.prepare("SELECT v FROM nc_kv WHERE k = ?1 AND (exp IS NULL OR exp > ?2)").bind(key, Date.now()).first();
      if (!r) return null;
      const t = type && typeof type === "object" ? type.type : type;
      if (t === "json") { try { return JSON.parse(r.v); } catch { return null; } }
      return r.v;
    },
    async put(key, value, opts) {
      await ready();
      const o = opts || {};
      const exp = o.expirationTtl ? Date.now() + Number(o.expirationTtl) * 1000 : null;
      const meta = o.metadata === undefined ? null : JSON.stringify(o.metadata);
      await db.prepare("INSERT INTO nc_kv (k, v, meta, exp) VALUES (?1, ?2, ?3, ?4) ON CONFLICT(k) DO UPDATE SET v = excluded.v, meta = excluded.meta, exp = excluded.exp")
        .bind(key, String(value), meta, exp).run();
    },
    async delete(key) {
      await ready();
      await db.prepare("DELETE FROM nc_kv WHERE k = ?1").bind(key).run();
    },
    async list(opts) {
      await ready();
      const o = opts || {};
      const prefix = o.prefix || "";
      const limit = Math.min(Number(o.limit) || 1000, 1000);
      const op = o.cursor ? ">" : ">=";
      const { results } = await db.prepare(
        `SELECT k, meta, exp FROM nc_kv WHERE k ${op} ?1 AND k >= ?2 AND k < ?3 AND (exp IS NULL OR exp > ?4) ORDER BY k LIMIT ?5`
      ).bind(o.cursor || prefix, prefix, prefix + "\uffff", Date.now(), limit + 1).all();
      const more = results.length > limit;
      const rows = more ? results.slice(0, limit) : results;
      return {
        keys: rows.map((r) => {
          const k = { name: r.k };
          if (r.meta != null) { try { k.metadata = JSON.parse(r.meta); } catch {} }
          if (r.exp) k.expiration = Math.floor(r.exp / 1000);
          return k;
        }),
        list_complete: !more,
        cursor: more ? rows[rows.length - 1].k : undefined,
      };
    },
    async purge() {            // called by the cron: drops expired rows
      await ready();
      await db.prepare("DELETE FROM nc_kv WHERE exp IS NOT NULL AND exp < ?1").bind(Date.now()).run();
    },
  };
}
function useD1(env) {
  if (!env.DB) return env;
  return { ...env, OLD_KV: env.STATE || null, STATE: d1Kv(env.DB) };
}

export default {
  async fetch(req, env, ctx) {
    const rawEnv = env;
    env = useD1(env);
    KV = env.STATE || null;
    ENV_G = env;
    S = await getCfg(env);
    const url = new URL(req.url);

    // One-time copy of everything from the old KV into D1:
    //   https://YOUR-WORKER.workers.dev/migrate-kv?key=WEBHOOK_SECRET   (repeat with the "next" link until done:true)
    // Needs BOTH bindings (STATE = old KV, DB = D1). Safe to run more than once (existing D1 rows are kept).
    if (url.pathname === "/migrate-kv") {
      if (url.searchParams.get("key") !== env.WEBHOOK_SECRET) return new Response("Forbidden", { status: 403 });
      const old = rawEnv.STATE, db = rawEnv.DB;
      if (!old || !db || !old.list) return new Response("Need both the STATE (KV) and DB (D1) bindings", { status: 400 });
      await env.STATE.init();
      const l = await old.list({ cursor: url.searchParams.get("cursor") || undefined, limit: 40 });
      const stmts = [];
      for (const k of l.keys) {
        const v = await old.get(k.name);
        if (v == null) continue;
        stmts.push(db.prepare("INSERT OR IGNORE INTO nc_kv (k, v, meta, exp) VALUES (?1, ?2, ?3, ?4)")
          .bind(k.name, v, k.metadata == null ? null : JSON.stringify(k.metadata), k.expiration ? k.expiration * 1000 : null));
      }
      if (stmts.length) await db.batch(stmts);
      const next = l.list_complete ? null : `${url.origin}/migrate-kv?key=${encodeURIComponent(env.WEBHOOK_SECRET)}&cursor=${encodeURIComponent(l.cursor)}`;
      return new Response(JSON.stringify({ copied: stmts.length, done: !!l.list_complete, next }, null, 1), { headers: { "content-type": "application/json" } });
    }

    // One-time webhook setup: https://YOUR-WORKER.workers.dev/setup?key=WEBHOOK_SECRET
    if (url.pathname === "/setup") {
      if (url.searchParams.get("key") !== env.WEBHOOK_SECRET) return new Response("Forbidden", { status: 403 });
      const r = await tg(env, "setWebhook", {
        url: `${url.origin}/`,
        secret_token: env.WEBHOOK_SECRET,
        allowed_updates: ["message", "callback_query", "my_chat_member"],
      });
      const menu = await ensureMenu(env, true);
      return new Response(JSON.stringify({ webhook: r, menu }), { headers: { "content-type": "application/json" } });
    }

    if (req.method !== "POST") return new Response("OK");
    if (req.headers.get("X-Telegram-Bot-Api-Secret-Token") !== env.WEBHOOK_SECRET)
      return new Response("Unauthorized", { status: 401 });

    const update = await req.json();
    ctx.waitUntil(handle(update, env).catch((e) => console.error(e)));
    if (KV && !MENU_SET) ctx.waitUntil(ensureMenu(env).catch((e) => console.error(e)));
    if (KV && Date.now() - LAST_SWEEP > 60 * 1000) {   // backup for the cron: sweep at most once a minute while the bot is busy
      LAST_SWEEP = Date.now();
      ctx.waitUntil(sweep(env).catch((e) => console.error(e)));
    }
    return new Response("OK");
  },

  // Cron trigger: deletes the bot cards whose time is up.
  async scheduled(event, env, ctx) {
    env = useD1(env);
    KV = env.STATE || null;
    if (env.STATE && env.STATE.purge) ctx.waitUntil(env.STATE.purge().catch((e) => console.error(e)));
    ENV_G = env;
    S = await getCfg(env);
    LAST_SWEEP = Date.now();
    ctx.waitUntil(sweep(env).catch((e) => console.error(e)));
    ctx.waitUntil(probeProviders().catch((e) => console.error(e)));
  },
};

/* ---------- Telegram helpers ---------- */
async function tg(env, method, body) {
  const r = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return r.json();
}
// env.replyTo is set per-message in groups so each answer replies to the person who asked.
const send = async (env, chat_id, text, extra = {}) => {
  const body = {
    chat_id,
    text,
    parse_mode: "HTML",
    ...(env.replyTo ? { reply_parameters: { message_id: env.replyTo, allow_sending_without_reply: true } } : {}),
    ...(env.ownerKb && !extra.reply_markup ? { reply_markup: mainKb() } : {}),   // owner, private chat: any reply puts the Menu keyboard back (no /start needed)
    ...extra,
  };
  const r = await tg(env, "sendMessage", body);
  if (env.junk && env.STATE && r?.ok && Number(chat_id) > 0) await junkAdd(env, chat_id, r.result.message_id, !!body.reply_markup?.keyboard).catch(() => {});
  return r;
};

/* ---------- Clean chat (owner's private chat) ----------
   Post composer prompts, pickers, previews and the owner's own inputs are scratch: they are removed once they are done.
   KV "pj:<chat>" = { ids: [bot messages still on screen], kb: the message that carries the current reply keyboard }.
   Rule: a message with a reply keyboard replaces the previous one, so everything older goes. The newest keyboard message is
   never deleted by itself (Telegram drops the keyboard together with the message that carried it). */
async function junkDel(env, chat, ids) {
  for (let i = 0; i < ids.length; i += 100) {
    const part = ids.slice(i, i + 100);
    await (part.length === 1
      ? tg(env, "deleteMessage", { chat_id: chat, message_id: part[0] })
      : tg(env, "deleteMessages", { chat_id: chat, message_ids: part })).catch(() => {});
  }
}
async function junkAdd(env, chat, mid, isKb) {
  const key = `pj:${chat}`;
  const j = (await env.STATE.get(key, "json").catch(() => null)) || { ids: [], kb: 0 };
  let gone = [];
  if (isKb) { gone = j.ids; j.ids = [mid]; j.kb = mid; }                  // new keyboard message: all the older ones are done
  else j.ids = [...j.ids, mid].slice(-60);
  await env.STATE.put(key, JSON.stringify(j), { expirationTtl: 6 * 3600 }).catch(() => {});
  if (gone.length) await junkDel(env, chat, gone);
}
async function junkPush(env, chat, ids) {      // previews / test copies sent without send()
  if (!env.STATE || !ids?.length) return;
  const key = `pj:${chat}`;
  const j = (await env.STATE.get(key, "json").catch(() => null)) || { ids: [], kb: 0 };
  j.ids = [...j.ids, ...ids].slice(-60);
  await env.STATE.put(key, JSON.stringify(j), { expirationTtl: 6 * 3600 }).catch(() => {});
}
async function junkSweep(env, chat) {          // everything tracked goes, except the message that holds the keyboard
  if (!env.STATE) return;
  const key = `pj:${chat}`;
  const j = await env.STATE.get(key, "json").catch(() => null);
  if (!j?.ids?.length) return;
  const gone = j.ids.filter((x) => x !== j.kb);
  j.ids = j.kb ? [j.kb] : [];
  await env.STATE.put(key, JSON.stringify(j), { expirationTtl: 6 * 3600 }).catch(() => {});
  if (gone.length) await junkDel(env, chat, gone);
}
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
// Result cards are wrapped in a quote block so they stand out from the chat around them.
const bq = (s) => s; // result cards are plain text (no quote block)
const idList = (s) => String(s || "").split(/[\s,]+/).filter(Boolean);

// Copy buttons are native (copy_text): one tap copies straight to the clipboard, in groups and private chat.
// ICON_COPY / ICON_DONE / ICON_REJECT / ICON_STORE (optional env vars) add a premium emoji icon to those buttons.
const ic = (env, k) => { const v = (S.icons && S.icons[k]) || (env && env[k]); return v ? { icon_custom_emoji_id: String(v) } : {}; };
const copyButton = (env, name) => ({ text: "Copy Name", copy_text: { text: String(name).slice(0, 256) }, style: "primary", ...ic(env, "ICON_COPY") });
const copyIdButton = (env, id) => ({ text: "Copy ID", copy_text: { text: String(id).slice(0, 256) }, style: "primary", ...ic(env, "ICON_COPY") });

// Result card: Game name / player name (quote + bold) / ID (Server), each block separated by a blank line.
// `head` and `tail` are already-escaped HTML. cardInfo() below parses this shape back.
const cardText = (game, head, tail) => (game ? `${esc(game)}\n\n` : "") + `<blockquote><b>${head}</b></blockquote>\n\n${tail}`;

/* RICH-START */
// Rich text: quote / bold / premium emoji typed by an admin are kept (templates are stored as HTML behind a marker).
const HTML_MARK = "<!--h-->";
const tplHtml = (s) => { s = String(s || ""); return s.startsWith(HTML_MARK) ? s.slice(HTML_MARK.length) : esc(s); };
const plainTpl = (s) => {
  s = String(s || "");
  return s.startsWith(HTML_MARK) ? s.slice(HTML_MARK.length).replace(/<[^>]+>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&") : s;
};
// The text after "/command " plus its message entities.
function cmdSource(m) {
  const raw = m.text || m.caption || "";
  const ents = (m.text ? m.entities : m.caption_entities) || [];
  const start = (raw.match(/^\s*\/\w+(?:@\w+)?\s*/) || [""])[0].length;
  return { raw, ents, start };
}
// Telegram entities -> HTML (offsets are UTF-16, same as JS string indexes). Cuts at `max` characters.
function richHtml(raw, ents, start = 0, max = 1500) {
  raw = String(raw || "");
  const text = raw.slice(start, start + max).trimEnd();
  const T = {
    bold: ["<b>", "</b>"], italic: ["<i>", "</i>"], underline: ["<u>", "</u>"], strikethrough: ["<s>", "</s>"],
    spoiler: ["<tg-spoiler>", "</tg-spoiler>"], code: ["<code>", "</code>"], pre: ["<pre>", "</pre>"],
    blockquote: ["<blockquote>", "</blockquote>"], expandable_blockquote: ["<blockquote expandable>", "</blockquote>"],
  };
  const attr = (v) => esc(v).replace(/"/g, "&quot;");
  const spans = [];
  for (const e of ents || []) {
    let tag = T[e.type];
    if (e.type === "text_link" && e.url) tag = [`<a href="${attr(e.url)}">`, "</a>"];
    else if (e.type === "text_mention" && e.user) tag = [`<a href="tg://user?id=${Number(e.user.id)}">`, "</a>"];
    else if (e.type === "custom_emoji" && e.custom_emoji_id) tag = [`<tg-emoji emoji-id="${attr(e.custom_emoji_id)}">`, "</tg-emoji>"];
    if (!tag) continue;
    const a = Math.max(0, e.offset - start);
    const b = Math.min(text.length, e.offset + e.length - start);
    if (b > a) spans.push({ a, b, tag });
  }
  spans.sort((x, y) => x.a - y.a || y.b - x.b);
  const open = {}, close = {};
  for (const x of spans) {
    (open[x.a] ||= []).push(x.tag[0]);
    (close[x.b] ||= []).unshift(x.tag[1]);   // inner entities close first
  }
  let out = "";
  for (let i = 0; i <= text.length; i++) {
    out += (close[i] || []).join("") + (open[i] || []).join("");
    if (i < text.length) { const c = text[i]; out += c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : c; }
  }
  return HTML_MARK + out;
}
// FAQ answers are shown as quote + bold (an answer that already has its own quote is left as the admin wrote it).
function faqHtml(a) {
  let h = tplHtml(a);
  if (/<blockquote/.test(h)) return h;
  if (!/<(code|pre)[ >]/.test(h)) h = "<b>" + h.replace(/<\/?b>/g, "") + "</b>";
  return "<blockquote>" + h + "</blockquote>";
}
/* RICH-END */

/* ---------- Store games (Firestore) ---------- */
function fv(v) {
  if (!v) return undefined;
  if ("stringValue" in v) return v.stringValue;
  if ("integerValue" in v) return Number(v.integerValue);
  if ("doubleValue" in v) return v.doubleValue;
  if ("booleanValue" in v) return v.booleanValue;
  if ("nullValue" in v) return null;
  if ("arrayValue" in v) return (v.arrayValue.values || []).map(fv);
  if ("mapValue" in v) return Object.fromEntries(Object.entries(v.mapValue.fields || {}).map(([k, x]) => [k, fv(x)]));
  return undefined;
}

// Same rules as the store's Name Check (ncCheckable): no vouchers, needs a Player ID, wired to G2Bulk or FazerCards.
// Games with a Server ID are checked with ID + Server; games without one (serverIdRequired === false) are checked
// with the ID only. Games with a fixed server dropdown are checked after the game name is typed: the player taps the server (or types its name).
function baseOk(g) {
  if (!g || !g.name) return false;
  if (["g2bulk_voucher", "fazercard_giftcard", "jcplays", "voucher_manual"].includes(g.fulfillProvider)) return false;
  if (g.g2bulkVoucherCategory || g.fazercardGiftCategoryId) return false;
  if (g.playerIdRequired === false) return false;
  if (/heartopia/i.test(g.name)) return false;
  return !!(g.g2bulkCode || g.fazercardCategoryId);
}
function isDropdown(g) {
  const hasOpts = (m, o) => m === "select" && Array.isArray(o) && o.length;
  return !!(hasOpts(g.fazercardServerMode, g.fazercardServerOptions) || hasOpts(g.g2bulkServerMode, g.g2bulkServerOptions));
}
const checkable = (g) => baseOk(g) && !isDropdown(g);
const idOnlyEntry = (g) => g.serverIdRequired === false;

function hash(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

let CACHE = { t: 0, groups: null };
async function loadGroups(env) {
  if (CACHE.groups && Date.now() - CACHE.t < 5 * 60 * 1000) return CACHE.groups;
  const docs = [];
  let token = "";
  for (let i = 0; i < 10; i++) {
    const qs = new URLSearchParams({ pageSize: "300", key: env.FIREBASE_API_KEY || FS_KEY });
    FS_FIELDS.forEach((f) => qs.append("mask.fieldPaths", f));
    if (token) qs.set("pageToken", token);
    let j;
    try {
      const r = await fetch(`https://firestore.googleapis.com/v1/projects/${FS_PROJECT}/databases/(default)/documents/games?${qs}`);
      if (!r.ok) break;
      j = await r.json();
    } catch {
      break;
    }
    (j.documents || []).forEach((d) => docs.push(fv({ mapValue: { fields: d.fields || {} } })));
    token = j.nextPageToken || "";
    if (!token) break;
  }
  if (!docs.length) return CACHE.groups || [];

  // Entries that share a name are regions of one game (the store groups them the same way).
  const hidden = new Map();
  docs.filter((g) => baseOk(g) && isDropdown(g)).forEach((g) => {
    const key = g.name.trim().toLowerCase();
    if (!hidden.has(key)) hidden.set(key, { key, id: hash(key), name: g.name.trim(), entries: [] });
    hidden.get(key).entries.push(g);
  });
  const map = new Map();
  docs.filter(checkable).forEach((g) => {
    const key = g.name.trim().toLowerCase();
    if (!map.has(key)) map.set(key, { key, id: hash(key), name: g.name.trim(), entries: [], order: Infinity });
    const grp = map.get(key);
    grp.entries.push(g);
    if (typeof g.order === "number") grp.order = Math.min(grp.order, g.order);
  });
  // Server-dropdown games are checkable too: the player picks the server from buttons (or types its name).
  hidden.forEach((h, key) => {
    if (map.has(key)) return;
    const orders = h.entries.map((e) => e.order).filter((n) => typeof n === "number");
    map.set(key, { ...h, dropdown: true, order: orders.length ? Math.min(...orders) : Infinity });
  });
  const groups = [...map.values()].filter((g) => !(S.hidden || []).includes(g.key)).sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));
  groups.forEach((g) => { g.idOnly = !g.dropdown && g.entries.every(idOnlyEntry); });
  groups.hidden = [];
  CACHE = { t: Date.now(), groups };
  return groups;
}

// Short names that can't be derived from the game's initials. Add more here: "short": "text in the game's name".
const ALIASES = {
  mlbb: "mobile legends",
  pubgm: "pubg mobile",
  pubg: "pubg mobile",
  codm: "call of duty",
  mcgg: "magic chess",
  sm: "sausage man",
  ml: "mobile legends",
  ff: "free fire",
  hok: "honor of kings",
  hsr: "star rail",
  zzz: "zenless",
  cod: "call of duty",
  valo: "valorant",
  bs: "brawl stars",
  coc: "clash of clans",
  cr: "clash royale",
};
function initials(name) {
  const w = String(name).toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const all = w.map((x) => x[0]).join("");
  const core = w.filter((x) => !["of", "the", "and", "a"].includes(x)).map((x) => x[0]).join("");
  return [all, core];
}

function findGroups(groups, query) {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const code = (grp) => grp.entries.map((e) => String(e.g2bulkCode || "").toLowerCase()).filter(Boolean);
  const exact = groups.filter((g) => g.key === q || code(g).includes(q));
  if (exact.length) return exact.slice(0, 1);
  // Short names: auto initials ("sm" = Sausage Man, "hok" = Honor of Kings, "gi" = Genshin Impact) + manual ALIASES.
  // More than one match -> the caller shows a "pick the game" list.
  if (q.length >= 2) {
    const al = (S.aliases || {})[q] || ALIASES[q];
    const short = groups.filter((g) => initials(g.name).includes(q) || (al && g.key.includes(al)));
    if (short.length) return short;
  }
  const words = q.split(/\s+/);
  return groups.filter((g) => words.every((w) => g.key.includes(w) || code(g).some((c) => c.includes(w))));
}

/* ---------- Input parsing ---------- */
// "mlbb 123456789(2002)", "mobile legends 123456789 2002", "123456789(2002)", "123456789|2002"
function parseInput(text) {
  // Any non-letter/digit character (space, - _ . / | , : ; ( ) + * # etc.) works as a separator.
  const tokens = text.split(/[^\p{L}\p{N}\p{M}]+/u).filter(Boolean);
  const i = tokens.findIndex((t) => /^\d{5,}$/.test(t));
  if (i === -1) return { tokens, query: tokens.join(" "), id: "", server: "" };
  return { tokens, query: tokens.slice(0, i).join(" "), id: tokens[i], server: tokens[i + 1] || "" };
}

/* ---------- Providers ---------- */
function regionFromServerId(game, serverId) {
  const rows = SERVER_REGION_MAP[String(game || "").toLowerCase()];
  const n = Number(String(serverId || "").trim());
  if (!rows || !String(serverId || "").trim() || !Number.isFinite(n)) return "";
  const hit = rows.find((r) => n >= r.from && n <= r.to);
  return hit ? hit.region : "";
}
const fmtRegion = (r) =>
  String(r || "").trim().replace(/(^|[\s\-_/(])([a-z])/g, (m, a, b) => a + b.toUpperCase());

const geoOf = (d) => {
  const pick = (...ks) => {
    for (const k of ks) if (d && typeof d[k] === "string" && d[k].trim()) return d[k].trim();
    return "";
  };
  return { region: pick("region", "server_name", "serverName"), country: pick("country", "country_name", "countryName") };
};

// -> { outcome: valid|invalid|unknown, name, geo, reason }
async function g2Check(game, id, server) {
  let res;
  try {
    res = await fetch(`${G2}/games/checkPlayerId`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ game, user_id: id, server_id: server || undefined }),
    });
  } catch {
    return { outcome: "unknown", why: "network" };
  }
  let data = null;
  try { data = await res.json(); } catch {}
  const msg = String((data && (data.message || data.error || data.detail || data.msg)) || "");
  const mentionsServer = /server|zone|region/i.test(msg);
  const isValid = !!data && (data.valid === "valid" || data.valid === true);
  if (res.ok) {
    // Some games (Genshin, ZZZ ...) have no name lookup: G2Bulk answers "valid" with a placeholder text instead of a name.
    if (isValid && /no\s+validation/i.test(String(data.name || ""))) return { outcome: "skip", why: "no validation" };
    return isValid && data.name
      ? { outcome: "valid", name: data.name, geo: geoOf(data) }
      : { outcome: "invalid", reason: mentionsServer ? "server" : "id" };
  }
  if ([400, 404, 422].includes(res.status)) {
    if (res.status === 400 && /required|missing|unsupported|not supported|unknown game|invalid game/i.test(msg)) return { outcome: "unknown", why: "unsupported" };
    return { outcome: "invalid", reason: mentionsServer ? "server" : "id" };
  }
  if (res.status === 403 && mentionsServer) return { outcome: "invalid", reason: "server" };
  return { outcome: "unknown", why: `HTTP ${res.status}` };
}

async function fazerCheck(g, id, server) {
  const keys = Array.isArray(g.fazercardFields) && g.fazercardFields.length ? g.fazercardFields : ["player_id"];
  if (keys.some((k) => /server|zone/i.test(k)) && !server) return { outcome: "unknown", why: "server ID လို" };
  const fields = {};
  keys.forEach((k) => { fields[k] = /server|zone/i.test(k) ? server : id; });
  try {
    const res = await fetch(FAZER_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ categoryId: g.fazercardCategoryId, fields }),
    });
    const data = await res.json();
    if (!res.ok || !data.ok) return { outcome: "unknown", why: `HTTP ${res.status}` };
    if (data.valid === true) return data.playerName ? { outcome: "valid", name: data.playerName, geo: geoOf(data) } : { outcome: "skip", why: "no name" };
    return { outcome: "invalid", reason: "id" };
  } catch {
    return { outcome: "unknown", why: "network" };
  }
}

/* ---------- Result cache (memory + KV) ---------- */
// Same provider + ID + server reuses the earlier answer (also shares in-flight calls).
// Found players are remembered for 1 hour (memory + KV), so searching again after the card was deleted is instant.
// "Not found" is kept 5 minutes. "unknown" results are never kept, so a provider hiccup is retried.
const MEM = new Map();
function cached(key, run) {
  const now = Date.now();
  const hit = MEM.get(key);
  if (hit && now - hit.t < hit.ttl) return hit.p;
  if (MEM.size > 1000) {
    for (const [k, v] of MEM) if (now - v.t > v.ttl) MEM.delete(k);
    if (MEM.size > 1000) MEM.clear();
  }
  const kvKey = "r:" + key;
  const p = (async () => {
    if (KV) {
      const saved = await KV.get(kvKey, "json").catch(() => null);
      if (saved && saved.outcome === "valid") return saved;
    }
    const v = await run();
    if (KV && v.outcome === "valid")
      await KV.put(kvKey, JSON.stringify(v), { expirationTtl: VALID_TTL_MS / 1000 }).catch(() => {});
    return v;
  })().catch(() => ({ outcome: "unknown", why: "error" }));
  const entry = { t: now, p, ttl: CHECK_TTL_MS };
  MEM.set(key, entry);
  p.then((v) => {
    if (v.outcome === "unknown") { if (MEM.get(key) === entry) MEM.delete(key); }
    else if (v.outcome === "valid") entry.ttl = VALID_TTL_MS;
  });
  return p;
}
const cachedG2 = (game, id, server) =>
  cached(`g:${game}|${id}|${server}`, async () => {
    const r = { ...(await g2Check(game, id, server)), provider: "G2Bulk" };
    await trackProvider(r).catch(() => {});
    return r;
  });
const cachedFazer = (g, id, server) =>
  cached(`f:${g.fazercardCategoryId}|${id}|${server}`, async () => {
    const r = { ...(await fazerCheck(g, id, server)), provider: "FazerCards" };
    await trackProvider(r).catch(() => {});
    return r;
  });
const callProvider = async (g, id, server) => {
  const provider = g.g2bulkCode ? "G2Bulk" : "FazerCards";
  if (await isDown(provider)) return { outcome: "unknown", why: "maintenance", provider };
  return g.g2bulkCode ? cachedG2(g.g2bulkCode, id, server) : cachedFazer(g, id, server);
};

// Which provider(s) failed, e.g. "G2Bulk (HTTP 502) / FazerCards (network)".
function busyProviders(results) {
  const seen = new Map();
  for (const r of results) if (r && r.outcome === "unknown" && r.provider) seen.set(r.provider, r.why || "");
  return [...seen].map(([p, w]) => esc(p) + (w ? ` (${esc(w)})` : "")).join(" / ");
}
const busyText = (results) =>
  results.length && results.every((r) => r && r.why === "maintenance")
    ? `🛠 ${busyProviders(results).replace(/ \(maintenance\)/g, "") || "Service"} ခဏ ပြုပြင်နေပါတယ်။ ခဏနေမှ ပြန်စမ်းပါ။`
    : `⚠️ ${busyProviders(results) || "Service"} busy ဖြစ်နေပါတယ်။ ခဏနေ ပြန်စမ်းပါ။`;

// Provider health: the owner(s) get ONE message when a provider goes down and ONE when it is back.
// "Down" = 2 failures in a row (network error / HTTP 5xx / 429). Any real answer (valid / not found) counts as alive.
// The cron trigger also probes both providers every few minutes, so the "back" message arrives even when nobody is checking.
const PH = new Map(); // provider -> { down, fails }
const isOutage = (r) => r.outcome === "unknown" && /^(network|error|HTTP (5\d\d|429|408))/.test(String(r.why || ""));
const isAlive = (r) => ["valid", "invalid", "skip"].includes(r.outcome);
async function notifyOwners(env, text) {
  await Promise.all(idList(env.OWNER_IDS).map((o) => tg(env, "sendMessage", { chat_id: o, text, parse_mode: "HTML" }).catch(() => {})));
}
async function trackProvider(r) {
  const env = ENV_G;
  if (!env || !r || !r.provider) return;
  let st = PH.get(r.provider);
  if (!st) {
    const saved = KV ? await KV.get("ph:" + r.provider).catch(() => null) : null;
    st = { down: saved === "down", fails: 0 };
    PH.set(r.provider, st);
  }
  if (isAlive(r)) {
    st.fails = 0;
    if (st.down) {
      st.down = false;
      if (KV) await KV.put("ph:" + r.provider, "up").catch(() => {});
      await notifyOwners(env, `✅ <b>${esc(r.provider)}</b> ပြန်ကောင်းလာပါပြီ`);
    }
  } else if (isOutage(r)) {
    st.fails += 1;
    if (st.down) st.nextTry = Date.now() + 120000;
    if (!st.down && st.fails >= 2) {
      st.down = true;
      st.nextTry = Date.now() + 120000;
      if (KV) await KV.put("ph:" + r.provider, "down").catch(() => {});
      await notifyOwners(env, `🚨 <b>${esc(r.provider)}</b> ကျနေပါတယ်${r.why ? ` (${esc(r.why)})` : ""}\nပြန်ကောင်းရင် ထပ်အကြောင်းကြားပါမယ်။`);
    }
  }
}
async function probeProviders() {
  const probe = async (provider, url, body) => {
    try {
      const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      return { provider, outcome: res.status < 500 && res.status !== 429 ? "invalid" : "unknown", why: `HTTP ${res.status}` };
    } catch {
      return { provider, outcome: "unknown", why: "network" };
    }
  };
  const rs = await Promise.all([
    probe("G2Bulk", `${G2}/games/checkPlayerId`, { game: "mlbb", user_id: "1", server_id: "1" }),
    probe("FazerCards", FAZER_URL, {}),
  ]);
  for (const r of rs) await trackProvider(r).catch(() => {});
}
// While a provider is marked down, checks for it answer "maintenance" at once (no waiting for a timeout).
// One real check is let through every 2 minutes, so the bot notices by itself when the provider is back.
async function isDown(provider) {
  let st = PH.get(provider);
  if (!st) {
    const saved = KV ? await KV.get("ph:" + provider).catch(() => null) : null;
    st = { down: saved === "down", fails: 0 };
    PH.set(provider, st);
  }
  if (!st.down) return false;
  if (Date.now() < (st.nextTry || 0)) return true;
  st.nextTry = Date.now() + 120000;
  return false;
}
// "Busy" reply to the user.
async function busy(env, chat, results, extra = "") {
  return send(env, chat, busyText(results) + extra);
}

/* ---------- Rate limit (per user, in memory) ---------- */
const RL = new Map();
const rateMax = (env) => num(S.rate, Number(env.RATE_LIMIT) || RATE_MAX);
function rateCheck(env, uid) {
  if (!uid || idList(env.OWNER_IDS).includes(String(uid))) return null;
  const max = rateMax(env);
  const now = Date.now();
  let e = RL.get(uid);
  if (!e || now - e.start >= RATE_WINDOW_MS) {
    if (RL.size > 5000) for (const [k, v] of RL) if (now - v.start >= RATE_WINDOW_MS) RL.delete(k);
    e = { start: now, n: 0, warned: false };
    RL.set(uid, e);
  }
  if (e.n + 1 > max) {
    const warn = !e.warned; // tell the user once per window, then stay quiet (no spam back)
    e.warned = true;
    return { wait: Math.max(1, Math.ceil((e.start + RATE_WINDOW_MS - now) / 1000)), warn, max };
  }
  e.n += 1;
  return null;
}
async function limited(env, chat) {
  const r = rateCheck(env, env.uid);
  if (!r) return false;
  if (r.warn) await send(env, chat, `⏳ တစ်မိနစ်ကို ${r.max} ကြိမ်ပဲ စစ်လို့ရပါတယ်။ ${r.wait} စက္ကန့်နောက် ပြန်စမ်းပါ။`);
  return true;
}

/* ---------- Group moderation (anti-forward + anti-spam) ---------- */
// Needs the bot to be a group admin with "Delete messages" (and "Ban users" for the mute).
// Admins, the group owner, OWNER_IDS and linked-channel auto posts are never touched.
// Set the variable ANTISPAM=off to switch all of this off.
const FLOOD_MAX = 5;               // more than this many messages ...
const FLOOD_WINDOW_MS = 10 * 1000; // ... inside this window = flood
const DUP_MAX = 3;                 // the same text this many times ...
const DUP_WINDOW_MS = 60 * 1000;   // ... inside this window = spam
const MUTE_SECONDS = 60 * 60;      // mute length on the 3rd warning

const ADMIN_MEM = new Map();
async function isAdmin(env, chat, uid) {
  const k = chat + ":" + uid;
  const hit = ADMIN_MEM.get(k);
  if (hit && Date.now() - hit.t < 5 * 60 * 1000) return hit.ok;
  const r = await tg(env, "getChatMember", { chat_id: chat, user_id: uid }).catch(() => null);
  const ok = ["creator", "administrator"].includes(r?.result?.status);
  if (ADMIN_MEM.size > 2000) ADMIN_MEM.clear();
  ADMIN_MEM.set(k, { t: Date.now(), ok });
  return ok;
}

const SPAM = new Map(); // chat:user -> { msgs: [{ id, t }], texts: [{ h, t }] }
const textKey = (m) => hash(String(m.text || m.caption || m.sticker?.file_unique_id || "").trim().toLowerCase());

// Returns true when the message was removed (the caller must stop handling it).
async function moderate(m, env) {
  if (flagOff(env, "antispam", "ANTISPAM")) return false;
  const chat = m.chat.id;
  const allowedChats = idList(env.ALLOWED_CHATS);
  if (allowedChats.length && !allowedChats.includes(String(chat))) return false;
  const uid = m.from?.id;
  if (!uid || m.from.is_bot || m.is_automatic_forward || m.sender_chat) return false; // bots, channel auto posts, anonymous admins
  if (m.new_chat_members || m.left_chat_member || m.pinned_message) return false;      // service messages
  if (idList(env.OWNER_IDS).includes(String(uid)) || (await isAdmin(env, chat, uid))) return false;

  const del = (ids) =>
    ids.length === 1
      ? tg(env, "deleteMessage", { chat_id: chat, message_id: ids[0] }).catch(() => {})
      : tg(env, "deleteMessages", { chat_id: chat, message_ids: ids.slice(-100) }).catch(() => {});

  // 1) Messages forwarded in from somewhere else.
  if (m.forward_origin || m.forward_date || m.forward_from || m.forward_from_chat) {
    await del([m.message_id]);
    await punish(env, m, "Forward မပို့ရပါ");
    return true;
  }

  // 1b) Links (admins are excluded above). LINKFILTER=off allows them.
  if (!flagOff(env, "linkfilter", "LINKFILTER") && hasLink(m, env)) {
    await del([m.message_id]);
    await punish(env, m, "Link မပို့ရပါ");
    return true;
  }

  // 1c) Rude words.
  const body = String(m.text || m.caption || "");
  if (body && hasBadWord(body, await getBadWords(env))) {
    await del([m.message_id]);
    await punish(env, m, "ရိုင်းစိုင်းတဲ့ စကားလုံး မသုံးရပါ");
    return true;
  }

  // 2) Flood: too many messages too fast, or the same text repeated.
  const now = Date.now();
  const key = chat + ":" + uid;
  let e = SPAM.get(key);
  if (!e) {
    if (SPAM.size > 5000) SPAM.clear();
    e = { msgs: [], texts: [] };
    SPAM.set(key, e);
  }
  e.msgs = e.msgs.filter((x) => now - x.t < FLOOD_WINDOW_MS);
  e.texts = e.texts.filter((x) => now - x.t < DUP_WINDOW_MS);
  const h = textKey(m);
  e.msgs.push({ id: m.message_id, t: now });
  if (h) e.texts.push({ h, id: m.message_id, t: now });
  const dups = e.texts.filter((x) => x.h === h);
  const flood = e.msgs.length > FLOOD_MAX;
  const dup = !!h && dups.length >= DUP_MAX;
  if (!flood && !dup) return false;

  // Remove the whole burst, then give the sender one strike (warning / mute / ban).
  const ids = [...new Set([...e.msgs.map((x) => x.id), ...(dup ? dups.map((x) => x.id) : [])])];
  SPAM.delete(key);
  await del(ids);
  await punish(env, m, "Spam မလုပ်ရပါ");
  return true;
}

/* ---------- Auto-delete queue, stats ---------- */
// Bot cards in groups are removed after AUTODEL_MS. The queue lives in KV ("del:<time>:<chat>:<message>") and the
// cron trigger (scheduled() above) sweeps it, so it survives Worker restarts.
async function scheduleDelete(env, chat, messageId, ms = autodelMs()) {
  if (!env.STATE || !messageId) return;
  const at = String(Date.now() + ms).padStart(14, "0");
  await env.STATE.put(`del:${at}:${chat}:${messageId}`, "1", { expirationTtl: Math.ceil(ms / 1000) + 86400 }).catch(() => {});
}
// send() + schedule the deletion (groups only, private chats keep their cards).
async function sendCard(env, chat, text, extra = {}, ms = autodelMs()) {
  const r = await send(env, chat, text, extra);
  if (Number(chat) < 0) await scheduleDelete(env, chat, r?.result?.message_id, ms);
  return r;
}
async function sweep(env) {
  if (!env.STATE) return;
  await sweepCaptcha(env).catch(() => {});
  await sweepPending(env).catch(() => {});
  await dailySummary(env).catch(() => {});
  await sweepUnlock(env).catch(() => {});
  await sweepSched(env).catch(() => {});
  const now = Date.now();
  let cursor;
  for (let page = 0; page < 10; page++) {
    const l = await env.STATE.list({ prefix: "del:", cursor, limit: 200 });
    const byChat = new Map();
    const keys = [];
    let future = false;
    for (const k of l.keys) {            // keys are sorted by time
      const [, at, chat, id] = k.name.split(":");
      if (Number(at) > now) { future = true; break; }
      if (!byChat.has(chat)) byChat.set(chat, []);
      byChat.get(chat).push(Number(id));
      keys.push(k.name);
    }
    for (const [chat, ids] of byChat)
      for (let i = 0; i < ids.length; i += 100)
        await tg(env, "deleteMessages", { chat_id: chat, message_ids: ids.slice(i, i + 100) }).catch(() => {});
    await Promise.all(keys.map((k) => env.STATE.delete(k).catch(() => {})));
    if (future || l.list_complete) return;
    cursor = l.cursor;
  }
}

// Daily counters (Myanmar time) for /stats.
const dayKey = (back = 0) => "st:" + new Date(Date.now() + 6.5 * 3600e3 - back * 86400e3).toISOString().slice(0, 10);
async function stat(env, kind, game) {
  if (!env.STATE) return;
  try {
    const k = dayKey();
    const s = (await env.STATE.get(k, "json")) || { found: 0, notfound: 0, games: {} };
    s[kind] = (s[kind] || 0) + 1;
    if (game) s.games[game] = (s.games[game] || 0) + 1;
    await env.STATE.put(k, JSON.stringify(s), { expirationTtl: 3 * 86400 });
  } catch {}
}

/* ---------- Order log (Done button) + "not done yet" reminder ---------- */
// Done never blocks anything, it only records who finished which order and when. The record is a KV key
// "ord:<day>:<time>:<chat>:<msg>" whose details live in the key metadata (kept 30 days).
// Every result card with a Done button is also queued as "pend:<due>:<chat>:<msg>". When it comes due and nobody
// pressed Done ("done:<chat>:<msg>" missing), the group admins are pinged once. Duplicate IDs have nothing to do with it.
// "Not done" reminder length: see pendingMs() (default 30 min, /set pending)
const ORDER_TTL_S = 30 * 86400;
const dayStr = (back = 0) => dayKey(back).slice(3);
const mmDate = (t) => new Date(t + 6.5 * 3600e3).toISOString(); // Myanmar clock
const mmTime = (t) => mmDate(t).slice(11, 16);
const mmDay = (t) => mmDate(t).slice(5, 10);

// Reads game / ID / server back from the card text the bot sent.
/* CARD-START */
// Card shapes: "Game / ✅ name / ID (Server)" (new), "✅ name / ID (Server)" (no game), "✅ name / Game · ID (Server)" (old).
function cardInfo(text) {
  const L = String(text || "").split("\n").map((x) => x.trim()).filter(Boolean);
  let game = "", rest = "";
  if (/^[✅❌]/.test(L[0] || "")) {
    const l = L[1] || "";
    const i = l.lastIndexOf(" · ");
    if (i > 0) { game = l.slice(0, i).trim(); rest = l.slice(i + 3).trim(); } else rest = l;
  } else if (/^[✅❌]/.test(L[1] || "")) {
    game = L[0];
    rest = L[2] || "";
  }
  const mm = rest.match(/^(\S+?)(?:\s*\((.+)\))?$/);
  return { game, id: mm?.[1] || "", server: mm?.[2] || "" };
}
const isCardText = (t) => {
  const L = String(t || "").split("\n").map((x) => x.trim()).filter(Boolean);
  return /^[✅❌]/.test(L[0] || "") || /^[✅❌]/.test(L[1] || "");
};
/* CARD-END */
async function logOrder(env, q, chat, who, rid, asker) {
  if (!env.STATE) return;
  const info = cardInfo(q.message.text);
  const now = Date.now();
  const mid = q.message.message_id;
  const meta = {
    a: who.slice(0, 30), u: q.from.id, g: info.game.slice(0, 40), i: info.id.slice(0, 40), s: info.server.slice(0, 20),
    t: now, c: String(chat), m: rid || 0, mn: String(asker?.first_name || "").slice(0, 25),
  };
  await Promise.all([
    env.STATE.put(`ord:${dayStr()}:${String(now).padStart(14, "0")}:${chat}:${mid}`, "1", { expirationTtl: ORDER_TTL_S, metadata: meta }),
    env.STATE.put(`done:${chat}:${mid}`, "1", { expirationTtl: Math.max(3 * 3600, Math.ceil(pendingMs() / 1000) + 3600) }),
  ]);
}
async function listOrders(env, prefix, keep) {
  const out = [];
  let cursor;
  for (let page = 0; page < 5; page++) {
    const l = await env.STATE.list({ prefix, cursor, limit: 1000 });
    for (const k of l.keys) if (k.metadata && keep(k.metadata)) out.push(k.metadata);
    if (l.list_complete) break;
    cursor = l.cursor;
  }
  return out.sort((a, b) => a.t - b.t);
}
async function trackPending(env, chat, messageId, info, askerId) {
  if (!env.STATE || !messageId || !pendingMs()) return;
  const at = String(Date.now() + pendingMs()).padStart(14, "0");
  await env.STATE.put(`pend:${at}:${chat}:${messageId}`, JSON.stringify({ ...info, u: askerId || 0 }), { expirationTtl: Math.ceil(pendingMs() / 1000) + 3600 }).catch(() => {});
}
async function sweepPending(env) {
  const now = Date.now();
  const l = await env.STATE.list({ prefix: "pend:", limit: 100 });
  for (const k of l.keys) {                     // keys are sorted by due time
    const [, at, chat, mid] = k.name.split(":");
    if (Number(at) > now) break;
    const info = await env.STATE.get(k.name, "json").catch(() => null);
    await env.STATE.delete(k.name).catch(() => {});
    if (!info) continue;
    if (await env.STATE.get(`done:${chat}:${mid}`).catch(() => null)) continue; // Done was pressed
    const r = await tg(env, "getChatAdministrators", { chat_id: chat }).catch(() => null);
    const tags = (r?.result || [])
      .filter((a) => a.user && !a.user.is_bot)
      .slice(0, 10)
      .map((a) => `<a href="tg://user?id=${a.user.id}">${esc(a.user.first_name || "Admin")}</a>`)
      .join(" ");
    const text =
      `⏰ <b>Order မပြီးသေးပါ</b>\n🎮 ${esc(info.g || "?")}\n🆔 <code>${esc(info.i || "?")}</code>${info.s ? ` (${esc(info.s)})` : ""}\n` +
      `Card တင်ပြီး ${pendingMs() / 60000} မိနစ်ကျော်ပါပြီ၊ Done မနှိပ်ရသေးပါ။` + (tags ? `\n${tags}` : "");
    await sendCard({ ...env, replyTo: Number(mid) }, chat, text, {}, 60 * 60 * 1000).catch(() => {});
  }
}

/* ---------- /lock /unlock: members cannot write; the permissions the group had are saved and restored ---------- */
async function doUnlock(env, chat) {
  const saved = await env.STATE.get(`lock:${chat}`, "json").catch(() => null);
  const perms = saved?.perms && Object.keys(saved.perms).length ? saved.perms : FULL_PERMS;
  const r = await tg(env, "setChatPermissions", { chat_id: chat, permissions: perms }).catch(() => null);
  if (r?.ok) await env.STATE.delete(`lock:${chat}`).catch(() => {});
  return r;
}
async function sweepUnlock(env) {   // /lock 30 -> unlock after 30 minutes (runs from the cron)
  const now = Date.now();
  const l = await env.STATE.list({ prefix: "unl:", limit: 50 });
  for (const k of l.keys) {
    const [, at, chat] = k.name.split(":");
    if (Number(at) > now) break;
    const lockAt = await env.STATE.get(k.name).catch(() => null);
    await env.STATE.delete(k.name).catch(() => {});
    const saved = await env.STATE.get(`lock:${chat}`, "json").catch(() => null);
    if (!saved || String(saved.at) !== String(lockAt)) continue;   // already unlocked by hand, or locked again since
    const r = await doUnlock(env, chat);
    if (r?.ok) await send({ ...env, replyTo: 0 }, chat, "🔓 Group ပြန်ဖွင့်ပါပြီ၊ စာပို့လို့ရပါပြီ").catch(() => {});
  }
}

/* ---------- Daily summary (sent to the owner(s) at night, or /summary) ---------- */
async function buildSummary(env, back = 0) {
  const label = back === 0 ? "ဒီနေ့" : back === 1 ? "မနေ့က" : dayStr(back);
  const s = (await env.STATE.get(dayKey(back), "json").catch(() => null)) || { found: 0, notfound: 0, games: {} };
  const rows = await listOrders(env, `ord:${dayStr(back)}:`, () => true);
  const per = {};
  rows.forEach((x) => (per[x.a] = (per[x.a] || 0) + 1));
  const adm = Object.entries(per).sort((a, b) => b[1] - a[1]).map(([a, n]) => `• ${esc(String(a).slice(0, 25))} — ${n}`).join("\n");
  const top = Object.entries(s.games || {}).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([g, n]) => `• ${esc(g)} — ${n}`).join("\n");
  return (
    `📊 <b>${esc(label)} စာရင်းချုပ်</b>\n\n🔎 စစ်ခဲ့တာ: ${(s.found || 0) + (s.notfound || 0)}\n✅ တွေ့: ${s.found || 0}\n❌ မတွေ့: ${s.notfound || 0}\n📦 Done: ${rows.length}` +
    (adm ? `\n\n👤 Admin အလိုက် Done\n${adm}` : "") +
    (top ? `\n\n🎮 အများဆုံး\n${top}` : "")
  );
}
async function buildWeek(env) {
  let found = 0, notfound = 0, done = 0;
  const per = {}, games = {};
  for (let d = 0; d < 7; d++) {
    const s = (await env.STATE.get(dayKey(d), "json").catch(() => null)) || {};
    found += s.found || 0;
    notfound += s.notfound || 0;
    for (const [g, n] of Object.entries(s.games || {})) games[g] = (games[g] || 0) + n;
    const rows = await listOrders(env, `ord:${dayStr(d)}:`, () => true);
    done += rows.length;
    rows.forEach((x) => (per[x.a] = (per[x.a] || 0) + 1));
  }
  const fmt = (o) => Object.entries(o).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, n]) => `• ${esc(String(k).slice(0, 25))} — ${n}`).join("\n");
  return `📊 <b>ရက် ၇ ရက် စာရင်းချုပ်</b>\n(ကောင်တာက ၃ ရက်ပဲ သိမ်းလို့ စစ်တာအရေအတွက်က နောက်ဆုံး ၃ ရက်စာပါ၊ Done က ၇ ရက်စာ)\n\n🔎 စစ်ခဲ့တာ: ${found + notfound} (✅ ${found} · ❌ ${notfound})\n📦 Done: ${done}` +
    (done ? `\n\n👤 Admin အလိုက်\n${fmt(per)}` : "") + (Object.keys(games).length ? `\n\n🎮 အများဆုံး\n${fmt(games)}` : "");
}
async function dailySummary(env) {
  if (!env.STATE || S.summary === "off") return;
  if (!idList(env.OWNER_IDS).length) return;
  const hour = new Date(Date.now() + 6.5 * 3600e3).getUTCHours();
  const at = S.summaryhour !== undefined ? Number(S.summaryhour) : 21;
  if (hour < at) return;
  const key = "sum:" + dayStr();
  if (await env.STATE.get(key).catch(() => null)) return;
  await env.STATE.put(key, "1", { expirationTtl: 3 * 86400 });   // mark first, so two overlapping sweeps send it once
  await notifyOwners(env, await buildSummary(env, 0));
}

/* ---------- Warnings: 1-2 warning, 3 mute, after that ban ---------- */
const STRIKE_TTL_S = 24 * 60 * 60;   // strikes are forgotten after 24 hours without a new one
const STRIKES = new Map();            // per-isolate counter, so a burst of messages handled at the same moment still counts 1, 2, 3 ...
const MUTED = new Map();              // member -> mute end (ms): messages of the same burst arriving after the mute are ignored (no ban)
const BURST_MEM_MS = 60 * 1000;       // the in-memory count only bridges a burst; KV stays the long-term record
async function addStrike(env, chat, uid) {
  const key = `s:${chat}:${uid}`;
  let kvN = 0, kvMute = 0;
  if (env.STATE) {
    [kvN, kvMute] = await Promise.all([
      env.STATE.get(key).then((v) => Number(v) || 0).catch(() => 0),
      env.STATE.get("mu:" + key).then((v) => Number(v) || 0).catch(() => 0),
    ]);
  }
  // From here to the return there is no await before the counter is written: concurrent webhooks run one after another here.
  const now = Date.now();
  const e = STRIKES.get(key);
  const memN = e && now - e.t < (env.STATE ? BURST_MEM_MS : STRIKE_TTL_S * 1000) ? e.n : 0;
  let n = Math.max(kvN, memN) + 1;
  const muteEnd = Math.max(MUTED.get(key) || 0, kvMute);
  if (n >= 4 && muteEnd > now) n = 0;                         // leftover message of the burst that already earned the mute: no ban, no new card
  else if (n === 3) MUTED.set(key, now + muteSec() * 1000);   // 3/3: mute window starts now
  if (STRIKES.size > 5000) STRIKES.clear();
  if (MUTED.size > 5000) MUTED.clear();
  STRIKES.set(key, { n: n || 3, t: now });
  if (env.STATE && n) {
    await env.STATE.put(key, String(n), { expirationTtl: STRIKE_TTL_S }).catch(() => {});
    if (n === 3) await env.STATE.put("mu:" + key, String(now + muteSec() * 1000), { expirationTtl: Math.max(60, muteSec()) }).catch(() => {});
  }
  return n;
}
async function punish(env, m, reason) {
  const chat = m.chat.id;
  const uid = m.from.id;
  const n = await addStrike(env, chat, uid);
  if (!n) return;   // already muted for this burst: the message was deleted by the caller, nothing more to do
  const who = `<a href="tg://user?id=${uid}">${esc(m.from.first_name || "User")}</a>`;
  let text;
  if (n >= 4) {
    await tg(env, "banChatMember", { chat_id: chat, user_id: uid }).catch(() => {});
    text = `⛔ ${who} ကို သတိပေးပြီးနောက် ထပ်ဖြစ်လို့ group ကနေ ban လိုက်ပါတယ်။`;
  } else if (n === 3) {
    await tg(env, "restrictChatMember", {
      chat_id: chat,
      user_id: uid,
      permissions: { can_send_messages: false },
      until_date: Math.floor(Date.now() / 1000) + muteSec(),
    }).catch(() => {});
    text = `🚫 ${who} — ${reason}။\nသတိပေးချက် 3/3 ပြည့်လို့ ${muteSec() / 60} မိနစ် mute လုပ်လိုက်ပါတယ်။ ထပ်ဖြစ်ရင် ban ပါမယ်။`;
  } else {
    text = `⚠️ ${who} — ${reason}။\nသတိပေးချက် ${n}/3 (၃ ကြိမ်ပြည့်ရင် mute ဖြစ်ပါမယ်)`;
  }
  await sendCard({ ...env, replyTo: 0 }, chat, text, {}, 10 * 60 * 1000);
}

/* ---------- Link filter + rude words ---------- */
const TG_USER_ONLY = /^(?:@|(?:https?:\/\/)?t\.me\/)[A-Za-z][A-Za-z0-9_]{3,31}$/i; // a lone username is a Telegram name check
function hasLink(m, env) {
  const text = String(m.text || m.caption || "");
  const ents = [...(m.entities || []), ...(m.caption_entities || [])];
  const urls = [
    ...ents.filter((e) => e.type === "url").map((e) => text.substr(e.offset, e.length)),
    ...ents.filter((e) => e.type === "text_link" && e.url).map((e) => e.url),
  ];
  const textual = /(?:https?:\/\/|www\.|t\.me\/|telegram\.(?:me|dog)\/)/i.test(text);
  if (!urls.length && !textual) return false;
  if (TG_USER_ONLY.test(text.trim())) return false;
  if (!urls.length) return true;
  const allowed = idList(S.links !== undefined ? S.links : env.ALLOWED_LINKS).map((d) => d.toLowerCase().replace(/^www\./, ""));
  const host = (u) => u.replace(/^[a-z]+:\/\//i, "").split(/[\/?#]/)[0].toLowerCase().replace(/^www\./, "");
  return !urls.every((u) => allowed.some((d) => host(u) === d || host(u).endsWith("." + d)));
}

// The built-in list is small on purpose (a short Burmese word could sit inside normal words and punish innocent members).
// Admins add more with /addword (stored in KV).
const DEFAULT_BAD = [
  "fuck", "motherfucker", "shit", "bitch", "asshole", "cunt", "bastard", "dickhead",
  "စောက်", "ဖာသည်", "ခွေးမသား",
];
let BAD = { t: 0, list: [] };
async function customBad(env) {
  if (!env.STATE) return [];
  const l = await env.STATE.get("cfg:badwords", "json").catch(() => null);
  return Array.isArray(l) ? l : [];
}
async function getBadWords(env) {
  if (BAD.list.length && Date.now() - BAD.t < 60 * 1000) return BAD.list;
  BAD = { t: Date.now(), list: [...DEFAULT_BAD, ...(await customBad(env))] };
  return BAD.list;
}
const normText = (s) => String(s).toLowerCase().replace(/[​-‍⁠﻿]/g, "");
function hasBadWord(text, words) {
  const t = normText(text);
  return words.some((w) => {
    const x = normText(w).trim();
    if (!x) return false;
    // Latin words must start at a word edge ("fuck" also catches "fucking"); Burmese is a plain substring match.
    return /^[a-z0-9 ]+$/.test(x) ? new RegExp("(^|[^a-z0-9])" + x).test(t) : t.includes(x);
  });
}

/* ---------- Welcome message (edited by group admins from inside the bot) ---------- */
const DEFAULT_WELCOME =
  "👋 {mention} ကြိုဆိုပါတယ်!\n\nGame name စစ်ချင်ရင် Player ID နဲ့ Server ID ပို့ပါ\nဥပမာ: 123456789(2002)  (ရှေ့က id ခံရင် ပိုတိကျပါတယ်)";
const WELCOME_USAGE =
  "ℹ️ <b>Welcome message ပြင်နည်း</b>\n" +
  "<code>/setwelcome စာသား</code>\n(သို့) စာတစ်ခုကို reply ပြီး <code>/setwelcome</code>\n\n" +
  "{mention} = member နာမည် (tag)\n{name} = နာမည်\n{group} = group နာမည်\n\n" +
  "<code>/welcome</code> ကြည့်ရန်\n<code>/welcome off</code> ပိတ်\n<code>/welcome on</code> ဖွင့်\n<code>/welcome reset</code> မူလပြန်\n\nBot ကို private chat မှာ ရိုက်ရင် group အားလုံးအတွက် default ဖြစ်ပါတယ်။";
// Settings: "w:<chat>" for one group, "w:default" for every group without its own (edited from private chat).
async function getWelcome(env, chat) {
  const get = (k) => (env.STATE ? env.STATE.get(k, "json").catch(() => null) : null);
  const own = chat === "default" ? null : await get("w:" + chat);
  const glob = await get("w:default");
  return {
    text: own?.text || glob?.text || DEFAULT_WELCOME,
    off: own ? !!own.off : !!glob?.off,
    nocaptcha: own ? !!own.nocaptcha : !!glob?.nocaptcha,
  };
}
// Store link (button on welcome + result cards) and the "order done" message. Both are global, set from the bot.
let STORE = { t: 0, v: "" };
async function getStore(env) {
  if (env.STORE_URL) return String(env.STORE_URL).trim();
  if (!env.STATE) return "";
  if (Date.now() - STORE.t < 60 * 1000) return STORE.v;
  const v = (await env.STATE.get("cfg:store").catch(() => "")) || "";
  STORE = { t: Date.now(), v };
  return v;
}
const DEFAULT_DONE = "{mention} သင့် order ပြီးပါပြီ ✅";
const DEFAULT_REJECT = "{mention} သင့် order ကို လက်မခံနိုင်ပါ ❌ Admin ကို ဆက်သွယ်ပါ";
async function getDoneText(env) {
  const v = env.STATE ? await env.STATE.get("cfg:done").catch(() => null) : null;
  return v || DEFAULT_DONE;
}
// FAQ auto-reply: [{ k: [keywords], a: "answer" }]
let FAQ = { t: 0, list: [] };
const FAQ_COOL = new Map();
async function getFaq(env) {
  if (!env.STATE) return [];
  if (Date.now() - FAQ.t < 60 * 1000) return FAQ.list;
  const l = await env.STATE.get("cfg:faq", "json").catch(() => null);
  FAQ = { t: Date.now(), list: Array.isArray(l) ? l : [] };
  return FAQ.list;
}
async function matchFaq(env, chat, text) {
  const list = await getFaq(env);
  if (!list.length || text.length > 300) return null;
  const t = normText(text);
  for (let i = 0; i < list.length; i++) {
    if (!list[i].k.some((k) => k && t.includes(k))) continue;
    const ck = chat + ":" + i;
    if (Date.now() - (FAQ_COOL.get(ck) || 0) < 60 * 1000) return null; // same answer at most once a minute per group
    if (FAQ_COOL.size > 2000) FAQ_COOL.clear();
    FAQ_COOL.set(ck, Date.now());
    return list[i].a;
  }
  return null;
}

// Captcha: a new member is muted until he presses the button. No press within 5 minutes -> removed (can join again).
const CAPTCHA_MS = 5 * 60 * 1000;
async function openPerms(env, chat) {
  const r = await tg(env, "getChat", { chat_id: chat }).catch(() => null);
  const p = r?.result?.permissions;
  if (p && Object.keys(p).length) return p;
  return {
    can_send_messages: true, can_send_audios: true, can_send_documents: true, can_send_photos: true, can_send_videos: true,
    can_send_video_notes: true, can_send_voice_notes: true, can_send_polls: true, can_send_other_messages: true, can_add_web_page_previews: true,
  };
}
async function sweepCaptcha(env) {
  const now = Date.now();
  const l = await env.STATE.list({ prefix: "cap:", limit: 200 });
  for (const k of l.keys) {
    const [, at, chat, uid] = k.name.split(":");
    if (Number(at) > now) break;
    await env.STATE.delete(k.name).catch(() => {});
    const pending = await env.STATE.get(`capv:${chat}:${uid}`).catch(() => null);
    if (!pending) continue;
    await env.STATE.delete(`capv:${chat}:${uid}`).catch(() => {});
    await tg(env, "banChatMember", { chat_id: chat, user_id: Number(uid) }).catch(() => {});
    await tg(env, "unbanChatMember", { chat_id: chat, user_id: Number(uid), only_if_banned: true }).catch(() => {});
  }
}

function renderWelcome(tpl, users, title) {
  const names = users.map((u) => ({ id: u.id, name: [u.first_name, u.last_name].filter(Boolean).join(" ") || "Member" }));
  const mention = names.map((n) => `<a href="tg://user?id=${n.id}">${esc(n.name)}</a>`).join(", ");
  const plain = names.map((n) => esc(n.name)).join(", ");
  return tplHtml(tpl)
    .replace(/\{mention\}/gi, () => mention)
    .replace(/\{name\}/gi, () => plain)
    .replace(/\{group\}/gi, () => esc(title || "Group"));
}
async function welcome(m, env) {
  const chat = m.chat.id;
  const allowed = idList(env.ALLOWED_CHATS);
  if (allowed.length && !allowed.includes(String(chat))) return;
  const users = m.new_chat_members.filter((u) => !u.is_bot);
  if (!users.length) return;
  const w = await getWelcome(env, chat);
  const store = await getStore(env);
  const storeRow = store ? [[{ text: "Store ဝင်ရန်", url: store, style: "primary", ...ic(env, "ICON_STORE") }]] : [];
  const owners = idList(env.OWNER_IDS);
  const plain = [];
  for (const u of users) {
    let cap = false;
    if (!w.nocaptcha && env.STATE && !owners.includes(String(u.id)) && !(await isAdmin(env, chat, u.id))) {
      const r = await tg(env, "restrictChatMember", { chat_id: chat, user_id: u.id, permissions: { can_send_messages: false } }).catch(() => null);
      cap = !!r?.ok;   // false when the bot may not restrict -> no captcha, plain welcome
    }
    if (!cap) { plain.push(u); continue; }
    const head = w.off ? renderWelcome("{mention}", [u], m.chat.title) : renderWelcome(w.text, [u], m.chat.title);
    const text = head + "\n\n🔒 Bot မဟုတ်ကြောင်း အောက်က ခလုတ်ကို ၅ မိနစ်အတွင်း နှိပ်ပါ";
    const r = await sendCard(
      env, chat, text,
      { reply_markup: { inline_keyboard: [[{ text: "✅ ကျွန်တော်/ကျွန်မ လူသားပါ", callback_data: `v:${u.id}`, style: "success" }], ...storeRow] } },
      WELCOME_TTL_MS
    );
    await env.STATE.put(`capv:${chat}:${u.id}`, String(r?.result?.message_id || 0), { expirationTtl: 3600 });
    await env.STATE.put(`cap:${String(Date.now() + CAPTCHA_MS).padStart(14, "0")}:${chat}:${u.id}`, "1", { expirationTtl: 7200 });
  }
  if (plain.length && !w.off)
    await sendCard(env, chat, renderWelcome(w.text, plain, m.chat.title), storeRow.length ? { reply_markup: { inline_keyboard: storeRow } } : {}, WELCOME_TTL_MS);
}

/* ---------- Admin commands (group admins + OWNER_IDS) ---------- */
// Who a /warns /unwarn /unban command is about: the replied-to member (or the member tagged in the bot's own warning
// message), a tagged member, or a numeric user ID in the command.
function targetUser(m, arg) {
  const fromEnt = (msg) => {
    for (const e of msg?.entities || []) {
      if (e.type === "text_mention" && e.user && !e.user.is_bot) return { id: e.user.id, name: e.user.first_name };
      const mm = e.type === "text_link" && String(e.url || "").match(/^tg:\/\/user\?id=(\d+)/i);
      if (mm) return { id: Number(mm[1]) };
    }
    return null;
  };
  const r = m.reply_to_message;
  if (r) {
    if (r.from && !r.from.is_bot) return { id: r.from.id, name: r.from.first_name };
    const t = fromEnt(r);
    if (t) return t;
  }
  const num = String(arg || "").match(/\d{5,}/);
  if (num) return { id: Number(num[0]) };
  return fromEnt(m);
}

// Owners can run all of them in private chat with the bot; group admins can run them in the group. Members are ignored silently.
// Welcome / captcha: in a group they change that group only; in private chat they change the default for every group.
// Rude words, FAQ, store link, "order done" message are global.
const ADMIN_MENU_TEXT =
  "🛠 <b>Admin commands</b>\n(Group admin ကို group ထဲမှာ၊ Owner ကို private မှာလည်း သုံးလို့ရ၊ Member တွေ ရိုက်ရင် Bot က မပြန်ပါ)\n\nဖတ်ချင်တာ ခလုတ်နှိပ်ပါ 👇";
const ADMIN_PAGES = {
  a1: ["⚙️ စတင်ရန်",
    [
      "<b>⚙️ စတင်ပြင်ဆင်ရန်</b>",
      "",
      "<b>၁။ Bot ကို Group admin ပေးပါ</b>",
      "• <b>Delete messages</b> — Forward / Link / Spam / ရိုင်းတဲ့စာ ဖျက်ဖို့",
      "• <b>Ban users</b> — Mute / Ban / Captcha / /unban / /lock အတွက်",
      "",
      "<b>၂။ ဘယ်သူ ဘာသုံးလို့ရလဲ</b>",
      "• Owner — command အားလုံး (Bot နဲ့ private chat မှာပါ)",
      "• Group admin — Group ထဲမှာ Owner-only မဟုတ်တဲ့ command တွေ",
      "• Member — Name စစ်ရုံပဲ၊ admin command ရိုက်ရင် Bot က မပြန်ပါ",
      "Owner-only: /set /maint /seticon /emojiid /summary /stats /reload /hidegame /showgame /announce /groups",
      "",
      "<b>၃။ ID ယူရန်</b>",
      "<code>/id</code> — သင့် user ID နဲ့ chat ID ပြ။ Worker variable OWNER_IDS (Owner ID)၊ ALLOWED_CHATS (Bot အလုပ်လုပ်စေမယ့် group) ထည့်ဖို့ သုံးပါ",
      "",
      "<b>၄။ Store link ခလုတ်</b>",
      "<code>/setstore https://your-store.com</code> — Welcome နဲ့ Result card မှာ Store ဝင်ရန် ခလုတ်ပေါ်",
      "<code>/setstore off</code> ပိတ် · <code>/setstore</code> လက်ရှိကြည့်",
      "",
      "<b>မှတ်ချက်</b>",
      "Auto-delete၊ order စာရင်း၊ strike တွေအတွက် KV (STATE) လို။ အလိုလိုဖျက်/သတိပေး/စာရင်းချုပ် အချိန်မှန်ဖို့ Cron trigger (*/5 * * * *) ထည့်ထားပါ"
    ].join("\n")],
  a2: ["📦 Order",
    [
      "<b>📦 Order</b>",
      "",
      "<b>Done ခလုတ်</b>",
      "Group ထဲက Result card (✅) မှာ Done ပါ၊ Admin / Owner ပဲ နှိပ်လို့ရ။ နှိပ်ရင်:",
      "• ခလုတ်က Done - နာမည် ဖြစ်သွား",
      "• မေးခဲ့တဲ့ member ကို tag ပြီး order ပြီးကြောင်း စာပို့",
      "• admin၊ game၊ ID၊ အချိန် မှတ်တမ်းသိမ်း (ရက် ၃၀)",
      "Done က ဘာကိုမှ မတားပါဘူး (မှတ်တမ်းသက်သက်)။ Private chat မှာ Owner စစ်ရင်လည်း Done ပါ (member tag စာ မပို့)",
      "Reject ခလုတ်ကလည်း Done ဘေးမှာ ပါ — နှိပ်ရင် ခလုတ်က Reject - နာမည် ဖြစ်၊ member ကို tag ပြီး လက်မခံကြောင်း စာပို့၊ Done မှတ်တမ်းထဲ မဝင်ဘဲ သတိပေးချိန်လည်း ရပ်သွားမယ်",
      "",
      "<b>/orders — မှတ်တမ်းကြည့်</b>",
      "<code>/orders</code> ဒီနေ့ · <code>/orders 1</code> မနေ့က (1–29 ရက်ပြန်)",
      "<code>/orders 123456789</code> Player ID နဲ့ ရှာ (ရက် ၃၀၊ အငြင်းပွားရင် သက်သေ)",
      "<code>/orders ကိုကို</code> Admin နာမည်နဲ့ (ဒီနေ့) · <code>/orders ကိုကို 1</code> မနေ့က",
      "Group admin က ကိုယ့် group ပဲ၊ Owner က Bot နဲ့ private မှာ group အားလုံး ကြည့်လို့ရ",
      "",
      "<b>⏰ Order မပြီးသေးသတိပေး</b>",
      "Card တင်ပြီး ၃၀ မိနစ် Done မနှိပ်ရင် admin တွေကို tag ပြီး သတိပေး",
      "<code>/set pending 20</code> မိနစ်ပြောင်း · <code>/set pending off</code> ပိတ်",
      "",
      "<b>Order ပြီးကြောင်း စာ</b>",
      "<code>/setdone {mention} order ပြီးပါပြီ ✅</code> — {mention} က member ကို tag",
      "<code>/setdone</code> လက်ရှိကြည့် · <code>/setdone reset</code> မူလ"
    ].join("\n")],
  a3: ["⚠️ Strike",
    [
      "<b>⚠️ Group စည်းကမ်း / Strike</b>",
      "Admin၊ Owner တွေကို မထိပါ။ အောက်ပါတွေကို Bot က ဖျက်ပြီး strike ပေး:",
      "• Forward · Link (@username တစ်ခုတည်း ပို့တာတော့ ရ) · ရိုင်းတဲ့စာလုံး",
      "• Spam — ၁၀ စက္ကန့်အတွင်း စာ ၅ စောင်ထက်များ၊ တူတဲ့စာ ၁ မိနစ်အတွင်း ၃ ကြိမ်",
      "Strike ၁-၂ = သတိပေး · ၃ = mute (မူလ ၆၀ မိနစ်) · ၄ = ban",
      "နောက်ဆုံး strike ကနေ ၂၄ နာရီ ကြာရင် ပျောက်",
      "",
      "<b>Strike စီမံရန်</b> (Group ထဲမှာ — member စာကို reply၊ သို့ ID ထည့်၊ သို့ Bot သတိပေးစာကို reply)",
      "<code>/warns</code> — strike ရှိသူအားလုံး၊ member ပေးရင် ၁ ယောက်စာ",
      "<code>/unwarn</code> — ၁ ခုလျော့ (၃ ကနေ လျော့ရင် mute ပါ ဖြေ) · <code>/unwarn all</code> အကုန်ဖယ်",
      "<code>/unban</code> — Ban / Mute ဖြေ + strike ရှင်း (ပြန်ဝင်လို့ရ)",
      "ဥပမာ: <code>/unban 123456789</code>",
      "",
      "<b>ရိုင်းတဲ့စာလုံး</b>",
      "<code>/addword စာလုံး, စာလုံး</code> — , နဲ့ခြားပြီး ထည့် (ရိုက်တဲ့စာကို Bot က ဖျက်ပေး)",
      "<code>/delword စာလုံး</code> · <code>/words</code> စာရင်း",
      "မြန်မာစာလုံးတိုတိုက ပုံမှန်စာထဲ ပါနိုင်လို့ ရှည်ရှည်ထည့်ပါ",
      "",
      "<b>ပြင်လို့ရတာ</b> (Owner)",
      "<code>/set antispam off</code> moderation အကုန်ပိတ်",
      "<code>/set linkfilter off</code> link ခွင့်ပြု · <code>/set links youtube.com</code> ဒီ domain ပဲ ခွင့်ပြု",
      "<code>/set mute 120</code> mute ကြာချိန် (မိနစ်)",
      "",
      "<b>🔒 Group ပိတ်/ဖွင့်</b> (Group ထဲမှာ)",
      "<code>/lock</code> — Member စာပို့ခွင့် အကုန်ပိတ် (Admin ပို့လို့ရ)",
      "<code>/lock 30 ည ၁၀ နာရီ ပိတ်ပါပြီ</code> — ၃၀ မိနစ်နဲ့ အလိုလိုပြန်ဖွင့် + ကြေညာစာ (Cron လို)",
      "<code>/unlock</code> — ပြန်ဖွင့် (Group မူလ permission အတိုင်း ပြန်ထား)",
      "Slow mode ကို Telegram က Bot ကို ခွင့်မပေးလို့ Group Settings ကနေ ကိုယ်တိုင်ဖွင့်ပါ"
    ].join("\n")],
  a4: ["👋 Welcome",
    [
      "<b>👋 Welcome</b>",
      "Member အသစ်ဝင်ရင် Bot က ကြိုဆိုစာပို့ (၁၀ မိနစ်နဲ့ ပျက်)",
      "<code>/setwelcome စာသား</code> — ပြင် · သို့ စာတစ်ခုကို reply ပြီး <code>/setwelcome</code>",
      "{mention} member ကို tag · {name} နာမည် · {group} group နာမည်",
      "Bold၊ Quote၊ Premium emoji ပါရိုက်ထားတဲ့အတိုင်း ပြ",
      "<code>/welcome</code> လက်ရှိကြည့် · <code>/welcome off</code> ပိတ် · <code>/welcome on</code> ဖွင့် · <code>/welcome reset</code> မူလ",
      "Group ထဲမှာ ရိုက်ရင် အဲဒီ group ပဲ။ Bot နဲ့ private မှာ (Owner) ရိုက်ရင် Group အားလုံးအတွက် default",
      "",
      "<b>🔒 Captcha</b>",
      "ဖွင့်ထားရင် member အသစ်ကို mute ထားပြီး ခလုတ် ၅ မိနစ်အတွင်း နှိပ်မှ စာပို့ခွင့်ပေး။ မနှိပ်ရင် group ကထုတ် (ပြန်ဝင်လို့ရ)",
      "<code>/captcha on</code> · <code>/captcha off</code> · <code>/captcha</code> လက်ရှိကြည့်",
      "Bot မှာ Ban users ခွင့်ရှိမှ အလုပ်လုပ်"
    ].join("\n")],
  a5: ["💬 FAQ/Cmd",
    [
      "<b>💬 FAQ auto-reply</b>",
      "Member စာထဲမှာ keyword ပါရင် Bot က အလိုလိုဖြေ (ID ပါတဲ့စာ၊ စာလုံး ၃၀၀ ကျော်တာ မဖြေ၊ တူတဲ့အဖြေ ၁ မိနစ်ကို ၁ ခါပဲ)",
      "<code>/addfaq ဈေး, price | Diamond ဈေး Store မှာ ကြည့်ပါ</code>",
      "keyword တွေ , နဲ့ခြား · | နောက်က အဖြေ · Quote+Bold နဲ့ပြ",
      "<code>/faqs</code> စာရင်း · <code>/delfaq ဈေး</code> (သို့) <code>/delfaq 2</code>",
      "",
      "<b>💳 Payment auto-reply ပြင်ရန်</b>",
      "<code>/paywords</code> စာရင် · <code>/payword kpay = ကေပေး, kbzpay</code> · <code>/delpayword kpay</code>",
      "<code>/paymsg လွှဲပြီး receipt ပို့ပါ</code> (ကတ်အောက်က စာ၊ ဖျက်ရန် <code>/paymsg off</code>) · <code>/set pay on|off</code>",
      "Group မှာ Member အားလုံးအတွက် အလုပ်လုပ်ပါတယ်၊ ပြင်လို့ရတာက Owner (DM) နဲ့ Group admin ပဲ",
      "",
      "<b>📩 Customer DM</b>",
      "<code>/set dmopen on|off</code> · <code>/set dmhours 9-22</code> · <code>/set offmsg စာ</code>",
      "",
      "<b>➕ ကိုယ်ပိုင် Command</b>",
      "/ နဲ့စတဲ့ command ကိုယ်တိုင်လုပ် — ရိုက်မှ ဖြေ (FAQ က keyword ပါရင် အလိုလိုဖြေ)",
      "<code>/addcmd rules | Group စည်းကမ်းတွေ ဒီမှာ</code> → <code>/rules</code> ရိုက်ရင် ပြ",
      "နာမည်: English စာလုံး/ဂဏန်း/_ ၂–၂၀ လုံး၊ အများဆုံး ၃၀ ခု၊ Bot သုံးပြီးသားနာမည် မရ",
      "<code>/cmds</code> စာရင်း · <code>/delcmd rules</code>"
    ].join("\n")],
  a6: ["🎮 Game",
    [
      "<b>🎮 Game</b>",
      "",
      "<b>အတိုကောက်</b> (ဥပမာ sm ရိုက်ရင် Sausage Man)",
      "<code>/addalias sm = sausage man</code> — = နောက်က Store ထဲက game နာမည်ရဲ့ တစ်စိတ်တစ်ပိုင်း (Store မှာမရှိရင် မထည့်ပေး)",
      "<code>/delalias sm</code> · <code>/aliases</code> (ထည့်ထားတာ + Bot မှာပါပြီးသား)",
      "Game နာမည်ရဲ့ ရှေ့စာလုံးတွေ (ဥပမာ gi) လည်း အလိုလိုရ",
      "",
      "<b>Game ပိတ်/ဖွင့်</b> (Owner)",
      "<code>/hidegame mobile legends</code> — name check မှာ ဖျောက် · <code>/showgame mobile legends</code> ပြန်ဖွင့်",
      "<code>/hidegame</code> — ပိတ်ထားတဲ့စာရင်း",
      "",
      "<b>Game list refresh</b> (Owner)",
      "<code>/reload</code> — Store ထဲ game အသစ်ထည့်/ပြင်ပြီးရင် ချက်ချင်းယူ (မဟုတ်ရင် ၅ မိနစ်စောင့်ရ)"
    ].join("\n")],
  a7: ["🧩 Settings",
    [
      "<b>🧩 Settings</b> (Owner)",
      "<code>/set</code> — အားလုံးနဲ့ လက်ရှိတန်ဖိုး · <code>/set rate 5</code> ပြင် · <code>/set rate reset</code> မူလ",
      "• rate — တစ်မိနစ်ကို စစ်ခွင့် (ကြိမ်၊ မူလ ၃)",
      "• autodel — Group card ပျက်ချိန် (မိနစ်၊ မူလ ၆၀)",
      "• pending — Done မနှိပ်ရင် သတိပေးချိန် (မူလ ၃၀၊ off ရ)",
      "• mute — ၃ ကြိမ်ပြည့် mute ကြာချိန် (မိနစ်၊ မူလ ၆၀)",
      "• antispam / linkfilter — on | off",
      "• links — ခွင့်ပြုတဲ့ domain (, နဲ့ခြား)",
      "• copyid — public (လူတိုင်း) | restricted (ပို့တဲ့သူ + admin ပဲ)",
      "• summary — on | off · summaryhour — စာရင်းချုပ်ပို့မယ့်နာရီ 0–23 (မူလ ၂၁)",
      "",
      "<b>🛠 Maintenance</b>",
      "<code>/maint on ခဏပြုပြင်နေပါတယ်</code> — Member တွေ စစ်ရင် ဒီစာပြ (Owner က စမ်းလို့ရသေး)",
      "<code>/maint off</code> · <code>/maint</code> အခြေအနေကြည့်",
      "Provider ကျရင် Bot က ကိုယ်တိုင်သိပြီး maintenance စာ ချက်ချင်းပြ၊ ပြန်ကောင်းရင်လည်း ကိုယ်တိုင်သိ (Owner ဆီ အကြောင်းကြား)",
      "",
      "<b>💎 Button icon (Premium emoji)</b>",
      "<code>/emojiid</code> + premium emoji (သို့ emoji ပါစာကို reply) — ID ပြ",
      "<code>/seticon copy 💎</code> — copy | done | store · <code>/seticon copy off</code> ဖယ်",
      "Bot owner မှာ Telegram Premium လို · Card အသစ်တွေကစပြ"
    ].join("\n")],
  a8: ["📊 Report",
    [
      "<b>📊 Report / Owner</b>",
      "<code>/stats</code> — ဒီနေ့+မနေ့က စစ်တာ၊ တွေ့/မတွေ့၊ game အများဆုံး",
      "<code>/summary</code> ဒီနေ့ · <code>/summary 1</code> မနေ့က · <code>/summary week</code> ရက် ၇ ရက်",
      "စစ်တာ၊ Done၊ Admin တစ်ယောက်ချင်း Done ပြ (စစ်တာအရေအတွက်က ၃ ရက်ပဲ သိမ်း၊ Done က ၃၀ ရက်)",
      "ညဘက် ၉ နာရီ (မြန်မာ) Owner ဆီ အလိုလိုပို့ — <code>/set summaryhour 22</code> · <code>/set summary off</code> (Cron နဲ့ OWNER_IDS လို)",
      "",
      "<b>📝 Post တင် (Channel / Group)</b> — Bot နဲ့ private chat မှာ Owner",
      "/start ရိုက်ရင် Menu ခလုတ်တွေ အောက်မှာ ပေါ်နေမယ် — 📝 Post တင်ရန် · ⏰ Schedule · 🗂 တင်ပြီးသား · 📋 Templates · 📢 Channels",
      "Post ခလုတ်တွေ: Button + 🎨 Color (အပြာ/အစိမ်း/အနီ) · 📌 Pin · 🔔 Silent · 🔗 Link preview · 📸 Album · 💾 Template · Preview · ယခုတင် / အချိန်ခွဲ (🔁 နေ့တိုင်း/အပတ်တိုင်း)",
      "Channel မှတ်ရန်: Bot ကို channel မှာ admin လုပ်ရုံ (အလိုလိုမှတ်) (သို့) 📢 Channels ထဲက ➕ ခလုတ်နဲ့ @username ထည့် — forward မလိုပါ",
      "တင်ပြီးသား Post ကို ✏️ စာပြင် / 🖼 ပုံ-video ပြောင်း / 🔘 Button ထည့်-ပြင်-ဖျက် / 🗑 ဖျက် / 📌 Pin ရ (ရက် ၃၀) · Schedule အတွက် Cron နဲ့ KV လို",
      "",
      "<b>📣 Group အားလုံးကို ကြေညာ</b>",
      "Bot နဲ့ private chat မှာ <code>/announce စာသား</code> — Bot သုံးနေတဲ့ group အားလုံးဆီ ပို့၊ ပြီးရင် ဘယ်နှစ်ခုရောက်လဲ ပြန်ပြော",
      "<code>/groups</code> — Bot သုံးနေတဲ့ group စာရင်း (Group ထဲမှာ စာတစ်ခုပေါ်မှ မှတ်)"
    ].join("\n")],
};
// Blue buttons, two per row. h:a = this menu, h:a1..a6 = pages (admins only), h:0 = back to the /start menu.
const adminMenu = () => {
  const b = (k) => ({ text: ADMIN_PAGES[k][0], callback_data: "h:" + k, style: "primary" });
  return { inline_keyboard: [[b("a1"), b("a2")], [b("a3"), b("a4")], [b("a5"), b("a6")], [b("a7"), b("a8")], [{ text: "⬅️ ပြန်သွားရန်", callback_data: "h:0", style: "primary" }]] };
};
async function adminCommand(env, m, text, isGroup, owners) {
  const mm = text.match(/^\/(lock|unlock|hidegame|showgame|announce|groups|addalias|delalias|aliases|settings|set|maint|seticon|emojiid|summary|addcmd|delcmd|cmds|setwelcome|welcome|captcha|addword|delword|words|stats|paymsg|payword|delpayword|paywords|addfaq|delfaq|faqs|setstore|setdone|adminhelp|orders|warns|unwarn|unban)(?:@\w+)?(?:\s+([\s\S]*))?$/i);
  if (!mm) return false;
  const cmd = mm[1].toLowerCase();
  const arg = (mm[2] || "").trim();
  const chat = m.chat.id;
  const uid = m.from?.id;
  const isOwner = owners.includes(String(uid));
  if (!isOwner && !(isGroup && (await isAdmin(env, chat, uid)))) return true;
  if (["set", "settings", "maint", "seticon", "emojiid", "summary", "hidegame", "showgame", "announce", "groups"].includes(cmd) && !isOwner) return true;   // owner only
  const say = (t, ms = 10 * 60 * 1000) => sendCard({ ...env, replyTo: 0 }, chat, t, {}, ms);
  const usage = (t) => say(t, 2 * 60 * 1000);
  if (cmd === "adminhelp") {
    await sendCard({ ...env, replyTo: 0 }, chat, ADMIN_MENU_TEXT, { reply_markup: adminMenu() }, 10 * 60 * 1000);
    return true;
  }
  if (cmd === "emojiid") {
    const ids = [...(m.entities || []), ...(m.reply_to_message?.entities || [])].filter((e) => e.type === "custom_emoji" && e.custom_emoji_id).map((e) => e.custom_emoji_id);
    await say(
      ids.length
        ? "💎 <b>Premium emoji ID</b>\n" + [...new Set(ids)].map((i) => `<code>${esc(i)}</code>`).join("\n") + "\n\nခလုတ်မှာ ထည့်ရန်: <code>/seticon copy 💎</code>"
        : "💎 Premium emoji ကို <code>/emojiid</code> နောက်မှာ ထည့်ပို့ပါ (သို့) emoji ပါတဲ့ စာကို reply လုပ်ပါ။\n(Telegram Premium လိုပါတယ်)",
      5 * 60 * 1000
    );
    return true;
  }
  if (!env.STATE) {
    await say("⚠️ KV (STATE) မချိတ်ရသေးလို့ ဒီ command သုံးလို့မရပါ။", 60 * 1000);
    return true;
  }

  if (cmd === "stats") {
    if (!isOwner) return true;
    const fmt = async (label, back) => {
      const s = await env.STATE.get(dayKey(back), "json").catch(() => null);
      if (!s) return `<b>${label}</b>\nစစ်ထားတာ မရှိသေးပါ`;
      const top = Object.entries(s.games || {}).sort((a, b) => b[1] - a[1]).slice(0, 5)
        .map(([g, n]) => `• ${esc(g)} — ${n}`).join("\n");
      return `<b>${label}</b>\n🔎 စစ်ခဲ့တာ: ${(s.found || 0) + (s.notfound || 0)}\n✅ တွေ့: ${s.found || 0}\n❌ မတွေ့: ${s.notfound || 0}` +
        (top ? `\n🎮 အများဆုံး\n${top}` : "");
    };
    await say("📊 <b>Stats</b>\n\n" + (await fmt("ဒီနေ့", 0)) + "\n\n" + (await fmt("မနေ့က", 1)));
    return true;
  }

  // ----- order log: /orders -----
  if (cmd === "orders") {
    const scope = isGroup ? String(chat) : null;           // group admins see their own group, owners (private) see all
    const keep = (x) => !scope || x.c === scope;
    const cut = (t, n) => esc(String(t || "?").slice(0, n));
    const line = (x, dated) =>
      `${dated ? mmDay(x.t) + " " : ""}${mmTime(x.t)} · ${cut(x.g, 22)} · <code>${esc(x.i || "?")}</code>${x.s ? `(${esc(x.s)})` : ""} — ${cut(x.a, 20)}` +
      (dated && x.mn ? ` (member: ${cut(x.mn, 20)})` : "");
    if (/^\d{5,}$/.test(arg)) {
      const days = await Promise.all(Array.from({ length: 30 }, (_, d) => listOrders(env, `ord:${dayStr(d)}:`, (x) => x.i === arg && keep(x))));
      const rows = days.flat().sort((a, b) => a.t - b.t);
      if (!rows.length) {
        await say(`🔎 <code>${esc(arg)}</code>\nDone မှတ်တမ်း မတွေ့ပါ (ရက် ၃၀ အတွင်း)`, 5 * 60 * 1000);
        return true;
      }
      const shown = rows.slice(-25);
      await say(`🔎 <code>${esc(arg)}</code> — Done ${rows.length} ကြိမ်\n\n` + shown.map((x) => line(x, true)).join("\n") + (rows.length > shown.length ? `\n\n(နောက်ဆုံး ${shown.length} ခုပဲ ပြထားတယ်)` : ""), 5 * 60 * 1000);
      return true;
    }
    let nameQ = "";
    let backArg = arg;
    if (arg && !/^\d{1,2}$/.test(arg)) {   // /orders <admin name> [days back]
      const m2 = arg.match(/^(.*\S)\s+(\d{1,2})$/);
      nameQ = (m2 ? m2[1] : arg).toLowerCase();
      backArg = m2 ? m2[2] : "0";
    }
    const back = Math.min(Number(backArg || 0), 29);
    const rows = await listOrders(env, `ord:${dayStr(back)}:`, (x) => keep(x) && (!nameQ || String(x.a).toLowerCase().includes(nameQ)));
    const label = (back === 0 ? "ဒီနေ့" : back === 1 ? "မနေ့က" : dayStr(back)) + (nameQ ? ` · ${esc(nameQ)}` : "");
    if (!rows.length) {
      await say(`📋 ${label} Done ပြီးတဲ့ order မရှိသေးပါ`, 5 * 60 * 1000);
      return true;
    }
    const per = {};
    rows.forEach((x) => (per[x.a] = (per[x.a] || 0) + 1));
    const sum = Object.entries(per).sort((a, b) => b[1] - a[1]).map(([a, n]) => `${cut(a, 20)} ${n}`).join(" · ");
    const shown = rows.slice(-30);
    const base = rows.length - shown.length;
    await say(
      `📋 <b>${label} Done ပြီးတဲ့ order</b> — ${rows.length} ခု\n👤 ${sum}\n\n` +
        shown.map((x, i) => `${base + i + 1}. ${line(x, false)}`).join("\n") +
        (base ? `\n\n(နောက်ဆုံး ${shown.length} ခုပဲ ပြထားတယ်)` : ""),
      5 * 60 * 1000
    );
    return true;
  }

  // ----- strikes: /warns /unwarn /unban -----
  if (cmd === "warns" || cmd === "unwarn" || cmd === "unban") {
    if (!isGroup) {
      await usage("⚠️ ဒီ command ကို Group ထဲမှာ သုံးပါ။");
      return true;
    }
    const t = targetUser(m, arg);
    const link = (x) => `<a href="tg://user?id=${x.id}">${esc(x.name || x.id)}</a>`;
    const skey = (uid2) => `s:${chat}:${uid2}`;
    const howTo = `Member ရဲ့ စာကို reply ပြီး (သို့) ID ထည့်ပါ\nဥပမာ: <code>/${cmd} 123456789</code>\n(Bot ရဲ့ သတိပေးစာကို reply လည်း ရပါတယ်)`;

    if (cmd === "warns") {
      if (!t) {   // no member given -> everyone who has an active strike in this group
        const l = await env.STATE.list({ prefix: `s:${chat}:`, limit: 30 });
        const rows = [];
        for (const k of l.keys) {
          const n = Number(await env.STATE.get(k.name).catch(() => 0)) || 0;
          if (n > 0) rows.push({ id: k.name.split(":")[2], n });
        }
        await say(
          "⚠️ <b>Strike ရှိတဲ့ member</b>\n\n" +
            (rows.length ? rows.map((r) => `• ${link({ id: r.id })} — ${r.n}${r.n >= 4 ? " (ban)" : "/3"}`).join("\n") : "ဘယ်သူမှ မရှိပါ ✅") +
            "\n\nတစ်ယောက်ချင်းကြည့်ရန်: member စာကို reply ပြီး <code>/warns</code>",
          5 * 60 * 1000
        );
        return true;
      }
      const n = Number(await env.STATE.get(skey(t.id)).catch(() => 0)) || 0;
      const status = n === 0 ? "မရှိပါ ✅" : n >= 4 ? `${n} — ⛔ ban ခံထားရပြီး` : n === 3 ? "3/3 — 🚫 mute လုပ်ခံထားရပြီး" : `${n}/3`;
      await say(`⚠️ ${link(t)}\nသတိပေးချက်: <b>${status}</b>` + (n ? "\n\n(နောက်ဆုံး strike ကနေ ၂၄ နာရီကြာရင် အလိုလို ပျောက်ပါမယ်)" : ""), 5 * 60 * 1000);
      return true;
    }

    if (!t) {
      await usage(howTo);
      return true;
    }
    const before = Number(await env.STATE.get(skey(t.id)).catch(() => 0)) || 0;

    if (cmd === "unwarn") {
      if (!before) {
        await say(`ℹ️ ${link(t)} မှာ strike မရှိပါ`, 2 * 60 * 1000);
        return true;
      }
      const all = /\b(all|အကုန်)\b/i.test(arg);
      const after = all ? 0 : before - 1;
      STRIKES.delete(skey(t.id)); MUTED.delete(skey(t.id));
      await env.STATE.delete("mu:" + skey(t.id)).catch(() => {});
      if (after <= 0) await env.STATE.delete(skey(t.id)).catch(() => {});
      else await env.STATE.put(skey(t.id), String(after), { expirationTtl: STRIKE_TTL_S }).catch(() => {});
      let unmuted = false;
      if (before === 3 && after < 3) {   // 3rd strike = mute -> lift it too
        const r = await tg(env, "restrictChatMember", { chat_id: chat, user_id: t.id, permissions: await openPerms(env, chat) }).catch(() => null);
        unmuted = !!r?.ok;
      }
      await say(
        `✅ ${link(t)} ရဲ့ strike ${all ? "အကုန်" : "၁ ခု"} ဖယ်ပေးပြီးပါပြီ — ကျန် ${Math.max(after, 0)}/3` +
          (unmuted ? "\n🔓 Mute လည်း ဖြေပေးပြီး" : "") +
          (before >= 4 ? "\n⛔ Ban ခံထားရင် <code>/unban</code> သုံးပါ" : ""),
        2 * 60 * 1000
      );
      return true;
    }

    // unban: lift a ban (the member can join again) + lift a mute + clear the strikes
    const r = await tg(env, "unbanChatMember", { chat_id: chat, user_id: t.id, only_if_banned: true }).catch(() => null);
    if (!r?.ok) {
      await say(`⚠️ Unban မလုပ်နိုင်ပါ${r?.description ? ": " + esc(r.description) : ""}\nBot ကို admin (Ban users အခွင့်အရေး) ပေးထားလား စစ်ပါ။`, 2 * 60 * 1000);
      return true;
    }
    await env.STATE.delete(skey(t.id)).catch(() => {});
    if (before >= 3) await tg(env, "restrictChatMember", { chat_id: chat, user_id: t.id, permissions: await openPerms(env, chat) }).catch(() => {});
    await say(`✅ ${link(t)} ကို Ban / Mute ဖြေပြီး strike ရှင်းပေးပါပြီ\n(Ban ခံထားရင် group ကို ပြန်ဝင်လို့ရပါပြီ)`, 2 * 60 * 1000);
    return true;
  }

  // ----- settings (owner): /set /settings -----
  if (cmd === "set" || cmd === "settings") {
    const parts = arg.split(/\s+/);
    const k = (parts[0] || "").toLowerCase();
    const val = parts.slice(1).join(" ").trim();
    const curv = (key) => (S[key] !== undefined && S[key] !== "" ? S[key] : SETTINGS[key][1]);
    if (!k || !SETTINGS[k]) {
      await say(
        "⚙️ <b>Settings</b>\n\n" +
          Object.keys(SETTINGS).map((key) => `• <code>${key}</code> = <b>${esc(curv(key) || "-")}</b>\n   ${esc(SETTINGS[key][0])}`).join("\n") +
          "\n\nပြောင်းရန်: <code>/set rate 5</code>\nမူလပြန်: <code>/set rate reset</code>"
      );
      return true;
    }
    if (!val) {
      await usage(`<b>${k}</b> — ${esc(SETTINGS[k][0])}\nလက်ရှိ: <code>${esc(curv(k) || "-")}</code>\n${esc(SETTINGS[k][3])}`);
      return true;
    }
    const isReset = val.toLowerCase() === "reset";
    const ns = isReset ? undefined : parseSetting(k, val);
    if (!isReset && ns === null) {
      await usage(`⚠️ တန်ဖိုး မမှန်ပါ\n${esc(SETTINGS[k][3])}`);
      return true;
    }
    await saveCfg(env, (c) => { if (isReset) delete c[k]; else c[k] = ns; });
    await say(`✅ <b>${k}</b> = <code>${esc(isReset ? (SETTINGS[k][1] || "-") + " (မူလ)" : ns || "-")}</code>`, 2 * 60 * 1000);
    return true;
  }

  // ----- maintenance (owner) -----
  if (cmd === "maint") {
    const sub = arg.split(/\s+/)[0].toLowerCase();
    if (sub === "on") {
      const ms = cmdSource(m);
      const off2 = ms.start + (ms.raw.slice(ms.start).match(/^on\s*/i) || [""])[0].length;
      const msg = ms.raw.length > off2 ? richHtml(ms.raw, ms.ents, off2, 500) : "";
      await saveCfg(env, (c) => { c.maint = "on"; if (msg) c.maintMsg = msg; else delete c.maintMsg; });
      await say("🛠 <b>Maintenance ဖွင့်လိုက်ပါပြီ</b> (Owner က စမ်းလို့ရသေးတယ်)\nMember တွေကို ပြမယ့်စာ:\n\n" + tplHtml(S.maintMsg || DEFAULT_MAINT), 2 * 60 * 1000);
    } else if (sub === "off") {
      await saveCfg(env, (c) => { c.maint = "off"; });
      await say("✅ Maintenance ပိတ်လိုက်ပါပြီ၊ Bot ပုံမှန်ပြန်အလုပ်လုပ်ပါပြီ", 2 * 60 * 1000);
    } else {
      const downs = [];
      for (const p of ["G2Bulk", "FazerCards"]) if (await isDown(p)) downs.push(p);
      await usage(
        `🛠 Maintenance: <b>${S.maint === "on" ? "ဖွင့်ထား" : "ပိတ်ထား"}</b>\n` +
          (downs.length ? `🚨 Provider ကျနေတာ: ${downs.join(", ")} (အလိုလို maintenance စာ ပြနေပါတယ်)\n` : "✅ Provider နှစ်ခုလုံး ကောင်းပါတယ်\n") +
          "\n<code>/maint on စာသား</code> · <code>/maint off</code>"
      );
    }
    return true;
  }

  // ----- game short names -----
  if (cmd === "addalias" || cmd === "delalias" || cmd === "aliases") {
    if (cmd === "aliases") {
      const al = S.aliases || {};
      const keys = Object.keys(al);
      await say(
        "🎮 <b>Game အတိုကောက်</b>\n\nမိမိထည့်ထားတာ:\n" + (keys.length ? keys.map((x) => `<code>${esc(x)}</code> → ${esc(al[x])}`).join("\n") : "မရှိသေးပါ") +
          "\n\nBuilt-in: " + Object.keys(ALIASES).join(" · ") + "\n\n<code>/addalias sm = sausage man</code>\n<code>/delalias sm</code>"
      );
      return true;
    }
    if (cmd === "delalias") {
      const key = arg.toLowerCase();
      if (!key || !(S.aliases || {})[key]) {
        await usage("ဖျက်လို့မရပါ။ <code>/aliases</code> နဲ့ စာရင်းကြည့်ပါ။");
        return true;
      }
      await saveCfg(env, (c) => { c.aliases = { ...(c.aliases || {}) }; delete c.aliases[key]; });
      await say(`✅ <code>${esc(key)}</code> ဖျက်ပြီးပါပြီ`, 2 * 60 * 1000);
      return true;
    }
    const am = arg.match(/^(\S+?)\s*(?:=|\s)\s*(.+)$/);
    const key = am ? am[1].toLowerCase() : "";
    const val = am ? am[2].trim().toLowerCase() : "";
    if (!/^[\p{L}\p{N}]{2,15}$/u.test(key) || !val) {
      await usage("ဥပမာ: <code>/addalias sm = sausage man</code>\n(= နောက်က Store ထဲက game နာမည်ရဲ့ တစ်စိတ်တစ်ပိုင်း)");
      return true;
    }
    const hit = (await loadGroups(env)).filter((g) => g.key.includes(val));
    if (!hit.length) {
      await usage(`⚠️ <b>${esc(val)}</b> နဲ့ ကိုက်တဲ့ game မတွေ့ပါ။ Store ထဲက နာမည်အတိုင်း ပြန်ရိုက်ပါ။`);
      return true;
    }
    await saveCfg(env, (c) => { c.aliases = { ...(c.aliases || {}), [key]: val }; });
    await say(`✅ <code>${esc(key)}</code> → ${esc(hit.slice(0, 5).map((g) => g.name).join(", "))}`, 2 * 60 * 1000);
    return true;
  }

  // ----- premium emoji on the buttons (owner) -----
  if (cmd === "seticon") {
    const MAP = { copy: "ICON_COPY", done: "ICON_DONE", reject: "ICON_REJECT", store: "ICON_STORE" };
    const which = arg.split(/\s+/)[0].toLowerCase();
    const key = MAP[which];
    const ce = [...(m.entities || []), ...(m.reply_to_message?.entities || [])].find((e) => e.type === "custom_emoji" && e.custom_emoji_id);
    const off = /\boff\b/i.test(arg.slice(which.length));
    if (!key || (!off && !ce)) {
      const cur = S.icons || {};
      await usage(
        "💎 <b>Button icon</b>\nလက်ရှိ: " + Object.keys(MAP).map((w) => `${w} ${cur[MAP[w]] ? "✅" : "—"}`).join(" · ") +
          "\n\n<code>/seticon copy 💎</code> (copy | done | reject | store + premium emoji)\n<code>/seticon copy off</code>\nEmoji ID ကြည့်ရန် <code>/emojiid</code>\n(Bot owner မှာ Telegram Premium လိုပါတယ်)"
      );
      return true;
    }
    await saveCfg(env, (c) => { c.icons = { ...(c.icons || {}) }; if (off) delete c.icons[key]; else c.icons[key] = ce.custom_emoji_id; });
    await say(off ? `✅ ${which} icon ဖယ်ပြီးပါပြီ` : `✅ ${which} button icon ထည့်ပြီးပါပြီ (Card အသစ်တွေကနေ စပြပါမယ်)`, 2 * 60 * 1000);
    return true;
  }

  // ----- lock / unlock the group -----
  if (cmd === "lock" || cmd === "unlock") {
    if (!isGroup) {
      await usage("⚠️ ဒီ command ကို Group ထဲမှာ သုံးပါ။");
      return true;
    }
    const bad = (r) => say(`⚠️ မအောင်မြင်ပါ${r?.description ? ": " + esc(r.description) : ""}\nBot ကို admin (Ban users အခွင့်အရေး) ပေးထားလား စစ်ပါ။`, 2 * 60 * 1000);
    if (cmd === "unlock") {
      const r = await doUnlock(env, chat);
      if (!r?.ok) { await bad(r); return true; }
      await send({ ...env, replyTo: 0 }, chat, "🔓 Group ပြန်ဖွင့်ပါပြီ၊ စာပို့လို့ရပါပြီ");
      return true;
    }
    const lm = arg.match(/^(\d{1,4})(?:\s+([\s\S]+))?$/);
    const mins = lm ? Number(lm[1]) : 0;
    const note = (lm ? lm[2] || "" : arg).trim().slice(0, 300);
    const prior = await env.STATE.get(`lock:${chat}`, "json").catch(() => null);
    const prev = prior?.perms || (await openPerms(env, chat));   // already locked -> keep the original permissions
    const r = await tg(env, "setChatPermissions", { chat_id: chat, permissions: NO_PERMS }).catch(() => null);
    if (!r?.ok) { await bad(r); return true; }
    const at = Date.now();
    await env.STATE.put(`lock:${chat}`, JSON.stringify({ perms: prev, at }));
    if (mins) await env.STATE.put(`unl:${String(at + mins * 60000).padStart(14, "0")}:${chat}`, String(at), { expirationTtl: mins * 60 + 86400 });
    await send({ ...env, replyTo: 0 }, chat, `🔒 <b>Group ကို ခဏပိတ်ထားပါတယ်</b>${mins ? ` (${mins} မိနစ်)` : ""}${note ? `\n${esc(note)}` : ""}\n(Admin တွေပဲ စာပို့လို့ရပါတယ်)`);
    return true;
  }

  // ----- hide / show a game for name check (owner) -----
  if (cmd === "hidegame" || cmd === "showgame") {
    const hidden = S.hidden || [];
    if (!arg) {
      await usage("🙈 <b>ပိတ်ထားတဲ့ game</b>\n" + (hidden.length ? hidden.map(esc).join("\n") : "မရှိပါ") + "\n\n<code>/hidegame mobile legends</code> · <code>/showgame mobile legends</code>");
      return true;
    }
    if (cmd === "hidegame") {
      const found = findGroups(await loadGroups(env), arg);
      if (found.length !== 1) {
        await usage(found.length ? "Game များနေပါတယ်၊ နာမည်အပြည့်ပေးပါ:\n" + found.slice(0, 8).map((g) => esc(g.name)).join("\n") : "Game မတွေ့ပါ။");
        return true;
      }
      await saveCfg(env, (c) => { c.hidden = [...new Set([...(c.hidden || []), found[0].key])]; });
      CACHE = { t: 0, groups: null };
      await say(`🙈 <b>${esc(found[0].name)}</b> ကို name check မှာ ပိတ်လိုက်ပါပြီ\nပြန်ဖွင့်ရန် <code>/showgame ${esc(found[0].key)}</code>`, 2 * 60 * 1000);
    } else {
      const q = arg.toLowerCase();
      const hit = hidden.filter((k) => k === q || k.includes(q));
      if (hit.length !== 1) {
        await usage(hit.length ? "နာမည်အပြည့်ပေးပါ:\n" + hit.map(esc).join("\n") : "ပိတ်ထားတဲ့ စာရင်းထဲ မတွေ့ပါ။ <code>/hidegame</code> နဲ့ ကြည့်ပါ။");
        return true;
      }
      await saveCfg(env, (c) => { c.hidden = (c.hidden || []).filter((k) => k !== hit[0]); });
      CACHE = { t: 0, groups: null };
      await say(`✅ <b>${esc(hit[0])}</b> ပြန်ဖွင့်ပြီးပါပြီ`, 2 * 60 * 1000);
    }
    return true;
  }

  // ----- groups list + announce to every group (owner, private chat only) -----
  if (cmd === "groups" || cmd === "announce") {
    const l = await env.STATE.list({ prefix: "grp:", limit: 200 });
    const gl = await Promise.all(l.keys.map(async (k) => ({ id: k.name.slice(4), title: (await env.STATE.get(k.name).catch(() => "")) || "" })));
    if (cmd === "groups") {
      await say("👥 <b>Bot သုံးနေတဲ့ group</b> (" + gl.length + ")\n\n" + (gl.length ? gl.map((x) => `• ${esc(x.title || "?")} <code>${esc(x.id)}</code>`).join("\n") : "မရှိသေးပါ (group ထဲမှာ စာတစ်ခု ပေါ်မှ မှတ်ပါတယ်)"), 5 * 60 * 1000);
      return true;
    }
    if (isGroup) {
      await usage("⚠️ <code>/announce</code> ကို Bot နဲ့ private chat မှာပဲ သုံးပါ။");
      return true;
    }
    const as = cmdSource(m);
    if (!arg) {
      await usage("ဥပမာ: <code>/announce ဒီည ၁၀ နာရီ ပိတ်ပါမယ်</code>\nBot သုံးနေတဲ့ group အားလုံးဆီ ပို့ပါမယ် (<code>/groups</code> နဲ့ စာရင်းကြည့်)");
      return true;
    }
    const html = tplHtml(richHtml(as.raw, as.ents, as.start, 1500));
    let ok = 0, fail = 0;
    for (const g of gl) {
      const r = await tg(env, "sendMessage", { chat_id: g.id, text: html, parse_mode: "HTML" }).catch(() => null);
      if (r?.ok) ok++; else fail++;
    }
    await say(`📣 ပို့ပြီးပါပြီ — ✅ ${ok} group${fail ? ` · ❌ ${fail} (Bot ကို ထုတ်ထားတာ/ခွင့်မရှိတာ)` : ""}`, 5 * 60 * 1000);
    return true;
  }

  // ----- daily summary now -----
  if (cmd === "summary") {
    await say(/^week$/i.test(arg) ? await buildWeek(env) : await buildSummary(env, /^\d{1,2}$/.test(arg) ? Math.min(Number(arg), 29) : 0), 5 * 60 * 1000);
    return true;
  }

  // ----- your own commands -----
  if (cmd === "addcmd" || cmd === "delcmd" || cmd === "cmds") {
    const list = S.cmds || {};
    if (cmd === "cmds") {
      const names = Object.keys(list);
      await say("➕ <b>Command အသစ်များ</b>\n\n" + (names.length ? names.map((n) => `<code>/${esc(n)}</code> → ${esc(plainTpl(list[n]).slice(0, 60))}`).join("\n") : "မရှိသေးပါ") + "\n\n<code>/addcmd rules | စာသား</code>\n<code>/delcmd rules</code>");
    } else if (cmd === "addcmd") {
      const [np, ...rest] = arg.split("|");
      const name = (np || "").trim().toLowerCase().replace(/^\//, "");
      if (!/^[a-z0-9_]{2,20}$/.test(name) || !rest.join("|").trim()) {
        await usage("ဥပမာ: <code>/addcmd rules | Group စည်းကမ်းတွေ ဒီမှာ</code>\n(နာမည်က English စာလုံး/ဂဏန်း ၂-၂၀ လုံး)");
        return true;
      }
      if (RESERVED_CMDS.includes(name) || (!list[name] && Object.keys(list).length >= 30)) {
        await usage(RESERVED_CMDS.includes(name) ? "ဒီနာမည်ကို Bot က သုံးပြီးသားပါ၊ တခြားနာမည်ပေးပါ။" : "Command ၃၀ ခုထက် မထည့်နိုင်ပါ။");
        return true;
      }
      const cs = cmdSource(m);
      let at = cs.raw.indexOf("|", cs.start) + 1;
      while (at < cs.raw.length && /\s/.test(cs.raw[at])) at++;
      const html = richHtml(cs.raw, cs.ents, at, 1500);
      await saveCfg(env, (c) => { c.cmds = { ...(c.cmds || {}), [name]: html }; });
      await say(`✅ <code>/${esc(name)}</code> ထည့်ပြီးပါပြီ`, 2 * 60 * 1000);
    } else {
      const name = arg.toLowerCase().replace(/^\//, "");
      if (!name || !list[name]) {
        await usage("ဖျက်လို့မရပါ။ <code>/cmds</code> နဲ့ စာရင်းကြည့်ပါ။");
        return true;
      }
      await saveCfg(env, (c) => { c.cmds = { ...(c.cmds || {}) }; delete c.cmds[name]; });
      await say(`✅ <code>/${esc(name)}</code> ဖျက်ပြီးပါပြီ`, 2 * 60 * 1000);
    }
    return true;
  }

  // ----- rude words -----
  if (cmd === "words") {
    const custom = await customBad(env);
    await say(
      `🧹 <b>Rude word filter</b>\nBuilt-in: ${DEFAULT_BAD.length} ခု\nထပ်ထည့်ထားတာ: ${custom.length} ခု` +
        (custom.length ? "\n" + custom.map(esc).join(", ") : "") +
        "\n\n<code>/addword စာလုံး, စာလုံး</code>\n<code>/delword စာလုံး</code>"
    );
    return true;
  }
  if (cmd === "addword" || cmd === "delword") {
    const items = arg.split(/[,\n]+/).map((x) => x.trim().toLowerCase()).filter((x) => x && x.length <= 40);
    if (!items.length) {
      await usage(`ဥပမာ: <code>/${cmd} စာလုံး, စာလုံး</code>`);
      return true;
    }
    const cur = await customBad(env);
    const list = cmd === "addword" ? [...new Set([...cur, ...items])].slice(0, 300) : cur.filter((x) => !items.includes(x));
    await env.STATE.put("cfg:badwords", JSON.stringify(list));
    BAD = { t: 0, list: [] };
    if (isGroup) await tg(env, "deleteMessage", { chat_id: chat, message_id: m.message_id }).catch(() => {}); // keep the word out of the chat
    await say(cmd === "addword" ? `✅ စာလုံး ${items.length} ခု ထည့်ပြီးပါပြီ (စုစုပေါင်း ${list.length})` : `✅ ဖယ်ပြီးပါပြီ (ကျန်တာ ${list.length})`, 60 * 1000);
    return true;
  }

  // ----- FAQ auto-reply -----
  // ----- Payment auto-reply editing: /paymsg /payword /delpayword /paywords -----
  if (cmd === "paymsg" || cmd === "payword" || cmd === "delpayword" || cmd === "paywords") {
    if (cmd === "paywords") {
      const pw = Object.entries(S.payWords || {});
      await say(
        "💳 <b>Payment auto-reply</b> — " + (S.pay === "off" ? "🔴 ပိတ်ထား" : "🟢 ဖွင့်ထား") + "\n\n" +
          (pw.length ? pw.map(([k, w]) => `• <code>${esc(k)}</code> ← ${esc((w || []).join(", "))}`).join("\n") : "ထပ်ထည့်ထားတဲ့ keyword မရှိပါ") +
          "\n\n<b>အောက်က စာ (ကတ်အောက်မှာ ထပ်ပြ):</b>\n" + (S.payMsg ? tplHtml(S.payMsg) : "မရှိပါ") +
          "\n\n<code>/payword kpay = ကေပေး, kbzpay</code>\n<code>/delpayword kpay</code>\n<code>/paymsg လွှဲပြီး receipt ပို့ပါ</code> (ဖျက်ရန် <code>/paymsg off</code>)\n<code>/set pay on|off</code>"
      );
      return true;
    }
    if (cmd === "paymsg") {
      if (!arg) { await usage("ဥပမာ: <code>/paymsg လွှဲပြီးရင် receipt ပို့ပါ</code>\nဖျက်ရန်: <code>/paymsg off</code>"); return true; }
      if (arg.toLowerCase() === "off") {
        await saveCfg(env, (c) => { delete c.payMsg; });
        await say("✅ Payment ကတ်အောက်က စာ ဖျက်ပြီးပါပြီ", 2 * 60 * 1000);
        return true;
      }
      const ms = cmdSource(m);
      const html = richHtml(ms.raw, ms.ents, ms.start, 500);
      await saveCfg(env, (c) => { c.payMsg = html; });
      await say("✅ Payment ကတ်အောက်မှာ ဒီစာ ပေါ်ပါမယ်:\n\n" + tplHtml(html), 2 * 60 * 1000);
      return true;
    }
    if (cmd === "payword") {
      const [kp, ...rest] = arg.split("=");
      const key = (kp || "").trim().toLowerCase();
      const words = rest.join("=").split(",").map((x) => x.trim().toLowerCase()).filter((x) => x && x.length <= 40);
      if (!key || key.length > 30 || !words.length) {
        await usage("ဥပမာ:\n<code>/payword kpay = ကေပေး, kbzpay, kpay နံပါတ်</code>\n(နာမည်က Store ထဲက payment method နာမည်ရဲ့ တစ်စိတ်၊ keyword တွေကို , နဲ့ခြား)");
        return true;
      }
      await saveCfg(env, (c) => {
        const cur = c.payWords && typeof c.payWords === "object" ? c.payWords : {};
        cur[key] = [...new Set([...(cur[key] || []), ...words])].slice(0, 30);
        c.payWords = cur;
      });
      await say(`✅ <code>${esc(key)}</code> ← ${esc(words.join(", "))}`, 2 * 60 * 1000);
      return true;
    }
    const key = arg.trim().toLowerCase();
    const had = !!(S.payWords || {})[key];
    if (key && had) await saveCfg(env, (c) => { if (c.payWords) delete c.payWords[key]; });
    await say(!key ? "ဥပမာ: <code>/delpayword kpay</code>" : had ? `🗑 <code>${esc(key)}</code> keyword တွေ ဖျက်ပြီးပါပြီ` : `ℹ️ <code>${esc(key)}</code> မရှိပါ`, 2 * 60 * 1000);
    return true;
  }

  if (cmd === "addfaq" || cmd === "delfaq" || cmd === "faqs") {
    const list = [...(await getFaq(env))];
    const save = async (l) => {
      await env.STATE.put("cfg:faq", JSON.stringify(l));
      FAQ = { t: 0, list: [] };
    };
    if (cmd === "faqs") {
      await say(
        "💬 <b>FAQ auto-reply</b>\n\n" +
          (list.length ? list.map((f, i) => `${i + 1}. <code>${esc(f.k.join(", "))}</code>\n→ ${esc(plainTpl(f.a).slice(0, 80))}${plainTpl(f.a).length > 80 ? "…" : ""}`).join("\n\n") : "မရှိသေးပါ") +
          "\n\n<code>/addfaq ဈေး, price | အဖြေစာသား</code>\n<code>/delfaq ဈေး</code>"
      );
    } else if (cmd === "addfaq") {
      const [kp, ...rest] = arg.split("|");
      const answer = rest.join("|").trim();
      const k = (kp || "").split(",").map((x) => x.trim().toLowerCase()).filter((x) => x && x.length <= 40);
      if (!k.length || !answer) {
        await usage("ဥပမာ:\n<code>/addfaq ဈေး, price | Diamond ဈေးတွေကို Store မှာ ကြည့်ပါ</code>\n\n(keyword တွေကို , နဲ့ ခြား၊ | နောက်က အဖြေ)");
        return true;
      }
      const fs = cmdSource(m);
      let at = fs.raw.indexOf("|", fs.start) + 1;
      while (at < fs.raw.length && /\s/.test(fs.raw[at])) at++;
      list.push({ k, a: richHtml(fs.raw, fs.ents, at, 1500) });
      await save(list.slice(-100));
      await say(`✅ FAQ ထည့်ပြီးပါပြီ (စုစုပေါင်း ${Math.min(list.length, 100)})\n<code>${esc(k.join(", "))}</code>`, 2 * 60 * 1000);
    } else {
      const q = arg.toLowerCase();
      const n = /^\d+$/.test(q) ? Number(q) : 0;
      const left = list.filter((f, i) => !(n ? i + 1 === n : f.k.includes(q)));
      if (!q || left.length === list.length) {
        await usage("ဖျက်လို့ မရပါ။ <code>/faqs</code> နဲ့ စာရင်းကြည့်ပြီး keyword (သို့) နံပါတ်ပေးပါ။");
        return true;
      }
      await save(left);
      await say(`✅ ဖျက်ပြီးပါပြီ (ကျန်တာ ${left.length})`, 2 * 60 * 1000);
    }
    return true;
  }

  // ----- store link, "order done" message -----
  if (cmd === "setstore") {
    if (arg.toLowerCase() === "off") {
      await env.STATE.delete("cfg:store");
      STORE = { t: 0, v: "" };
      await say("🔕 Store ခလုတ် ပိတ်လိုက်ပါပြီ", 60 * 1000);
    } else if (/^https?:\/\/\S+$/i.test(arg)) {
      await env.STATE.put("cfg:store", arg);
      STORE = { t: 0, v: "" };
      await say(`✅ Store link ထည့်ပြီးပါပြီ\n${esc(arg)}`, 2 * 60 * 1000);
    } else {
      await usage("ဥပမာ: <code>/setstore https://your-store.com</code>\nပိတ်ရန်: <code>/setstore off</code>\n\nလက်ရှိ: " + (esc(await getStore(env)) || "မထည့်ရသေးပါ"));
    }
    return true;
  }
  if (cmd === "setdone") {
    if (arg.toLowerCase() === "reset") {
      await env.STATE.delete("cfg:done");
      await say("♻️ မူလ စာပြန်ထားပါပြီ\n\n" + renderWelcome(DEFAULT_DONE, [m.from], m.chat.title), 2 * 60 * 1000);
    } else if (!arg) {
      await usage("<b>လက်ရှိ</b>\n" + renderWelcome(await getDoneText(env), [m.from], m.chat.title) + "\n\n<code>/setdone {mention} order ပြီးပါပြီ ✅</code>\n<code>/setdone reset</code>");
    } else {
      const ds = cmdSource(m);
      const rich = richHtml(ds.raw, ds.ents, ds.start, 500);
      await env.STATE.put("cfg:done", rich);
      await say("✅ ပြောင်းပြီးပါပြီ\n\n" + renderWelcome(rich, [m.from], m.chat.title), 2 * 60 * 1000);
    }
    return true;
  }

  // ----- welcome + captcha (per group in a group, default in private chat) -----
  const wkey = isGroup ? "w:" + chat : "w:default";
  const wchat = isGroup ? chat : "default";
  const cur = (await env.STATE.get(wkey, "json").catch(() => null)) || {};
  const save = (o) => env.STATE.put(wkey, JSON.stringify(o));
  const preview = async () => renderWelcome((await getWelcome(env, wchat)).text, [m.from], m.chat.title);
  const where = isGroup ? "" : " (group အားလုံးအတွက် default)";
  if (cmd === "captcha") {
    const sub = arg.toLowerCase();
    if (sub !== "on" && sub !== "off") {
      const w = await getWelcome(env, wchat);
      await usage(`🔒 Captcha: <b>${w.nocaptcha ? "ပိတ်ထား" : "ဖွင့်ထား"}</b>${where}\n<code>/captcha on</code> · <code>/captcha off</code>\n\nBot ကို admin (Ban users အခွင့်အရေး) ပေးထားမှ အလုပ်လုပ်ပါမယ်။`);
      return true;
    }
    await save({ ...cur, nocaptcha: sub === "off" });
    await say(sub === "off" ? `🔓 Captcha ပိတ်လိုက်ပါပြီ${where}` : `🔒 Captcha ဖွင့်လိုက်ပါပြီ${where}`, 60 * 1000);
    return true;
  }
  if (cmd === "setwelcome") {
    const rt = m.reply_to_message;
    let rich = "";
    if (arg) {
      const ws = cmdSource(m);
      rich = richHtml(ws.raw, ws.ents, ws.start, 1500);
    } else if (rt && (rt.text || rt.caption)) {
      rich = richHtml(rt.text || rt.caption, (rt.text ? rt.entities : rt.caption_entities) || [], 0, 1500);
    }
    if (!rich) {
      await usage(WELCOME_USAGE);
      return true;
    }
    await save({ ...cur, text: rich, off: false });
    await say(`✅ Welcome message ပြောင်းပြီးပါပြီ${where}\n\n` + (await preview()), 2 * 60 * 1000);
    return true;
  }
  const sub = arg.toLowerCase();
  if (sub === "off" || sub === "on") {
    await save({ ...cur, off: sub === "off" });
    await say(sub === "off" ? `🔕 Welcome message ပိတ်လိုက်ပါပြီ${where}` : `🔔 Welcome message ဖွင့်လိုက်ပါပြီ${where}`, 60 * 1000);
  } else if (sub === "reset") {
    await save({ off: !!cur.off, nocaptcha: !!cur.nocaptcha });
    await say(`♻️ မူလ Welcome message ပြန်ထားပါပြီ${where}\n\n` + (await preview()), 2 * 60 * 1000);
  } else {
    const w = await getWelcome(env, wchat);
    await say("👀 <b>လက်ရှိ Welcome message</b>" + (w.off ? " (ပိတ်ထား)" : "") + where + "\n\n" + (await preview()) + "\n\n" + WELCOME_USAGE);
  }
  return true;
}

/* ---------- Post composer (owner, private chat): everything is a button ---------- */
// Main menu (reply keyboard, always visible): Post / Schedule list / Sent posts / Templates / Channels / Help.
// Post flow: pick targets (inline toggles) -> send content (text / photo / video / file, or 📸 Album) -> menu:
//   link buttons + colors, Pin, Silent, Link preview, Template save, Preview, post now / schedule (+ repeat).
// Sent posts can be edited later: text / caption, replace the photo-video-file (editMessageMedia), add / replace / delete / recolor link buttons.
// State lives in KV "pst:<uid>"; scheduled posts "sch:<time>:<id>"; sent posts "sent:<time>:<id>" (30 days, for edit / delete / pin);
// templates "tpl:<id>"; album parts "alb:<uid>:<message>"; channels "chn:<id>" (register by forwarding a channel post to the bot).
const PL = {
  add: "➕ Button ထည့်", store: "🏪 Store button", clr: "🧹 Button ရှင်း", prev: "👀 Preview", test: "🧪 Test (ကိုယ့်ဆီပို့)", color: "🎨 Button Color",
  now: "✅ ယခုတင်", later: "⏰ အချိန်ခွဲတင်", cancel: "❌ ပယ်ဖျက်", back: "⬅️ Back",
  redo: "🔄 Content ပြန်ပို့", album: "📸 Album", done: "✔️ ပြီးပြီ", tpl: "💾 Template သိမ်း",
};
const ML = { new: "📝 Post တင်ရန်", list: "⏰ Schedule စာရင်း", sent: "🗂 တင်ပြီးသား Post", tpl: "📋 Templates", chn: "📢 Channels", help: "ℹ️ အကူအညီ" };
const POST_HELP_TEXT =
  "ℹ️ <b>Post တင်နည်း</b>\n\n1️⃣ <b>" + ML.new + "</b> နှိပ် → နေရာရွေး → စာ/ပုံ/video ပို့\n2️⃣ ခလုတ်တွေနဲ့ စီမံ — Button + 🎨 Color၊ 📌 Pin၊ 🔔 Silent၊ 🔗 Link preview၊ 📸 Album၊ 💾 Template\n3️⃣ 👀 Preview ကြည့်ပြီး ✅ ယခုတင် (သို့) ⏰ အချိန်ခွဲတင် (နေ့တိုင်း/အပတ်တိုင်း repeat ရ)\n\n" +
        "🗂 <b>တင်ပြီးသား Post</b> — ✏️ စာပြင် / 🖼 ပုံ-video ပြောင်း / 🔘 Button ထည့်-ပြင်-ဖျက်-color / ဖျက် / Pin / Unpin\n📋 <b>Templates</b> — သိမ်းထားတာ တစ်ချက်နှိပ်ပြီး ပြန်သုံး\n\n📢 Channel အသစ်: Bot ကို channel မှာ admin လုပ်ရုံ (သို့) 📢 Channels ထဲက ➕ ခလုတ်နဲ့ @username ထည့်\n👥 Group တွေက အလိုလိုမှတ်ပါတယ်";
const WL = { h1: "⏰ +1 နာရီ", h3: "⏰ +3 နာရီ", night: "🌙 ည ၉ နာရီ", morn: "🌅 မနက် ၉ နာရီ" };
const RPL = { once: "1️⃣ တစ်ခါတည်း", daily: "🔁 နေ့တိုင်း", weekly: "🔁 အပတ်တိုင်း" };
const PERIOD = { daily: 86400e3, weekly: 7 * 86400e3 };
const COLORS = {
  blue: { label: "🔵 အပြာ", style: "primary" }, green: { label: "🟢 အစိမ်း", style: "success" },
  red: { label: "🔴 အနီ", style: "danger" }, none: { label: "⚪ မူလ", style: "" },
};
// "green" / "အစိမ်း" / "success" ... -> button style (or "" when not a color word)
const colorOf = (w) => {
  const x = String(w || "").trim().toLowerCase();
  if (/^(blue|primary|အပြာ)$/.test(x)) return "primary";
  if (/^(green|success|အစိမ်း)$/.test(x)) return "success";
  if (/^(red|danger|အနီ)$/.test(x)) return "danger";
  return "";
};
const onoff = (b) => (b ? "✅" : "⬜");
const kb = (rows) => ({ keyboard: rows, resize_keyboard: true });
const mainKb = () => ({
  keyboard: [[{ text: ML.new, style: "success" }, { text: ML.list }], [{ text: ML.sent }, { text: ML.tpl }], [{ text: ML.chn }, { text: ML.help }]],
  resize_keyboard: true,
  is_persistent: true,
});
const NO_KB = mainKb();   // after a post is finished / cancelled the keyboard goes back to the main menu
const cancelKb = () => kb([[{ text: PL.cancel }]]);
const backKb = () => kb([[{ text: PL.back }]]);
const contentKb = () => kb([[{ text: PL.album }], [{ text: PL.back }]]);
const albumKb = () => kb([[{ text: PL.done, style: "success" }], [{ text: PL.back }]]);
const whenKb = () => kb([[{ text: WL.h1 }, { text: WL.h3 }], [{ text: WL.night }, { text: WL.morn }], [{ text: PL.back }]]);
const repKb = () => kb([[{ text: RPL.once, style: "success" }], [{ text: RPL.daily }, { text: RPL.weekly }], [{ text: PL.back }]]);
const colorKb = () => kb([[{ text: COLORS.blue.label, style: "primary" }, { text: COLORS.green.label, style: "success" }], [{ text: COLORS.red.label, style: "danger" }, { text: COLORS.none.label }], [{ text: PL.back }]]);
const postKb = (p) =>
  kb([
    [{ text: PL.add }, { text: PL.store }],
    [{ text: PL.color }, { text: PL.clr }],
    [{ text: `📌 Pin ${onoff(p.pin)}` }, { text: `🔔 Silent ${onoff(p.silent)}` }],
    [{ text: `🔗 Link preview ${onoff(!p.nopv)}` }, { text: PL.tpl }],
    [{ text: PL.redo }, { text: PL.album }],
    [{ text: PL.prev }, { text: PL.test, style: "primary" }],
    [{ text: PL.now, style: "success" }, { text: PL.later, style: "primary" }],
    [{ text: PL.back, style: "primary" }, { text: PL.cancel, style: "danger" }],
  ]);
const closeRow = () => [{ text: "❌ ပိတ်", callback_data: "pz:c", style: "danger" }];   // closes a list screen
const presetWhen = (t) =>
  t === WL.h1 ? Date.now() + 3600e3 : t === WL.h3 ? Date.now() + 3 * 3600e3 : t === WL.night ? parseWhen("21:00") : t === WL.morn ? parseWhen("09:00") : 0;
const newPost = () => ({ targets: [], html: "", media: null, album: [], btns: [], color: "", pin: false, silent: false, nopv: false });

async function listTargets(env) {
  const out = [];
  for (const [prefix, kind] of [["chn:", "📢"], ["grp:", "👥"]]) {
    const l = await env.STATE.list({ prefix, limit: 100 });
    for (const k of l.keys) out.push({ id: k.name.slice(4), kind, title: (await env.STATE.get(k.name).catch(() => "")) || k.name.slice(4) });
  }
  return out;
}
const targetKb = (targets, sel) => ({
  inline_keyboard: [
    ...targets.map((t) => [{ text: `${sel.includes(t.id) ? "✅" : "⬜"} ${t.kind} ${t.title}`.slice(0, 60), callback_data: `pt:${t.id}`, style: sel.includes(t.id) ? "success" : "primary" }]),
    [{ text: "☑️ အားလုံး", callback_data: "pt:all", style: "primary" }, { text: "▶️ ဆက်သွားမယ်", callback_data: "pt:ok", style: "success" }],
    [{ text: "❌ ပယ်ဖျက်", callback_data: "pz:x", style: "danger" }],
  ],
});
const TARGET_TEXT = "📝 <b>Post အသစ်</b>\n\nဘယ်ကိုတင်မလဲ ရွေးပါ (အများကြီးရွေးလို့ရ) 👇";
const CONTENT_TEXT = "✍️ Post ကို ပို့ပါ\n• စာသား (Bold / Quote / Premium emoji ပါ ရိုက်ထားတဲ့အတိုင်း)\n• ပုံ / video / file + caption\n• ပုံအများကြီးဆိုရင် <b>📸 Album</b> ခလုတ်ကို အရင်နှိပ်ပါ";

// Link buttons: one per row. Own color (b.c) wins over the post color; "" = Telegram default.
function postMarkup(post) {
  if (!post.btns || !post.btns.length) return undefined;
  return {
    inline_keyboard: post.btns.map((b) => {
      const style = b.c || post.color || "";
      return [{ text: b.t, url: b.u, ...(style ? { style } : {}) }];
    }),
  };
}
// "name | https://link" or "name | https://link | green", one button per line -> [{ t, u, c }]
function parseBtnLines(t) {
  const rows = [];
  for (const line of String(t || "").split("\n")) {
    const [name, url, col] = line.split("|").map((x) => x.trim());
    if (name && url && /^(https?|tg):\/\/\S+$/i.test(url)) rows.push({ t: name.slice(0, 40), u: url, c: colorOf(col) });
  }
  return rows;
}
const BTN_FORMAT_HINT = "⚠️ ပုံစံမမှန်ပါ။ တစ်ကြောင်းကို ခလုတ်တစ်ခု:\n<code>နာမည် | https://link</code>\n<code>နာမည် | https://link | green</code>";
const saveSent = (env, sk, rec) => env.STATE.put(`sent:${sk}`, JSON.stringify(rec), { expirationTtl: 30 * 86400 }).catch(() => {});
// Put the post's current buttons on every message already sent (an album cannot carry buttons, those are skipped).
async function applySentMarkup(env, rec) {
  const rm = postMarkup(rec.post) || { inline_keyboard: [] };   // empty keyboard = remove the buttons
  let ok = 0, skip = 0, err = "";
  for (const s of rec.sent) {
    if (s.m.length !== 1) { skip++; continue; }
    const r = await tg(env, "editMessageReplyMarkup", { chat_id: s.c, message_id: s.m[0], reply_markup: rm }).catch(() => null);
    if (r?.ok || /not modified/i.test(r?.description || "")) ok++; else err = err || r?.description || "";
  }
  return { ok, skip, err };
}
// Button editor screen of a sent post (list + add / replace / delete one / color / clear).
function btnPanel(rec, sk) {
  const b = rec.post.btns || [];
  const col = (Object.values(COLORS).find((c) => c.style === (rec.post.color || "")) || COLORS.none).label;
  const text =
    "🔘 <b>Button ပြင်ရန်</b>\n\n" +
    (b.length ? b.map((x, i) => `${i + 1}. ${esc(x.t)} → ${esc(x.u)}${x.c ? ` (${esc(x.c)})` : ""}`).join("\n") : "Button မရှိသေးပါ") +
    `\n\n🎨 Color: ${col}` +
    (rec.sent.some((s) => s.m.length > 1) ? "\n⚠️ Album ပါတဲ့နေရာမှာ Link button မရပါ (Telegram က Album မှာ button မခွင့်ပြုပါ)" : "");
  const rows = [
    [{ text: "➕ ထည့်", callback_data: `sa:badd:${sk}`, style: "success" }, { text: "🔄 အားလုံး အစားထိုး", callback_data: `sa:bset:${sk}`, style: "primary" }],
    ...b.map((x, i) => [{ text: `🗑 ${i + 1}. ${x.t}`.slice(0, 40), callback_data: `sa:bd${i}:${sk}`, style: "danger" }]),
    [
      { text: "🔵", callback_data: `sa:bcp:${sk}`, style: "primary" }, { text: "🟢", callback_data: `sa:bcg:${sk}`, style: "success" },
      { text: "🔴", callback_data: `sa:bcr:${sk}`, style: "danger" }, { text: "⚪", callback_data: `sa:bcn:${sk}` },
    ],
    [{ text: "🧹 Button အကုန်ရှင်း", callback_data: `sa:bx:${sk}`, style: "danger" }],
    closeRow(),
  ];
  return { text, rows };
}
// One copy of the post to one chat. -> { ok, ids, description }
async function sendPostTo(env, chat, post, preview = false) {
  const r = await sendPostRaw(env, chat, post, preview);
  if (preview && env.junk && r.ok) await junkPush(env, chat, r.ids);
  return r;
}
async function sendPostRaw(env, chat, post, preview = false) {
  const html = tplHtml(post.html || "");
  const common = { chat_id: chat, ...(post.silent && !preview ? { disable_notification: true } : {}) };
  const items = post.media ? [post.media, ...(post.album || [])] : [];
  let r;
  if (items.length > 1) {   // album: Telegram does not allow buttons on it
    r = await tg(env, "sendMediaGroup", {
      ...common,
      media: items.map((x, i) => ({ type: x.type, media: x.id, ...(i === 0 && html ? { caption: html, parse_mode: "HTML" } : {}) })),
    });
    return { ok: !!r?.ok, ids: (r?.result || []).map((x) => x.message_id), description: r?.description };
  }
  const rm = postMarkup(post);
  const base = { ...common, parse_mode: "HTML", ...(rm ? { reply_markup: rm } : {}) };
  if (post.media) {
    const M = { photo: "sendPhoto", video: "sendVideo", document: "sendDocument", animation: "sendAnimation" };
    r = await tg(env, M[post.media.type], { ...base, [post.media.type]: post.media.id, caption: html });
  } else {
    r = await tg(env, "sendMessage", { ...base, text: html, ...(post.nopv ? { link_preview_options: { is_disabled: true } } : {}) });
  }
  return { ok: !!r?.ok, ids: r?.result?.message_id ? [r.result.message_id] : [], description: r?.description };
}
async function publishPost(env, post) {
  const res = { ok: 0, bad: [], pinBad: [], sent: [] };
  for (const id of post.targets || []) {
    const r = await sendPostTo(env, id, post).catch(() => ({ ok: false }));
    if (!r.ok) { res.bad.push(`${id}${r.description ? " (" + r.description + ")" : ""}`); continue; }
    res.ok++;
    res.sent.push({ c: id, m: r.ids });
    if (post.pin && r.ids[0]) {
      const pr = await tg(env, "pinChatMessage", { chat_id: id, message_id: r.ids[0], disable_notification: true }).catch(() => null);
      if (!pr?.ok) res.pinBad.push(id);
    }
  }
  return res;
}
// Remember what was sent, so it can be edited / deleted / pinned later from "🗂 တင်ပြီးသား Post".
async function recordSent(env, post, res, by) {
  if (!res.sent.length) return;
  const { targets, ...rest } = post;
  const t = Date.now();
  const id = Math.random().toString(36).slice(2, 7);
  await env.STATE.put(`sent:${t}:${id}`, JSON.stringify({ t, by: by || 0, post: rest, sent: res.sent }), { expirationTtl: 30 * 86400 }).catch(() => {});
}
const postReport = (res) =>
  `✅ ${res.ok} နေရာ တင်ပြီးပါပြီ` +
  (res.bad.length ? `\n❌ ${res.bad.length} နေရာ မအောင်မြင်ပါ\n` + res.bad.map((x) => `• <code>${esc(x)}</code>`).join("\n") + "\n(Bot ကို admin + Post messages ခွင့်ပေးထားလား စစ်ပါ)" : "") +
  (res.pinBad.length ? `\n📌 ${res.pinBad.length} နေရာမှာ Pin မရပါ (Bot ကို Pin messages ခွင့်ပေးပါ)` : "");

// "HH:MM" (today, or tomorrow when already past) or "YYYY-MM-DD HH:MM", Myanmar time -> epoch ms (or 0).
function parseWhen(s) {
  const m = String(s).trim().match(/^(?:(\d{4})-(\d{1,2})-(\d{1,2})\s+)?(\d{1,2})[:.](\d{2})$/);
  if (!m) return 0;
  const h = Number(m[4]), mi = Number(m[5]);
  if (h > 23 || mi > 59) return 0;
  const off = 6.5 * 3600e3;
  const nowMM = new Date(Date.now() + off);
  let y = nowMM.getUTCFullYear(), mo = nowMM.getUTCMonth(), d = nowMM.getUTCDate();
  const dated = !!m[1];
  if (dated) { y = Number(m[1]); mo = Number(m[2]) - 1; d = Number(m[3]); }
  let at = Date.UTC(y, mo, d, h, mi) - off;
  if (!dated && at <= Date.now()) at += 86400e3;
  return at > Date.now() ? at : 0;
}
const whenLabel = (at) => { const s = mmDate(at); return `${s.slice(0, 10)} ${s.slice(11, 16)}`; };

async function sweepSched(env) {
  const now = Date.now();
  const l = await env.STATE.list({ prefix: "sch:", limit: 50 });
  for (const k of l.keys) {
    const [, at, id] = k.name.split(":");
    if (Number(at) > now) break;
    const post = await env.STATE.get(k.name, "json").catch(() => null);
    await env.STATE.delete(k.name).catch(() => {});   // delete first so overlapping sweeps send it once
    if (!post) continue;
    const res = await publishPost(env, post);
    await recordSent(env, post, res, post.by);
    let note = "";
    if (post.rep && PERIOD[post.rep]) {   // repeat: queue the next run (same id)
      let next = Number(at) + PERIOD[post.rep];
      while (next <= now) next += PERIOD[post.rep];
      await env.STATE.put(`sch:${String(next).padStart(14, "0")}:${id}`, JSON.stringify(post), { expirationTtl: Math.ceil((next - now) / 1000) + 7 * 86400 });
      note = `\n🔁 နောက်တစ်ကြိမ်: ${whenLabel(next)}`;
    }
    if (post.by) await tg(env, "sendMessage", { chat_id: post.by, text: `⏰ Schedule post (<code>${esc(id)}</code>)\n` + postReport(res) + note, parse_mode: "HTML" }).catch(() => {});
  }
}

// The bot was added to / removed from a channel: when an owner makes it admin, the channel is saved automatically (no forwarding).
// Needs "my_chat_member" in the webhook's allowed_updates -> open /setup?key=WEBHOOK_SECRET once after deploying.
async function onMyChat(c, env) {
  if (!env.STATE || c.chat?.type !== "channel") return;
  const owners = idList(env.OWNER_IDS);
  const st = c.new_chat_member?.status;
  const title = esc(c.chat.title || c.chat.username || c.chat.id);
  if (st === "administrator") {
    if (owners.length && !owners.includes(String(c.from?.id))) return;   // only owners can add channels
    await env.STATE.put("chn:" + c.chat.id, String(c.chat.title || c.chat.username || c.chat.id).slice(0, 60));
    const can = c.new_chat_member.can_post_messages !== false;
    await notifyOwners(env, `📢 Channel မှတ်ပြီးပါပြီ: <b>${title}</b>\n` + (can ? "📝 Post တင်ရန် နဲ့ ရွေးလို့ရပါပြီ" : "⚠️ Bot မှာ <b>Post messages</b> ခွင့် မရှိသေးပါ၊ Channel admin settings မှာ ဖွင့်ပေးပါ"));
  } else if (["left", "kicked", "member", "restricted"].includes(st)) {
    const had = await env.STATE.get("chn:" + c.chat.id).catch(() => null);
    await env.STATE.delete("chn:" + c.chat.id).catch(() => {});
    if (had && (!owners.length || owners.includes(String(c.from?.id)))) await notifyOwners(env, `🗑 Channel ဖယ်လိုက်ပါပြီ: <b>${title}</b> (Bot ကို admin ကနေ ဖြုတ်ထားလို့)`);
  }
}
let BOT_ID = 0;
async function botId(env) {
  if (!BOT_ID) BOT_ID = (await tg(env, "getMe", {}).catch(() => null))?.result?.id || 0;
  return BOT_ID;
}
let BOT_NAME = "";
async function botName(env) {
  if (!BOT_NAME) BOT_NAME = String((await tg(env, "getMe", {}).catch(() => null))?.result?.username || "").toLowerCase();
  return BOT_NAME;   // "" when getMe failed -> the check below is skipped, our own commands are never dropped
}
const ALB_SEEN = new Set();   // one "album started" reply per album, even when its photos arrive at the same moment
async function beginPost(env, chat, uid, base) {
  const targets = await listTargets(env);
  const say = (txt, extra = {}) => send({ ...env, replyTo: 0 }, chat, txt, extra);
  if (!targets.length) {
    await say("⚠️ တင်စရာနေရာ မရှိသေးပါ။\n• Channel: Bot ကို channel မှာ <b>admin</b> လုပ်လိုက်ရုံနဲ့ အလိုလိုမှတ်ပါတယ် (သို့) 📢 Channels ထဲက ➕ ခလုတ်နဲ့ @username ထည့်ပါ\n• Group: Bot ရှိတဲ့ group ထဲမှာ စာတစ်ခုပေါ်ရင် အလိုလိုမှတ်ပါတယ်");
    return false;
  }
  const st = { step: "target", sel: [], post: { ...newPost(), ...(base || {}), targets: [] } };
  await env.STATE.put(`pst:${uid}`, JSON.stringify(st), { expirationTtl: 6 * 3600 });
  await say("⌨️ Post menu ဖွင့်ပါပြီ", { reply_markup: backKb() });
  await say(TARGET_TEXT, { reply_markup: targetKb(targets, []) });
  return true;
}

// Returns true when the message was part of the post flow (the caller stops handling it).
async function postFlow(env, m) {
  const chat = m.chat.id, uid = m.from.id;
  const raw = m.text || m.caption || "";
  let t = raw.trim();
  if (t === ML.new) t = "/post";            // main-menu buttons act as the commands
  else if (t === ML.list) t = "/posts";
  else if (t === ML.chn) t = "/channels";
  else if (t === ML.sent) t = "/sent";
  else if (t === ML.tpl) t = "/templates";
  const key = `pst:${uid}`;
  const say = (txt, extra = {}) => send({ ...env, replyTo: 0 }, chat, txt, extra);
  if (t === ML.help) {   // the same menu /start shows, called from the keyboard; ❌ ပိတ် deletes it
    await junkSweep(env, chat);
    await say(MENU_TEXT, { reply_markup: helpMenu(true, true) });
    return true;
  }
  let st = await env.STATE.get(key, "json").catch(() => null);
  const save = () => env.STATE.put(key, JSON.stringify(st), { expirationTtl: 6 * 3600 });

  // register a channel: forward any post of it to the bot (only when not busy writing a post)
  if (m.forward_origin?.type === "channel" && m.forward_origin.chat && (!st || !["content", "edit"].includes(st.step))) {
    const c = m.forward_origin.chat;
    await env.STATE.put("chn:" + c.id, String(c.title || c.username || c.id).slice(0, 60));
    await say(`📢 Channel မှတ်ပြီးပါပြီ: <b>${esc(c.title || c.username || c.id)}</b>\n<code>${c.id}</code>\nBot ကို အဲဒီ channel မှာ admin (Post / Edit / Delete / Pin messages ခွင့်) ပေးထားပါ။\n(နောက်ကျရင် forward မလိုပါ — Bot ကို admin လုပ်ရုံနဲ့ အလိုလိုမှတ်ပါတယ်)`, { reply_markup: mainKb() });
    return true;
  }

  const cm = t.match(/^\/(post|posts|sent|templates|delpost|addchannel|delchannel|channels)(?:@\w+)?(?:\s+([\s\S]*))?$/i);
  if (cm) {
    const cmd = cm[1].toLowerCase(), arg = (cm[2] || "").trim();
    if (t !== raw.trim() || ["post", "posts", "sent", "templates", "channels"].includes(cmd)) await junkSweep(env, chat);   // a menu button / command clears the older screens
    if (cmd === "post") { await beginPost(env, chat, uid, null); return true; }
    if (cmd === "channels") {
      const l = await env.STATE.list({ prefix: "chn:", limit: 100 });
      const items = await Promise.all(l.keys.map(async (k) => ({ id: k.name.slice(4), title: (await env.STATE.get(k.name).catch(() => "")) || "?" })));
      await say(
        "📢 <b>Channels</b>\n\n" + (items.length ? "🗑 နှိပ်ရင် ဖယ်မယ် 👇" : "မရှိသေးပါ") +
          "\n\n➕ အသစ်ထည့်ရန် နည်း ၂ မျိုး:\n1️⃣ Bot ကို channel မှာ <b>admin</b> လုပ်လိုက် (အလိုလိုမှတ်မယ်၊ forward မလို)\n2️⃣ အောက်က ➕ ခလုတ်နဲ့ @username ပို့",
        { reply_markup: { inline_keyboard: [...items.map((x) => [{ text: `🗑 ${x.title}`.slice(0, 60), callback_data: `pc:${x.id}`, style: "danger" }]), [{ text: "➕ Channel ထည့်ရန်", callback_data: "pa:add", style: "success" }], closeRow()] } }
      );
      return true;
    }
    if (cmd === "addchannel") {
      const id = (arg.match(/-?\d{6,}|@[A-Za-z][A-Za-z0-9_]{3,31}/) || [""])[0];
      if (!id) { await say("ဥပမာ: <code>/addchannel -1001234567890</code> (သို့) channel post တစ်ခုကို ဒီ bot ဆီ forward လုပ်ပါ"); return true; }
      const r = await tg(env, "getChat", { chat_id: id }).catch(() => null);
      if (!r?.ok) { await say(`⚠️ Channel မတွေ့ပါ${r?.description ? ": " + esc(r.description) : ""}\nBot ကို channel admin ပေးထားလား စစ်ပါ။`); return true; }
      await env.STATE.put("chn:" + r.result.id, String(r.result.title || r.result.username || r.result.id).slice(0, 60));
      await say(`📢 မှတ်ပြီးပါပြီ: <b>${esc(r.result.title || id)}</b> <code>${r.result.id}</code>`);
      return true;
    }
    if (cmd === "delchannel") { await env.STATE.delete("chn:" + arg).catch(() => {}); await say("🗑 ဖယ်ပြီးပါပြီ"); return true; }
    if (cmd === "posts") {
      const l = await env.STATE.list({ prefix: "sch:", limit: 50 });
      const rows = [], btns = [];
      for (const k of l.keys) {
        const [, at, id] = k.name.split(":");
        const p = await env.STATE.get(k.name, "json").catch(() => null);
        if (!p) continue;
        const prev = esc(plainTpl(p.html).slice(0, 40) || (p.media ? "(" + p.media.type + ")" : ""));
        rows.push(`• ${whenLabel(Number(at))}${p.rep ? " 🔁" : ""} · ${p.targets.length} နေရာ\n   ${prev}`);
        btns.push([{ text: `🗑 ${whenLabel(Number(at))}${p.rep ? " 🔁" : ""}`, callback_data: `ps:${id}`, style: "danger" }]);
      }
      await say("⏰ <b>Schedule လုပ်ထားတဲ့ post</b>\n\n" + (rows.join("\n") || "မရှိပါ") + (btns.length ? "\n\nဖျက်ချင်ရင် ခလုတ်နှိပ်ပါ 👇" : ""), { reply_markup: { inline_keyboard: [...btns, closeRow()] } });
      return true;
    }
    if (cmd === "delpost") {
      const l = await env.STATE.list({ prefix: "sch:", limit: 100 });
      const hit = l.keys.find((k) => k.name.split(":")[2] === arg);
      if (!hit) { await say("ID မတွေ့ပါ"); return true; }
      await env.STATE.delete(hit.name);
      await say("🗑 Schedule post ဖျက်ပြီးပါပြီ");
      return true;
    }
    if (cmd === "sent") {   // last 10 posts the bot sent: tap one to edit / delete / pin
      const l = await env.STATE.list({ prefix: "sent:", limit: 1000 });
      const keys = l.keys.slice(-10).reverse();
      const btns = [];
      for (const k of keys) {
        const rec = await env.STATE.get(k.name, "json").catch(() => null);
        if (!rec) continue;
        const prev = plainTpl(rec.post.html).replace(/\s+/g, " ").slice(0, 25) || (rec.post.media ? `(${rec.post.media.type})` : "");
        btns.push([{ text: `${whenLabel(rec.t)} · ${prev}`.slice(0, 60), callback_data: `sm:${k.name.slice(5)}`, style: "primary" }]);
      }
      await say(btns.length ? "🗂 <b>တင်ပြီးသား Post</b> (နောက်ဆုံး ၁၀ ခု)\nရွေးပါ 👇" : "🗂 တင်ပြီးသား Post မရှိသေးပါ (ရက် ၃၀ သိမ်းပါတယ်)", { reply_markup: { inline_keyboard: [...btns, closeRow()] } });
      return true;
    }
    if (cmd === "templates") {
      const l = await env.STATE.list({ prefix: "tpl:", limit: 50 });
      const btns = [];
      for (const k of l.keys) {
        const tp = await env.STATE.get(k.name, "json").catch(() => null);
        if (!tp) continue;
        const id = k.name.slice(4);
        btns.push([{ text: `📄 ${tp.name}`.slice(0, 40), callback_data: `tu:${id}`, style: "primary" }, { text: "🗑", callback_data: `td:${id}`, style: "danger" }]);
      }
      await say(btns.length ? "📋 <b>Templates</b>\nအသုံးပြုချင်တာ နှိပ်ပါ (🗑 = ဖျက်) 👇" : "📋 Template မရှိသေးပါ\nPost တစ်ခုပြင်ဆင်ပြီး <b>" + PL.tpl + "</b> နှိပ်ရင် သိမ်းပေးပါမယ်", { reply_markup: { inline_keyboard: [...btns, closeRow()] } });
      return true;
    }
  }

  if (!st) return false;
  // ❌ ပယ်ဖျက် = leave everything. ⬅️ Back on the first / single-screen steps leaves too (nothing to lose there).
  if (t === PL.cancel || (t === PL.back && ["target", "edit", "addch", "editmedia", "editbtn"].includes(st.step))) {
    if (st.step === "album") await clearAlbum(env, uid);
    await env.STATE.delete(key).catch(() => {});
    await say("❌ ပယ်ဖျက်လိုက်ပါပြီ", { reply_markup: NO_KB });
    return true;
  }
  if (st.step === "target") {
    await say("အပေါ်က ခလုတ်တွေနဲ့ နေရာရွေးပြီး ▶️ ဆက်သွားမယ် ကို နှိပ်ပါ (ပယ်ဖျက်ချင်ရင် ❌)");
    return true;
  }
  if (st.step === "addch") {   // channel by @username / link / numeric id
    const mm = t.match(/(?:@|t\.me\/)([A-Za-z][A-Za-z0-9_]{3,31})/);
    const id = mm ? "@" + mm[1] : (t.match(/^-100\d{6,}$/) || [""])[0];
    if (!id) { await say("⚠️ ဥပမာ: <code>@mychannel</code> (သို့) <code>t.me/mychannel</code>"); return true; }
    const r = await tg(env, "getChat", { chat_id: id }).catch(() => null);
    if (!r?.ok || r.result.type !== "channel") { await say(`⚠️ Channel မတွေ့ပါ${r?.description ? ": " + esc(r.description) : ""}\nPrivate channel ဆိုရင် Bot ကို admin လုပ်လိုက်ရုံနဲ့ အလိုလိုမှတ်ပါတယ်`); return true; }
    const cmr = await tg(env, "getChatMember", { chat_id: r.result.id, user_id: await botId(env) }).catch(() => null);
    if (cmr?.result?.status !== "administrator") { await say(`⚠️ Bot က <b>${esc(r.result.title)}</b> မှာ admin မဟုတ်သေးပါ\nChannel settings → Administrators မှာ Bot ကို admin ထည့်ပြီး (Post messages ခွင့်ပေးပြီး) ပြန်ထည့်ပါ`); return true; }
    await env.STATE.put("chn:" + r.result.id, String(r.result.title || id).slice(0, 60));
    await env.STATE.delete(key).catch(() => {});
    await say(`📢 Channel မှတ်ပြီးပါပြီ: <b>${esc(r.result.title)}</b>` + (cmr.result.can_post_messages === false ? "\n⚠️ Post messages ခွင့် မရှိသေးပါ" : "\n📝 Post တင်ရန် နဲ့ ရွေးလို့ရပါပြီ"), { reply_markup: NO_KB });
    return true;
  }
  if (t.startsWith("/") && !["content", "edit", "editmedia"].includes(st.step)) return false;   // other commands keep working

  const post = st.post || newPost();
  const menu = (txt) => say(txt, { reply_markup: postKb(post) });
  const preview = async () => {
    if (!post.html && !post.media) return say("⚠️ Post မှာ ဘာမှမရှိသေးပါ၊ စာ/ပုံ/video ပို့ပါ");
    await sendPostTo(env, chat, post, true).catch(() => {});
  };
  const ready = () => !!(post.html || post.media);
  const goAlbum = async () => {
    await clearAlbum(env, uid);
    st.step = "album";
    await save();
    await say("📸 <b>Album</b> — ပုံ / video တွေ (၂ ခုကနေ ၁၀ ခုအထိ) ပို့ပါ။ Caption ကို ပထမပုံမှာ ရေးပါ။\nအကုန်ပို့ပြီးရင် <b>" + PL.done + "</b> နှိပ်ပါ\n(Album မှာ Link button မရပါ — Telegram ကန့်သတ်ချက်)", { reply_markup: albumKb() });
  };

  // ⬅️ Back: one step at a time, what was written is kept.
  if (t === PL.back) {
    const s = st.step;
    if (s === "content" || s === "menu") {   // back to the target picker (targets stay ticked)
      const targets = await listTargets(env);
      st.step = "target";
      st.sel = (post.targets || []).filter((id) => targets.some((x) => x.id === id));
      await save();
      await say("⬅️ နေရာပြန်ရွေးလို့ရပါတယ် (ရေးထားတာ မပျောက်ပါ)", { reply_markup: backKb() });
      await say(TARGET_TEXT, { reply_markup: targetKb(targets, st.sel) });
    } else if (s === "album") {
      await clearAlbum(env, uid);
      if (ready()) { st.step = "menu"; await save(); await preview(); await menu("⬅️ Album မလုပ်တော့ပါ"); }
      else { st.step = "content"; await save(); await say(CONTENT_TEXT, { reply_markup: contentKb() }); }
    } else if (s === "rep") {
      st.step = "when";
      await save();
      await say("⬅️ အချိန်ပြန်ရွေးပါ 👇", { reply_markup: whenKb() });
    } else {   // buttons / color / tplname / when -> post menu
      st.step = "menu";
      await save();
      await menu("⬅️ ပြန်ရောက်ပါပြီ");
    }
    return true;
  }

  // ----- content: text / photo / video / file -----
  if (st.step === "content") {
    if (t === PL.album) { await goAlbum(); return true; }
    const isAlbumPart = (m.photo || m.video) && m.media_group_id;
    if (isAlbumPart) {   // an album sent as a whole: collect its parts, no need to press the Album button first
      await env.STATE.put(`alb:${uid}:${m.message_id}`, JSON.stringify({ type: m.photo ? "photo" : "video", id: m.photo ? m.photo[m.photo.length - 1].file_id : m.video.file_id, html: raw ? richHtml(raw, m.caption_entities || [], 0, 1000) : "" }), { expirationTtl: 6 * 3600 });
      st.step = "album";
      await save();
      const gk = uid + ":" + m.media_group_id;
      if (!ALB_SEEN.has(gk)) {
        if (ALB_SEEN.size > 200) ALB_SEEN.clear();
        ALB_SEEN.add(gk);
        await say("📸 Album လက်ခံနေပါတယ် — အကုန်ရောက်ပြီးရင် <b>" + PL.done + "</b> နှိပ်ပါ", { reply_markup: albumKb() });
      }
      return true;
    }
    let media = null;
    if (m.photo?.length) media = { type: "photo", id: m.photo[m.photo.length - 1].file_id };
    else if (m.video) media = { type: "video", id: m.video.file_id };
    else if (m.animation) media = { type: "animation", id: m.animation.file_id };
    else if (m.document) media = { type: "document", id: m.document.file_id };
    if (!media && !m.text) { await say("စာ / ပုံ / video / file တစ်ခုပို့ပါ"); return true; }
    if (media && raw.length > 1000) { await say("⚠️ ပုံ/video caption က စာလုံး ၁၀၀၀ ထက် မကျော်ရပါ၊ တိုတိုလေးပြန်ပို့ပါ"); return true; }
    post.html = raw ? richHtml(raw, (m.text ? m.entities : m.caption_entities) || [], 0, media ? 1000 : 3500) : "";
    post.media = media;
    post.album = [];
    st.post = post;
    st.step = "menu";
    await save();
    await preview();
    await menu("👆 Preview ပါ။ အောက်က ခလုတ်တွေနဲ့ ဆက်လုပ်ပါ");
    return true;
  }

  // ----- album: parts are stored one KV key each (parts of an album arrive at the same time) -----
  if (st.step === "album") {
    if (t === PL.done) {
      const l = await env.STATE.list({ prefix: `alb:${uid}:`, limit: 50 });
      const parts = [];
      for (const k of l.keys) {
        const v = await env.STATE.get(k.name, "json").catch(() => null);
        if (v) parts.push({ mid: Number(k.name.split(":")[2]), ...v });
      }
      if (parts.length < 2) { await say("⚠️ ပုံ / video အနည်းဆုံး ၂ ခု လိုပါတယ်။ ဆက်ပို့ပါ", { reply_markup: albumKb() }); return true; }
      parts.sort((a, b) => a.mid - b.mid);
      const use = parts.slice(0, 10);
      await clearAlbum(env, uid);
      post.media = { type: use[0].type, id: use[0].id };
      post.album = use.slice(1).map((x) => ({ type: x.type, id: x.id }));
      post.html = (use.find((x) => x.html) || {}).html || "";
      st.post = post;
      st.step = "menu";
      await save();
      await preview();
      await menu(`📸 Album ${use.length} ခု ရပါပြီ` + (parts.length > 10 ? " (၁၀ ခုပဲ ယူထားတယ်)" : "") + (post.btns.length ? "\n⚠️ Album မှာ Link button မပါပါ" : ""));
      return true;
    }
    if (m.photo || m.video) {
      await env.STATE.put(`alb:${uid}:${m.message_id}`, JSON.stringify({ type: m.photo ? "photo" : "video", id: m.photo ? m.photo[m.photo.length - 1].file_id : m.video.file_id, html: raw ? richHtml(raw, m.caption_entities || [], 0, 1000) : "" }), { expirationTtl: 6 * 3600 });
      return true;   // silent: just collecting
    }
    await say("ပုံ / video ပို့ပါ၊ ပြီးရင် <b>" + PL.done + "</b> နှိပ်ပါ", { reply_markup: albumKb() });
    return true;
  }

  // ----- replace the photo / video / file of an already sent post -----
  if (st.step === "editmedia") {
    const rec = await env.STATE.get(`sent:${st.sk}`, "json").catch(() => null);
    if (!rec) { await env.STATE.delete(key).catch(() => {}); await say("⚠️ ဒီ post မတွေ့တော့ပါ", { reply_markup: NO_KB }); return true; }
    if (m.media_group_id) { await say("ပုံ/video တစ်ခုတည်း ပို့ပါ (Album အစုလိုက် မရပါ)"); return true; }
    let media = null;
    if (m.photo?.length) media = { type: "photo", id: m.photo[m.photo.length - 1].file_id };
    else if (m.video) media = { type: "video", id: m.video.file_id };
    else if (m.animation) media = { type: "animation", id: m.animation.file_id };
    else if (m.document) media = { type: "document", id: m.document.file_id };
    if (!media) { await say("ပုံ / video / GIF / file တစ်ခု ပို့ပါ (စာသားတင် ပို့လို့မရပါ)"); return true; }
    if (raw.length > 1000) { await say("⚠️ Caption က စာလုံး ၁၀၀၀ ထက် မကျော်ရပါ"); return true; }
    const html = raw ? richHtml(raw, m.caption_entities || [], 0, 1000) : rec.post.html || "";   // no new caption -> keep the old one
    let ok = 0, err = "", album = false;
    for (const s of rec.sent) {
      const isAlbum = s.m.length > 1;
      if (isAlbum) album = true;
      const rm = isAlbum ? undefined : postMarkup(rec.post);   // keep the buttons
      const r = await tg(env, "editMessageMedia", {
        chat_id: s.c, message_id: s.m[0],
        media: { type: media.type, media: media.id, caption: tplHtml(html), parse_mode: "HTML" },
        ...(rm ? { reply_markup: rm } : {}),
      }).catch(() => null);
      if (r?.ok) ok++; else err = err || r?.description || "";
    }
    if (ok) {
      rec.post.media = media;
      rec.post.html = html;
      await saveSent(env, st.sk, rec);
    }
    await env.STATE.delete(key).catch(() => {});
    await say(`🖼 အစားထိုးပြီးပါပြီ — ✅ ${ok}/${rec.sent.length} နေရာ` + (album ? "\n(Album ဆိုရင် ပထမပုံ/video တစ်ခုတည်း အစားထိုးတာပါ)" : "") + (err ? `\n⚠️ ${esc(err)}` : ""), { reply_markup: NO_KB });
    return true;
  }

  // ----- add / replace the link buttons of an already sent post -----
  if (st.step === "editbtn") {
    const rec = await env.STATE.get(`sent:${st.sk}`, "json").catch(() => null);
    if (!rec) { await env.STATE.delete(key).catch(() => {}); await say("⚠️ ဒီ post မတွေ့တော့ပါ", { reply_markup: NO_KB }); return true; }
    const rows = m.text ? parseBtnLines(t) : [];
    if (!rows.length) { await say(BTN_FORMAT_HINT); return true; }
    rec.post.btns = (st.mode === "add" ? [...(rec.post.btns || []), ...rows] : rows).slice(0, 8);
    const r = await applySentMarkup(env, rec);
    if (r.ok) await saveSent(env, st.sk, rec);
    await env.STATE.delete(key).catch(() => {});
    await say(
      `🔘 ✅ ${r.ok}/${rec.sent.length - r.skip} နေရာ ပြင်ပြီး (Button ${r.ok ? rec.post.btns.length : (rec.post.btns || []).length} ခု)` +
        (r.skip ? `\n⚠️ Album ${r.skip} နေရာမှာ Button မရပါ` : "") + (r.err ? `\n⚠️ ${esc(r.err)}` : ""),
      { reply_markup: NO_KB }
    );
    const cur = r.ok ? rec : (await env.STATE.get(`sent:${st.sk}`, "json").catch(() => null)) || rec;
    const pn = btnPanel(cur, st.sk);
    await say(pn.text, { reply_markup: { inline_keyboard: pn.rows } });
    return true;
  }

  // ----- edit an already sent post (from 🗂 တင်ပြီးသား Post) -----
  if (st.step === "edit") {
    const rec = await env.STATE.get(`sent:${st.sk}`, "json").catch(() => null);
    if (!rec) { await env.STATE.delete(key).catch(() => {}); await say("⚠️ ဒီ post မတွေ့တော့ပါ", { reply_markup: NO_KB }); return true; }
    if (!m.text) { await say("စာသားပဲ ပို့ပါ (ပုံ/video ပြောင်းချင်ရင် ❌ နှိပ်ပြီး 🗂 တင်ပြီးသား Post → 🖼 ပုံ/Video ပြောင်း ကို သုံးပါ)"); return true; }
    const mediaPost = !!rec.post.media;
    if (mediaPost && raw.length > 1000) { await say("⚠️ Caption က စာလုံး ၁၀၀၀ ထက် မကျော်ရပါ"); return true; }
    const html = richHtml(raw, m.entities || [], 0, mediaPost ? 1000 : 3500);
    let ok = 0, err = "";
    for (const s of rec.sent) {
      const rm = s.m.length === 1 ? postMarkup(rec.post) : undefined;   // keep the buttons on the edited message
      const common = { chat_id: s.c, message_id: s.m[0], parse_mode: "HTML", ...(rm ? { reply_markup: rm } : {}) };
      const r = mediaPost
        ? await tg(env, "editMessageCaption", { ...common, caption: tplHtml(html) }).catch(() => null)
        : await tg(env, "editMessageText", { ...common, text: tplHtml(html), ...(rec.post.nopv ? { link_preview_options: { is_disabled: true } } : {}) }).catch(() => null);
      if (r?.ok) ok++; else err = err || r?.description || "";
    }
    if (ok) {
      rec.post.html = html;
      await env.STATE.put(`sent:${st.sk}`, JSON.stringify(rec), { expirationTtl: 30 * 86400 }).catch(() => {});
    }
    await env.STATE.delete(key).catch(() => {});
    await say(`✏️ ပြင်ပြီးပါပြီ — ✅ ${ok}/${rec.sent.length} နေရာ` + (err ? `\n⚠️ ${esc(err)}` : ""), { reply_markup: NO_KB });
    return true;
  }

  // ----- template name -----
  if (st.step === "tplname") {
    const name = t.slice(0, 30);
    if (!name || !m.text) { await say("Template နာမည် (စာသား) ပို့ပါ"); return true; }
    const l = await env.STATE.list({ prefix: "tpl:", limit: 100 });
    if (l.keys.length >= 30) { st.step = "menu"; await save(); await menu("⚠️ Template ၃၀ ခုထက် မသိမ်းနိုင်ပါ၊ 📋 Templates မှာ တချို့ဖျက်ပါ"); return true; }
    const { targets, ...rest } = post;
    await env.STATE.put("tpl:" + Math.random().toString(36).slice(2, 7), JSON.stringify({ name, post: rest }));
    st.step = "menu";
    await save();
    await menu(`💾 Template "${esc(name)}" သိမ်းပြီးပါပြီ\n📋 Templates ကနေ နောက်ကျရင် တစ်ချက်နှိပ်ပြီး သုံးနိုင်ပါတယ်`);
    return true;
  }

  // ----- link buttons: "name | https://link" or "name | https://link | green" -----
  if (st.step === "buttons") {
    const rows = parseBtnLines(t);
    if (!rows.length) { await say(BTN_FORMAT_HINT); return true; }
    post.btns = [...(post.btns || []), ...rows].slice(0, 8);
    st.step = "menu";
    await save();
    await preview();
    await menu(`✅ Button ${rows.length} ခု ထည့်ပြီး (စုစုပေါင်း ${post.btns.length})` + (post.album?.length ? "\n⚠️ Album မှာ Link button မပါပါ" : ""));
    return true;
  }

  // ----- color of all link buttons -----
  if (st.step === "color") {
    const pick = Object.values(COLORS).find((c) => c.label === t);
    if (!pick) { await say("အောက်က အရောင်ခလုတ်တစ်ခု နှိပ်ပါ 👇", { reply_markup: colorKb() }); return true; }
    post.color = pick.style;
    post.btns = (post.btns || []).map((b) => ({ ...b, c: "" }));   // one color for all (a color typed per button can be added again)
    st.step = "menu";
    await save();
    await preview();
    await menu(`🎨 Button color: ${pick.label}`);
    return true;
  }

  // ----- schedule: time, then repeat -----
  if (st.step === "when") {
    const at = presetWhen(t) || parseWhen(t);
    if (!at) { await say("⚠️ အချိန်မမှန်ပါ (သို့) ကျော်သွားပြီ\nအောက်ကခလုတ်ကိုနှိပ် (သို့) ရိုက်ပါ: <code>21:30</code> · <code>2026-10-12 09:00</code>\n(မြန်မာစံတော်ချိန်)", { reply_markup: whenKb() }); return true; }
    st.at = at;
    st.step = "rep";
    await save();
    await say(`🕒 ${whenLabel(at)} (မြန်မာ)\nထပ်ခါထပ်ခါ တင်မလား?`, { reply_markup: repKb() });
    return true;
  }
  if (st.step === "rep") {
    const rep = t === RPL.daily ? "daily" : t === RPL.weekly ? "weekly" : t === RPL.once ? "" : null;
    if (rep === null) { await say("အောက်က ခလုတ်တစ်ခု နှိပ်ပါ 👇", { reply_markup: repKb() }); return true; }
    const id = Math.random().toString(36).slice(2, 7);
    await env.STATE.put(`sch:${String(st.at).padStart(14, "0")}:${id}`, JSON.stringify({ ...post, by: uid, rep }), { expirationTtl: Math.ceil((st.at - Date.now()) / 1000) + 7 * 86400 });
    await env.STATE.delete(key).catch(() => {});
    await say(`⏰ Schedule လုပ်ပြီးပါပြီ\n🕒 ${whenLabel(st.at)} (မြန်မာ)${rep ? (rep === "daily" ? " · 🔁 နေ့တိုင်း" : " · 🔁 အပတ်တိုင်း") : ""}\n📍 ${post.targets.length} နေရာ\n\n⏰ Schedule စာရင်း ကနေ ကြည့်/ဖျက်လို့ရ\n(အချိန်မှန်ဖို့ Cron trigger <code>*/5 * * * *</code> လို)`, { reply_markup: NO_KB });
    return true;
  }

  // ----- step === "menu" -----
  if (t === PL.add) {
    st.step = "buttons";
    await save();
    await say("➕ Link button ထည့်ပါ — တစ်ကြောင်းကို ခလုတ်တစ်ခု:\n<code>Store ဝင်ရန် | https://your-store.com | green\nChannel Join | https://t.me/yourchannel | blue</code>\n\nအရောင်က မထည့်လည်းရ — <code>blue</code> / <code>green</code> / <code>red</code> (သို့) အပြာ / အစိမ်း / အနီ\n(အားလုံးတစ်ခါတည်း ရောင်ချိန်ချင်ရင် 🎨 Button Color ကိုသုံး)", { reply_markup: backKb() });
    return true;
  }
  if (t === PL.store) {
    const store = await getStore(env);
    if (!store) { await menu("⚠️ Store link မထည့်ရသေးပါ။ <code>/setstore https://...</code> အရင်သုံးပါ"); return true; }
    if (!(post.btns || []).some((b) => b.u === store)) post.btns = [...(post.btns || []), { t: "Store ဝင်ရန်", u: store, c: "success" }];
    await save();
    await preview();
    await menu("✅ Store button ထည့်ပြီး (အစိမ်းရောင်)");
    return true;
  }
  if (t === PL.color) {
    st.step = "color";
    await save();
    await say("🎨 Button အားလုံးရဲ့ အရောင်ရွေးပါ 👇", { reply_markup: colorKb() });
    return true;
  }
  if (t === PL.clr) { post.btns = []; await save(); await preview(); await menu("🧹 Button အကုန်ရှင်းပြီး"); return true; }
  if (t.startsWith("📌 Pin")) { post.pin = !post.pin; await save(); await menu(`📌 Pin: ${post.pin ? "ဖွင့် — တင်ပြီးရင် channel/group မှာ pin လုပ်ပေးမယ်" : "ပိတ်"}`); return true; }
  if (t.startsWith("🔔 Silent")) { post.silent = !post.silent; await save(); await menu(`🔔 Silent: ${post.silent ? "ဖွင့် — အသံမမြည်ဘဲ တင်မယ်" : "ပိတ်"}`); return true; }
  if (t.startsWith("🔗 Link preview")) { post.nopv = !post.nopv; await save(); await menu(`🔗 Link preview: ${post.nopv ? "ပိတ်" : "ဖွင့်"}` + (post.media ? "\n(ပုံ/video post မှာ မသက်ရောက်ပါ)" : "")); return true; }
  if (t === PL.tpl) {
    if (!ready()) { await menu("⚠️ Post မှာ ဘာမှမရှိသေးပါ"); return true; }
    st.step = "tplname";
    await save();
    await say("💾 Template နာမည်ပေးပါ (ဥပမာ: Promo၊ ဈေးနှုန်း၊ Maintenance)", { reply_markup: backKb() });
    return true;
  }
  if (t === PL.redo) {
    st.step = "content";
    await save();
    await say(CONTENT_TEXT + "\n\n(Button / Pin / Silent / Color တွေ မပျောက်ပါ)", { reply_markup: contentKb() });
    return true;
  }
  if (t === PL.album) { await goAlbum(); return true; }
  if (t === PL.prev) { await preview(); return true; }
  if (t === PL.test) {   // the real post (same buttons / caption / album), sent to this private chat only
    if (!ready()) { await menu("⚠️ Post မှာ ဘာမှမရှိသေးပါ"); return true; }
    await say("🧪 <b>Test</b> — တကယ်တင်ရင် ဒီလိုပဲ ထွက်ပါမယ် 👇");
    const r = await sendPostTo(env, chat, post, true).catch(() => ({ ok: false }));
    await menu(r.ok ? "🧪 Test ပို့ပြီးပါပြီ — မှန်ရင် ✅ ယခုတင် (သို့) ⏰ အချိန်ခွဲတင်\n(Test က ဘယ် channel/group ဆီမှ မရောက်ပါ)" : `⚠️ Test မပို့နိုင်ပါ${r.description ? ": " + esc(r.description) : ""}`);
    return true;
  }
  if (t === PL.now) {   // ask first: a wrong post in 5 places is hard to take back
    if (!ready()) { await menu("⚠️ Post မှာ ဘာမှမရှိသေးပါ"); return true; }
    const targets = await listTargets(env);
    const names = targets.filter((x) => post.targets.includes(x.id)).map((x) => `${x.kind} ${esc(x.title)}`);
    const flags = [post.pin ? "📌 Pin" : "", post.silent ? "🔔 Silent" : "", post.album?.length ? `📸 Album ${post.album.length + 1} ခု` : "", post.btns?.length ? `🔘 Button ${post.btns.length} ခု` : ""].filter(Boolean).join(" · ");
    await say(
      `⚠️ <b>နေရာ ${post.targets.length} ခုကို တင်တော့မယ်၊ သေချာလား?</b>\n\n${names.join("\n") || post.targets.map(esc).join("\n")}` + (flags ? `\n\n${flags}` : ""),
      { reply_markup: { inline_keyboard: [[{ text: "✅ တင်မယ်", callback_data: "pk:y", style: "success" }, { text: "❌ မတင်သေးဘူး", callback_data: "pk:n", style: "danger" }]] } }
    );
    return true;
  }
  if (t === PL.later) {
    if (!ready()) { await menu("⚠️ Post မှာ ဘာမှမရှိသေးပါ"); return true; }
    st.step = "when";
    await save();
    await say("⏰ ဘယ်အချိန် တင်မလဲ — ခလုတ်နှိပ်ပါ 👇\n(သို့) ကိုယ်တိုင်ရိုက်: <code>21:30</code> · <code>2026-10-12 09:00</code> (မြန်မာစံတော်ချိန်)", { reply_markup: whenKb() });
    return true;
  }
  await menu("အောက်က ခလုတ်တွေကို သုံးပါ 👇");
  return true;
}
async function clearAlbum(env, uid) {
  const l = await env.STATE.list({ prefix: `alb:${uid}:`, limit: 50 });
  await Promise.all(l.keys.map((k) => env.STATE.delete(k.name).catch(() => {})));
}

// Inline-button callbacks of the post composer (owner, private chat only):
//   pt = target picker, ps = delete scheduled, pc = delete channel, tu / td = use / delete template,
//   sm = sent post detail, sa = sent post action (edit / media / btn / badd / bset / bd<N> / bc<p|g|r|n> / bx / del / pin / unpin)
async function postCallback(q, env) {
  const uid = q.from.id;
  const chat = q.message.chat.id;
  const key = `pst:${uid}`;
  const parts = String(q.data).split(":");
  const tag = parts[0];
  const ans = (text, alert = true) => tg(env, "answerCallbackQuery", { callback_query_id: q.id, ...(text ? { text, show_alert: alert } : {}) });
  const say = (txt, extra = {}) => send({ ...env, replyTo: 0 }, chat, txt, extra);
  const dropRow = () => {
    const rows = (q.message.reply_markup?.inline_keyboard || []).filter((r) => !r.some((b) => b.callback_data === q.data));
    return tg(env, "editMessageReplyMarkup", { chat_id: chat, message_id: q.message.message_id, reply_markup: { inline_keyboard: rows } });
  };

  if (tag === "pz") {   // pz:c = close this screen, pz:x = cancel the post being written
    await ans(null);
    if (parts[1] === "x") {
      await clearAlbum(env, uid);
      await env.STATE.delete(key).catch(() => {});
      await tg(env, "editMessageText", { chat_id: chat, message_id: q.message.message_id, text: "❌ ပယ်ဖျက်လိုက်ပါပြီ", parse_mode: "HTML" }).catch(() => {});
      return say("📝 Menu ပြန်ရောက်ပါပြီ", { reply_markup: NO_KB });
    }
    return tg(env, "deleteMessage", { chat_id: chat, message_id: q.message.message_id }).catch(() => {});
  }
  if (tag === "pa") {
    await env.STATE.put(key, JSON.stringify({ step: "addch" }), { expirationTtl: 3600 });
    await ans(null);
    return say("➕ Channel ရဲ့ <code>@username</code> (သို့) <code>t.me/username</code> ပို့ပါ\n(Bot ကို အဲဒီ channel မှာ admin အရင်လုပ်ထားရမယ်)", { reply_markup: cancelKb() });
  }
  if (tag === "pc") {
    await env.STATE.delete("chn:" + parts[1]).catch(() => {});
    await ans("🗑 ဖျက်ပြီးပါပြီ", false);
    return dropRow();
  }
  if (tag === "ps") {
    const l = await env.STATE.list({ prefix: "sch:", limit: 100 });
    const hit = l.keys.find((k) => k.name.split(":")[2] === parts[1]);
    if (hit) await env.STATE.delete(hit.name).catch(() => {});
    await ans("🗑 ဖျက်ပြီးပါပြီ", false);
    return dropRow();
  }
  if (tag === "td") {
    await env.STATE.delete("tpl:" + parts[1]).catch(() => {});
    await ans("🗑 Template ဖျက်ပြီးပါပြီ", false);
    const rows = (q.message.reply_markup?.inline_keyboard || []).filter((r) => !r.some((b) => b.callback_data === q.data));
    return tg(env, "editMessageReplyMarkup", { chat_id: chat, message_id: q.message.message_id, reply_markup: { inline_keyboard: rows } });
  }
  if (tag === "tu") {
    const tp = await env.STATE.get("tpl:" + parts[1], "json").catch(() => null);
    if (!tp) return ans("Template မတွေ့ပါ");
    await ans();
    return beginPost(env, chat, uid, tp.post);
  }

  // ----- sent posts -----
  if (tag === "sm" || tag === "sa") {
    const act = tag === "sa" ? parts[1] : "";
    const sk = parts.slice(tag === "sa" ? 2 : 1).join(":");
    const rec = await env.STATE.get(`sent:${sk}`, "json").catch(() => null);
    if (!rec) return ans("ဒီ post မတွေ့တော့ပါ");
    if (tag === "sm") {
      await ans(null);
      const p = rec.post;
      const prev = esc(plainTpl(p.html).replace(/\s+/g, " ").slice(0, 150) || (p.media ? `(${p.media.type}${p.album?.length ? " + album" : ""})` : ""));
      const rows = [
        [{ text: "✏️ စာပြင်", callback_data: `sa:edit:${sk}`, style: "primary" }, { text: "🗑 ဖျက်", callback_data: `sa:del:${sk}`, style: "danger" }],
        [...(p.media ? [{ text: "🖼 ပုံ/Video ပြောင်း", callback_data: `sa:media:${sk}`, style: "primary" }] : []), { text: "🔘 Button", callback_data: `sa:btn:${sk}`, style: "primary" }],
        [{ text: "📌 Pin", callback_data: `sa:pin:${sk}`, style: "success" }, { text: "📍 Unpin", callback_data: `sa:unpin:${sk}` }],
      ];
      rec.sent.slice(0, 4).forEach((s, i) => {
        if (String(s.c).startsWith("-100") && s.m[0]) rows.push([{ text: `🔗 Post ဖွင့်ကြည့်${rec.sent.length > 1 ? " " + (i + 1) : ""}`, url: `https://t.me/c/${String(s.c).slice(4)}/${s.m[0]}` }]);
      });
      rows.push(closeRow());
      return say(`🗂 <b>${whenLabel(rec.t)}</b> · ${rec.sent.length} နေရာ\n\n${prev}`, { reply_markup: { inline_keyboard: rows } });
    }
    if (act === "edit") {
      await env.STATE.put(key, JSON.stringify({ step: "edit", sk }), { expirationTtl: 6 * 3600 });
      await ans(null);
      return say("✏️ စာအသစ် ပို့ပါ (နေရာအားလုံးမှာ အစားထိုးမယ်၊ Button တွေ မပျောက်ပါ)" + (rec.post.media ? "\n(ပုံ/video ရဲ့ caption ကိုပဲ ပြင်တာပါ — ပုံပြောင်းချင်ရင် 🖼 ပုံ/Video ပြောင်း)" : ""), { reply_markup: cancelKb() });
    }
    if (act === "media") {
      if (!rec.post.media) return ans("စာသားချည်းပဲ Post မှာ ပုံ/video ထည့်လို့မရပါ (Telegram က စာ message ကို ပုံ message အဖြစ် မပြောင်းပေးပါ)၊ Post အသစ်တင်ပါ");
      await env.STATE.put(key, JSON.stringify({ step: "editmedia", sk }), { expirationTtl: 6 * 3600 });
      await ans(null);
      return say("🖼 ပုံ / video / GIF / file အသစ် ပို့ပါ (နေရာအားလုံးမှာ အစားထိုးမယ်၊ Button တွေ မပျောက်ပါ)\n• Caption ပါရင် caption အသစ်၊ မပါရင် မူလ caption ကို ဆက်သုံးမယ်" + (rec.sent.some((s) => s.m.length > 1) ? "\n• Album ဆိုရင် ပထမတစ်ခုပဲ အစားထိုးမယ်" : ""), { reply_markup: cancelKb() });
    }
    if (act === "btn") {
      await ans(null);
      const pn = btnPanel(rec, sk);
      return say(pn.text, { reply_markup: { inline_keyboard: pn.rows } });
    }
    if (act === "badd" || act === "bset") {
      await env.STATE.put(key, JSON.stringify({ step: "editbtn", sk, mode: act === "badd" ? "add" : "set" }), { expirationTtl: 6 * 3600 });
      await ans(null);
      return say(
        (act === "badd" ? "➕ Button အသစ်ထည့်မယ်" : "🔄 Button အားလုံးကို အစားထိုးမယ်") + " — တစ်ကြောင်းကို တစ်ခု ပို့ပါ (အများဆုံး ၈ ခု):\n<code>နာမည် | https://link</code>\n<code>နာမည် | https://link | green</code>\n(color: blue / green / red)",
        { reply_markup: cancelKb() }
      );
    }
    if (/^b[dcx]/.test(act)) {   // bd<N> = delete button N, bc<p|g|r|n> = color, bx = clear all
      const p = rec.post;
      if (act.startsWith("bd")) {
        const i = Number(act.slice(2));
        if (!(p.btns || [])[i]) return ans("ဒီ Button မတွေ့တော့ပါ");
        p.btns.splice(i, 1);
      } else if (act === "bx") {
        p.btns = [];
      } else {
        const style = { bcp: "primary", bcg: "success", bcr: "danger", bcn: "" }[act];
        if (style === undefined) return ans(null);
        p.color = style;
        p.btns = (p.btns || []).map((b) => ({ ...b, c: "" }));   // one color for all, same as when writing a post
      }
      const r = await applySentMarkup(env, rec);
      if (r.ok) await saveSent(env, sk, rec);
      await ans(`🔘 ${r.ok}/${rec.sent.length - r.skip} နေရာ ပြင်ပြီး` + (r.skip ? `\n(Album ${r.skip} နေရာ မပါ)` : "") + (r.err ? "\n" + r.err : ""), false);
      const cur = r.ok ? rec : (await env.STATE.get(`sent:${sk}`, "json").catch(() => null)) || rec;
      const pn = btnPanel(cur, sk);
      return tg(env, "editMessageText", { chat_id: chat, message_id: q.message.message_id, text: pn.text, parse_mode: "HTML", reply_markup: { inline_keyboard: pn.rows } }).catch(() => {});
    }
    if (act === "del") {
      let ok = 0, err = "";
      for (const s of rec.sent) {
        const r = await tg(env, "deleteMessages", { chat_id: s.c, message_ids: s.m }).catch(() => null);
        if (r?.ok) ok++; else err = err || r?.description || "";
      }
      if (ok === rec.sent.length) await env.STATE.delete(`sent:${sk}`).catch(() => {});
      await ans(`🗑 ${ok}/${rec.sent.length} နေရာ ဖျက်ပြီး${err ? "\n" + err : ""}`);
      return tg(env, "editMessageText", { chat_id: chat, message_id: q.message.message_id, text: `🗑 ဖျက်ပြီး — ${ok}/${rec.sent.length} နေရာ` + (err ? `\n⚠️ ${esc(err)}` : ""), parse_mode: "HTML" });
    }
    if (act === "pin" || act === "unpin") {
      let ok = 0, err = "";
      for (const s of rec.sent) {
        const r = await tg(env, act === "pin" ? "pinChatMessage" : "unpinChatMessage", { chat_id: s.c, message_id: s.m[0], ...(act === "pin" ? { disable_notification: true } : {}) }).catch(() => null);
        if (r?.ok) ok++; else err = err || r?.description || "";
      }
      return ans(`${act === "pin" ? "📌 Pin" : "📍 Unpin"} ${ok}/${rec.sent.length} နေရာ${err ? "\n" + err : ""}`);
    }
    return ans(null);
  }

  // ----- final confirmation before posting -----
  if (tag === "pk") {
    const s2 = await env.STATE.get(key, "json").catch(() => null);
    if (!s2 || s2.step !== "menu" || !(s2.post.html || s2.post.media)) return ans("ဒီ Post က တင်ပြီးသား (သို့) မရှိတော့ပါ");
    if (parts[1] === "n") {
      await ans(null);
      return tg(env, "editMessageText", { chat_id: chat, message_id: q.message.message_id, text: "↩️ မတင်သေးပါ — ဆက်ပြင်လို့ရပါတယ်", parse_mode: "HTML" });
    }
    await env.STATE.delete(key).catch(() => {});   // first, so a double tap posts once
    await ans("⏳ တင်နေပါတယ်...", false);
    const res = await publishPost(env, s2.post);
    await recordSent(env, s2.post, res, uid);
    await tg(env, "editMessageReplyMarkup", { chat_id: chat, message_id: q.message.message_id, reply_markup: { inline_keyboard: [] } }).catch(() => {});
    return say(postReport(res) + (res.ok ? "\n\n🗂 တင်ပြီးသား Post ကနေ ပြင်/ဖျက်လို့ရ" : ""), { reply_markup: NO_KB });
  }

  // ----- target picker -----
  const st = await env.STATE.get(key, "json").catch(() => null);
  if (!st || st.step !== "target") return ans("Post အသစ်ကို 📝 Post တင်ရန် နဲ့ ပြန်စပါ");
  const targets = await listTargets(env);
  const gid = parts[1];
  if (gid === "all") st.sel = st.sel.length === targets.length ? [] : targets.map((x) => x.id);
  else if (gid === "ok") {
    if (!st.sel.length) return ans("နေရာ အနည်းဆုံး ၁ ခု ရွေးပါ");
    st.post.targets = st.sel;
    const pre = !!(st.post.html || st.post.media);   // a template already has its content
    st.step = pre ? "menu" : "content";
    await env.STATE.put(key, JSON.stringify(st), { expirationTtl: 6 * 3600 });
    await ans(null);
    const names = targets.filter((x) => st.sel.includes(x.id)).map((x) => `${x.kind} ${esc(x.title)}`).join("\n");
    await tg(env, "editMessageText", { chat_id: chat, message_id: q.message.message_id, text: `📝 <b>တင်မယ့်နေရာ</b>\n${names}`, parse_mode: "HTML" });
    if (pre) {
      await sendPostTo(env, chat, st.post, true).catch(() => {});
      return say("📋 Template ဖွင့်ပြီးပါပြီ — အောက်က ခလုတ်တွေနဲ့ ဆက်လုပ်ပါ (စာပြင်ချင်ရင် 🔄 Content ပြန်ပို့)", { reply_markup: postKb(st.post) });
    }
    return say(CONTENT_TEXT, { reply_markup: contentKb() });
  } else if (targets.some((x) => x.id === gid)) st.sel = st.sel.includes(gid) ? st.sel.filter((x) => x !== gid) : [...st.sel, gid];
  await env.STATE.put(key, JSON.stringify(st), { expirationTtl: 6 * 3600 });
  await ans(null);
  return tg(env, "editMessageReplyMarkup", { chat_id: chat, message_id: q.message.message_id, reply_markup: targetKb(targets, st.sel) });
}

/* ---------- Bot flow ---------- */
const MENU_TEXT =
  "<b>🤖 PCA Name Check Bot</b>\n" +
  "Player ID + Server ID ပို့ရင် Name စစ်ပေးပါတယ်\n<code>123456789(2002)</code>\n(ရှေ့က <b>id</b> ခံရင် ပိုတိကျပါတယ်: <code>id 123456789(2002)</code>)\n\n" +
  "ဖတ်ချင်တာ ခလုတ်နှိပ်ပါ 👇";
const HELP_PAGES = {
  w: ["📝 Post တင်နည်း", POST_HELP_TEXT],
  n: ["🔎 Name စစ်နည်း",
    "<b>🔎 Name စစ်နည်း</b>\nGroup မှာ <code>123456789(2002)</code> လို့ပို့ရင် ရပါတယ်။ ရှေ့က <b>id</b> ခံရင် ပိုတိကျပါတယ်\n<code>id 123456789(2002)</code>\n\nServer မလိုတဲ့ game ဆိုရင် <b>id</b> ရှေ့ခံ ပို့ပါ\n<code>id 123456789</code> (DM မှာ id မလိုပါ)\n\n" +
    "Game နာမည်ပါ ထည့်ရင် ပိုမြန်ပြီး တိကျပါတယ်\n<code>mlbb 123456789(2002)</code>\n<code>sm 123456789(2002)</code>\n\n" +
    "Server ID မလိုတဲ့ game ဆိုရင် ID ပဲ ပို့ပါ\n<code>123456789</code>\n\n" +
    "ID နဲ့ Server ကို space ( ) | - , ဘာနဲ့ခြားခြား ရပါတယ်။\n\n" +
    "<b>🤖 Game နာမည် မထည့်ရင်</b>\n• ID + Server ပို့ရင် Server လိုတဲ့ game တွေကို အစဉ်လိုက် ရှာပြီး ပထမဆုံး တွေ့တဲ့ game ရဲ့ Card ၁ ခုပဲ ပြပါမယ်\n• ID ပဲ ပို့ရင် Server မလိုတဲ့ game တွေကိုပဲ ရှာပါမယ်\n• Game နာမည်ပေးပြီး Server မပါရင် Server ID တောင်းပါမယ် (Server list ရှိရင် တွဲပြပါမယ်)\n• Bot မေးတဲ့ စာကို reply လုပ်ပြီး ID ပို့လည်း ရပါတယ်၊ Game နာမည် ပြန်မရိုက်ရပါ\n\n<b>🔽 Server ရွေးရတဲ့ game</b> (ဥပမာ gi)\nGame နာမည် အရင်ရိုက်ပါ၊ ID ပို့ရင် Server ကို ခလုတ်နဲ့ ရွေးခိုင်းပါမယ်\n<code>gi 800123456</code> (သို့) <code>gi 800123456 asia</code>"],
  g: ["🎮 အတိုကောက်",
    "<b>🎮 အတိုကောက်</b>\nmlbb · ml · pubg · pubgm · codm · cod · ff · sm · hok · hsr · zzz · valo · bs · coc · cr · mcgg\n(Game နာမည်ရဲ့ ရှေ့စာလုံးတွေလည်း ရပါတယ်၊ ဥပမာ gi)\nGame များနေရင် ခလုတ်နဲ့ ရွေးခိုင်းပါမယ်။"],
  t: ["✈️ Telegram",
    "<b>✈️ Telegram (Stars / Premium)</b>\n<code>@username</code>\n(Group မှာ username တစ်ခုတည်း ပို့မှ စစ်ပါမယ်)"],
  r: ["✅ ရလဒ်",
    "<b>✅ ရလဒ်</b>\n• တွေ့ရင် ✅ Card — Game၊ နာမည်၊ ID (Server) နဲ့ <b>Copy ID</b>၊ <b>Store ဝင်ရန်</b> ခလုတ်\n• မတွေ့ရင် ❌ <b>Player Not found</b> — ID / Server ID ပြန်စစ်ပါ\n• ⚠️ <b>busy</b> ပြရင် Provider ပြဿနာပါ၊ ခဏနေ ပြန်စမ်းပါ\n• Voucher၊ Provider က နာမည်မပြန်တဲ့ game တွေကို စစ်လို့မရပါ"],
  p: ["📌 Group မှာ",
    "<b>📌 Group မှာ</b>\n• Card တွေ ၁ နာရီကြာရင် အလိုလို ပျက်ပါမယ်\n• ⏳ တစ်မိနစ်ကို ၃ ကြိမ်ပဲ စစ်လို့ရပါတယ် (မူလ)\n• ID မပါတဲ့ ပုံမှန်စကား ပြောရင် Bot က မပြန်ပါ\n• Bot ကို Private chat မှာ သတ်မှတ်ထားတဲ့ Owner ပဲ သုံးလို့ရ"],
  s: ["📜 စည်းကမ်း",
    "<b>📜 Group စည်းကမ်း</b> (Admin တွေကို မထိပါ)\n❌ Forward · Link (@username တစ်ခုတည်း ပို့တာတော့ ရ) · ရိုင်းတဲ့စကား\n❌ Spam — ၁၀ စက္ကန့်အတွင်း စာ ၅ စောင်ထက်များ၊ (သို့) တူတဲ့စာ ၁ မိနစ်အတွင်း ၃ ကြိမ်\n⚠️ ၁-၂ ကြိမ် သတိပေး → ၃ ကြိမ် ၁ နာရီ mute → ၄ ကြိမ် ban\n(နောက်ဆုံး သတိပေးချက်ကနေ ၂၄ နာရီကြာရင် ပျောက်ပါမယ်)\n\n" +
    "<b>🔒 Member အသစ်</b>\nCaptcha ဖွင့်ထားရင် ၅ မိနစ်အတွင်း ခလုတ်နှိပ်ရပါမယ်၊ မနှိပ်ရင် group ကနေ ထုတ်ပါမယ် (ပြန်ဝင်လို့ရ)။\n\n" +
    "<b>💬 FAQ</b>\nဈေး၊ ဘယ်လိုဝယ် စတဲ့ မေးခွန်းတွေကို Admin ထည့်ထားတဲ့အတိုင်း အလိုလို ပြန်ဖြေပါမယ်။"],
};
// Blue (primary) buttons, two per row. h:<page> opens a page, h:0 is the menu, h:a is the admin help (admins only).
const helpMenu = (admin = false, priv = false) => {
  const b = (k) => ({ text: HELP_PAGES[k][0], callback_data: "h:" + k, style: "primary" });
  const rows = [[b("n"), b("g")], [b("t"), b("r")], [b("p"), b("s")]];
  if (admin) rows.push([{ text: "🛠 Admin", callback_data: "h:a", style: "primary" }]);
  if (priv) rows.push([b("w")], closeRow());   // owner's private chat: Post how-to + ❌ ပိတ် (deletes the menu)
  return { inline_keyboard: rows };
};

/* ---------- Customer DM features ----------
   Customers can open the bot in private chat (owner switch: /set dmopen off). They get a menu with:
   🆔 My IDs (their last checked IDs, one tap to re-check) · 💰 Price list (from the store) · 📦 My orders (Done orders from
   the group order log, last 14 days) · 💳 Payment (same cards as the auto-reply) · 🌐 Language (မြန်မာ / English).
   Admin-only commands are untouched: they still need the owner (private) or a group admin. */
const LANGS = {
  my: {
    menuBody: "<b>🤖 PCA Name Check Bot</b>\nPlayer ID နဲ့ Server ID ပို့ရင် Name စစ်ပေးပါတယ်\n<code>123456789(2002)</code>\n\nအောက်က ခလုတ်တွေကိုလည်း သုံးလို့ရပါတယ် 👇",
    btnId: "🆔 ကျွန်တော့် ID များ", btnPrice: "💰 ဈေးနှုန်း", btnOrders: "📦 ကျွန်တော့် Order", btnPay: "💳 ငွေလွှဲရန်", btnLang: "🌐 Language", btnStore: "Store ဝင်ရန်", btnHelp: "ℹ️ အကူအညီ",
    noIds: "🆔 စစ်ထားတဲ့ ID မရှိသေးပါ။\nPlayer ID နဲ့ Server ID ပို့ပြီး စစ်ကြည့်ပါ။",
    idsTitle: "🆔 <b>ကျွန်တော့် ID များ</b>\nနှိပ်ရင် ပြန်စစ်ပေးပါမယ် 👇", btnClear: "🗑 အကုန်ဖျက်", idsCleared: "🗑 ဖျက်ပြီးပါပြီ",
    pickGame: "💰 <b>ဈေးနှုန်း</b>\nGame ရွေးပါ 👇", noPrice: "ဒီ game ရဲ့ ဈေးနှုန်း မတွေ့ပါ။", gameNotFound: (q) => `❌ <b>${q}</b> ဆိုတဲ့ game မတွေ့ပါ။`,
    priceNote: "ဈေးနှုန်းက Store ထဲကအတိုင်းပါ၊ ပြောင်းလဲနိုင်ပါတယ်။",
    ordersTitle: "📦 <b>ကျွန်တော့် Order</b> (Done ပြီးတာ၊ ရက် ၁၄ အတွင်း)", noOrders: "📦 Done ပြီးတဲ့ order မရှိသေးပါ (ရက် ၁၄ အတွင်း)။",
    langPick: "🌐 ဘာသာစကား ရွေးပါ", langSet: "✅ မြန်မာဘာသာ ပြောင်းပြီးပါပြီ",
    dmOnly: "🔒 ဒီ command ကို Bot နဲ့ private chat (DM) မှာ သုံးပါ။",
    offDefault: "🕐 ယခု Admin မရှိတဲ့ အချိန်ဖြစ်ပါတယ်။ Name စစ်တာ၊ ဈေးနှုန်း၊ ငွေလွှဲအချက်အလက်ကို Bot က ဆက်ပြီး ဖြေပေးပါမယ်။ Admin ပြန်ရောက်ရင် ဆက်သွယ်ပါမယ်။",
    dupReceipt: "⚠️ <b>ဒီ receipt ပုံကို အရင်က ပို့ဖူးပါတယ်</b>",
  },
  en: {
    menuBody: "<b>🤖 PCA Name Check Bot</b>\nSend a Player ID and Server ID to check the player name\n<code>123456789(2002)</code>\n\nYou can also use the buttons below 👇",
    btnId: "🆔 My IDs", btnPrice: "💰 Price list", btnOrders: "📦 My orders", btnPay: "💳 Payment", btnLang: "🌐 Language", btnStore: "Open Store", btnHelp: "ℹ️ Help",
    noIds: "🆔 No checked IDs yet.\nSend a Player ID and Server ID to check one.",
    idsTitle: "🆔 <b>My IDs</b>\nTap one to check it again 👇", btnClear: "🗑 Clear all", idsCleared: "🗑 Cleared",
    pickGame: "💰 <b>Price list</b>\nPick a game 👇", noPrice: "No prices found for this game.", gameNotFound: (q) => `❌ Game <b>${q}</b> not found.`,
    priceNote: "Prices are the same as in the store and may change.",
    ordersTitle: "📦 <b>My orders</b> (completed, last 14 days)", noOrders: "📦 No completed orders yet (last 14 days).",
    langPick: "🌐 Choose your language", langSet: "✅ Language set to English",
    dmOnly: "🔒 Please use this command in a private chat (DM) with the bot.",
    offDefault: "🕐 The admin is away right now. The bot still answers name checks, prices and payment details. The admin will get back to you later.",
    dupReceipt: "⚠️ <b>This receipt image was already sent before</b>",
  },
};
const L = (lang, k, ...a) => {
  const v = (LANGS[lang] || LANGS.my)[k];
  return typeof v === "function" ? v(...a) : v;
};
async function getLang(env, uid) {
  if (!env.STATE || !uid) return "my";
  return (await env.STATE.get("lang:" + uid).catch(() => null)) === "en" ? "en" : "my";
}
async function customerMenuMarkup(env, lang) {
  const rows = [
    [{ text: L(lang, "btnId"), callback_data: "mi:l", style: "primary" }, { text: L(lang, "btnPrice"), callback_data: "pr:l", style: "primary" }],
    [{ text: L(lang, "btnOrders"), callback_data: "mo:l", style: "primary" }, { text: L(lang, "btnPay"), callback_data: "pm:l", style: "primary" }],
    [{ text: L(lang, "btnLang"), callback_data: "lg:t" }, { text: L(lang, "btnHelp"), callback_data: "h:0" }],
  ];
  const store = await getStore(env);
  if (store) rows.push([{ text: L(lang, "btnStore"), url: store, style: "primary", ...ic(env, "ICON_STORE") }]);
  return { inline_keyboard: rows };
}
const sendCustomerMenu = async (env, chat, uid) => {
  const lang = await getLang(env, uid);
  return send(env, chat, L(lang, "menuBody"), { reply_markup: await customerMenuMarkup(env, lang) });
};

// ----- saved IDs (last 6 per person) -----
async function rememberId(env, uid, group, id, server) {
  if (!env.STATE || !uid || !id) return;
  const key = "ids:" + uid;
  let list = await env.STATE.get(key, "json").catch(() => null);
  if (!Array.isArray(list)) list = [];
  list = list.filter((x) => !(x.g === group.key && x.i === id && (x.s || "") === (server || "")));
  list.unshift({ g: group.key, n: group.name, i: id, s: server || "", t: Date.now() });
  await env.STATE.put(key, JSON.stringify(list.slice(0, 6)), { expirationTtl: 90 * 86400 }).catch(() => {});
}
async function showMyIds(env, chat, uid, lang) {
  const list = env.STATE ? await env.STATE.get("ids:" + uid, "json").catch(() => null) : null;
  if (!Array.isArray(list) || !list.length) return send(env, chat, L(lang, "noIds"));
  const rows = list.map((x, n) => [{ text: `🎮 ${x.n} · ${x.i}${x.s ? `(${x.s})` : ""}`.slice(0, 60), callback_data: `mi:${n}`, style: "primary" }]);
  rows.push([{ text: L(lang, "btnClear"), callback_data: "mi:x", style: "danger" }]);
  return send(env, chat, L(lang, "idsTitle"), { reply_markup: { inline_keyboard: rows } });
}

// ----- price list (straight from the store's games) -----
let PKG = { t: 0, map: null };
async function loadPackages(env) {
  if (PKG.map && Date.now() - PKG.t < 5 * 60 * 1000) return PKG.map;
  const map = new Map();
  let token = "";
  for (let i = 0; i < 10; i++) {
    const qs = new URLSearchParams({ pageSize: "300", key: env.FIREBASE_API_KEY || FS_KEY });
    ["name", "serverName", "packages", "order"].forEach((f) => qs.append("mask.fieldPaths", f));
    if (token) qs.set("pageToken", token);
    let j;
    try {
      const r = await fetch(`https://firestore.googleapis.com/v1/projects/${FS_PROJECT}/databases/(default)/documents/games?${qs}`);
      if (!r.ok) break;
      j = await r.json();
    } catch { break; }
    (j.documents || []).forEach((d) => {
      const o = fv({ mapValue: { fields: d.fields || {} } }) || {};
      if (!o.name) return;
      const key = String(o.name).trim().toLowerCase();
      if (!map.has(key)) map.set(key, []);
      map.get(key).push({ server: String(o.serverName || ""), packages: Array.isArray(o.packages) ? o.packages : [] });
    });
    token = j.nextPageToken || "";
    if (!token) break;
  }
  if (map.size) PKG = { t: Date.now(), map };
  return map.size ? map : PKG.map || new Map();
}
async function sendPricePicker(env, chat, lang, list) {
  const groups = list || (await loadGroups(env));
  if (!groups.length) return send(env, chat, L(lang, "noPrice"));
  const btns = groups.slice(0, 60).map((g) => ({ text: g.name.slice(0, 28), callback_data: `pr:${g.id}`, style: "primary" }));
  const rows = [];
  for (let i = 0; i < btns.length; i += 2) rows.push(btns.slice(i, i + 2));
  return send(env, chat, L(lang, "pickGame"), { reply_markup: { inline_keyboard: rows } });
}
// Bot API 10.3 rich message (sendRichMessage + HTML): heading, compact table and a button row inside the message.
// Returns true when Telegram accepted it. Any error -> false, and the caller sends the plain text version instead.
async function sendRichHtml(env, chat, html) {
  const r = await tg(env, "sendRichMessage", {
    chat_id: chat,
    rich_message: { html },
    ...(env.replyTo ? { reply_parameters: { message_id: env.replyTo, allow_sending_without_reply: true } } : {}),
  }).catch(() => null);
  if (r?.ok && Number(chat) < 0) await scheduleDelete(env, chat, r.result?.message_id);
  return !!r?.ok;
}
async function sendPriceRich(env, chat, group, entries, lang) {
  let h = `<h3>💰 ${esc(group.name)}</h3>`;
  for (const e of entries) {
    if (e.server && entries.length > 1) h += `<h4>${esc(e.server)}</h4>`;
    const rows = e.packages.filter((p) => p && p.amount && Number(p.price) > 0).slice(0, 40)
      .map((p) => `<tr><td>${esc(String(p.amount))}</td><td align="right"><b>${Number(p.price).toLocaleString("en-US")}</b> Ks</td></tr>`).join("");
    h += `<table bordered striped compact>${rows}</table>`;
  }
  h += `<p><i>${esc(L(lang, "priceNote"))}</i></p>`;
  const store = await getStore(env);
  const btns = [];
  if (store && /^https:\/\//.test(store)) btns.push(`<tg-button type="url" style="primary" url="${esc(store).replace(/"/g, "&quot;")}">${esc(L(lang, "btnStore"))}</tg-button>`);
  if (Number(chat) > 0) btns.push(`<tg-button type="callback_data" style="link" data="pr:l">⬅️ ${esc(L(lang, "btnPrice"))}</tg-button>`);
  if (btns.length) h += `<tg-button-row align="center">${btns.join("")}</tg-button-row>`;
  return sendRichHtml(env, chat, h);
}
async function sendPrice(env, chat, group, lang) {
  const map = await loadPackages(env);
  const entries = (map.get(group.key) || []).filter((e) => e.packages.some((p) => p && p.amount && Number(p.price) > 0));
  if (!entries.length) return send(env, chat, L(lang, "noPrice"));
  if (S.rich !== "off" && (await sendPriceRich(env, chat, group, entries, lang).catch(() => false))) return;   // fallback: the plain message below
  let out = `💰 <b>${esc(group.name)}</b>\n`;
  for (const e of entries) {
    if (e.server && entries.length > 1) out += `\n<b>${esc(e.server)}</b>\n`;
    else out += "\n";
    const lines = e.packages.filter((p) => p && p.amount && Number(p.price) > 0).slice(0, 40)
      .map((p) => `• ${esc(String(p.amount))} — <b>${Number(p.price).toLocaleString("en-US")}</b> Ks`);
    out += lines.join("\n") + "\n";
  }
  out += `\n<i>${L(lang, "priceNote")}</i>`;
  const store = await getStore(env);
  return send(env, chat, out.slice(0, 3900), store ? { reply_markup: { inline_keyboard: [[{ text: L(lang, "btnStore"), url: store, style: "primary", ...ic(env, "ICON_STORE") }]] } } : {});
}

// ----- my orders (Done orders in the group log whose asker is this person) -----
async function showMyOrders(env, chat, uid, lang) {
  if (!env.STATE) return send(env, chat, L(lang, "noOrders"));
  const days = await Promise.all(Array.from({ length: 14 }, (_, d) => listOrders(env, `ord:${dayStr(d)}:`, (x) => String(x.m) === String(uid))));
  const rows = days.flat().sort((a, b) => b.t - a.t).slice(0, 15);
  if (!rows.length) return send(env, chat, L(lang, "noOrders"));
  const cut = (t, n) => esc(String(t || "?").slice(0, n));
  return send(env, chat, `${L(lang, "ordersTitle")}\n\n` + rows.map((x) => `✅ ${mmDay(x.t)} ${mmTime(x.t)} · ${cut(x.g, 22)} · <code>${esc(x.i || "?")}</code>${x.s ? `(${esc(x.s)})` : ""}`).join("\n"));
}

// ----- language -----
const sendLangPicker = (env, chat, lang) =>
  send(env, chat, L(lang, "langPick"), { reply_markup: { inline_keyboard: [[{ text: "🇲🇲 မြန်မာ", callback_data: "lg:my", style: "primary" }, { text: "🇬🇧 English", callback_data: "lg:en", style: "primary" }]] } });

// /price /myids /myorders /language /menu (customers and members)
async function userCommand(env, m, chat, cmd, arg, isPrivate) {
  const uid = m.from?.id;
  const lang = await getLang(env, uid);
  if (cmd === "price") {
    if (!arg) return sendPricePicker(env, chat, lang);
    const groups = await loadGroups(env);
    const found = findGroups(groups, arg);
    if (found.length === 1) return sendPrice(env, chat, found[0], lang);
    if (found.length > 1) return sendPricePicker(env, chat, lang, found);
    return send(env, chat, L(lang, "gameNotFound", esc(arg)));
  }
  if (!isPrivate) return send(env, chat, L(lang, "dmOnly"));
  if (cmd === "myids") return showMyIds(env, chat, uid, lang);
  if (cmd === "myorders") return showMyOrders(env, chat, uid, lang);
  if (cmd === "language") return sendLangPicker(env, chat, lang);
  return sendCustomerMenu(env, chat, uid);
}
// Menu buttons in private chat: mi (my IDs) · pr (price) · mo (my orders) · pm (payment) · lg (language)
async function customerCallback(env, q, chat, tag, arg) {
  const uid = q.from.id;
  const lang = await getLang(env, uid);
  await tg(env, "answerCallbackQuery", { callback_query_id: q.id });
  if (q.message.chat.type !== "private") return;
  if (tag === "mi") {
    if (arg === "l") return showMyIds(env, chat, uid, lang);
    if (arg === "x") {
      if (env.STATE) await env.STATE.delete("ids:" + uid).catch(() => {});
      return send(env, chat, L(lang, "idsCleared"));
    }
    const list = env.STATE ? await env.STATE.get("ids:" + uid, "json").catch(() => null) : null;
    const item = Array.isArray(list) ? list[Number(arg)] : null;
    if (!item) return;
    const group = (await loadGroups(env)).find((g) => g.key === item.g);
    if (!group) return send(env, chat, L(lang, "gameNotFound", esc(item.n)));
    return runCheck({ ...env, requester: uid, ownerKb: idList(env.OWNER_IDS).includes(String(uid)) }, chat, group, item.i, item.s);
  }
  if (tag === "pr") {
    if (arg === "l") return sendPricePicker(env, chat, lang);
    const group = (await loadGroups(env)).find((g) => g.id === arg);
    return group ? sendPrice(env, chat, group, lang) : send(env, chat, L(lang, "noPrice"));
  }
  if (tag === "mo") return showMyOrders(env, chat, uid, lang);
  if (tag === "pm") {
    if (!(await payAutoReply({ ...env, replyTo: 0 }, chat, "/pay", false, true).catch(() => false))) return send(env, chat, L(lang, "noPrice"));
    return;
  }
  if (tag === "lg") {
    if (arg === "my" || arg === "en") {
      if (env.STATE) await env.STATE.put("lang:" + uid, arg, { expirationTtl: 365 * 86400 }).catch(() => {});
      return send(env, chat, L(arg, "langSet"), { reply_markup: await customerMenuMarkup(env, arg) });
    }
    return sendLangPicker(env, chat, lang);
  }
}

// DM opening hours (Myanmar time, "9-22"; set with /set dmhours 9-22). Outside them a customer gets the away note once every 3 hours.
function inDmHours() {
  const r = String(S.dmhours || "").match(/^(\d{1,2})\s*-\s*(\d{1,2})$/);
  if (!r) return true;
  const a = Number(r[1]), b = Number(r[2]);
  const h = Number(mmDate(Date.now()).slice(11, 13));
  return a <= b ? h >= a && h < b : h >= a || h < b;
}

// Same receipt image sent twice (Telegram's own file_unique_id): warn the group and the owners. Never blocks anything.
async function receiptDuplicateCheck(env, m, chat) {
  if (!env.STATE || !m.from || m.from.is_bot) return;
  const fu = m.photo?.length ? m.photo[m.photo.length - 1].file_unique_id : /^image\//.test(m.document?.mime_type || "") ? m.document.file_unique_id : "";
  if (!fu) return;
  const allowed = idList(env.ALLOWED_CHATS);
  if (allowed.length && !allowed.includes(String(chat))) return;
  const key = "ru:" + fu;
  const prev = await env.STATE.get(key, "json").catch(() => null);
  const who = [m.from.first_name, m.from.last_name].filter(Boolean).join(" ") || String(m.from.id);
  if (!prev) {
    await env.STATE.put(key, JSON.stringify({ u: m.from.id, n: who.slice(0, 40), t: Date.now(), c: String(chat) }), { expirationTtl: 30 * 86400 }).catch(() => {});
    return;
  }
  if (idList(env.OWNER_IDS).includes(String(m.from.id))) return;
  const lang = await getLang(env, m.from.id);
  const when = `${mmDay(prev.t)} ${mmTime(prev.t)}`;
  await sendCard({ ...env, replyTo: m.message_id }, chat, `${L(lang, "dupReceipt")}\n🕐 ${when} · ${esc(prev.n || "?")}`).catch(() => {});
  await notifyOwners(env, `⚠️ <b>Receipt ပုံတူ</b>\n${esc(who)} (<code>${m.from.id}</code>) ပို့တဲ့ ပုံကို ${when} မှာ ${esc(prev.n || "?")} ပို့ဖူးပြီး\nGroup: <code>${chat}</code>`);
}

// A member who keeps checking IDs that do not exist (guessing / scanning): tell the owners once.
async function notFoundWatch(env, chat) {
  const uid = env.requester || env.uid;
  if (!env.STATE || !uid || idList(env.OWNER_IDS).includes(String(uid))) return;
  const key = "nf:" + uid;
  const n = (Number(await env.STATE.get(key).catch(() => 0)) || 0) + 1;
  await env.STATE.put(key, String(n), { expirationTtl: 1800 }).catch(() => {});
  if (n === 8) await notifyOwners(env, `⚠️ <b>မတွေ့တဲ့ ID အကြိမ်များ</b>\nUser <code>${uid}</code> က ၃၀ မိနစ်အတွင်း မတွေ့တဲ့ ID ${n} ကြိမ် စစ်ထားတယ်\nChat: <code>${chat}</code>`);
}

// Group name checks need the word "id" in front of the number: "id 123456789(2002)", "ID: 123456789 2002",
// "mlbb id 123456789(2002)". Returns the text with that word taken out, or null when it is not there.
const ID_WORD = /(^|[^\p{L}\p{N}])(?:id|အိုင်ဒီ)[\s:：.\-–]*(?=\d{5,})/iu;
function stripIdWord(text) {
  const m = String(text || "").match(ID_WORD);
  return m ? String(text).replace(m[0], m[1] + " ").trim() : null;
}
// Bold / italic / mono / quote formatted messages (price lists, notices) are never auto-answered in groups.
const STYLE_ENTITIES = new Set(["bold", "italic", "underline", "strikethrough", "spoiler", "code", "pre", "blockquote", "expandable_blockquote"]);
const isFormatted = (m) => [...(m.entities || []), ...(m.caption_entities || [])].some((e) => STYLE_ENTITIES.has(e.type));

// Bot API 10.3: once an order is Done / Rejected the result button becomes a real DISABLED button
// ({ disabled: {} } = DisabledButton, it does nothing and cannot be tapped). If Telegram refuses it for any reason
// the old tappable button ("n" / "nr" -> "already done" popup) is used instead, so nothing ever breaks.
async function markResolved(env, chat, messageId, keep, text, style, legacyCb) {
  const body = (btn) => ({ chat_id: chat, message_id: messageId, reply_markup: { inline_keyboard: [...keep, [btn]] } });
  const r = await tg(env, "editMessageReplyMarkup", body({ text, disabled: {}, style })).catch(() => null);
  if (r && r.ok) return r;
  return tg(env, "editMessageReplyMarkup", body({ text, callback_data: legacyCb, style })).catch(() => null);
}

const doneRejectRow = (requester, env) => [
  { text: "Done", callback_data: `d:${requester}`, style: "success", ...ic(env, "ICON_DONE") },
  { text: "Reject", callback_data: `r:${requester}`, style: "danger", ...ic(env, "ICON_REJECT") },
];

// A receipt image arrived from this member (no caption). If their latest ID card is still waiting, add Done / Reject
// to it now; otherwise remember the receipt for 15 minutes so the ID they send next gets Done / Reject straight away.
async function receiptSeen(env, chat, uid) {
  const raw = await env.STATE.get(`lc:${chat}:${uid}`).catch(() => null);
  let card = null;
  try { card = raw ? JSON.parse(raw) : null; } catch (e) { card = null; }
  if (card && card.mid) {
    const r = await tg(env, "editMessageReplyMarkup", {
      chat_id: chat, message_id: card.mid,
      reply_markup: { inline_keyboard: [...card.rows, doneRejectRow(uid, env)] },
    }).catch(() => null);
    if (r && r.ok) {
      await env.STATE.delete(`lc:${chat}:${uid}`).catch(() => {});
      await trackPending(env, chat, card.mid, card.info, uid);
      return;
    }
  }
  await env.STATE.put(`rcpt:${chat}:${uid}`, "1", { expirationTtl: 900 }).catch(() => {});
}

async function handle(u, env) {
  if (u.callback_query) return onCallback(u.callback_query, env);
  if (u.my_chat_member) return onMyChat(u.my_chat_member, env);
  const m = u.message;
  if (!m) return;
  const chat = m.chat.id;
  const isGroup = m.chat.type === "group" || m.chat.type === "supergroup";
  const isPrivate = m.chat.type === "private";
  if (!isGroup && !isPrivate) return;
  // Group moderation runs on every message type (forwards, stickers, photos ...), before anything else.
  if (isGroup && (await moderate(m, env))) return;
  if (isGroup) await receiptDuplicateCheck(env, m, chat).catch((e) => console.error("dup", e));
  // Plain text, or the caption of a photo / forwarded image / file (e.g. a receipt with "ID (Server)" as its caption).
  // New members -> welcome message (admins edit it with /setwelcome).
  if (isGroup && m.new_chat_members?.length) return welcome(m, env);
  // Post composer: owner in private chat only (runs before the text check so photos / videos / forwards work).
  if (isPrivate && env.STATE && idList(env.OWNER_IDS).includes(String(m.from?.id)) && (await postFlow({ ...env, uid: m.from.id, requester: m.from.id, junk: true }, m))) {
    await tg(env, "deleteMessage", { chat_id: chat, message_id: m.message_id }).catch(() => {});   // typed / tapped input is used up
    return;
  }
  const raw = m.text || m.caption;
  const isImage = !!(m.photo?.length || /^image\//.test(m.document?.mime_type || ""));
  // A receipt photo WITHOUT a caption (sent before or after the ID): remember it, or attach Done / Reject to the
  // customer's latest ID card. Done / Reject only ever appear once receipt + ID are both there.
  if (!raw && isGroup && isImage && m.from && !m.from.is_bot && env.STATE) {
    const allowed = idList(env.ALLOWED_CHATS);
    if (!allowed.length || allowed.includes(String(chat))) await receiptSeen({ ...env, uid: m.from.id }, chat, m.from.id);
    return;
  }
  if (!raw) return;
  const text = raw.trim();
  env = { ...env, uid: m.from?.id };
  if (isGroup) {
    if (m.from?.is_bot) return;
    // hasReceipt: the message carries an image (receipt photo, or an image sent as a file), or this member sent one
    // a moment ago. Only then does the result card get Done / Reject; a plain ID check gets Copy ID (+ Store) only.
    let hasReceipt = isImage;
    if (!hasReceipt && env.STATE && m.from) hasReceipt = !!(await env.STATE.get(`rcpt:${chat}:${m.from.id}`).catch(() => null));
    env = { ...env, replyTo: m.message_id, requester: m.from?.id, hasReceipt }; // reply to the asker; remember who asked
  } else {
    env = { ...env, requester: m.from?.id, ownerKb: idList(env.OWNER_IDS).includes(String(m.from?.id)) };   // private chat (owner): result cards get the same Done / Copy buttons
  }

  // A command addressed to another bot ("/help@OtherBot") is not ours: with privacy mode off we still receive it.
  const addr = isGroup ? text.match(/^\/\w+@(\w+)/) : null;
  if (addr) {
    const me = await botName(env);
    if (me && addr[1].toLowerCase() !== me) return;
  }

  // /id -> shows your user ID / chat ID (use it to fill OWNER_IDS / ALLOWED_CHATS).
  if (/^\/id(@\w+)?$/i.test(text))
    return send(env, chat, `🆔 User ID: <code>${m.from?.id}</code>\n💬 Chat ID: <code>${chat}</code>`);

  // Payment auto-reply (kpay / wave ... or /pay). Runs BEFORE the private-chat owner lock below, so customers
  // can ask in DM too. Groups: only the allowed groups. Messages with a long ID are name checks, not questions.
  {
    const isPayCmd = /^\/pay(@\w+)?(\s|$)/i.test(text);
    const chatOk = isPrivate || !idList(env.ALLOWED_CHATS).length || idList(env.ALLOWED_CHATS).includes(String(chat));
    if (chatOk && (isPayCmd || S.pay !== "off") && (isPayCmd || (!text.startsWith("/") && !/\d{5,}/.test(text) && text.length <= 200 && !(isGroup && isFormatted(m))))) {
      if (await payAutoReply(env, chat, text, isGroup, isPayCmd).catch((e) => { console.error("pay", e); return false; })) return;
    }
  }

  // Access rules: groups are open to every member; private chat is owner-only (when OWNER_IDS is set).
  const owners = idList(env.OWNER_IDS);
  const isOwnerUser = owners.includes(String(m.from?.id));
  if (isPrivate && owners.length && !isOwnerUser && S.dmopen === "off")
    return send(env, chat, "🔒 ဒီ bot ကို သတ်မှတ်ထားတဲ့ group ထဲမှာပဲ သုံးလို့ရပါတယ်။");
  if (isPrivate && !isOwnerUser && env.STATE && !inDmHours()) {   // away note, once every 3 hours (the bot keeps answering)
    const ok = "off:" + m.from?.id;
    if (!(await env.STATE.get(ok).catch(() => null))) {
      await env.STATE.put(ok, "1", { expirationTtl: 3 * 3600 }).catch(() => {});
      await send(env, chat, S.offmsg ? esc(S.offmsg) : L(await getLang(env, m.from?.id), "offDefault"));
    }
  }
  const allowedChats = idList(env.ALLOWED_CHATS);
  if (isGroup && allowedChats.length && !allowedChats.includes(String(chat))) return;
  if (isGroup && env.STATE && !SEEN_GRP.has(chat)) {   // remembered for /groups and /announce
    SEEN_GRP.add(chat);
    await env.STATE.put("grp:" + chat, String(m.chat.title || "").slice(0, 60)).catch(() => {});
  }

  if (isPrivate && !isOwnerUser && /^\/(start|help|menu)(@\w+)?(\s|$)/i.test(text)) return sendCustomerMenu(env, chat, m.from?.id);
  const ucm = text.match(/^\/(myids|myorders|price|language|menu)(?:@\w+)?(?:\s+([\s\S]*))?$/i);
  if (ucm) return userCommand(env, m, chat, ucm[1].toLowerCase(), (ucm[2] || "").trim(), isPrivate);
  if (/^\/(start|help)(@\w+)?(\s|$)/i.test(text)) {
    if (isPrivate && owners.includes(String(m.from?.id))) await send({ ...env, replyTo: 0, junk: true }, chat, "⌨️ Menu ခလုတ်တွေ အောက်မှာ ပေါ်နေပါပြီ 👇", { reply_markup: mainKb() });
    const isAdm = owners.includes(String(m.from?.id)) || (isGroup && (await isAdmin(env, chat, m.from?.id)));   // the Admin button is shown to admins only
    return sendCard(env, chat, MENU_TEXT, { reply_markup: helpMenu(isAdm, isPrivate) }, 10 * 60 * 1000);
  } // group: removed after 10 min
  if (await adminCommand(env, m, text, isGroup, owners)) return;
  const cm = text.match(/^\/([A-Za-z0-9_]{2,20})(?:@\w+)?\s*$/);
  if (cm && S.cmds && S.cmds[cm[1].toLowerCase()]) return sendCard(env, chat, faqHtml(S.cmds[cm[1].toLowerCase()]));

  // FAQ auto-reply ("ဈေး", "ဘယ်လိုဝယ်" ...): keywords and answers are set with /addfaq. Messages with an ID are name checks, not questions.
  if (!/\d{5,}/.test(text) && !(isGroup && isFormatted(m))) {
    const faq = await matchFaq(env, chat, text);
    if (faq) return sendCard(env, chat, faqHtml(faq));
  }

  // /reload (owners only): refresh the game list now instead of waiting for the 5-minute cache.
  if (/^\/reload(@\w+)?$/i.test(text)) {
    if (!owners.includes(String(m.from?.id))) return;
    CACHE = { t: 0, groups: null };
    MEM.clear();
    SERVERS.clear();
    const fresh = await loadGroups(env);
    return send(env, chat, fresh.length
      ? `🔄 Game list refresh လုပ်ပြီးပါပြီ\n✅ စစ်လို့ရတဲ့ game: ${fresh.length}\n🔽 Server dropdown game: ${fresh.filter((g) => g.dropdown).length}`
      : "⚠️ Game list မရနိုင်သေးပါ။");
  }

  // Telegram username (Stars / Premium): "@name", "t.me/name" or "https://t.me/name".
  // In groups only a message that is JUST the username triggers a check (avoids reacting to @mentions in chatter).
  const tgUser = text.match(isGroup ? /^(?:@|(?:https?:\/\/)?t\.me\/)([A-Za-z][A-Za-z0-9_]{3,31})$/i : /(?:^|\s)@([A-Za-z][A-Za-z0-9_]{3,31})(?=\s|$)|t\.me\/([A-Za-z][A-Za-z0-9_]{3,31})/i);
  if (tgUser) return checkTelegramUser(env, chat, tgUser[1] || tgUser[2]);

  // Groups: a number is only treated as a Player ID when it is written as ID(Server), or has "id" in front of it (or answers the bot's
  // own prompt / result card). Price lists, order numbers and chatter are left alone. /set idprefix off turns this off.
  const idStripped = isGroup ? stripIdWord(text) : null;
  const rt0 = m.reply_to_message?.text || "";
  const answersBot = !!m.reply_to_message?.from?.is_bot && (/🎮/.test(rt0) || isCardText(rt0));
  const bracketForm = isGroup && /\d{5,}\s*[(（]\s*\d{1,6}\s*[)）]/.test(text);   // "123456789(2002)" is clear enough without "id"
  if (isGroup && S.idprefix !== "off" && idStripped === null && !bracketForm && !answersBot) return;
  const p = parseInput(idStripped !== null ? idStripped : text);
  const repliedToBot = !!m.reply_to_message?.from?.is_bot;
  // In groups stay silent on normal chatter: only react to messages that look like a check.
  if (isGroup && (!p.id || (!p.server && !p.query && !repliedToBot))) return;

  const groups = await loadGroups(env);
  if (!groups.length) return send(env, chat, "⚠️ Game list မရနိုင်သေးပါ။ ခဏနေ ပြန်စမ်းပါ။");

  // Game remembered from a replied-to bot message, or from the last check in this chat.
  let known = null;
  const rt = m.reply_to_message?.text || "";
  // Replying to a bot message keeps its game: the "🎮 Game" prompt, or the game line of a result card.
  const replied = rt.match(/🎮\s*([^\n]+)/) || (repliedToBot && isCardText(rt) && cardInfo(rt).game ? [null, cardInfo(rt).game] : null);
  if (replied) known = groups.find((g) => g.key === replied[1].trim().toLowerCase()) || null;
  if (!known && env.STATE) {
    const k = await env.STATE.get("g:" + chat);
    known = groups.find((g) => g.key === k) || null;
  }

  let group = null;
  let id = p.id, server = p.server;
  if (p.query) {
    const found = findGroups(groups, p.query);
    if (found.length === 1) group = found[0];
    else if (found.length > 1) return chooseGame(env, chat, found, id, server);
    else if ((groups.hidden || []).length && findGroups(groups.hidden, p.query).length) return; // server-dropdown game: no reply
    else if (known && !p.id && p.tokens.length <= 3) {
      // no game name matched -> treat the text as an ID (some games use letters in IDs)
      group = known;
      id = p.tokens[0];
      server = p.tokens[1] || "";
    } else {
      if (isGroup) return;
      return send(env, chat, `❌ <b>${esc(p.query)}</b> ဆိုတဲ့ game မတွေ့ပါ။\nStore ထဲက game နာမည် ပြန်ရိုက်ပါ။`);
    }
  } else if (replied && known) {
    // replying to the bot's "🎮 Game" prompt -> keep that game
    group = known;
  } else if (id && server) {
    // No game name: ID + Server only -> auto-scan every checkable game.
    return autoScan(env, chat, groups, id, server);
  } else if (id) {
    // ID only, no game name -> scan the games that need no Server ID.
    if (groups.some((g) => g.idOnly)) return autoScan(env, chat, groups, id, "");
    return send(env, chat, "Server ID လိုပါတယ်\nဥပမာ: <code>" + esc(id) + "(2002)</code>");
  } else {
    group = known;
  }
  if (!group) return isGroup ? undefined : isOwnerUser ? send(env, chat, MENU_TEXT, { reply_markup: helpMenu(true) }) : sendCustomerMenu(env, chat, m.from?.id);
  return runCheck(env, chat, group, id, server);
}

/* ---------- Payment auto-reply (KPay / Wave / ...) ----------
   A message that mentions a payment method (kpay, wave, aya pay ... or any name listed in the store's
   Firestore "paymentMethods") gets that method's account NAME + NUMBER back, with native Copy buttons
   (copy_text: one tap copies the number / the name). Works in groups and in private chat (customers too,
   not only owners). A generic question ("ငွေလွှဲမယ်", "payment", "account number" ...) lists every method.
   /pay            -> every method          /pay kpay wave -> only those
   Data = the same paymentMethods the store shows: name, number, accountName, availabilityNote, qrImage.
   Cache 2 min; same method answered at most once a minute per group (DM: always). */
const PAY_GROUPS = [
  { words: ["kpay", "k pay", "kbzpay", "kbz pay", "kbz", "ကေပေး", "ကေပေ"], names: ["kpay", "kbz"] },
  { words: ["wave", "wavepay", "wave pay", "wave money", "wavemoney", "ဝေ့ဗ်", "ဝေ့"], names: ["wave"] },
  { words: ["ayapay", "aya pay", "aya", "အေအိုင်ဝိုင်"], names: ["aya"] },
  { words: ["cbpay", "cb pay", "cbbank", "cb bank"], names: ["cbpay", "cbbank", "cb"] },
  { words: ["uabpay", "uab pay", "uab"], names: ["uab"] },
  { words: ["mpt", "mptmoney", "mpt money"], names: ["mpt"] },
  { words: ["onepay", "one pay"], names: ["onepay"] },
];
const PAY_GENERIC = [
  "payment", "pay လုပ်", "pay နံပါတ်", "account number", "acc number", "ငွေလွှဲ", "ငွေလွဲ", "ငွေပေးချေ", "ငွေသွင်း", "ငွေပေး",
  "အကောင့်နံပါတ်", "ဘယ်ကိုလွှဲ", "ဘယ်လိုလွှဲ", "ဘယ်လိုပေး", "ဘယ်နံပါတ်", "ဘဏ်နံပါတ်",
];
let PAYM = { t: 0, list: [] };
async function getPayMethods(env) {
  if (PAYM.list.length && Date.now() - PAYM.t < 2 * 60 * 1000) return PAYM.list;
  const out = [];
  let token = "";
  for (let i = 0; i < 3; i++) {
    const qs = new URLSearchParams({ pageSize: "100", key: env.FIREBASE_API_KEY || FS_KEY });
    ["name", "number", "accountName", "availabilityNote", "qrImage", "order"].forEach((f) => qs.append("mask.fieldPaths", f));
    if (token) qs.set("pageToken", token);
    let j;
    try {
      const r = await fetch(`https://firestore.googleapis.com/v1/projects/${FS_PROJECT}/databases/(default)/documents/paymentMethods?${qs}`);
      if (!r.ok) break;
      j = await r.json();
    } catch { break; }
    (j.documents || []).forEach((d) => {
      const o = fv({ mapValue: { fields: d.fields || {} } }) || {};
      if (o.name && o.number) out.push({ id: d.name.split("/").pop(), ...o });
    });
    token = j.nextPageToken || "";
    if (!token) break;
  }
  out.sort((a, b) => (typeof a.order === "number" ? a.order : 1e9) - (typeof b.order === "number" ? b.order : 1e9));
  if (out.length) PAYM = { t: Date.now(), list: out };
  return out.length ? out : PAYM.list;
}
const payNorm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9\u1000-\u109f]/g, "");
// Latin words must stand alone ("aya" must not fire inside "maya"); Burmese words just need to be contained.
function hasWord(text, w) {
  if (/[\u1000-\u109f]/.test(w)) return text.includes(w);
  const re = new RegExp("(^|[^a-z0-9])" + w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/ /g, "\\s*") + "([^a-z0-9]|$)");
  return re.test(text);
}
// "I already paid" chatter must NOT trigger the account details again.
const PAY_DONE = /လွှဲ(ပြီး|လိုက်ပြီ|ထား)|လွဲ(ပြီး|လိုက်ပြီ|ထား)|ပေးပြီး|ပေးလိုက်ပြီ|ပို့ပြီး|ပို့လိုက်ပြီ|သွင်းပြီး|သွင်းထား|\bpaid\b|\bdone\b|\bsent\b|receipt|slip|screenshot/i;
const PAY_ASK = /[?？]|ဘယ်|လား|ပေးပါ|ပို့ပါ|ပြောပါ|ရှိ|number|နံပါတ်|\bno\b|\bacc/i;
// Which payment methods does this text ask for? -> { list, all }
async function payWanted(env, text, forced) {
  const methods = await getPayMethods(env);
  if (!methods.length) return { list: [], all: false };
  if (!forced && PAY_DONE.test(text)) return { list: [], all: false };
  const t = normText(text);
  const hit = new Map();
  for (const g of PAY_GROUPS) {
    if (!g.words.some((w) => hasWord(t, w))) continue;
    methods.forEach((m) => { if (g.names.some((n) => payNorm(m.name).includes(n))) hit.set(m.id, m); });
  }
  // any other method named exactly in the message (custom names the admin added in the store)
  methods.forEach((m) => {
    const n = String(m.name).toLowerCase().trim();
    if (n.length >= 3 && hasWord(t, n)) hit.set(m.id, m);
  });
  for (const [key, words] of Object.entries(S.payWords || {})) {   // extra keywords added with /payword
    if (!(words || []).some((w) => hasWord(t, String(w).toLowerCase()))) continue;
    methods.forEach((m) => { if (payNorm(m.name).includes(payNorm(key))) hit.set(m.id, m); });
  }
  if (hit.size) return { list: methods.filter((m) => hit.has(m.id)), all: false };
  if (forced || (PAY_ASK.test(text) && PAY_GENERIC.some((w) => t.includes(w)))) return { list: methods, all: true };
  return { list: [], all: false };
}
const payPhone = (n) => String(n).replace(/[\s-]/g, "").slice(0, 256);
function payCard(list) {
  return list.map((m) =>
    `<blockquote><b>💳 ${esc(m.name)}</b></blockquote>\n` +
    `👤 <b>Name:</b> <code>${esc(m.accountName || "-")}</code>\n` +
    `📱 <b>Number:</b> <code>${esc(m.number)}</code>` +
    (m.availabilityNote ? `\n🕐 ${esc(m.availabilityNote)}` : "")
  ).join("\n\n") + (S.payMsg ? "\n\n" + tplHtml(S.payMsg) : "");
}
function payButtons(env, list) {
  const single = list.length === 1;
  const rows = [];
  for (const m of list) {
    const row = [{ text: single ? "📋 Copy Number" : `📋 ${m.name} No.`.slice(0, 32), copy_text: { text: payPhone(m.number) }, style: "primary", ...ic(env, "ICON_COPY") }];
    if (m.accountName) row.push({ text: single ? "📋 Copy Name" : `📋 ${m.name} Name`.slice(0, 32), copy_text: { text: String(m.accountName).slice(0, 256) }, style: "primary", ...ic(env, "ICON_COPY") });
    rows.push(row);
  }
  return { inline_keyboard: rows };
}
// -> true when the message was answered. `forced` = the /pay command.
async function payAutoReply(env, chat, text, isGroup, forced = false) {
  let q = text;
  if (forced) q = text.replace(/^\/pay(@\w+)?/i, "").trim();
  const { list, all } = await payWanted(env, q, forced);
  if (!list.length) return false;
  if (isGroup && !forced) {   // same answer at most once a minute per group
    const key = chat + ":pay:" + (all ? "all" : list.map((m) => m.id).join(","));
    if (Date.now() - (FAQ_COOL.get(key) || 0) < 60 * 1000) return true;   // already answered a moment ago: stay quiet but swallow
    if (FAQ_COOL.size > 2000) FAQ_COOL.clear();
    FAQ_COOL.set(key, Date.now());
  }
  const html = payCard(list);
  const markup = payButtons(env, list);
  const one = list.length === 1 ? list[0] : null;
  if (one && /^https:\/\//.test(one.qrImage || "")) {   // a single method with a QR: photo + the same card as caption
    const r = await tg(env, "sendPhoto", {
      chat_id: chat, photo: one.qrImage, caption: html, parse_mode: "HTML", reply_markup: markup,
      ...(env.replyTo ? { reply_parameters: { message_id: env.replyTo, allow_sending_without_reply: true } } : {}),
    }).catch(() => null);
    if (r?.ok) {
      if (Number(chat) < 0) await scheduleDelete(env, chat, r.result.message_id);
      return true;
    }
  }
  await sendCard(env, chat, html, { reply_markup: markup });
  return true;
}

/* ---------- Telegram Stars / Premium username check (G2Bulk game code "Telegram") ---------- */
async function checkTelegramUser(env, chat, username) {
  if (await maintBlock(env, chat)) return;
  if (await limited(env, chat)) return;
  await tg(env, "sendChatAction", { chat_id: chat, action: "typing" });
  const r = await cachedG2("Telegram", username, "");
  if (r.outcome === "valid") {
    await stat(env, "found", "Telegram");
    return sendCard(env, chat, cardText("Telegram", `✅ ${esc(r.name)}`, `<code>@${esc(username)}</code>`));
  }
  if (r.outcome === "unknown") return busy(env, chat, [r]);
  await stat(env, "notfound", "Telegram");
  return sendCard(env, chat, cardText("Telegram", "❌ Username not found", `<code>@${esc(username)}</code>`));
}

/* ---------- Auto scan (no game name) ---------- */
const SCAN_CONCURRENCY = 6;      // parallel provider calls
const SCAN_BUDGET_MS = 24000;    // stop launching new checks after this (waitUntil limit is ~30s)

async function autoScan(env, chat, groups, id, server) {
  if (await maintBlock(env, chat)) return;
  // With a Server ID -> games that need one; without -> ID-only games.
  groups = groups.filter((g) => !g.dropdown && (server ? !g.idOnly : g.idOnly));
  if (!groups.length) return;
  if (await limited(env, chat)) return;
  const note = await send(env, chat, `🔍 <b>စစ်နေပါတယ်...</b>\n🆔 <code>${esc(id)}</code>${server ? ` (${esc(server)})` : ""}`);
  const noteId = note?.result?.message_id;
  const started = Date.now();

  // Unique provider calls (identical G2Bulk code / Fazer category are shared across regions & groups).
  const calls = new Map(); // key -> { run, result }
  const plan = groups.map((group) => ({
    group,
    items: group.entries.map((g) => {
      const g2 = !!g.g2bulkCode;
      const key = (g2 ? "g:" + g.g2bulkCode : "f:" + g.fazercardCategoryId) + "|" + id + "|" + server;
      if (!calls.has(key)) calls.set(key, { run: () => callProvider(g, id, server), result: null });
      return { g, g2, key };
    }),
  }));

  // Check games in priority (store) order, a few at a time, and STOP at the first game that really has this player.
  // One ID -> one game -> one card.
  const runItems = (pl) =>
    Promise.all(
      pl.items.map(async (x) => {
        const c = calls.get(x.key);
        if (!c.result) c.result = await c.run().catch(() => ({ outcome: "unknown" }));
      })
    );
  let skipped = 0;
  let hits = 0;
  let cursor = 0;
  while (cursor < plan.length && !hits) {
    if (Date.now() - started > SCAN_BUDGET_MS) { skipped = plan.length - cursor; break; }
    const batch = plan.slice(cursor, cursor + SCAN_CONCURRENCY);
    cursor += batch.length;
    await Promise.all(batch.map(runItems));
    for (const { group, items } of batch) {   // batch is in priority order -> first valid game wins
      const results = items.map((x) => ({ g: x.g, g2: x.g2, r: calls.get(x.key).result })).filter((x) => x.r);
      if (results.some((x) => x.r.outcome === "valid")) {
        if (env.STATE) await env.STATE.put("g:" + chat, group.key, { expirationTtl: 86400 });
        hits += await sendValid(env, chat, group, results, id, server, 1);
        break;
      }
    }
  }
  const allResults = [...calls.values()].map((c) => c.result).filter(Boolean);

  if (noteId) await tg(env, "deleteMessage", { chat_id: chat, message_id: noteId }).catch(() => {});
  const partial = skipped ? `\n\n⏱ Game ${skipped} ခုကို အချိန်မလောက်လို့ မစစ်လိုက်ရပါ။ ပြန်စမ်းကြည့်ပါ။` : "";
  if (hits) return partial ? send(env, chat, partial.trim()) : undefined;
  const scanned = allResults.filter((r) => r.outcome !== "skip");
  if (scanned.length && scanned.every((r) => r.outcome === "unknown")) return busy(env, chat, scanned, partial);
  await stat(env, "notfound", null);
  await notFoundWatch(env, chat).catch(() => {});
  return sendCard(env, chat, cardText("", "❌ Player Not found", `<code>${esc(id)}</code>${server ? ` (${esc(server)})` : ""}\n(${server ? "ID / Server ID ကို စစ်ကြည့်ပါ" : "ID ကို စစ်ကြည့်ပါ၊ Server ID ရှိရင် ထည့်ပို့ပါ"})`) + partial);
}

async function onCallback(q, env) {
  env = { ...env, uid: q.from.id };
  const chat = q.message.chat.id;
  const owners = idList(env.OWNER_IDS);
  const allowedChats = idList(env.ALLOWED_CHATS);
  const inGroup = q.message.chat.type !== "private";
  const blocked =
    (!inGroup && owners.length && !owners.includes(String(q.from.id)) && S.dmopen === "off") ||
    (inGroup && allowedChats.length && !allowedChats.includes(String(chat)));
  if (blocked) return tg(env, "answerCallbackQuery", { callback_query_id: q.id, text: "🔒 သုံးခွင့်မရှိပါ", show_alert: true });

  const [tag, gid, id = "", server = ""] = String(q.data || "").split(":");

  // Done (group result cards): only group admins / bot owners. Replaces the button with "Done - <admin name>"
  // and tells the member who asked (reply + tag) that the order is finished.
  if (tag === "d") {
    const ok = owners.includes(String(q.from.id)) || (await isAdmin(env, chat, q.from.id));
    if (!ok)
      return tg(env, "answerCallbackQuery", { callback_query_id: q.id, text: "⛔ Admin ပဲ နှိပ်လို့ရပါတယ်", show_alert: true });
    await tg(env, "answerCallbackQuery", { callback_query_id: q.id });
    const keep = (q.message.reply_markup?.inline_keyboard || []).filter((r) => !r.some((b) => ["d", "r"].includes(String(b.callback_data || "").split(":")[0])));
    const who = [q.from.first_name, q.from.last_name].filter(Boolean).join(" ") || "Admin";
    await markResolved(env, chat, q.message.message_id, keep, `Done - ${who}`.slice(0, 60), "success", "n");
    const asker = q.message.reply_to_message?.from;
    const rid = asker?.id || Number(gid) || 0;
    await logOrder(env, q, chat, who, rid, asker).catch((e) => console.error(e)); // record only, never blocks
    if (rid && inGroup) {
      const tpl = await getDoneText(env);
      const text = renderWelcome(tpl, [{ id: rid, first_name: asker?.first_name || "Member", last_name: asker?.last_name }], q.message.chat.title);
      await sendCard({ ...env, replyTo: q.message.reply_to_message?.message_id || 0 }, chat, text);
    }
    return;
  }
  if (tag === "n") return tg(env, "answerCallbackQuery", { callback_query_id: q.id, text: "Done ပြီးသား ဖြစ်ပါတယ်" });

  // Reject (group result cards): same rules as Done. Replaces the row with "Reject - <admin name>", stops the
  // "not done yet" reminder, does not count as a Done order, and tells the member who asked.
  if (tag === "r") {
    const ok = owners.includes(String(q.from.id)) || (await isAdmin(env, chat, q.from.id));
    if (!ok)
      return tg(env, "answerCallbackQuery", { callback_query_id: q.id, text: "⛔ Admin ပဲ နှိပ်လို့ရပါတယ်", show_alert: true });
    await tg(env, "answerCallbackQuery", { callback_query_id: q.id });
    const keep = (q.message.reply_markup?.inline_keyboard || []).filter((r) => !r.some((b) => ["d", "r"].includes(String(b.callback_data || "").split(":")[0])));
    const who = [q.from.first_name, q.from.last_name].filter(Boolean).join(" ") || "Admin";
    await markResolved(env, chat, q.message.message_id, keep, `Reject - ${who}`.slice(0, 60), "danger", "nr");
    if (env.STATE) await env.STATE.put(`done:${chat}:${q.message.message_id}`, "1", { expirationTtl: Math.max(3 * 3600, Math.ceil(pendingMs() / 1000) + 3600) }).catch(() => {});   // stops the reminder
    const asker = q.message.reply_to_message?.from;
    const rid = asker?.id || Number(gid) || 0;
    if (rid && inGroup) {
      const text = renderWelcome(DEFAULT_REJECT, [{ id: rid, first_name: asker?.first_name || "Member", last_name: asker?.last_name }], q.message.chat.title);
      await sendCard({ ...env, replyTo: q.message.reply_to_message?.message_id || 0 }, chat, text);
    }
    return;
  }
  if (tag === "nr") return tg(env, "answerCallbackQuery", { callback_query_id: q.id, text: "Reject လုပ်ပြီးသား ဖြစ်ပါတယ်" });

  if (["mi", "pr", "mo", "pm", "lg"].includes(tag)) return customerCallback(env, q, chat, tag, gid);

  // Post composer buttons (owner, private chat): target picker, schedule / channel / template / sent-post actions.
  if (["pt", "ps", "pc", "pa", "pz", "tu", "td", "sm", "sa", "pk"].includes(tag)) {
    if (inGroup || !env.STATE || !owners.includes(String(q.from.id)))
      return tg(env, "answerCallbackQuery", { callback_query_id: q.id, text: "⛔ Owner ပဲ သုံးလို့ရပါတယ်", show_alert: true });
    return postCallback(q, { ...env, junk: true });
  }

  // Captcha button: only the new member himself. Gives the send permission back.
  if (tag === "v") {
    if (String(q.from.id) !== gid)
      return tg(env, "answerCallbackQuery", { callback_query_id: q.id, text: "ဒီခလုတ်က အသစ်ဝင်လာတဲ့သူအတွက်ပါ", show_alert: true });
    await tg(env, "answerCallbackQuery", { callback_query_id: q.id, text: "✅ ကျေးဇူးတင်ပါတယ်" });
    if (env.STATE) await env.STATE.delete(`capv:${chat}:${gid}`).catch(() => {});
    await tg(env, "restrictChatMember", { chat_id: chat, user_id: q.from.id, permissions: await openPerms(env, chat) }).catch(() => {});
    const rows = (q.message.reply_markup?.inline_keyboard || []).filter((r) => !r.some((b) => String(b.callback_data || "").startsWith("v:")));
    return tg(env, "editMessageReplyMarkup", { chat_id: chat, message_id: q.message.message_id, reply_markup: { inline_keyboard: rows } });
  }

  // Help menu (/start): each button opens one page in place, "back" returns to the menu.
  if (tag === "h") {
    let page = gid === "0" ? MENU_TEXT : gid === "a" ? ADMIN_MENU_TEXT : (HELP_PAGES[gid] || ADMIN_PAGES[gid] || [])[1];
    if (gid[0] === "a") {
      const ok = owners.includes(String(q.from.id)) || (inGroup && (await isAdmin(env, chat, q.from.id)));
      if (!ok)
        return tg(env, "answerCallbackQuery", { callback_query_id: q.id, text: "⛔ Admin ပဲ ကြည့်လို့ရပါတယ်", show_alert: true });
    }
    await tg(env, "answerCallbackQuery", { callback_query_id: q.id });
    if (!page) return;
    const priv = q.message.chat.type === "private";
    const back = (to) => ({ inline_keyboard: [[{ text: "⬅️ ပြန်သွားရန်", callback_data: "h:" + to, style: "primary" }, ...(priv ? closeRow() : [])]] });
    const markup = gid === "0" ? helpMenu(owners.includes(String(q.from.id)) || (inGroup && (await isAdmin(env, chat, q.from.id))), priv) : gid === "a" ? adminMenu() : back(gid[0] === "a" ? "a" : "0");
    return tg(env, "editMessageText", { chat_id: chat, message_id: q.message.message_id, text: page, parse_mode: "HTML", reply_markup: markup });
  }

  // Copy Name / Copy ID (old cards only, new cards use native copy buttons): only the person who asked, group admins, or the bot owner.
  if (tag === "c" || tag === "i") {
    let ok = String(q.from.id) === gid || owners.includes(String(q.from.id));
    if (!ok) {
      const r = await tg(env, "getChatMember", { chat_id: chat, user_id: q.from.id }).catch(() => null);
      ok = ["creator", "administrator"].includes(r?.result?.status);
    }
    if (!ok)
      return tg(env, "answerCallbackQuery", {
        callback_query_id: q.id,
        text: "⛔ ပို့တဲ့သူနဲ့ admin ပဲ copy လို့ရပါတယ်",
        show_alert: true,
      });
    await tg(env, "answerCallbackQuery", { callback_query_id: q.id });
    const text = q.message.text || "";
    const ci = cardInfo(text);
    const value = (tag === "c" ? text.match(/^✅\s*(.+)/m)?.[1] : ci.server ? `${ci.id}(${ci.server})` : ci.id)?.trim();
    if (!value) return;
    return sendCard({ ...env, replyTo: q.message.message_id }, chat, `📋 နှိပ်ပြီး copy ယူပါ\n<code>${esc(value)}</code>`, {}, 5 * 60 * 1000);
  }

  await tg(env, "answerCallbackQuery", { callback_query_id: q.id });
  if (tag !== "g") return;
  const groups = await loadGroups(env);
  const group = groups.find((g) => g.id === gid);
  if (!group) return send(env, chat, "⚠️ Game မတွေ့ပါ။ ပြန်ရိုက်ပါ။");
  // The picker message was a reply to the person who asked: keep that, so the result card still replies to them
  // and still gets the Done / Reject buttons (a button tap alone has neither replyTo nor requester).
  const asked = q.message.reply_to_message;
  let askedHasReceipt = !!(asked?.photo?.length || /^image\//.test(asked?.document?.mime_type || ""));   // the original message carried the receipt
  if (inGroup && !askedHasReceipt && env.STATE) askedHasReceipt = !!(await env.STATE.get(`rcpt:${chat}:${asked?.from?.id || q.from.id}`).catch(() => null));
  env = inGroup
    ? { ...env, replyTo: asked?.message_id || q.message.message_id, requester: asked?.from?.id || q.from.id, hasReceipt: askedHasReceipt }
    : { ...env, requester: q.from.id, ownerKb: owners.includes(String(q.from.id)) };
  return runCheck(env, chat, group, id, server);
}

/* ---------- Server dropdown games ---------- */
// Options come from the game's own dropdown in the store: [{ label, value }] or plain strings.
function dropOptions(group) {
  const norm = (o) =>
    o && typeof o === "object"
      ? { label: String(o.label ?? o.name ?? o.text ?? o.title ?? o.value ?? o.id ?? o.code ?? ""), value: String(o.value ?? o.id ?? o.code ?? o.server ?? o.label ?? o.name ?? "") }
      : { label: String(o ?? ""), value: String(o ?? "") };
  const sel = (m, o) => (m === "select" && Array.isArray(o) && o.length ? o : null);
  const out = [];
  for (const e of group.entries) {
    const g2 = sel(e.g2bulkServerMode, e.g2bulkServerOptions);
    const fz = sel(e.fazercardServerMode, e.fazercardServerOptions);
    const list = (e.g2bulkCode ? g2 || fz : fz || g2) || [];
    for (const o of list) {
      const n = norm(o);
      if (n.label && n.value && !out.some((x) => x.entry === e && x.value === n.value)) out.push({ ...n, entry: e });
    }
  }
  return out;
}
// The server the player typed (name or value) or tapped ("#<index>"); a game with one option needs no choice.
function pickServer(group, server) {
  const opts = dropOptions(group);
  const sv = String(server || "").trim().toLowerCase();
  if (!opts.length) return null;
  if (!sv) return opts.length === 1 ? opts[0] : null;
  if (/^#\d+$/.test(sv)) return opts[Number(sv.slice(1))] || null;
  return opts.find((o) => o.value.toLowerCase() === sv) || opts.find((o) => o.label.toLowerCase() === sv) || opts.find((o) => o.label.toLowerCase().startsWith(sv)) || null;
}
function chooseServer(env, chat, group, id) {
  const opts = dropOptions(group).slice(0, 16);
  if (!opts.length) return send(env, chat, `ℹ️ <b>${esc(group.name)}</b> ရဲ့ Server စာရင်း မတွေ့ပါ`);
  const rows = [];
  opts.forEach((o, i) => {
    const b = { text: o.label.slice(0, 30), callback_data: `g:${group.id}:${id}:#${i}`.slice(0, 64), style: "primary" };
    if (i % 2 === 0) rows.push([b]); else rows[rows.length - 1].push(b);
  });
  return send(env, chat, `🎮 <b>${esc(group.name)}</b>\n<code>${esc(id)}</code>\n\nServer ရွေးပါ 👇`, { reply_markup: { inline_keyboard: rows } });
}

function chooseGame(env, chat, found, id, server) {
  const list = found.slice(0, 8);
  const rows = list.map((g) => [{ text: g.name, callback_data: `g:${g.id}:${id}:${server}`.slice(0, 64), style: "primary" }]);
  const more = found.length > list.length ? "\n\n(ပိုတိကျအောင် နာမည်အပြည့်ရိုက်ပါ)" : "";
  return send(env, chat, `🎮 Game ရွေးပါ${more}`, { reply_markup: { inline_keyboard: rows } });
}

function ask(env, chat, group, text, placeholder) {
  return send(env, chat, `🎮 ${esc(group.name)}\n${text}`, {
    reply_markup: { force_reply: true, input_field_placeholder: placeholder },
  });
}

async function runCheck(env, chat, group, id, server) {
  if (await maintBlock(env, chat)) return;
  if (env.STATE) await env.STATE.put("g:" + chat, group.key, { expirationTtl: 86400 });

  if (group.idOnly) server = ""; // this game has no Server ID: check the ID only
  let pick = null;
  if (group.dropdown) {
    if (!id) return ask(env, chat, group, "Player ID ပို့ပါ\nဥပမာ: <code>123456789</code>", "ID");
    pick = pickServer(group, server);
    if (!pick) return chooseServer(env, chat, group, id);
    server = pick.label;
  }
  if (!id) return group.idOnly
    ? ask(env, chat, group, "Player ID ပို့ပါ\nဥပမာ: <code>123456789</code>", "ID")
    : ask(env, chat, group, "Player ID နဲ့ Server ID ပို့ပါ\nဥပမာ: <code>123456789(2002)</code>", "ID(Server)");
  if (!server && !group.idOnly) {
    let hint = "";
    const code = group.entries.find((e) => e.g2bulkCode)?.g2bulkCode;
    const list = code ? await g2Servers(code) : [];
    if (list.length) hint = "\n\n🖥 <b>Server list</b>\n" + list.slice(0, 30).map((s) => `<code>${esc(s.id)}</code> — ${esc(s.name)}`).join("\n");
    return ask(env, chat, group, `Server ID လိုပါတယ်\nဥပမာ: <code>${esc(id)}(2002)</code>${hint}`, "ID(Server)");
  }

  if (await limited(env, chat)) return;
  await tg(env, "sendChatAction", { chat_id: chat, action: "typing" });

  const results = pick
    ? [{ g: pick.entry, g2: !!pick.entry.g2bulkCode, r: await callProvider(pick.entry, id, pick.value) }]
    : await checkGroup(group, id, server);
  if (await sendValid(env, chat, group, results, id, server)) return;

  const rs = results.map((x) => x.r);
  if (rs.every((r) => r.outcome === "unknown")) return busy(env, chat, rs);
  if (rs.some((r) => r.outcome === "skip") && !rs.some((r) => r.outcome === "invalid"))
    return send(env, chat, bq(`ℹ️ <b>${esc(group.name)}</b> ကို name စစ်လို့မရပါ\n(Provider က player name ပြန်မပေးပါ)`));
  const serverProblem = rs.some((r) => r.reason === "server");
  await stat(env, "notfound", group.name);
  await notFoundWatch(env, chat).catch(() => {});
  return sendCard(
    env,
    chat,
    cardText(group.name, "❌ Player Not found", `<code>${esc(id)}</code>${server ? ` (${esc(server)})` : ""}${serverProblem ? "\n(Server ID ကို စစ်ကြည့်ပါ)" : ""}`)
  );
}

// Checks every region entry of a game through its own provider (identical calls are shared by the cache).
const checkGroup = (group, id, server) =>
  Promise.all(group.entries.map(async (g) => ({ g, g2: !!g.g2bulkCode, r: await callProvider(g, id, server) })));

// Sends one card per in-game name; returns how many cards were sent.
async function sendValid(env, chat, group, results, id, server, maxCards = Infinity) {
  const valid = results.filter((x) => x.r.outcome === "valid");
  if (!valid.length) return 0;
  // Prefer the entry whose region label matches what the provider reports.
  const byName = new Map();
  valid.forEach(({ g, g2, r }) => {
    const k = String(r.name).trim().toLowerCase();
    const cur = byName.get(k);
    const matches = r.geo.region && String(g.serverName || "").trim().toLowerCase() === r.geo.region.toLowerCase();
    if (!cur || (matches && !cur.matches)) byName.set(k, { g, g2, r, matches });
  });
  const picked = [...byName.values()].sort((x, y) => Number(!!y.matches) - Number(!!x.matches)).slice(0, maxCards);
  for (const { g, g2, r } of picked) {
    // Card: Game / name (quote + bold) / ID (Server). cardInfo() parses this shape back.
    const card = cardText(group.name, `✅ ${esc(r.name)}`, `<code>${esc(id)}</code>${!group.idOnly && server ? ` (${esc(server)})` : ""}`);
    const copyBtn =
      S.copyid === "restricted" && env.requester
        ? { text: "Copy ID", callback_data: `i:${env.requester}`, style: "primary", ...ic(env, "ICON_COPY") }   // only the asker / admins / owners
        : copyIdButton(env, !group.idOnly && !group.dropdown && server ? `${id}(${server})` : id);              // native: anyone can tap
    const rows = [[copyBtn]];
    const store = await getStore(env);
    if (store) rows.push([{ text: "Store ဝင်ရန်", url: store, style: "primary", ...ic(env, "ICON_STORE") }]);
    const wantsDone = env.requester && (Number(chat) > 0 ? env.ownerKb : env.hasReceipt);   // group: only image + ID gets Done / Reject
    if (wantsDone) rows.push(doneRejectRow(env.requester, env));   // group: admins mark the order done or rejected (side by side, one row)
    const sent = await sendCard(env, chat, bq(card), { reply_markup: { inline_keyboard: rows } });
    const info = { g: group.name, i: id, s: group.idOnly ? "" : server };
    if (wantsDone && Number(chat) < 0) {
      await trackPending(env, chat, sent?.result?.message_id, info, env.requester);
      if (env.STATE) await env.STATE.delete(`rcpt:${chat}:${env.requester}`).catch(() => {});   // one receipt = one order
    } else if (!wantsDone && Number(chat) < 0 && env.requester && env.STATE && sent?.result?.message_id) {
      // ID checked, no receipt yet: if the receipt photo arrives within 15 minutes, this card gets Done / Reject.
      await env.STATE.put(`lc:${chat}:${env.requester}`, JSON.stringify({ mid: sent.result.message_id, rows, info }), { expirationTtl: 900 }).catch(() => {});
    }
  }
  if (picked.length) await rememberId(env, env.requester, group, id, group.idOnly ? "" : server).catch(() => {});
  await stat(env, "found", group.name);
  return picked.length;
}

// Server list help (G2Bulk only) shown when the Server ID is missing.
const SERVERS = new Map();
async function g2Servers(game) {
  const hit = SERVERS.get(game);
  if (hit && Date.now() - hit.t < hit.ttl) return hit.list;
  const list = await g2ServersFetch(game);
  SERVERS.set(game, { t: Date.now(), list, ttl: list.length ? 3600e3 : 600e3 });
  return list;
}
async function g2ServersFetch(game) {
  try {
    const r = await fetch(`${G2}/games/servers`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ game }),
    });
    if (!r.ok) return [];
    const d = await r.json();
    let arr = Array.isArray(d) ? d : d?.servers || d?.data || [];
    if (arr && !Array.isArray(arr) && typeof arr === "object")
      arr = Object.entries(arr).map(([k, v]) => (typeof v === "object" ? { id: k, ...v } : { id: k, name: v }));
    if (!Array.isArray(arr)) return [];
    return arr
      .map((s) =>
        typeof s === "string"
          ? { id: s, name: s }
          : { id: String(s.id ?? s.server_id ?? s.value ?? s.code ?? ""), name: String(s.name ?? s.server_name ?? s.label ?? s.region ?? s.id ?? "") }
      )
      .filter((s) => s.id);
  } catch {
    return [];
  }
}
