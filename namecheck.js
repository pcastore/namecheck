// PCA Name Check Bot — Cloudflare Worker + Telegram
// Games come live from the store's Firestore "games" collection, filtered with the same rules as the
// store's own Name Check. Each game entry is checked through its OWN provider only (G2Bulk).
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
const FS_PROJECT = "pca-game-store";
const FS_KEY = "AIzaSyA2mwdZ2tAoZ3_6HNl43fUSi9t_ZkRita4"; // public web key, same one the store page uses
const FS_FIELDS = [
  "name", "serverName", "order", "g2bulkCode",
  "serverIdRequired", "playerIdRequired", "fulfillProvider", "g2bulkVoucherCategory",
  "g2bulkServerMode", "g2bulkServerOptions",
];

const CHECK_TTL_MS = 5 * 60 * 1000;   // "not found" answers are remembered this long
const VALID_TTL_MS = 60 * 60 * 1000;  // found players are remembered for 1 hour (memory + KV)
const AUTODEL_MS = 60 * 60 * 1000;    // bot cards in groups are deleted after 1 hour
const WELCOME_TTL_MS = 10 * 60 * 1000;
let KV = null;                        // set per request from env.STATE
let ENV_G = null;                     // last env (used by the provider health tracker)
let LAST_SWEEP = 0;
const SEEN_UPD = new Set();           // Telegram re-sends an update when the answer is slow: handle each update_id once
const ERR_AT = new Map();
async function reportError(env, e) {
  console.error(e);
  const msg = String((e && (e.stack || e.message)) || e).split("\n").slice(0, 3).join(" | ").slice(0, 300);
  const key = msg.slice(0, 80);
  if (Date.now() - (ERR_AT.get(key) || 0) < 10 * 60 * 1000) return;   // the same error at most once per 10 minutes
  if (ERR_AT.size > 200) ERR_AT.clear();
  ERR_AT.set(key, Date.now());
  await notifyOwners(env, `🐞 <b>Bot error</b>\n<code>${esc(msg)}</code>`).catch(() => {});
}
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
  calc: ["Calculator (auto = ဂဏန်းတွက်စာကို auto ဖြေ၊ cmd = /calc ပဲ၊ off = ပိတ်)", "auto", "enum:auto,cmd,off", "/set calc auto|cmd|off"],
  quote: ["Game + package ဈေးတွက် (ml 86 x3 → စုစုပေါင်း)", "on", "onoff", "/set quote on|off"],
  orderpv: ["Customer order (ml ID server 86 x3) ကို ID စစ်ပြီး ဈေးစုစုပေါင်းပါ ပြမလား", "on", "onoff", "/set orderpv on|off"],
  idprefix: ["Group မှာ ID(Server) ပုံစံ သို့ 'id' ရှေ့ခံမှ စစ်မလား (on = ရှေ့ခံလို၊ off = ID ပို့တာနဲ့ auto စစ်)", "off", "onoff", "/set idprefix on|off"],
  pricewatch: ["Price / Cost / USD rate ပြောင်းရင် Owner ကို table နဲ့ သတိပေး (cron ၅ မိနစ်)", "on", "onoff", "/set pricewatch on|off"],
  rich: ["Rich message (Bot API 10.3: table + ခလုတ်) သုံးမလား — ဈေးနှုန်းမှာ", "on", "onoff", "/set rich on|off (app ဗားရှင်းဟောင်းမှာ မမြင်ရရင် off)"],
  richcard: ["Name စစ်ရလဒ်ကတ်ကို Table border (rich message) နဲ့ ပြမလား", "on", "onoff", "/set richcard on|off (ပြဿနာရှိရင် off)"],
  pay: ["Payment auto-reply (KPay/Wave ... မေးရင် ဖြေမလား)", "on", "onoff", "/set pay on|off"],
  dmopen: ["Customer တွေ DM မှာ Bot သုံးခွင့် (on = ရ၊ off = Owner ပဲ)", "on", "onoff", "/set dmopen on|off"],
  dmhours: ["DM ဖွင့်ချိန် (မြန်မာ နာရီ) ဥပမာ 9-22 — ပြင်ပရင် away စာပို့", "", "text", "ဥပမာ: /set dmhours 9-22 (ရှင်းရန် /set dmhours reset)"],
  offmsg: ["DM ပိတ်ချိန် away စာ (ဗလာ = မူလစာ)", "", "text", "ဥပမာ: /set offmsg ည ၁၀ နာရီကနေ မနက် ၉ နာရီထိ ပိတ်ပါတယ်"],
  summaryhour: ["စာရင်းချုပ်ပို့မယ့် နာရီ (မြန်မာ 0-23)", "23", "hour", "ဥပမာ: /set summaryhour 22"],
  buy: ["Admin ဝယ်ခြင်း (game + ID + package ပို့ရင် Wallet လောက်ရင် တန်းဝယ်)", "on", "onoff", "/set buy on|off (G2BULK_API_KEY လိုတယ်)"],
  lowbal: ["Wallet ကျန်ငွေ ဒီ USD အောက်ရောက်ရင် Owner ကို သတိပေး", "off", "numoff", "ဥပမာ: /set lowbal 20 (ပိတ်ရန် /set lowbal off)"],
};
function parseSetting(k, v) {
  const t = SETTINGS[k][2];
  const x = String(v).trim();
  if (t === "text") return x.slice(0, 300);
  const low = x.toLowerCase();
  if (t === "onoff") return low === "on" || low === "off" ? low : null;
  if (t === "numoff" && low === "off") return "off";
  if (t.startsWith("enum:")) return t.slice(5).split(",").includes(low) ? low : null;
  if (t === "usd") return /^\d{3,6}(\.\d{1,2})?$/.test(x) && Number(x) >= 100 ? x : null;
  if (!/^\d+$/.test(x)) return null;
  const n = Number(x);
  if (t === "hour") return n <= 23 ? String(n) : null;
  return n >= 1 && n <= 1440 ? String(n) : null;
}
const RESERVED_CMDS = [
  "start", "help", "id", "reload", "setwelcome", "welcome", "captcha", "addword", "delword", "words", "stats", "addfaq", "delfaq",
  "faqs", "setstore", "setdone", "adminhelp", "orders", "warns", "unwarn", "unban", "addalias", "delalias", "aliases", "settings",
  "set", "maint", "seticon", "emojiid", "summary", "addcmd", "delcmd", "cmds", "hidegame", "showgame", "announce", "groups", "lock", "unlock",
  "calc", "change", "list", "post", "posts", "delpost", "addchannel", "delchannel", "channels", "pay", "pkgs", "setpkg", "delpkg", "balance", "health",
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
  if (!force && (await env.STATE.get("cfg:menu:v4").catch(() => null))) return;
  const base = [
    { command: "start", description: "📋 Menu ဖွင့်ရန်" },
    { command: "price", description: "💰 ဈေးနှုန်း" },
    { command: "calc", description: "🧮 Calculator" },
    { command: "help", description: "ℹ️ အကူအညီ" },
  ];
  const adminCmds = [
    { command: "start", description: "📋 Menu ဖွင့်ရန်" },
    { command: "balance", description: "💰 Wallet Balance" },
    { command: "orders", description: "📋 Done order စာရင်း" },
    { command: "warns", description: "⚠️ Strike ရှိသူများ" },
    { command: "adminhelp", description: "🛠 Admin commands" },
    { command: "calc", description: "🧮 Calculator" },
    { command: "price", description: "💰 ဈေးနှုန်း" },
  ];
  const ownerCmds = [
    { command: "start", description: "📋 Menu ဖွင့်ရန်" },
    { command: "post", description: "📝 Post တင်ရန်" },
    { command: "posts", description: "⏰ Schedule စာရင်း" },
    { command: "channels", description: "📢 Channels" },
    { command: "balance", description: "💰 Wallet Balance" },
    { command: "orders", description: "📋 Done order စာရင်း" },
    { command: "stats", description: "📊 Stats" },
    { command: "health", description: "🩺 System အခြေအနေ" },
    { command: "calc", description: "🧮 Calculator" },
    { command: "adminhelp", description: "🛠 Admin commands" },
  ];
  const a = await tg(env, "setMyCommands", { commands: base }).catch(() => null);
  await tg(env, "setMyCommands", { commands: adminCmds, scope: { type: "all_chat_administrators" } }).catch(() => null);
  for (const o of idList(env.OWNER_IDS)) await tg(env, "setMyCommands", { commands: ownerCmds, scope: { type: "chat", chat_id: Number(o) } }).catch(() => null);
  const b = await tg(env, "setChatMenuButton", { menu_button: { type: "commands" } }).catch(() => null);
  if (env.STATE && a?.ok && b?.ok) await env.STATE.put("cfg:menu:v4", "1").catch(() => {});
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
        allowed_updates: ["message", "callback_query", "my_chat_member", "business_connection", "business_message"],
      });
      const menu = await ensureMenu(env, true);
      return new Response(JSON.stringify({ webhook: r, menu }), { headers: { "content-type": "application/json" } });
    }

    if (url.pathname.startsWith("/api/")) return apiHandle(req, env, url);

    if (req.method !== "POST") return new Response("OK");
    if (req.headers.get("X-Telegram-Bot-Api-Secret-Token") !== env.WEBHOOK_SECRET)
      return new Response("Unauthorized", { status: 401 });

    const update = await req.json();
    if (update.update_id) {
      if (SEEN_UPD.has(update.update_id)) return new Response("OK");
      if (SEEN_UPD.size > 500) SEEN_UPD.clear();
      SEEN_UPD.add(update.update_id);
    }
    ctx.waitUntil(handle(update, env).catch((e) => reportError(env, e)));
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
    ctx.waitUntil(priceWatch(env).catch((e) => console.error(e)));
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
    ...(env.bc ? { business_connection_id: env.bc } : {}),   // Chat automation: answer inside the owner's account chat
    ...(env.replyTo ? { reply_parameters: { message_id: env.replyTo, allow_sending_without_reply: true } } : {}),
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

// Same rules as the store's Name Check (ncCheckable): no vouchers, needs a Player ID, wired to G2Bulk.
// Games with a Server ID are checked with ID + Server; games without one (serverIdRequired === false) are checked
// with the ID only. Games with a fixed server dropdown are checked after the game name is typed: the player taps the server (or types its name).
function baseOk(g) {
  if (!g || !g.name) return false;
  if (["g2bulk_voucher", "fazercard_giftcard", "jcplays", "voucher_manual"].includes(g.fulfillProvider)) return false;
  if (g.g2bulkVoucherCategory) return false;
  if (g.playerIdRequired === false) return false;
  if (/heartopia/i.test(g.name)) return false;
  return !!g.g2bulkCode;
}
function isDropdown(g) {
  const hasOpts = (m, o) => m === "select" && Array.isArray(o) && o.length;
  return !!hasOpts(g.g2bulkServerMode, g.g2bulkServerOptions);
}
const checkable = (g) => baseOk(g) && !isDropdown(g);
const idOnlyEntry = (g) => g.serverIdRequired === false;

function hash(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

// All games are read from Firestore ONCE and shared: memory (5 min) -> KV/D1 (shared by every Worker instance, 5 min) -> Firestore.
// Games list, groups, prices and packages all come from this single read. /reload forces a new read.
const GAME_FIELDS = [...FS_FIELDS, "packages", "packageTabLabels", "packageTabs"];
const GAMES_TTL_MS = 5 * 60 * 1000;
let GDOCS = { t: 0, docs: null };
let GCOLL = "";   // which collection answered last: "games" (full, has Cost) or "gamesPublic" (Cost-free mirror, used when the rules keep `games` admin-only)
async function loadGameDocs(env) {
  if (GDOCS.docs && Date.now() - GDOCS.t < GAMES_TTL_MS) return GDOCS.docs;
  if (env.STATE) {
    const s = await env.STATE.get("fs:games", "json").catch(() => null);
    if (s && Array.isArray(s.docs) && Date.now() - s.t < GAMES_TTL_MS) { GDOCS = s; return s.docs; }
  }
  const docs = [];
  for (const coll of GCOLL === "games" ? ["games", "gamesPublic"] : ["gamesPublic", "games"]) {
    let token = "";
    for (let i = 0; i < 10; i++) {
      const qs = new URLSearchParams({ pageSize: "300", key: env.FIREBASE_API_KEY || FS_KEY });
      GAME_FIELDS.forEach((f) => qs.append("mask.fieldPaths", f));
      if (token) qs.set("pageToken", token);
      let j;
      try {
        const r = await fetch(`https://firestore.googleapis.com/v1/projects/${FS_PROJECT}/databases/(default)/documents/${coll}?${qs}`);
        if (!r.ok) break;
        j = await r.json();
      } catch {
        break;
      }
      (j.documents || []).forEach((d) => docs.push(fv({ mapValue: { fields: d.fields || {} } })));
      token = j.nextPageToken || "";
      if (!token) break;
    }
    if (docs.length) { GCOLL = coll; break; }
  }
  if (!docs.length) return GDOCS.docs || [];   // Firestore failed: keep serving the old copy
  GDOCS = { t: Date.now(), docs };
  if (env.STATE) await env.STATE.put("fs:games", JSON.stringify(GDOCS), { expirationTtl: 900 }).catch(() => {});
  return docs;
}
let CACHE = { t: 0, groups: null };
async function loadGroups(env) {
  if (CACHE.groups && Date.now() - CACHE.t < 60 * 1000 && CACHE.src === GDOCS.docs) return CACHE.groups;
  const docs = await loadGameDocs(env);
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
  CACHE = { t: Date.now(), groups, src: docs };
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
  m: "mobile legends",
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
  // "123456789abc2002" -> ID, letters, server: letters stuck between the two numbers count as a separator too.
  text = String(text).replace(/(\d{5,20})([A-Za-z]+)(\d{1,6})(?!\d)/g, "$1 $2 $3");
  const tokens = text.split(/[^\p{L}\p{N}\p{M}]+/u).filter(Boolean);
  const i = tokens.findIndex((t) => /^\d{5,20}$/.test(t));
  if (i === -1) return { tokens, query: tokens.join(" "), id: "", server: "" };
  // Server = the first short number after the ID; letters / symbols in between ("id 123456789 server 2002") are ignored.
  // "server2002" / "sv2002" / "zone2002" (label glued to the number) -> 2002.
  const after = tokens.slice(i + 1).map((t) => (t.match(/^(?:server|svr|sv|zone|s|z)(\d{1,6})$/i) || [, t])[1]);
  // A leading "id" word is not a game name ("id 123456789 2002" in private chat).
  const query = tokens.slice(0, i).filter((t) => !/^(?:id|အိုင်ဒီ)$/i.test(t)).join(" ");
  const server = /^\d{1,6}$/.test(after[0] || "") ? after[0] : after.find((t) => /^\d{1,6}$/.test(t)) || after[0] || "";
  return { tokens, query, id: tokens[i], server };
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
      signal: AbortSignal.timeout(9000),
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
const callProvider = async (g, id, server) => {
  if (await isDown("G2Bulk")) return { outcome: "unknown", why: "maintenance", provider: "G2Bulk" };
  return cachedG2(g.g2bulkCode, id, server);
};

// Which provider(s) failed, e.g. "G2Bulk (HTTP 502)".
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
  let info = cardInfo(q.message.text);
  if (!info.id && env.STATE) {   // rich (table) card: details were saved when it was sent
    const ci = await env.STATE.get(`ci:${chat}:${q.message.message_id}`, "json").catch(() => null);
    if (ci) info = { game: ci.g || "", id: ci.i || "", server: ci.s || "" };
  }
  const now = Date.now();
  const mid = q.message.message_id;
  const meta = {
    a: who.slice(0, 30), u: q.from.id, g: info.game.slice(0, 40), i: info.id.slice(0, 40), s: info.server.slice(0, 20),
    t: now, c: String(chat), m: rid || 0, mn: String(asker?.first_name || "").slice(0, 25),
  };
  const pv = await env.STATE.get(`pv:${chat}:${mid}`, "json").catch(() => null);
  if (pv && pv.p > 0) { meta.p = Math.round(pv.p); if (pv.c > 0) meta.c = Math.round(pv.c); }
  if (info.id) {   // the same ID + game finished twice within 30 minutes: tell the owners
    const dk = `dd:${info.game}:${info.id}:${info.server}`.slice(0, 180);
    const prevDone = Number(await env.STATE.get(dk).catch(() => 0)) || 0;
    await env.STATE.put(dk, String(now), { expirationTtl: 1800 }).catch(() => {});
    if (prevDone) await notifyOwners(env, `⚠️ <b>Done ထပ်နေ</b>\n${esc(info.game)} <code>${esc(info.id)}${info.server ? `(${esc(info.server)})` : ""}</code>\n${Math.max(1, Math.round((now - prevDone) / 60000))} မိနစ်အလိုကလည်း Done လုပ်ထားပြီး — ${esc(who)}`).catch(() => {});
  }
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
  const sales = rows.filter((x) => x.p > 0).concat(await listOrders(env, `sale:${dayStr(back)}:`, () => true));
  const per = {};
  rows.forEach((x) => (per[x.a] = (per[x.a] || 0) + 1));
  const adm = Object.entries(per).sort((a, b) => b[1] - a[1]).map(([a, n]) => `• ${esc(String(a).slice(0, 25))} — ${n}`).join("\n");
  const top = Object.entries(s.games || {}).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([g, n]) => `• ${esc(g)} — ${n}`).join("\n");
  return (
    `📊 <b>${esc(label)} စာရင်းချုပ်</b>\n\n🔎 စစ်ခဲ့တာ: ${(s.found || 0) + (s.notfound || 0)}\n✅ တွေ့: ${s.found || 0}\n❌ မတွေ့: ${s.notfound || 0}\n📦 Done: ${rows.length}` + salesText(sales) +
    (adm ? `\n\n👤 Admin အလိုက် Done\n${adm}` : "") +
    (top ? `\n\n🎮 အများဆုံး\n${top}` : "")
  );
}
// sales = rows with p (selling price) and optionally c (cost): admin-bought orders and customer orders that were marked Done
function salesText(sales) {
  if (!sales.length) return "";
  const rev = sales.reduce((s, x) => s + (x.p || 0), 0);
  const known = sales.filter((x) => x.c > 0);
  const profit = known.reduce((s, x) => s + (x.p - x.c), 0);
  return `\n\n💰 ရောင်းရငွေ: ${fmtKs(rev)} Ks (${sales.length} order)` + (known.length ? `\n📈 အမြတ်: ${fmtKs(profit)} Ks${known.length < sales.length ? ` (cost သိတဲ့ ${known.length}/${sales.length} order ကိုပဲ တွက်)` : ""}` : "");
}
async function buildWeek(env) {
  let found = 0, notfound = 0, done = 0;
  const allSales = [];
  const per = {}, games = {};
  for (let d = 0; d < 7; d++) {
    const s = (await env.STATE.get(dayKey(d), "json").catch(() => null)) || {};
    found += s.found || 0;
    notfound += s.notfound || 0;
    for (const [g, n] of Object.entries(s.games || {})) games[g] = (games[g] || 0) + n;
    const rows = await listOrders(env, `ord:${dayStr(d)}:`, () => true);
    allSales.push(...rows.filter((x) => x.p > 0), ...(await listOrders(env, `sale:${dayStr(d)}:`, () => true)));
    done += rows.length;
    rows.forEach((x) => (per[x.a] = (per[x.a] || 0) + 1));
  }
  const fmt = (o) => Object.entries(o).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, n]) => `• ${esc(String(k).slice(0, 25))} — ${n}`).join("\n");
  return `📊 <b>ရက် ၇ ရက် စာရင်းချုပ်</b>\n(ကောင်တာက ၃ ရက်ပဲ သိမ်းလို့ စစ်တာအရေအတွက်က နောက်ဆုံး ၃ ရက်စာပါ၊ Done က ၇ ရက်စာ)\n\n🔎 စစ်ခဲ့တာ: ${found + notfound} (✅ ${found} · ❌ ${notfound})\n📦 Done: ${done}` + salesText(allSales) +
    (done ? `\n\n👤 Admin အလိုက်\n${fmt(per)}` : "") + (Object.keys(games).length ? `\n\n🎮 အများဆုံး\n${fmt(games)}` : "");
}
async function dailySummary(env) {
  if (!env.STATE || S.summary === "off") return;
  if (!idList(env.OWNER_IDS).length) return;
  const hour = new Date(Date.now() + 6.5 * 3600e3).getUTCHours();
  const at = S.summaryhour !== undefined ? Number(S.summaryhour) : 23;
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
      "<b>Package အတိုကောက်</b> (Owner)",
      "<code>/pkgs ml</code> — အတိုကောက်စာရင် (86 · wp ...) · <code>/setpkg ml wp = weekly pass</code> ပြင် · <code>/delpkg ml wp</code> ဖျက်",
      "အရေအတွက်: <code>wp2</code> · <code>86x3</code>",
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
      "• lowbal — Wallet ကျန်ငွေ USD ဒီအောက်ရောက်ရင် Owner ကို သတိပေး (ပိတ်ရန် off)",
      "• summary — on | off · summaryhour — စာရင်းချုပ်ပို့မယ့်နာရီ 0–23 (မူလ ၂၃)",
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
      "ည ၁၁ နာရီ (မြန်မာ) Owner ဆီ အလိုလိုပို့ — <code>/set summaryhour 22</code> · <code>/set summary off</code> (Cron နဲ့ OWNER_IDS လို)",
      "",
      "<b>📝 Post တင် (Channel / Group)</b> — Bot နဲ့ private chat မှာ Owner",
      "/start ရိုက်ရင် Menu ခလုတ်တွေ အောက်မှာ ပေါ်နေမယ် — 📝 Post တင်ရန် · ⏰ Schedule · 📢 Channels",
      "Post ခလုတ်တွေ: Button + 🎨 Color (အပြာ/အစိမ်း/အနီ) · 📌 Pin · 🔔 Silent · 🔗 Link preview · 📸 Album · Preview · ယခုတင် / အချိန်ခွဲ (🔁 နေ့တိုင်း/အပတ်တိုင်း)",
      "Channel မှတ်ရန်: Bot ကို channel မှာ admin လုပ်ရုံ (အလိုလိုမှတ်) (သို့) 📢 Channels ထဲက ➕ ခလုတ်နဲ့ @username ထည့် — forward မလိုပါ",
      "",
      "<b>📣 Group အားလုံးကို ကြေညာ</b>",
      "Bot နဲ့ private chat မှာ <code>/announce စာသား</code> — Bot သုံးနေတဲ့ group အားလုံးဆီ ပို့၊ ပြီးရင် ဘယ်နှစ်ခုရောက်လဲ ပြန်ပြော",
      "<code>/groups</code> — Bot သုံးနေတဲ့ group စာရင်း (Group ထဲမှာ စာတစ်ခုပေါ်မှ မှတ်)"
    ].join("\n")],
};
// Blue buttons, two per row. h:a = this menu, h:a1..a6 = pages (admins only), h:0 = back to the /start menu.
const adminRows = () => {
  const b = (k) => ({ text: ADMIN_PAGES[k][0], data: "h:" + k, style: "primary" });
  return [[b("a1"), b("a2")], [b("a3"), b("a4")], [b("a5"), b("a6")], [b("a7"), b("a8")], [{ text: "⬅️ ပြန်သွားရန်", data: "h:0", style: "primary" }]];
};
async function adminCommand(env, m, text, isGroup, owners) {
  const mm = text.match(/^\/(lock|unlock|hidegame|showgame|announce|groups|addalias|delalias|aliases|settings|set|maint|seticon|emojiid|summary|addcmd|delcmd|cmds|setwelcome|welcome|captcha|addword|delword|words|stats|paymsg|payword|delpayword|paywords|addfaq|delfaq|faqs|setstore|setdone|adminhelp|orders|warns|unwarn|unban|pkgs|setpkg|delpkg)(?:@\w+)?(?:\s+([\s\S]*))?$/i);
  if (!mm) return false;
  const cmd = mm[1].toLowerCase();
  const arg = (mm[2] || "").trim();
  const chat = m.chat.id;
  const uid = m.from?.id;
  const isOwner = owners.includes(String(uid));
  if (!isOwner && !(isGroup && (await isAdmin(env, chat, uid)))) return true;
  if (["set", "settings", "maint", "seticon", "emojiid", "summary", "hidegame", "showgame", "announce", "groups", "pkgs", "setpkg", "delpkg"].includes(cmd) && !isOwner) return true;   // owner only
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
      for (const p of ["G2Bulk"]) if (await isDown(p)) downs.push(p);
      await usage(
        `🛠 Maintenance: <b>${S.maint === "on" ? "ဖွင့်ထား" : "ပိတ်ထား"}</b>\n` +
          (downs.length ? `🚨 Provider ကျနေတာ: ${downs.join(", ")} (အလိုလို maintenance စာ ပြနေပါတယ်)\n` : "✅ Provider နှစ်ခုလုံး ကောင်းပါတယ်\n") +
          "\n<code>/maint on စာသား</code> · <code>/maint off</code>"
      );
    }
    return true;
  }

  // ----- package short codes (owner): /pkgs /setpkg /delpkg -----
  if (cmd === "pkgs" || cmd === "setpkg" || cmd === "delpkg") {
    const pa = arg.split(/\s+/).filter(Boolean);
    const groups = await loadGroups(env);
    let g = null;
    if (pa[0]) {
      const a = abbrGroups(groups, pa[0], true);
      const f = a.length === 1 ? a : findGroups(groups, pa[0]);
      if (f.length === 1) g = f[0];
    }
    if (!g) {
      await usage("ဥပမာ:\n<code>/pkgs ml</code> — အတိုကောက်စာရင်း\n<code>/setpkg ml wp = weekly pass</code> — အတိုကောက်ပြင်/ထည့် (= နောက်က package နာမည်ရဲ့ တစ်စိတ်)\n<code>/delpkg ml wp</code> — ဖျက်");
      return true;
    }
    const pks = (await freshPackages(env, g)).flatMap((e) => e.packages).filter((p) => p && p.g2bulk && Number(p.price) > 0);
    if (cmd === "pkgs") {
      const seen = new Set(), cnt = {};
      pks.forEach((p) => { const s = pkgShort(g.key, p); const k = s + "|" + p.amount; if (!seen.has(k)) { seen.add(k); cnt[s] = (cnt[s] || 0) + 1; } });
      const lines = [...seen].map((k) => { const [s, a] = k.split("|"); return `<code>${esc(s)}</code>${cnt[s] > 1 ? " ⚠️" : ""} → ${esc(a)}`; });
      await say(`🏷 <b>${esc(g.name)}</b> — အတိုကောက်\n\n` + (lines.join("\n") || "package မတွေ့ပါ") + "\n\n⚠️ = တူနေတဲ့ကုဒ် (<code>/setpkg</code> နဲ့ ပြင်ပါ)\nအရေအတွက်: <code>wp2</code> · <code>86x3</code> · <code>86 x3</code>", 5 * 60 * 1000);
      return true;
    }
    if (cmd === "delpkg") {
      const sh = (pa[1] || "").toLowerCase();
      if (!sh || !((S.pkgs || {})[g.key] || {})[sh]) { await usage("ဖျက်လို့မရပါ။ <code>/pkgs " + esc(pa[0]) + "</code> နဲ့ ကြည့်ပါ။ (ကိုယ်ပြင်ထားတာပဲ ဖျက်လို့ရ)"); return true; }
      await saveCfg(env, (c) => { c.pkgs = { ...(c.pkgs || {}) }; c.pkgs[g.key] = { ...(c.pkgs[g.key] || {}) }; delete c.pkgs[g.key][sh]; });
      await say(`✅ <code>${esc(sh)}</code> ဖျက်ပြီးပါပြီ`, 2 * 60 * 1000);
      return true;
    }
    const sm = arg.match(/^\S+\s+(\S+)\s*=\s*(.+)$/);
    const sh = sm ? sm[1].toLowerCase() : "";
    const val = sm ? sm[2].trim().toLowerCase() : "";
    if (!/^[a-z0-9]{1,10}$/.test(sh) || !val || !pks.some((p) => String(p.amount).toLowerCase().includes(val))) {
      await usage("ဥပမာ: <code>/setpkg " + esc(pa[0]) + " wp = weekly pass</code>\n(= နောက်က package နာမည်ရဲ့ တစ်စိတ်၊ <code>/pkgs " + esc(pa[0]) + "</code> နဲ့ ကြည့်ပါ)");
      return true;
    }
    await saveCfg(env, (c) => { c.pkgs = { ...(c.pkgs || {}) }; c.pkgs[g.key] = { ...(c.pkgs[g.key] || {}), [sh]: val }; });
    await say(`✅ <b>${esc(g.name)}</b> — <code>${esc(sh)}</code> → ${esc(val)}`, 2 * 60 * 1000);
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
// Main menu (reply keyboard, always visible): Post / Schedule list / Channels / Help.
// Post flow: pick targets (inline toggles) -> send content (text / photo / video / file, or 📸 Album) -> menu:
//   link buttons + colors, Pin, Silent, Link preview, Preview, post now / schedule (+ repeat).
// State lives in KV "pst:<uid>"; scheduled posts "sch:<time>:<id>"; album parts "alb:<uid>:<message>"; channels "chn:<id>" (register by forwarding a channel post to the bot).
const PL = {
  add: "➕ Button ထည့်", store: "🏪 Store button", clr: "🧹 Button ရှင်း", prev: "👀 Preview", test: "🧪 Test (ကိုယ့်ဆီပို့)", color: "🎨 Button Color",
  now: "✅ ယခုတင်", later: "⏰ အချိန်ခွဲတင်", cancel: "❌ ပယ်ဖျက်", back: "⬅️ Back",
  redo: "🔄 Content ပြန်ပို့", album: "📸 Album", done: "✔️ ပြီးပြီ",
};
const ML = { new: "📝 Post တင်ရန်", list: "⏰ Schedule စာရင်း", chn: "📢 Channels", help: "ℹ️ အကူအညီ", bal: "💰 Balance" };
const POST_HELP_TEXT = [
  "<b>📝 Post တင်နည်း</b>",
  "<blockquote>1️⃣ <b>/post</b> → နေရာရွေး → စာ / ပုံ / video ပို့\n2️⃣ Button + 🎨 Color · 📌 Pin · 🔔 Silent · 📸 Album\n3️⃣ 👀 Preview ကြည့်ပြီး ✅ ယခုတင် (သို့) ⏰ အချိန်ခွဲတင် (repeat ရ)</blockquote>",
  "<blockquote>📢 <b>Channel</b> — Bot ကို channel မှာ admin လုပ်ရုံ (သို့) 📢 Channels ထဲက ➕\n👥 <b>Group</b> တွေက အလိုလိုမှတ်ပါတယ်</blockquote>",
].join("\n");
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
const MKB = { price: "💰 ဈေးနှုန်း", calc: "🧮 Calculator" };
// Owner's bottom keyboard (private chat): always shown again after a post is finished / cancelled. Taps are handled at the top of postFlow().
const mainKb = () => ({
  keyboard: [
    [{ text: ML.new, style: "primary" }, { text: ML.list, style: "primary" }],
    [{ text: ML.chn, style: "primary" }, { text: ML.bal, style: "primary" }],
    [{ text: MKB.price, style: "primary" }, { text: MKB.calc, style: "primary" }],
    [{ text: ML.help, style: "primary" }],
  ],
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
    [{ text: `🔗 Link preview ${onoff(!p.nopv)}` }, { text: PL.redo }],
    [{ text: PL.album }, { text: PL.prev }],
    [{ text: PL.test, style: "primary" }],
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
  const key = `pst:${uid}`;
  const say = (txt, extra = {}) => send({ ...env, replyTo: 0 }, chat, txt, extra);
  if (t === ML.bal) { await showBalance({ ...env, replyTo: 0 }, chat); return true; }
  if (t === MKB.price) { await sendPricePicker({ ...env, replyTo: 0 }, chat, await getLang(env, uid)); return true; }
  if (t === MKB.calc) { await say(CALC_HELP); return true; }
  if (t === ML.help) {   // the same menu /start shows, called from the keyboard; ❌ ပိတ် deletes it
    await junkSweep(env, chat);
    await sendUi({ ...env, replyTo: 0 }, chat, MENU_TEXT, helpRows(true, true));
    return true;
  }
  let st = await env.STATE.get(key, "json").catch(() => null);
  const save = () => env.STATE.put(key, JSON.stringify(st), { expirationTtl: 6 * 3600 });

  // register a channel: forward any post of it to the bot (only when not busy writing a post)
  if (m.forward_origin?.type === "channel" && m.forward_origin.chat && (!st || !["content"].includes(st.step))) {
    const c = m.forward_origin.chat;
    await env.STATE.put("chn:" + c.id, String(c.title || c.username || c.id).slice(0, 60));
    await say(`📢 Channel မှတ်ပြီးပါပြီ: <b>${esc(c.title || c.username || c.id)}</b>\n<code>${c.id}</code>\nBot ကို အဲဒီ channel မှာ admin (Post / Edit / Delete / Pin messages ခွင့်) ပေးထားပါ။\n(နောက်ကျရင် forward မလိုပါ — Bot ကို admin လုပ်ရုံနဲ့ အလိုလိုမှတ်ပါတယ်)`, { reply_markup: mainKb() });
    return true;
  }

  const cm = t.match(/^\/(post|posts|delpost|addchannel|delchannel|channels)(?:@\w+)?(?:\s+([\s\S]*))?$/i);
  if (cm) {
    const cmd = cm[1].toLowerCase(), arg = (cm[2] || "").trim();
    if (t !== raw.trim() || ["post", "posts", "channels"].includes(cmd)) await junkSweep(env, chat);   // a menu button / command clears the older screens
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
  }

  if (!st) return false;
  // ❌ ပယ်ဖျက် = leave everything. ⬅️ Back on the first / single-screen steps leaves too (nothing to lose there).
  if (t === PL.cancel || (t === PL.back && ["target", "addch"].includes(st.step))) {
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
  if (t.startsWith("/") && !["content"].includes(st.step)) return false;   // other commands keep working

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
    } else {   // buttons / color / when -> post menu
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
    await tg(env, "editMessageReplyMarkup", { chat_id: chat, message_id: q.message.message_id, reply_markup: { inline_keyboard: [] } }).catch(() => {});
    return say(postReport(res), { reply_markup: NO_KB });
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
    st.step = "content";
    await env.STATE.put(key, JSON.stringify(st), { expirationTtl: 6 * 3600 });
    await ans(null);
    const names = targets.filter((x) => st.sel.includes(x.id)).map((x) => `${x.kind} ${esc(x.title)}`).join("\n");
    await tg(env, "editMessageText", { chat_id: chat, message_id: q.message.message_id, text: `📝 <b>တင်မယ့်နေရာ</b>\n${names}`, parse_mode: "HTML" });
    return say(CONTENT_TEXT, { reply_markup: contentKb() });
  } else if (targets.some((x) => x.id === gid)) st.sel = st.sel.includes(gid) ? st.sel.filter((x) => x !== gid) : [...st.sel, gid];
  await env.STATE.put(key, JSON.stringify(st), { expirationTtl: 6 * 3600 });
  await ans(null);
  return tg(env, "editMessageReplyMarkup", { chat_id: chat, message_id: q.message.message_id, reply_markup: targetKb(targets, st.sel) });
}

/* ---------- Rich UI (Bot API 10.3): table + button grid in one message, replaces the inline keyboards ---------- */
// Buttons are written once as { text, data | url, style } rows; sendUi() sends them as a rich message
// (every label cut / padded to the same length, so the buttons look even) and falls back to a normal inline keyboard.
const CLOSE_BTN = { text: "❌ ပိတ်", data: "pz:c", style: "danger" };
const qa = (s) => esc(String(s)).replace(/"/g, "&quot;");
const vlen = (s) => [...String(s)].filter((c) => !/\p{M}/u.test(c)).length;
function fitLabel(t, n) {
  let out = "", v = 0, cut = false;
  for (const ch of String(t)) {
    const w = /\p{M}/u.test(ch) ? 0 : 1;
    if (v + w > n) { cut = true; break; }
    out += ch; v += w;
  }
  if (cut) { out = out.replace(/\s+$/, "") + "…"; v = vlen(out); }
  const pad = Math.max(0, n - v);
  return "\u2800".repeat(Math.floor(pad / 2)) + out + "\u2800".repeat(Math.ceil(pad / 2));
}
const evenRows = (rows, n = 14) => rows.filter((r) => r.length).map((r) => r.map((b) => ({ ...b, text: fitLabel(b.text, n) })));
const toInline = (rows) => rows.map((r) => r.map((b) => ({ text: b.text, ...(b.url ? { url: b.url } : { callback_data: b.data }), ...(b.style ? { style: b.style } : {}) })));
const rbtn = (b) => `<tg-button type="${b.url ? "url" : "callback_data"}"${b.style ? ` style="${b.style}"` : ""} ${b.url ? `url="${qa(b.url)}"` : `data="${qa(b.data)}"`}>${esc(b.text)}</tg-button>`;
const rrows = (rows) => rows.map((r) => `<tg-button-row align="center">${r.map(rbtn).join("")}</tg-button-row>`).join("");
// Telegram-HTML text (b / i / code, \n) -> rich paragraphs
const htmlToRich = (h) => String(h).split(/\n+/).map((l) => l.trim()).filter(Boolean).map((l) => `<p>${l}</p>`).join("");
async function sendUi(env, chat, html, rows, ms, n = 14) {
  // Normal inline keyboard on purpose: every button in a row gets the same width (the rich button grid sized buttons by their text).
  let rs = rows.filter((r) => r.length);
  if (env.bc) rs = rs.map((r) => r.filter((b) => b.url)).filter((r) => r.length);   // Chat automation: only link buttons
  return sendCard(env, chat, html, rs.length ? { reply_markup: { inline_keyboard: toInline(rs) } } : {}, ms);
}

/* ---------- Package price quote ("ml 86 x3" -> total), order preview, change, USD <-> Ks ---------- */
// Customers never see the cost price: only the selling price (package.price). Cost is kept for the owner's daily summary.
const fmtKs = (n) => Math.round(Number(n) || 0).toLocaleString("en-US");
// ["86", "x3", "wp2", "50+x2"] -> { want: [{ tok, qty }], bad: [tok] }   (same token rules as the admin buy message)
function wantFromTokens(entries, gkey, toks) {
  const want = [], bad = [];
  for (const raw of toks) {
    const r = String(raw).toLowerCase();
    let mm;
    if ((mm = r.match(/^x(\d{1,2})$/)) && want.length) { want[want.length - 1].qty = Number(mm[1]); continue; }
    if (pickPackage(entries, r, gkey, true)) { want.push({ tok: r, qty: 1 }); continue; }
    mm = r.match(/^(\d+\+?)x(\d{1,2})$/) || r.match(/^([a-z]+)(\d{1,2})$/);
    if (mm && pickPackage(entries, mm[1], gkey, true)) { want.push({ tok: mm[1], qty: Number(mm[2]) }); continue; }
    bad.push(r);
  }
  const merged = [];
  for (const w of want) { const p = merged.find((y) => y.tok === w.tok); if (p) p.qty += w.qty; else merged.push({ ...w }); }
  return { want: merged, bad };
}
// -> { items: [{ tok, qty, p, unit, sub }], bad: [tok], total, cost }   cost = 0 when any package has no cost price
function quoteOf(entries, gkey, want) {
  const items = [], bad = [];
  let total = 0, cost = 0, costOk = true;
  for (const w of want) {
    const hit = w.qty >= 1 && w.qty <= 99 ? pickPackage(entries, w.tok, gkey, true) : null;
    if (!hit) { bad.push(w.tok); continue; }
    const unit = Number(hit.p.price) || 0, c = Number(hit.p.cost) || 0;
    items.push({ tok: w.tok, qty: w.qty, p: hit.p, unit, sub: unit * w.qty });
    total += unit * w.qty;
    if (c > 0) cost += c * w.qty; else costOk = false;
  }
  return { items, bad, total, cost: costOk ? cost : 0 };
}
const quoteLines = (q) => q.items.map((x) => `${esc(String(x.p.amount))}${x.qty > 1 ? ` ×${x.qty}` : ""} — ${fmtKs(x.sub)} Ks`).join("\n");
// "ml 86 x3 wp" -> { group, entries, quote } ; null when the message is not exactly "<game> <packages>" (chatter stays untouched)
async function parseQuote(env, text) {
  const toks = buyTokens(text);
  if (toks.length < 2 || toks.length > 14 || toks.some((t) => /^\d{5,}$/.test(t))) return null;
  const groups = await loadGroups(env);
  for (const k of [1, 2]) {
    const hit = abbrGroups(groups, toks.slice(0, k).join(" "), true);
    if (hit.length !== 1) continue;
    const group = hit[0];
    const entries = (await loadPackages(env)).get(group.key) || [];
    if (!entries.length) return null;
    const rest = toks.slice(k).filter((t) => !BUY_FILLER.test(t));
    if (!rest.length) return null;
    const { want, bad } = wantFromTokens(entries, group.key, rest);
    if (bad.length || !want.length) return null;
    const quote = quoteOf(entries, group.key, want);
    if (quote.bad.length || !quote.items.length) return null;
    return { group, entries, quote };
  }
  return null;
}
async function sendQuote(env, chat, q) {
  const html = `🎮 <b>${esc(q.group.name)}</b>\n\n${quoteLines(q.quote)}\n━━━━━━━━\n💰 <b>Total: ${fmtKs(q.quote.total)} Ks</b>`;
  const copy = { text: "Copy", copy_text: { text: String(Math.round(q.quote.total)) }, style: "primary", ...ic(env, "ICON_COPY") };
  return sendCard(env, chat, html, { reply_markup: { inline_keyboard: [[copy]] } });
}
const adminTags = async (env, chat) => {
  const r = await tg(env, "getChatAdministrators", { chat_id: chat }).catch(() => null);
  return (r?.result || []).filter((a) => a.user && !a.user.is_bot).slice(0, 10).map((a) => `<a href="tg://user?id=${a.user.id}">${esc(a.user.first_name || "Admin")}</a>`).join(" ");
};

// Customer order message: "ml 123456789 2002 86 x3" (same format the admins use to buy). Not bought: the ID is checked and the card
// also shows the packages + total. The same ID + package sent again within 10 minutes is flagged (admins are tagged in groups).
async function orderPreview(env, m, chat, plan, isGroup) {
  const { group, orders } = plan;
  const entries = (await loadPackages(env)).get(group.key) || plan.entries;
  const todo = [], probs = [];
  for (const o of orders) {
    if (o.err) { probs.push(`${o.id || o.line.slice(0, 30)} — ${o.err}`); continue; }
    const qt = quoteOf(entries, group.key, o.want);
    if (qt.bad.length) probs.push(`${o.id} — Package မတွေ့: ${qt.bad.join(" ")}`);
    else todo.push({ o, qt });
  }
  if (probs.length) await sendCard(env, chat, `⚠️ <b>${esc(group.name)}</b>\n${probs.map((x) => esc(x)).join("\n")}\n\n<code>/pkgs ${esc(group.key)}</code> နဲ့ package အတိုကောက် ကြည့်နိုင်ပါတယ်`);
  for (const { o, qt } of todo.slice(0, 5)) {
    let warn = "";
    if (env.STATE) {
      const sig = `opv:${chat}:${group.key}:${o.id}:${o.server}:${o.want.map((w) => w.tok + "x" + w.qty).join(",")}`;
      const prev = Number(await env.STATE.get(sig).catch(() => 0)) || 0;
      await env.STATE.put(sig, String(Date.now()), { expirationTtl: 600 }).catch(() => {});
      if (prev) {
        const mins = Math.max(1, Math.round((Date.now() - prev) / 60000));
        warn = `⚠️ <b>ထပ်နေပါတယ်</b> — ဒီ ID / package ကို ${mins} မိနစ်အလိုက ပို့ပြီးသား` + (isGroup ? `\n${await adminTags(env, chat)}` : "");
        if (!isGroup) await notifyOwners(env, `⚠️ <b>Order ထပ်နေ</b>\n${esc(group.name)} <code>${esc(o.id)}${o.server ? `(${esc(o.server)})` : ""}</code> — ${mins} မိနစ်အတွင်း ထပ်ပို့ထားတယ်`).catch(() => {});
      }
    }
    const html = `📦 ${quoteLines(qt)}\n💰 <b>Total: ${fmtKs(qt.total)} Ks</b>` + (warn ? `\n\n${warn}` : "");
    await runCheck({ ...env, orderExtra: { html, price: qt.total, cost: qt.cost, n: qt.items.length, items: qt.items.map((x) => [String(x.p.amount), x.qty, x.sub]) } }, chat, group, o.id, o.server);
  }
  return true;
}

// ----- change ("paid 50000 price 45000") and USD <-> Ks -----
const CH_PAID = "(?:paid|pay|ပေး(?:ငွေ)?|လက်ခံ(?:ငွေ)?)";
const CH_PRICE = "(?:price|total|bill|cost|ဈေး|ကျငွေ|ကျ|စုစုပေါင်း)";
function calcChangeParse(line) {
  const s = String(line || "").trim();
  let m = s.match(new RegExp(`^${CH_PAID}\\s*[:=]?\\s*(.+?)\\s+${CH_PRICE}\\s*[:=]?\\s*(.+)$`, "iu"));
  if (m) return { paid: m[1], price: m[2] };
  m = s.match(new RegExp(`^${CH_PRICE}\\s*[:=]?\\s*(.+?)\\s+${CH_PAID}\\s*[:=]?\\s*(.+)$`, "iu"));
  return m ? { paid: m[2], price: m[1] } : null;
}
// -> { paid, price, diff } ; the price may also be a package list ("ml 86 x3")
async function calcChangeEval(env, c) {
  const amount = async (s, allowQuote) => {
    try { return calcEval(calcNormalize(s)).v; }
    catch (e) {
      if (!allowQuote) throw e;
      const q = await parseQuote(env, s);
      if (q) return q.quote.total;
      throw e;
    }
  };
  const paid = await amount(c.paid, false), price = await amount(c.price, true);
  return { paid, price, diff: paid - price };
}
function calcChangeHtml(r) {
  const head = r.diff > 0 ? `<b>ပြန်အမ်း: ${fmtKs(r.diff)} Ks</b>` : r.diff === 0 ? "✅ <b>အတိအကျ ပေးထားပါတယ်</b>" : `⚠️ <b>ငွေ လိုနေသေး: ${fmtKs(-r.diff)} Ks</b>`;
  return `💵 <b>ပြန်အမ်းငွေ</b>\nပေးငွေ: ${fmtKs(r.paid)} Ks\nဈေး: ${fmtKs(r.price)} Ks\n━━━━━━━━\n${head}`;
}
const CUR_WORD = "(?:usd|dollars?|mmk|ks|kyat|ကျပ်|\\$)";
const curOf = (w) => (/^(?:usd|dollars?|\$)$/i.test(w) ? "usd" : /^(?:mmk|ks|kyat|ကျပ်)$/i.test(w) ? "mmk" : "");
function calcCurrencyParse(line) {
  const m = String(line || "").trim().match(new RegExp(`^(\\$)?\\s*([\\d.,]+\\s*[kKmM]?)\\s*(${CUR_WORD})?\\s*(?:to|in|into|->|=>|→|=)\\s*(${CUR_WORD})$`, "iu"));
  if (!m) return null;
  const from = m[1] ? "usd" : curOf(m[3] || ""), to = curOf(m[4]);
  if (!from || !to || from === to) return null;
  try { return { x: calcEval(calcNormalize(m[2])).v, from, to }; } catch { return null; }
}
const calcCurrencyOut = (c, rate) => {
  const y = c.from === "usd" ? c.x * rate : c.x / rate;
  const a = calcFmt(c.x).pretty, b = calcFmt(Math.round(y * 100) / 100).pretty;
  return { y, text: c.from === "usd" ? `${a} USD = ${b} Ks` : `${a} Ks = ${b} USD`, rate };
};

/* ---------- HTTP API for other chat-automation tools (Messenger / Viber / n8n / Make / your own site) ---------- */
// Needs the secret API_KEY. Send it as header "x-api-key: <key>" (or "Authorization: Bearer <key>", or ?key=<key> for quick tests).
//   GET|POST /api/calc?q=5000+3000*2                      calculator (expression, "20% of 5000", "5 km to mi", "paid 50000 price 45000", "50 usd to mmk")
//   GET|POST /api/check?game=ml&id=123456789&server=2002  player name + region (server only for games that need one)
//   GET|POST /api/price?game=ml                           package list with selling prices (no cost)
//   GET|POST /api/quote?game=ml&items=86x3,wp             total price of the packages
//   GET|POST /api/order?game=ml&id=...&server=...&items=86x3   name check + total in one call
// POST bodies are JSON with the same field names. Every answer is JSON: { ok: true, ... } or { ok: false, error }.
const API_RL = new Map();
const timingEq = (a, b) => {
  a = String(a); b = String(b);
  let d = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) d |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return d === 0;
};
async function apiGame(env, q) {
  const groups = await loadGroups(env);
  let hit = abbrGroups(groups, q, true);
  if (hit.length !== 1) hit = findGroups(groups, q);
  return hit.length === 1 ? hit[0] : null;
}
async function apiCalc(env, q) {
  const lines = String(q || "").split(/\n+/).map((x) => x.trim()).filter(Boolean).slice(0, 16);
  if (!lines.length) return { ok: false, error: "q is empty" };
  const results = [];
  let total = 0;
  for (const line of lines) {
    try {
      const conv = lines.length === 1 ? calcConvert(line) : null;
      if (conv) { results.push({ type: "unit", input: line, text: conv.text, value: Number(conv.plain) }); continue; }
      const chg = calcChangeParse(line);
      if (chg) { const r = await calcChangeEval(env, chg); results.push({ type: "change", input: line, paid: r.paid, price: r.price, change: r.diff, value: r.diff, text: calcChangeHtml(r).replace(/<[^>]+>/g, "") }); continue; }
      const cur = calcCurrencyParse(line);
      if (cur) {
        const rate = await storeRate(env);
        if (!rate) { results.push({ type: "currency", input: line, error: "USD rate not available" }); continue; }
        const o = calcCurrencyOut(cur, rate);
        results.push({ type: "currency", input: line, text: o.text, value: o.y, rate });
        continue;
      }
      const r = calcEval(calcNormalize(line));
      total += r.v;
      results.push({ type: "expr", input: line, value: r.v, pretty: calcFmt(r.v).pretty });
    } catch (e) {
      if (!(e instanceof CalcErr)) throw e;
      results.push({ type: "error", input: line, error: e.message, detail: e.what || undefined });
    }
  }
  const first = results[0];
  return { ok: !results.every((r) => r.type === "error"), results, ...(lines.length > 1 ? { total, total_pretty: calcFmt(total).pretty } : { result: first.value ?? null, pretty: first.pretty || first.text || null }) };
}
function apiItems(entries, gkey, raw) {
  const toks = buyTokens(String(raw || "").replace(/,/g, " ")).filter((t) => !BUY_FILLER.test(t));
  const { want, bad } = wantFromTokens(entries, gkey, toks);
  const q = quoteOf(entries, gkey, want);
  return { q, bad: [...bad, ...q.bad] };
}
const apiQuoteJson = (q) => ({
  items: q.items.map((x) => ({ code: x.tok, amount: String(x.p.amount), qty: x.qty, unit_price: x.unit, subtotal: x.sub })),
  total: q.total,
  total_pretty: fmtKs(q.total) + " Ks",
});
async function apiCheck(env, group, id, server) {
  if (!id) return { ok: false, error: "id is required" };
  let pick = null;
  if (group.dropdown) {
    pick = pickServer(group, server);
    if (!pick) return { ok: false, error: "server is required", servers: dropOptions(group).map((o) => o.label) };
    server = pick.label;
  } else if (group.idOnly) server = "";
  else if (!server) return { ok: false, error: "server is required" };
  const results = pick
    ? [{ g: pick.entry, r: await callProvider(pick.entry, id, pick.value) }]
    : await Promise.all(group.entries.map(async (g) => ({ g, r: await callProvider(g, id, server) })));
  const valid = results.filter((x) => x.r.outcome === "valid");
  if (valid.length) {
    const best = valid.find(({ g, r }) => r.geo && r.geo.region && String(g.serverName || "").trim().toLowerCase() === r.geo.region.toLowerCase()) || valid[0];
    const region = fmtRegion((best.r.geo && best.r.geo.region) || regionFromServerId(best.g.g2bulkCode, server));
    return { ok: true, found: true, game: group.name, id, server: server || "", name: best.r.name, region, country: (best.r.geo && best.r.geo.country) || "", provider: best.r.provider || "", all_names: [...new Set(valid.map((x) => x.r.name))] };
  }
  if (results.every((x) => x.r.outcome === "unknown")) return { ok: false, error: "provider busy, try again", providers: [...new Set(results.map((x) => x.r.provider).filter(Boolean))] };
  if (results.some((x) => x.r.outcome === "skip") && !results.some((x) => x.r.outcome === "invalid")) return { ok: false, error: "this game has no name check" };
  return { ok: true, found: false, game: group.name, id, server: server || "", reason: results.some((x) => x.r.reason === "server") ? "server" : "id" };
}
async function apiHandle(req, env, url) {
  const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "content-type,x-api-key,authorization", "access-control-allow-methods": "GET,POST,OPTIONS" };
  const out = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json; charset=utf-8", ...cors } });
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (!env.API_KEY) return out({ ok: false, error: "API is off: set the API_KEY secret" }, 503);
  let body = {};
  if (req.method === "POST") { try { body = (await req.json()) || {}; } catch { body = {}; } }
  const key = req.headers.get("x-api-key") || (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "") || url.searchParams.get("key") || body.key || "";
  if (!timingEq(key, env.API_KEY)) return out({ ok: false, error: "unauthorized" }, 401);
  const now = Date.now(), rl = API_RL.get("k") || { t: now, n: 0 };
  if (now - rl.t > 60000) { rl.t = now; rl.n = 0; }
  if (++rl.n > 120) { API_RL.set("k", rl); return out({ ok: false, error: "too many requests (120 per minute)" }, 429); }
  API_RL.set("k", rl);
  const arg = (k) => String(body[k] ?? url.searchParams.get(k) ?? "").trim();
  try {
    const path = url.pathname.replace(/\/+$/, "");
    if (path === "/api/health") return out({ ok: true, time: now });
    if (path === "/api/calc") return out(await apiCalc(env, arg("q") || arg("text") || arg("expression")));
    const needGame = async () => {
      const g = await apiGame(env, arg("game"));
      return g ? { g, entries: (await loadPackages(env)).get(g.key) || [] } : null;
    };
    if (path === "/api/check" || path === "/api/price" || path === "/api/quote" || path === "/api/order") {
      const gm = await needGame();
      if (!gm) return out({ ok: false, error: "game not found (or more than one match): send the short name or the full name" }, 404);
      const { g, entries } = gm;
      if (path === "/api/check") return out(await apiCheck(env, g, arg("id"), arg("server")));
      if (path === "/api/price") {
        const list = [];
        for (const e of entries) for (const p of e.packages) if (priced(p)) list.push({ code: pkgShort(g.key, p), amount: String(p.amount), price: Number(p.price), region: e.server || "" });
        return out({ ok: true, game: g.name, packages: list });
      }
      const { q, bad } = apiItems(entries, g.key, arg("items"));
      if (bad.length || !q.items.length) return out({ ok: false, error: "package not found", not_found: bad }, 404);
      if (path === "/api/quote") return out({ ok: true, game: g.name, ...apiQuoteJson(q) });
      const chk = await apiCheck(env, g, arg("id"), arg("server"));
      return out({ ...chk, order: apiQuoteJson(q) });
    }
    return out({ ok: false, error: "unknown endpoint" }, 404);
  } catch (e) {
    console.error("api", e);
    return out({ ok: false, error: "server error" }, 500);
  }
}

/* ---------- Calculator ---------- */
// Plain messages that look like a calculation ("5000+3000*2", "20% of 5000", "5k*3", "2^10", "sqrt(144)") are answered with the result,
// and /calc <expression> always works. Several lines = one calculation per line + a total. Units: "5 km to mi", "100 f to c", "2 viss to kg".
// Setting: /set calc auto|cmd|off   (auto = answer by itself, cmd = only /calc, off = no calculator).
/* CALC-PURE-START */
class CalcErr extends Error {}
const CALC_BURMESE = [["သိန်း", 1e5], ["သောင်း", 1e4], ["ထောင်", 1e3], ["သန်း", 1e6], ["ကုဋေ", 1e7]];
function calcNormalize(raw) {
  let s = String(raw || "").replace(/[၀-၉]/g, (c) => "၀၁၂၃၄၅၆၇၈၉".indexOf(c));
  s = s.replace(/[−–—]/g, "-").replace(/[×✕✖✗⋅∙]/g, "*").replace(/÷/g, "/").replace(/＋/g, "+").replace(/（/g, "(").replace(/）/g, ")").replace(/＝/g, "=");
  s = s.replace(/\*\*/g, "^");
  s = s.replace(/(\d|\))\s*[xX]\s*(?=[\d(.])/g, "$1*");                      // 86x3, 5 x 4
  s = s.replace(/(\d)\s*(?:percent|pct)\b/gi, "$1%");                          // 20 percent
  s = s.replace(/(\d)\s*%\s*of\s+/gi, "$1%*");                                 // 20% of 5000
  s = s.replace(/\$|ကျပ်|(?<=\d)\s*(?:ks|mmk|usd)\b/gi, "");                   // currency marks
  if (!/[A-Za-z_]\w*\s*\(/.test(s)) s = s.replace(/(\d),(?=\d{3}(?!\d))/g, "$1"); // 1,000,000 (not inside max(1,000))
  return s.replace(/\s*=\s*\??\s*$/, "").replace(/^\s*=\s*/, "").trim();
}
function calcFn(name, a, fail) {
  const n = (k) => { if (a.length !== k) fail("args", name); };
  const one = (f) => { n(1); return f(a[0]); };
  const int = (x) => { if (!Number.isInteger(x) || x < 0) fail("math"); return x; };
  const gcd = (x, y) => { x = Math.abs(x); y = Math.abs(y); while (y) [x, y] = [y, x % y]; return x; };
  switch (name) {
    case "sqrt": return one(Math.sqrt);
    case "cbrt": return one(Math.cbrt);
    case "abs": return one(Math.abs);
    case "floor": return one(Math.floor);
    case "ceil": return one(Math.ceil);
    case "trunc": return one(Math.trunc);
    case "sign": return one(Math.sign);
    case "round": { if (a.length === 2) { const f = 10 ** Math.max(0, Math.min(12, Math.trunc(a[1]))); return Math.round((a[0] + Number.EPSILON) * f) / f; } return one(Math.round); }
    case "ln": return one(Math.log);
    case "log": case "log10": { if (a.length === 2) return Math.log(a[0]) / Math.log(a[1]); return one(Math.log10); }
    case "log2": return one(Math.log2);
    case "exp": return one(Math.exp);
    case "sin": return one(Math.sin);
    case "cos": return one(Math.cos);
    case "tan": return one(Math.tan);
    case "asin": return one(Math.asin);
    case "acos": return one(Math.acos);
    case "atan": return one(Math.atan);
    case "rad": return one((x) => (x * Math.PI) / 180);
    case "deg": return one((x) => (x * 180) / Math.PI);
    case "pow": n(2); return Math.pow(a[0], a[1]);
    case "mod": n(2); if (a[1] === 0) fail("div0"); return a[0] % a[1];
    case "hypot": if (!a.length) fail("args", name); return Math.hypot(...a);
    case "min": if (!a.length) fail("args", name); return Math.min(...a);
    case "max": if (!a.length) fail("args", name); return Math.max(...a);
    case "sum": if (!a.length) fail("args", name); return a.reduce((x, y) => x + y, 0);
    case "avg": case "mean": if (!a.length) fail("args", name); return a.reduce((x, y) => x + y, 0) / a.length;
    case "fact": return one((x) => { int(x); if (x > 170) fail("overflow"); let r = 1; for (let i = 2; i <= x; i++) r *= i; return r; });
    case "gcd": if (a.length < 2) fail("args", name); return a.map(int).reduce(gcd);
    case "lcm": if (a.length < 2) fail("args", name); return a.map(int).reduce((x, y) => (x && y ? (x / gcd(x, y)) * y : 0));
    // store helpers: disc(price, pct) = price after discount, vat/tax(price, pct) = price + pct, pctof(a, b) = a is what % of b, pchange(old, new) = % change
    case "disc": case "discount": n(2); return a[0] * (1 - a[1] / 100);
    case "vat": case "tax": case "markup": n(2); return a[0] * (1 + a[1] / 100);
    case "pctof": n(2); if (a[1] === 0) fail("div0"); return (a[0] / a[1]) * 100;
    case "pchange": n(2); if (a[0] === 0) fail("div0"); return ((a[1] - a[0]) / Math.abs(a[0])) * 100;
    default: fail("unknown", name);
  }
}
// -> { v, ops, nums }. ops = operators / functions / % used, nums = numbers and constants read (used to tell a calculation from chatter).
function calcEval(s, ans) {
  let i = 0, depth = 0, ops = 0, nums = 0;
  const fail = (code, what) => { const e = new CalcErr(code); e.what = what || ""; throw e; };
  const ok = (x) => { if (!Number.isFinite(x)) fail("math"); return x; };
  const peek = () => { while (i < s.length && /\s/.test(s[i])) i++; return s[i] || ""; };
  const unitAt = (t) => CALC_BURMESE.find(([w]) => t.startsWith(w));

  function number() {
    const m = s.slice(i).match(/^(?:0[xX][0-9a-fA-F]+|0[bB][01]+|(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)/);
    if (!m) fail("syntax");
    const t = m[0];
    i += t.length;
    nums++;
    let v = /^0[xX]/.test(t) ? parseInt(t, 16) : /^0[bB]/.test(t) ? parseInt(t.slice(2), 2) : parseFloat(t);
    const sfx = s.slice(i).match(/^([kKmMbB])(?![A-Za-z])/);   // 5k, 2.5m, 1b (attached to the number)
    if (sfx) { v *= { k: 1e3, m: 1e6, b: 1e9 }[sfx[1].toLowerCase()]; i += 1; ops++; return v; }
    const u = unitAt(s.slice(i).trimStart());               // 5သိန်း 3သောင်း 2ထောင် = 530,000 + 2,000
    if (u) {
      i = s.length - s.slice(i).trimStart().length + u[0].length;
      let total = v * u[1], last = u[1];
      for (;;) {
        const mm = s.slice(i).match(/^\s*(\d+(?:\.\d+)?)\s*/);
        if (!mm) break;
        const rest = s.slice(i + mm[0].length);
        const u2 = unitAt(rest);
        if (!u2 || u2[1] >= last) break;
        total += parseFloat(mm[1]) * u2[1]; last = u2[1]; i += mm[0].length + u2[0].length; nums++;
      }
      ops++;
      return total;
    }
    return v;
  }
  function primary() {
    const c = peek();
    if (c === "(") {
      i++;
      if (++depth > 40) fail("syntax");
      const r = expr();
      if (peek() !== ")") fail("paren");
      i++; depth--;
      return { v: r.v };
    }
    if (/[\d.]/.test(c)) return { v: number() };
    if (/[A-Za-z_]/.test(c)) {
      const word = s.slice(i).match(/^[A-Za-z_]\w*/)[0];
      i += word.length;
      const name = word.toLowerCase();
      if (peek() === "(") {
        i++;
        if (++depth > 40) fail("syntax");
        const args = [];
        if (peek() === ")") i++;
        else for (;;) {
          args.push(expr().v);
          const d = peek();
          if (d === "," || d === ";") { i++; continue; }
          if (d === ")") { i++; break; }
          fail("paren");
        }
        depth--; ops++;
        return { v: ok(calcFn(name, args, fail)) };
      }
      if (name === "pi") { nums++; return { v: Math.PI }; }
      if (name === "e") { nums++; return { v: Math.E }; }
      if (name === "tau") { nums++; return { v: 2 * Math.PI }; }
      if (name === "ans") { if (ans === undefined) fail("noans"); nums++; return { v: ans }; }
      fail("unknown", word);
    }
    fail("syntax");
  }
  function postfix() {
    let r = primary();
    for (;;) {
      const c = peek();
      if (c === "!") { i++; ops++; r = { v: ok(calcFn("fact", [r.v], fail)) }; continue; }
      if (c === "%") {
        const save = i;
        i++;
        const nx = peek();
        if (nx && /[\d(.A-Za-z]/.test(nx) && !/^of\b/i.test(s.slice(i))) { i = save; break; }   // "10 % 3" = remainder
        ops++;
        r = { v: r.v / 100, p: true, raw: r.v };
        continue;
      }
      break;
    }
    return r;
  }
  function power() {
    const b = postfix();
    if (peek() === "^") { i++; ops++; const e = unary(); return { v: ok(Math.pow(b.v, e.v)) }; }
    return b;
  }
  function unary() {
    const c = peek();
    if (c === "-") { i++; return { v: -unary().v }; }
    if (c === "+") { i++; return unary(); }
    return power();
  }
  function term() {
    let a = unary();
    for (;;) {
      const c = peek();
      if (c === "*" || c === "/") {
        i++; ops++;
        const b = unary();
        if (c === "/" && b.v === 0) fail("div0");
        a = { v: ok(c === "*" ? a.v * b.v : a.v / b.v) };
        continue;
      }
      if (c === "%" || /^mod\b/i.test(s.slice(i))) {
        i += c === "%" ? 1 : 3; ops++;
        const b = unary();
        if (b.v === 0) fail("div0");
        a = { v: ok(a.v % b.v) };
        continue;
      }
      if (c === "(" || (/[A-Za-z_]/.test(c) && !/^(?:mod|of)\b/i.test(s.slice(i)))) {   // 2(3+4), 3pi
        ops++;
        const b = unary();
        a = { v: ok(a.v * b.v) };
        continue;
      }
      break;
    }
    return a;
  }
  function expr() {
    let a = term();
    for (;;) {
      const c = peek();
      if (c !== "+" && c !== "-") break;
      i++; ops++;
      const b = term();
      const bv = b.p ? (a.v * b.raw) / 100 : b.v;   // 5000 + 10% = 5500, 5000 - 10% = 4500
      a = { v: ok(c === "+" ? a.v + bv : a.v - bv) };
    }
    return a;
  }
  if (!s) fail("syntax");
  const r = expr();
  if (peek()) fail("syntax");
  return { v: ok(r.v), ops, nums };
}
// 12,345.6 -> "12,345.6" ; plain = the same without commas (for Copy)
function calcFmt(n) {
  if (Object.is(n, -0)) n = 0;
  const abs = Math.abs(n);
  let t;
  if (abs !== 0 && (abs >= 1e15 || abs < 1e-9)) t = n.toExponential(8).replace(/\.?0+e/, "e").replace("e+", "e");
  else {
    t = Number.isInteger(n) ? String(n) : String(Number(n.toPrecision(12)));
    if (/e/.test(t)) t = n.toFixed(12).replace(/\.?0+$/, "");
  }
  if (/e/.test(t)) return { pretty: t, plain: t };
  const neg = t[0] === "-";
  const [ip, fp] = t.replace("-", "").split(".");
  const pretty = (neg ? "-" : "") + ip.replace(/\B(?=(\d{3})+(?!\d))/g, ",") + (fp ? "." + fp : "");
  return { pretty, plain: t };
}
// Unit conversion: "5 km to mi", "100 f to c", "2 viss to kg", "1.5gb in mb" -> { text, plain } or null
const CALC_UNITS = {
  length: { m: 1, mm: 0.001, cm: 0.01, km: 1000, in: 0.0254, ft: 0.3048, yd: 0.9144, mi: 1609.344 },
  mass: { kg: 1, g: 0.001, mg: 1e-6, lb: 0.45359237, oz: 0.028349523125, viss: 1.63293 },
  volume: { l: 1, ml: 0.001, gal: 3.785411784, floz: 0.0295735295625 },
  data: { b: 1, kb: 1024, mb: 1048576, gb: 1073741824, tb: 1099511627776 },
  time: { s: 1, min: 60, h: 3600, d: 86400, wk: 604800 },
  temp: { c: 1, f: 1, k: 1 },
};
const CALC_UNIT_ALIAS = {
  meter: "m", meters: "m", metre: "m", metres: "m", millimeter: "mm", centimeter: "cm", kilometer: "km", kilometers: "km", kms: "km",
  inch: "in", inches: "in", foot: "ft", feet: "ft", yard: "yd", yards: "yd", mile: "mi", miles: "mi",
  kilo: "kg", kilos: "kg", kilogram: "kg", kilograms: "kg", gram: "g", grams: "g", pound: "lb", pounds: "lb", lbs: "lb", ounce: "oz", ounces: "oz",
  ပိဿာ: "viss", liter: "l", litre: "l", liters: "l", litres: "l", gallon: "gal", gallons: "gal",
  byte: "b", bytes: "b", sec: "s", second: "s", seconds: "s", minute: "min", minutes: "min", hr: "h", hour: "h", hours: "h", day: "d", days: "d", week: "wk", weeks: "wk",
  celsius: "c", "°c": "c", "ºc": "c", fahrenheit: "f", "°f": "f", "ºf": "f", kelvin: "k",
};
const calcUnit = (u) => {
  const x = String(u || "").toLowerCase().replace(/\.$/, "");
  const k = CALC_UNIT_ALIAS[x] || x;
  const cat = Object.keys(CALC_UNITS).find((c) => k in CALC_UNITS[c]);
  return cat ? { cat, k } : null;
};
function calcConvert(line) {
  const m = String(line || "").trim().match(/^(-?\d[\d,]*\.?\d*|-?\.\d+)\s*([A-Za-z°º\u1000-\u109F]+)\s+(?:to|into|in|->|=>|→|=)\s+([A-Za-z°º\u1000-\u109F]+)$/i);
  if (!m) return null;
  const a = calcUnit(m[2]), b = calcUnit(m[3]);
  if (!a || !b || a.cat !== b.cat) return null;
  const x = parseFloat(m[1].replace(/,/g, ""));
  if (!Number.isFinite(x)) return null;
  let y;
  if (a.cat === "temp") {
    const c = a.k === "c" ? x : a.k === "f" ? ((x - 32) * 5) / 9 : x - 273.15;
    y = b.k === "c" ? c : b.k === "f" ? (c * 9) / 5 + 32 : c + 273.15;
  } else y = (x * CALC_UNITS[a.cat][a.k]) / CALC_UNITS[a.cat][b.k];
  const name = (u) => (u.cat === "temp" ? (u.k === "k" ? "K" : "°" + u.k.toUpperCase()) : u.k);
  const fx = calcFmt(x), fy = calcFmt(y);
  return { text: `${fx.pretty} ${name(a)} = ${fy.pretty} ${name(b)}`, plain: fy.plain };
}
/* CALC-PURE-END */

const CALC_ANS = new Map();   // user id -> last result (the word "ans")
const CALC_ERR = {
  div0: "သုညနဲ့ စားလို့မရပါ",
  overflow: "ဂဏန်း ကြီးလွန်းပါတယ်",
  math: "တွက်လို့မရတဲ့ တန်ဖိုးပါ (ဥပမာ အနုတ်ကို square root)",
  paren: "ကွင်းစ ကွင်းပိတ် မကိုက်ပါ",
  syntax: "ပုံစံ မမှန်ပါ",
  noans: "ရှေ့က ရလဒ် မရှိသေးပါ",
};
const CALC_HELP = [
  "<b>🧮 Calculator</b>",
  "<blockquote><b>ပုံမှန်</b>\n<code>5000+3000*2</code>  <code>(15000-2500)/5</code></blockquote>",
  "<blockquote><b>%</b>\n<code>20% of 5000</code>  <code>5000+10%</code>  <code>5000-15%</code></blockquote>",
  "<blockquote><b>အတိုကောက်</b>\n<code>5k*3</code>  <code>2m</code>  <code>2သိန်း 5သောင်း</code></blockquote>",
  "<blockquote><b>ဆိုင်သုံး</b>\n<code>disc(50000,10)</code> — လျှော့ပြီး\n<code>vat(50000,5)</code> — တိုးပြီး\n<code>pctof(30,200)</code> · <code>pchange(100,125)</code></blockquote>",
  "<blockquote><b>အကြွေးပြန်အမ်း · USD</b>\n<code>paid 50000 price 45000</code>\n<code>50 usd to mmk</code> <i>(Admin)</i></blockquote>",
  "<blockquote><b>Unit</b>\n<code>5 km to mi</code>  <code>100 f to c</code>  <code>2 viss to kg</code></blockquote>",
  "<blockquote><b>တခြား</b>\n<code>2^10</code>  <code>10!</code>  <code>17 mod 5</code>  <code>sqrt(144)</code>  <code>pi*5^2</code>\n<code>round(10/3, 2)</code>  <code>min(3,9)</code>  <code>avg(10,20,30)</code>  <code>ans*2</code></blockquote>",
  "<i>စာကြောင်းများများ ရေးရင် တစ်ကြောင်းချင်း တွက်ပြီး စုစုပေါင်း ပေးမယ်\nReply လုပ်ပြီး /calc ရိုက်ရင် အဲဒီစာကို တွက်ပေးမယ်\nAdmin: /set calc auto|cmd|off</i>",
].join("\n");

// Returns true when the message was answered as a calculation.
async function calcHandle(env, m, chat, text, isGroup) {
  const mode = S.calc || "auto";
  let cmd = text.match(/^\/(?:calc|change)(?:@\w+)?(?:\s+([\s\S]*))?$/i);
  if (cmd && /^\/change/i.test(text)) { const nn = (cmd[1] || "").trim().split(/\s+/); cmd = [cmd[0], nn.length === 2 && /^[\d.,]+[kKmM]?$/.test(nn[0]) ? `paid ${nn[0]} price ${nn[1]}` : cmd[1]]; }
  if (mode === "off") return false;
  if (!cmd && (mode !== "auto" || text.startsWith("/"))) return false;
  let body = cmd ? (cmd[1] || "").trim() : text;
  if (cmd && !body) body = String(m.reply_to_message?.text || m.reply_to_message?.caption || "").trim();
  if (cmd && !body) { await send(env, chat, CALC_HELP); return true; }
  if (!body || body.length > 600) return false;
  if (!cmd) {
    // Automatic mode stays quiet on anything that could be an ID, a date, a phone number or a formatted notice.
    if (isGroup && isFormatted(m)) return false;
    if (m.reply_to_message?.from?.is_bot) return false;
    if (/\d{5,20}\s*[(（]\s*\d{1,6}\s*[)）]/.test(body)) return false;                 // 123456789(2002)
    if (/^\d{6,20}[-–/|,:.]\d{1,6}$/.test(body.trim()) && !/0{3}[-–/|,:.]/.test(body.trim())) return false;   // 123456789-2002 (round amounts like 1000000-50000 are calculated)
    if (/^\d{1,4}[-/.]\d{1,2}[-/.]\d{2,4}$/.test(body.trim())) return false;           // 12-11-2026
    if (/^(?:\+?95|0)9[\d\s-]{7,}$/.test(body.trim())) return false;                    // 09-123-456-789
  }
  const lines = body.split(/\n+/).map((x) => x.trim()).filter(Boolean);
  if (!lines.length || lines.length > 16) return false;
  const uid = String(m.from?.id || chat);
  const ans = CALC_ANS.get(uid);
  if (lines.length === 1) {
    const one = lines[0];
    const chg = calcChangeParse(one);   // "paid 50000 price 45000" (the price may be a package list: "paid 20000 price ml 86 x3")
    if (chg) {
      try { await sendCard(env, chat, calcChangeHtml(await calcChangeEval(env, chg))); return true; }
      catch (e) { if (!(e instanceof CalcErr)) throw e; if (!cmd) return false; }
    }
    const cur = calcCurrencyParse(one);   // "50 usd to mmk": uses the store's USD rate, so only owners / group admins
    if (cur) {
      const isOwn = idList(env.OWNER_IDS).includes(String(m.from?.id));
      if (isOwn || (isGroup && (await isAdmin(env, chat, m.from?.id)))) {
        const rate = await storeRate(env);
        if (!rate) { await send(env, chat, esc(NO_RATE)); return true; }
        const o = calcCurrencyOut(cur, rate);
        await sendCard(env, chat, `💱 <b>${esc(o.text)}</b>\n<i>rate ${esc(String(rate))}</i>`, { reply_markup: { inline_keyboard: [[{ text: "Copy", copy_text: { text: String(Math.round(o.y * 100) / 100) }, style: "primary", ...ic(env, "ICON_COPY") }]] } });
        return true;
      }
      if (cmd) { await send(env, chat, "⛔ Admin ပဲ သုံးလို့ရပါတယ်"); return true; }
      return false;
    }
    if (cmd) { const qq = await parseQuote(env, one); if (qq) { await sendQuote(env, chat, qq); return true; } }   // /calc ml 86 x3
  }
  const rows = [];
  let meaningful = false;
  for (const line of lines) {
    if (line.length > 200) return false;
    const conv = lines.length === 1 ? calcConvert(line) : null;
    if (conv) { rows.push({ src: line, conv }); meaningful = true; continue; }
    try {
      const r = calcEval(calcNormalize(line), ans);
      if (r.ops > 0 && (r.nums >= 2 || /[A-Za-z]\w*\s*\(/.test(line))) meaningful = true;
      rows.push({ src: line, v: r.v });
    } catch (e) {
      if (!(e instanceof CalcErr)) { if (cmd) throw e; return false; }
      if (!cmd) return false;   // chatter, not a calculation
      const why = e.message === "unknown" ? `မသိတဲ့ စကားလုံး: <code>${esc(e.what)}</code>` : e.message === "args" ? `<code>${esc(e.what)}()</code> ရဲ့ ဂဏန်းအရေအတွက် မမှန်ပါ` : CALC_ERR[e.message] || CALC_ERR.syntax;
      return await send(env, chat, `🧮 ⚠️ ${why}\n<code>${esc(line)}</code>\n\nနည်းလမ်းကြည့်ရန် <code>/calc</code>`), true;
    }
  }
  if (!cmd && !meaningful) return false;

  let html, plain;
  if (rows.length === 1) {
    const r = rows[0];
    if (r.conv) { html = `🔄 <b>${esc(r.conv.text)}</b>`; plain = r.conv.plain; }
    else {
      const f = calcFmt(r.v);
      plain = f.plain;
      CALC_ANS.set(uid, r.v);
      if (CALC_ANS.size > 2000) CALC_ANS.clear();
      const abs = Math.abs(r.v);
      const lakh = abs >= 1e5 && abs < 1e12 ? `\n<i>≈ ${esc(calcFmt(Math.round((r.v / 1e5) * 100) / 100).pretty)} သိန်း</i>` : "";
      html = `🧮 <b>Calculator</b>\n<blockquote>${esc(calcNormalize(r.src))}</blockquote>\n<b>= ${esc(f.pretty)}</b>${lakh}`;
    }
  } else {
    let total = 0;
    const out = rows.map((r, k) => {
      total += r.v;
      return `${k + 1}) <code>${esc(calcNormalize(r.src))}</code> = <b>${esc(calcFmt(r.v).pretty)}</b>`;
    });
    const f = calcFmt(total);
    plain = f.plain;
    CALC_ANS.set(uid, total);
    html = `🧮 <b>Calculator</b>\n${out.join("\n")}\n━━━━━━━━\n<b>Σ Total = ${esc(f.pretty)}</b>`;
  }
  const copy = { text: "Copy", copy_text: { text: String(plain).slice(0, 256) }, style: "primary", ...ic(env, "ICON_COPY") };
  await sendCard(env, chat, html, { reply_markup: { inline_keyboard: [[copy]] } });
  return true;
}

/* ---------- Bot flow ---------- */
const MENU_TEXT = [
  "<b>🤖 PCA Name Check Bot</b>",
  "<blockquote><b>🔎 Name စစ်</b>\n<code>123456789(2002)</code></blockquote>",
  "<blockquote><b>💰 ဈေးကြည့်</b>\nGame အတိုကောက် ရိုက်ပါ — <code>ml</code></blockquote>",
  "<blockquote><b>🧮 တွက်ချက်</b>\n<code>5000+3000*2</code> သို့ <code>/calc</code></blockquote>",
].join("\n");
const HELP_PAGES = {
  w: ["📝 Post တင်နည်း", POST_HELP_TEXT],
  n: ["🔎 Name စစ်နည်း", [
    "<b>🔎 Name စစ်နည်း</b>",
    "<blockquote><b>ပုံမှန်</b>\n<code>123456789(2002)</code></blockquote>",
    "<blockquote><b>Game နာမည်ပါရင် ပိုမြန်</b>\n<code>ml 123456789 2002</code></blockquote>",
    "<blockquote><b>Group မှာ</b> — <b>id</b> ရှေ့ခံ\n<code>id 123456789(2002)</code></blockquote>",
    "<blockquote><b>Server မလိုတဲ့ game</b>\n<code>id 123456789</code></blockquote>",
    "<i>ID နဲ့ Server ကို space ( ) | - , ဘာနဲ့ခြားခြား ရတယ်။ Bot မေးတဲ့စာကို reply လုပ်ပြီး ID ပို့လည်း ရတယ်။</i>",
  ].join("\n")],
  g: ["🎮 အတိုကောက်", [
    "<b>🎮 အတိုကောက် · ဈေး · ဝယ်</b>",
    "<blockquote><b>ဈေးကြည့်</b>\n<code>ml</code></blockquote>",
    "<blockquote><b>Name စစ်</b>\n<code>ml 123456789 2002</code></blockquote>",
    "<blockquote><b>Order (Name စစ် + ဈေးစုစုပေါင်း)</b>\n<code>ml 123456789 2002 86 x3</code></blockquote>",
    "<blockquote><b>ဝယ် (Admin)</b>\n<code>ml 123456789 2002 86 wp2</code>\nwp2 = wp နှစ်ခု · <code>86x3</code> ရ · စုစုပေါင်း ၁၀ ခုထိ\nWallet လောက်ရင် မစစ်ဘဲ တန်းဝယ်ပေးမယ်</blockquote>",
    "<b>Package အတိုကောက်</b> — <code>/pkgs ml</code>",
    "<b>Game အတိုကောက်</b>\nmlbb · ml · pubg · pubgm · codm · cod · ff · sm · hok · hsr · zzz · valo · bs · coc · cr · mcgg\n<i>(Game နာမည်ရဲ့ ရှေ့စာလုံးတွေလည်း ရ၊ ဥပမာ gi)</i>",
  ].join("\n")],
  c: ["🧮 Calculator", CALC_HELP],
  t: ["✈️ Telegram", [
    "<b>✈️ Telegram (Stars / Premium)</b>",
    "<blockquote><code>@username</code></blockquote>",
    "<i>Group မှာ username တစ်ခုတည်း ပို့မှ စစ်မယ်</i>",
  ].join("\n")],
  r: ["✅ ရလဒ်", [
    "<b>✅ ရလဒ်</b>",
    "<blockquote>✅ <b>တွေ့</b> — Game · နာမည် · ID (Server)\n<b>Copy ID</b> · <b>Store</b> ခလုတ်</blockquote>",
    "<blockquote>❌ <b>Player Not found</b>\nID / Server ပြန်စစ်ပါ</blockquote>",
    "<blockquote>⚠️ <b>busy</b>\nProvider ပြဿနာ၊ ခဏနေ ပြန်စမ်းပါ</blockquote>",
    "<i>Voucher နဲ့ နာမည်မပြန်တဲ့ game တွေ စစ်လို့မရ</i>",
  ].join("\n")],
  p: ["📌 Group မှာ", [
    "<b>📌 Group မှာ</b>",
    "<blockquote>• Card တွေ ၁ နာရီကြာရင် အလိုလို ပျက်မယ်\n• တစ်မိနစ် ၃ ကြိမ်ပဲ စစ်လို့ရ (မူလ)\n• ID မပါတဲ့ စကားပြောကို မပြန်ပါ</blockquote>",
    "<blockquote><b>Private chat</b>\nOwner ပဲ သုံးလို့ရ၊ Customer က ဈေး / ID / Order ပဲ</blockquote>",
  ].join("\n")],
  s: ["📜 စည်းကမ်း", [
    "<b>📜 Group စည်းကမ်း</b> <i>(Admin မထိ)</i>",
    "<blockquote>❌ Forward · Link · ရိုင်းတဲ့စကား · Spam</blockquote>",
    "<blockquote>⚠️ ၁-၂ ကြိမ် သတိပေး\n🔇 ၃ ကြိမ် ၁ နာရီ mute\n⛔ ၄ ကြိမ် ban (၂၄ နာရီကြာရင် ပျောက်)</blockquote>",
    "<blockquote>🔒 <b>Captcha</b> — Member အသစ် ၅ မိနစ်အတွင်း ခလုတ်နှိပ်ရ\n💬 <b>FAQ</b> — Admin ထည့်ထားတဲ့အတိုင်း အလိုလို ဖြေမယ်</blockquote>",
  ].join("\n")],
};
// Blue (primary) buttons, two per row (a normal inline keyboard: every button in a row is the same width).
// h:<page> opens a page, h:0 is the menu, h:a is the admin help (admins only).
const helpRows = (admin = false, priv = false) => {
  const b = (k) => ({ text: HELP_PAGES[k][0], data: "h:" + k, style: "primary" });
  const rows = [[b("n"), b("g")], [b("c"), b("t")], [b("r"), b("p")], priv ? [b("s"), b("w")] : [b("s")]];
  if (admin) rows.push([{ text: "🛠 Admin", data: "h:a", style: "primary" }, { text: "💰 Balance", data: "bl:x", style: "primary" }]);
  if (priv) rows.push([CLOSE_BTN]);
  return rows;
};
const helpMenu = (admin = false, priv = false) => ({ inline_keyboard: toInline(helpRows(admin, priv)) });
const adminMenu = () => ({ inline_keyboard: toInline(adminRows()) });

/* ---------- Customer DM features ----------
   Customers can open the bot in private chat (owner switch: /set dmopen off). They get a menu with:
   🆔 My IDs (their last checked IDs, one tap to re-check) · 💰 Price list (from the store) · 📦 My orders (Done orders from
   the group order log, last 14 days) · 💳 Payment (same cards as the auto-reply) · 🌐 Language (မြန်မာ / English).
   Admin-only commands are untouched: they still need the owner (private) or a group admin. */
const LANGS = {
  my: {
    menuBody: "<b>🤖 PCA Name Check Bot</b>\n<blockquote><b>🔎 Name စစ်</b>\n<code>123456789(2002)</code></blockquote>\n<blockquote><b>💰 ဈေးကြည့်</b>\nGame အတိုကောက် ရိုက်ပါ — <code>ml</code></blockquote>",
    btnId: "🆔 ကျွန်တော့် ID", btnPrice: "💰 ဈေးနှုန်း", btnOrders: "📦 Order", btnPay: "💳 ငွေလွှဲရန်", btnLang: "🌐 Language", btnStore: "🏪 Store", btnHelp: "ℹ️ အကူအညီ",
    noIds: "🆔 စစ်ထားတဲ့ ID မရှိသေးပါ။",
    idsTitle: "🆔 <b>ကျွန်တော့် ID များ</b>\nနှိပ်ရင် ပြန်စစ်ပေးမယ်", btnClear: "🗑 အကုန်ဖျက်", idsCleared: "🗑 ဖျက်ပြီးပါပြီ",
    pickGame: "💰 <b>ဈေးနှုန်း</b>\nGame ရွေးပါ (သို့) အတိုကောက်ရိုက်ပါ — <code>ml</code>", noPrice: "ဒီ game ဈေးနှုန်း မတွေ့ပါ။", gameNotFound: (q) => `❌ <b>${q}</b> game မတွေ့ပါ။`,
    priceNote: "ဈေးက Store အတိုင်းပါ၊ ပြောင်းနိုင်ပါတယ်။",
    ordersTitle: "📦 <b>ကျွန်တော့် Order</b> (ရက် ၁၄)", noOrders: "📦 Order မရှိသေးပါ။",
    langPick: "🌐 ဘာသာစကား ရွေးပါ", langSet: "✅ မြန်မာဘာသာ ပြောင်းပြီး",
    dmOnly: "🔒 ဒီ command ကို DM မှာ သုံးပါ။",
    offDefault: "🕐 Admin မရှိချိန်ပါ။ Name စစ်၊ ဈေး၊ ငွေလွှဲအချက်အလက်ကို Bot က ဆက်ဖြေပါမယ်။",
    dupReceipt: "⚠️ <b>ဒီ receipt ပုံ အရင်ပို့ဖူးပါတယ်</b>",
  },
  en: {
    menuBody: "<b>🤖 PCA Name Check Bot</b>\n<blockquote><b>🔎 Name check</b>\n<code>123456789(2002)</code></blockquote>\n<blockquote><b>💰 Prices</b>\nType a game short name — <code>ml</code></blockquote>",
    btnId: "🆔 My IDs", btnPrice: "💰 Prices", btnOrders: "📦 Orders", btnPay: "💳 Payment", btnLang: "🌐 Language", btnStore: "🏪 Store", btnHelp: "ℹ️ Help",
    noIds: "🆔 No checked IDs yet.",
    idsTitle: "🆔 <b>My IDs</b>\nTap one to check again", btnClear: "🗑 Clear all", idsCleared: "🗑 Cleared",
    pickGame: "💰 <b>Prices</b>\nPick a game (or type a short name — <code>ml</code>)", noPrice: "No prices for this game.", gameNotFound: (q) => `❌ Game <b>${q}</b> not found.`,
    priceNote: "Same prices as the store, may change.",
    ordersTitle: "📦 <b>My orders</b> (14 days)", noOrders: "📦 No orders yet.",
    langPick: "🌐 Choose language", langSet: "✅ Language set to English",
    dmOnly: "🔒 Use this command in a DM.",
    offDefault: "🕐 Admin is away. The bot still answers name checks, prices and payment info.",
    dupReceipt: "⚠️ <b>This receipt was already sent</b>",
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
async function customerMenuRows(env, lang) {
  const b = (k, d, style = "primary") => ({ text: L(lang, k), data: d, style });
  const rows = [[b("btnId", "mi:l"), b("btnPrice", "pr:l")], [b("btnOrders", "mo:l"), b("btnPay", "pm:l")], [b("btnLang", "lg:t", ""), b("btnHelp", "h:0", "")]];
  const store = await getStore(env);
  if (store && /^https:\/\//.test(store)) rows.push([{ text: L(lang, "btnStore"), url: store, style: "primary" }]);
  return rows;
}
const sendCustomerMenu = async (env, chat, uid) => {
  const lang = await getLang(env, uid);
  return sendUi(env, chat, L(lang, "menuBody"), await customerMenuRows(env, lang));
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
  const rows = list.map((x, n) => [{ text: `🎮 ${x.n} · ${x.i}${x.s ? `(${x.s})` : ""}`, data: `mi:${n}`, style: "primary" }]);
  rows.push([{ text: L(lang, "btnClear"), data: "mi:x", style: "danger" }]);
  return sendUi(env, chat, L(lang, "idsTitle"), rows, undefined, 28);
}

// ----- price list (straight from the store's games) -----
let PKG = { src: null, map: null };
const pkgEntryOf = (o) => ({
  server: String(o.serverName || ""),
  code: String(o.g2bulkCode || "").trim(),
  packages: Array.isArray(o.packages) ? o.packages : [],
  labels: o.packageTabLabels && typeof o.packageTabLabels === "object" ? o.packageTabLabels : {},
  customTabs: Array.isArray(o.packageTabs) ? o.packageTabs.map(String) : [],
});
async function loadPackages(env) {
  const docs = await loadGameDocs(env);
  if (PKG.map && PKG.src === docs) return PKG.map;
  const map = new Map();
  for (const o of docs) {
    if (!o || !o.name) continue;
    const key = String(o.name).trim().toLowerCase();
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(pkgEntryOf(o));
  }
  if (map.size) PKG = { src: docs, map };
  return map.size ? map : PKG.map || new Map();
}
// Live prices for ONE game (query by name = only that game's documents are read). Used when buying and by /pkgs.
async function freshPackages(env, group) {
  const names = [...new Set(group.entries.map((e) => String(e.name || "")).filter(Boolean))];
  const out = [];
  for (const name of names) {
    try {
      const r = await fetch(`https://firestore.googleapis.com/v1/projects/${FS_PROJECT}/databases/(default)/documents:runQuery?key=${encodeURIComponent(env.FIREBASE_API_KEY || FS_KEY)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ structuredQuery: {
          from: [{ collectionId: GCOLL || "gamesPublic" }],
          where: { fieldFilter: { field: { fieldPath: "name" }, op: "EQUAL", value: { stringValue: name } } },
          select: { fields: ["name", "serverName", "packages", "g2bulkCode", "packageTabLabels", "packageTabs"].map((fieldPath) => ({ fieldPath })) },
        } }),
      });
      if (!r.ok) continue;
      for (const row of await r.json()) {
        if (!row.document) continue;
        const o = fv({ mapValue: { fields: row.document.fields || {} } }) || {};
        if (o.name) out.push(pkgEntryOf(o));
      }
    } catch {}
  }
  return out;
}
async function sendPricePicker(env, chat, lang, list) {
  const groups = list || (await loadGroups(env));
  if (!groups.length) return send(env, chat, L(lang, "noPrice"));
  const btns = groups.slice(0, 60).map((g) => ({ text: g.name, data: `pr:${g.id}`, style: "primary" }));
  const rows = [];
  for (let i = 0; i < btns.length; i += 2) rows.push(btns.slice(i, i + 2));
  rows.push([closeBtn(env)]);
  return sendUi(env, chat, L(lang, "pickGame"), rows, 5 * 60 * 1000, 16);
}
// "px:c:<uid>" closes (deletes) a list / price message: the person who opened it, or an admin / owner. "px:y:<gameId>:<tab>" = Copy.
const closeBtn = (env) => ({ text: "Close", data: `px:c:${env.requester || env.uid || 0}`, style: "danger" });
// Bot API 10.3 rich message (sendRichMessage + HTML): heading, compact table and a button row inside the message.
// Returns true when Telegram accepted it. Any error -> false, and the caller sends the plain text version instead.
async function sendRichCard(env, chat, html, extra, ms) {
  const r = await tg(env, "sendRichMessage", {
    chat_id: chat,
    rich_message: { html },
    ...(env.replyTo ? { reply_parameters: { message_id: env.replyTo, allow_sending_without_reply: true } } : {}),
    ...(extra || {}),
  }).catch(() => null);
  if (r?.ok && Number(chat) < 0) await scheduleDelete(env, chat, r.result?.message_id, ms);
  return r?.ok ? r : null;
}
async function sendRichHtml(env, chat, html, ms) {
  const r = await tg(env, "sendRichMessage", {
    chat_id: chat,
    rich_message: { html },
    ...(env.replyTo ? { reply_parameters: { message_id: env.replyTo, allow_sending_without_reply: true } } : {}),
  }).catch(() => null);
  if (r?.ok && Number(chat) < 0) await scheduleDelete(env, chat, r.result?.message_id, ms);
  return !!r?.ok;
}
/* ---------- Price list: tabs (catalog) + short codes + copy ---------- */
// Package tab id, same rule as the store: pkg.tab || pkg.type || "currency". Built-in tabs: currency, package (renamable per game), plus custom tabs.
const pkgTab = (p) => String((p && (p.tab || p.type)) || "currency");
const priced = (p) => !!(p && p.amount && Number(p.price) > 0);
const pkgNum = (p) => (String(p.amount || "").toLowerCase().match(/\d+(?:\.\d+)?/) || [""])[0];
// Short code shown in the list and accepted when buying: "86 Diamonds" -> 86, "Weekly Pass" -> wp (or the /setpkg shortcut).
function pkgShort(gkey, p) {
  const a = String(p.amount || "").trim().toLowerCase();
  const ov = Object.entries((S.pkgs || {})[gkey] || {}).find(([, v]) => a.includes(v));
  if (ov) return ov[0];
  if (/^\d/.test(a)) return pkgNum(p) + (isDoublePkg(a) ? "+" : "");
  const ini = a.split(/[^a-z0-9]+/).filter(Boolean).map((w) => w[0]).join("");
  return ini || pkgNum(p);
}
function priceTabs(entries) {
  const have = new Set();
  const custom = [];
  for (const e of entries) {
    for (const p of e.packages) if (priced(p)) have.add(pkgTab(p));
    for (const c of e.customTabs || []) if (!custom.includes(c)) custom.push(c);
  }
  const order = ["currency", "package", ...custom, ...[...have].filter((t) => !["currency", "package"].includes(t) && !custom.includes(t))];
  return order.filter((t) => have.has(t));
}
function tabLabel(entries, id) {
  for (const e of entries) {
    const l = (e.labels || {})[id];
    if (l && (id === "currency" || id === "package")) return String(l);
  }
  return id === "currency" ? "Currency" : id === "package" ? "Package" : id;
}
// Price list of one game. More than one tab -> buttons first (tap = that tab's list). Lists in groups vanish after 2 minutes.
async function sendPrice(env, chat, group, lang, tabIdx, mode) {
  const MS = 2 * 60 * 1000;
  let all = await freshPackages(env, group).catch(() => []);   // live from Firestore: same numbers as the store page and the admin panel
  if (!all.some((e) => e.packages.some(priced))) all = (await loadPackages(env)).get(group.key) || [];
  const entries = all.filter((e) => e.packages.some(priced));
  if (!entries.length) return send(env, chat, L(lang, "noPrice"));
  const tabs = priceTabs(entries);
  if (env.bc && tabIdx === undefined && tabs.length > 1) {   // no tab buttons in Chat automation: send every tab
    for (let i = 0; i < tabs.length; i++) await sendPrice(env, chat, group, lang, i);
    return;
  }
  if (tabIdx === undefined && tabs.length > 1) {
    const btns = tabs.map((t, i) => ({ text: tabLabel(entries, t), data: `pr:${group.id}:${i}`, style: "primary" }));
    const rows = [];
    for (let i = 0; i < btns.length; i += 2) rows.push(btns.slice(i, i + 2));
    if (Number(chat) > 0) rows.push([{ text: "⬅️ " + L(lang, "btnPrice"), data: "pr:l", style: "link" }]);
    rows.push([closeBtn(env)]);
    return sendUi(env, chat, `💰 <b>${esc(group.name)}</b>\n${lang === "en" ? "Pick a category" : "Catalog ရွေးပါ"}`, rows, MS, 14);
  }
  let tab;
  if (tabs.length > 1) {
    if (!(tabIdx >= 0 && tabIdx < tabs.length)) return send(env, chat, L(lang, "noPrice"));
    tab = tabs[tabIdx];
  }
  const es = entries
    .map((e) => ({ server: e.server, packages: e.packages.filter((p) => priced(p) && (tab === undefined || pkgTab(p) === tab)).slice(0, 40) }))
    .filter((e) => e.packages.length);
  if (!es.length) return send(env, chat, L(lang, "noPrice"));
  const title = esc(group.name) + (tab !== undefined ? " · " + esc(tabLabel(entries, tab)) : "");
  const money = (p) => Number(p.price).toLocaleString("en-US");
  // One label per package: the short code, plus the rest of the amount text only when it adds something (never "86 86").
  const parts = (p) => {
    const code = String(pkgShort(group.key, p)), amt = String(p.amount).trim();
    return { code, rest: amt.toLowerCase().startsWith(code.toLowerCase()) ? amt.slice(code.length).trim() : amt };
  };
  const cellText = (p) => { const { code, rest } = parts(p); return code + (rest ? " " + rest : ""); };
  const cell = (p) => { const { code, rest } = parts(p); return `<code>${esc(code)}</code>${rest ? " " + esc(rest) : ""}`; };
  if (mode === "copy") {   // Copy button: the list as one code block (tap the block = copy); replaces the table, "Table" brings it back
    const txt = es.map((e) => (e.server && es.length > 1 ? e.server + "\n" : "") + e.packages.map((p) => `${cellText(p)} - ${money(p)} Ks`).join("\n")).join("\n\n");
    const here = `pr:${group.id}${tabIdx === undefined ? "" : ":" + tabIdx}`;
    return sendUi(env, chat, `<b>${title}</b>\n<pre>${esc(txt.slice(0, 3500))}</pre>\n<i>Block ကို နှိပ်ရင် Copy ရပါမယ်</i>`, [[{ text: "⬅️ Table", data: here, style: "primary" }, closeBtn(env)]], MS);
  }
  const store = await getStore(env);
  const storeBtn = store && /^https:\/\//.test(store) ? [{ text: L(lang, "btnStore"), url: store, style: "primary" }] : [];
  const back = Number(chat) > 0
    ? [tabs.length > 1 ? { text: "⬅️ " + group.name.slice(0, 20), data: `pr:${group.id}`, style: "link" } : { text: "⬅️ " + L(lang, "btnPrice"), data: "pr:l", style: "link" }]
    : [];
  const btns = [[{ text: "Copy", data: `px:y:${group.id}:${tabIdx === undefined ? "" : tabIdx}`, style: "primary" }, closeBtn(env)]];
  const nav = [...storeBtn, ...back];
  if (nav.length) btns.push(nav);
  // 1) rich message: simple bordered table (tap a code / price to copy it)
  if (S.rich !== "off" && !env.bc) {
    const th = (cols) => `<tr>${cols.map((c) => `<td align="center"><b>${c}</b></td>`).join("")}</tr>`;
    let h = `<h3>${title}</h3>`;
    for (const e of es) {
      if (e.server && es.length > 1) h += `<h4>${esc(e.server)}</h4>`;
      h += `<table bordered striped>${th(["Package", "Price (Ks)"])}` +
        e.packages.map((p) => `<tr><td align="center">${cell(p)}</td><td align="center"><code>${money(p)}</code></td></tr>`).join("") + `</table>`;
    }
    h += `<p><i>${esc(L(lang, "priceNote"))}</i></p>`;
    if (await sendRichHtml(env, chat, h + rrows(evenRows(btns, 14)), MS).catch(() => false)) return;
  }
  // 2) plain fallback: tap a code to copy, plus a native Copy button with the whole list
  let out = `💰 <b>${title}</b>\n`;
  const plainLines = [];
  for (const e of es) {
    out += e.server && es.length > 1 ? `\n<b>${esc(e.server)}</b>\n` : "\n";
    out += e.packages.map((p) => `${cell(p)} — <code>${money(p)}</code> Ks`).join("\n") + "\n";
    e.packages.forEach((p) => plainLines.push(`${cellText(p)} - ${money(p)} Ks`));
  }
  out += `\n<i>${L(lang, "priceNote")}</i>`;
  let copy = "";
  for (const l of plainLines) { if ((copy ? copy.length + 1 : 0) + l.length > 256) break; copy += (copy ? "\n" : "") + l; }
  const rows = [];
  if (copy) rows.push([{ text: "Copy", copy_text: { text: copy }, style: "primary", ...ic(env, "ICON_COPY") }, { text: "Close", callback_data: `px:c:${env.requester || env.uid || 0}`, style: "danger" }]);
  else rows.push([{ text: "Close", callback_data: `px:c:${env.requester || env.uid || 0}`, style: "danger" }]);
  if (nav.length) rows.push(toInline([nav])[0]);
  return sendCard(env, chat, out.slice(0, 3900), rows.length ? { reply_markup: { inline_keyboard: rows } } : {}, MS);
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
  sendUi(env, chat, L(lang, "langPick"), [[{ text: "🇲🇲 မြန်မာ", data: "lg:my", style: "primary" }, { text: "🇬🇧 English", data: "lg:en", style: "primary" }]]);

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
async function customerCallback(env, q, chat, tag, arg, extra) {
  const uid = q.from.id;
  if (tag === "px") {   // list / price screens: Close and Copy (work in groups and private chat)
    const parts = String(q.data || "").split(":");
    if (parts[1] === "c") {
      const okc = !parts[2] || parts[2] === "0" || String(uid) === parts[2] || q.message.chat.type === "private" || idList(env.OWNER_IDS).includes(String(uid)) || (await isAdmin(env, chat, uid));
      if (!okc) return tg(env, "answerCallbackQuery", { callback_query_id: q.id, text: "ဖွင့်တဲ့သူ / Admin ပဲ ပိတ်လို့ရပါတယ်", show_alert: true });
      await tg(env, "answerCallbackQuery", { callback_query_id: q.id });
      return tg(env, "deleteMessage", { chat_id: chat, message_id: q.message.message_id }).catch(() => {});
    }
    if (parts[1] === "y") {
      await tg(env, "answerCallbackQuery", { callback_query_id: q.id });
      const group = (await loadGroups(env)).find((g) => g.id === parts[2]);
      if (!group) return;
      await tg(env, "deleteMessage", { chat_id: chat, message_id: q.message.message_id }).catch(() => {});   // the Copy view takes the table's place
      return sendPrice({ ...env, replyTo: 0 }, chat, group, await getLang(env, uid), parts[3] === undefined || parts[3] === "" ? undefined : Number(parts[3]), "copy");
    }
    return tg(env, "answerCallbackQuery", { callback_query_id: q.id });
  }
  const lang = await getLang(env, uid);
  await tg(env, "answerCallbackQuery", { callback_query_id: q.id });
  if (q.message.chat.type !== "private" && tag !== "pr") return;
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
  if (tag === "pr") {   // game list -> catalog -> price table: each tap replaces the screen (the old message is removed), so only one message is ever left
    const swap = () => tg(env, "deleteMessage", { chat_id: chat, message_id: q.message.message_id }).catch(() => {});
    if (arg === "l") { await swap(); return sendPricePicker({ ...env, replyTo: 0 }, chat, lang); }
    const group = (await loadGroups(env)).find((g) => g.id === arg);
    if (!group) return send(env, chat, L(lang, "noPrice"));
    await swap();
    return sendPrice({ ...env, replyTo: 0 }, chat, group, lang, extra === undefined || extra === "" ? undefined : Number(extra));
  }
  if (tag === "mo") return showMyOrders(env, chat, uid, lang);
  if (tag === "pm") {
    if (!(await payAutoReply({ ...env, replyTo: 0 }, chat, "/pay", false, true).catch(() => false))) return send(env, chat, L(lang, "noPrice"));
    return;
  }
  if (tag === "lg") {
    if (arg === "my" || arg === "en") {
      if (env.STATE) await env.STATE.put("lang:" + uid, arg, { expirationTtl: 365 * 86400 }).catch(() => {});
      return sendUi(env, chat, L(arg, "langSet"), await customerMenuRows(env, arg));
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

/* ---------- Short game names, price list by name, admin auto-buy (G2Bulk wallet) ---------- */
// Exact short names only: manual / built-in aliases, G2Bulk game code, full name, and the game's initials (3+ letters in groups).
function abbrGroups(groups, query, loose) {
  const q = String(query || "").trim().toLowerCase();
  if (q.length < 1 || q.length > 30) return [];
  const al = (S.aliases || {})[q] || ALIASES[q];
  if (q.length < 2 && !al) return [];
  const code = (g) => g.entries.map((e) => String(e.g2bulkCode || "").toLowerCase()).filter(Boolean);
  let hit = groups.filter((g) => g.key === q || code(g).includes(q) || (al && g.key.includes(al)));
  if (!hit.length && (loose || q.length >= 3)) hit = groups.filter((g) => initials(g.name).includes(q));
  return hit;
}
// "ml 123456789 2002 86 wp2 x3" -> { group, id, server, want: [{ tok, qty }], entries }  (or { askServer } / null = not a buy message)
// Letters / symbols between the ID and the Server ID are ignored. "wp2" = 2 x wp, "86x3" or "86 x3" = 3 x 86.
const BUY_MAX_UNITS = 30;      // total packages in one message
const BUY_MAX_ACCOUNTS = 15;   // accounts (lines) in one message
const BUY_FILLER = /^(diamonds?|dia|stars?|pcs?|pieces?)$/i;
// Tokens keep a trailing "+" (double diamond): "500+", "50 +" and "50+50" all become "500+" / "50+".
function buyTokens(text) {
  const raw = String(text).split(/[^\p{L}\p{N}\p{M}+]+/u).filter(Boolean);
  const out = [];
  for (const t of raw) {
    if (/^\++$/.test(t)) { if (out.length && !out[out.length - 1].endsWith("+")) out[out.length - 1] += "+"; continue; }
    out.push(t.replace(/^\++/, "").replace(/^(\d+)\+\d+$/, "$1+").replace(/\++$/, "+"));
  }
  return out.filter(Boolean);
}
// Message = one or more lines. Line 1: "<game> <ID> <Server> <packages>" (a leading "." is fine: ".m 123456789 2002 86 50+").
// Next lines: "<ID> <Server> <packages>" (a game name in front is allowed, but it must be the same game).
// -> { group, entries, orders: [{ id, server, want } | { line, err }] }   (null = not a buy message)
async function parseBuy(env, text) {
  const lines = String(text).split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (!lines.length || lines.length > 60) return null;
  const groups = await loadGroups(env);
  const pickGame = (q) => { const h = abbrGroups(groups, q, true); return h.length === 1 && !h[0].dropdown ? h[0] : null; };
  let group = null, entries = [];
  const setGroup = async (g) => {
    const e = ((await loadPackages(env)).get(g.key) || []).filter((x) => x.code);
    if (!e.length) return false;
    group = g; entries = e; return true;
  };
  const isPkgTok = (t) => pickPackage(entries, t.toLowerCase(), group.key) || /^x\d{1,2}$/i.test(t) || /^[a-z]+\d{1,2}$/i.test(t) || /^\d+\+?x\d{1,2}$/i.test(t);
  const orders = [];
  for (const line of lines) {
    const tokens = buyTokens(line);
    const i = tokens.findIndex((t) => /^\d{5,20}$/.test(t));
    const bad = (why, id) => { orders.push({ id, line, err: why }); };
    if (i === -1) {
      if (!group && !orders.length && tokens.length <= 2) {   // the game name alone on the first line
        const g = pickGame(tokens.join(" "));
        if (g && (await setGroup(g))) continue;
      }
      if (!group) return null;
      bad("Format မမှန်ပါ");
      continue;
    }
    if (i > 2) { if (!group) return null; bad("Format မမှန်ပါ"); continue; }
    if (i >= 1) {
      const g = pickGame(tokens.slice(0, i).join(" "));
      if (!group) { if (!g || !(await setGroup(g))) return null; }
      else if (g && g.key !== group.key) { bad("Game မတူပါ", tokens[i]); continue; }
    } else if (!group) return null;
    const first = !orders.length;
    const id = tokens[i];
    const rest = tokens.slice(i + 1).filter((t) => !BUY_FILLER.test(t));
    if (!rest.length) { if (first) return null; bad("Package မပါပါ", id); continue; }
    let server = "", wantRaw = rest;
    if (!group.idOnly) {
      const si = rest.findIndex((t) => /^\d{1,6}$/.test(t));   // first number after the ID = Server ID
      if (si === -1) {
        if (first && !rest.every(isPkgTok)) return null;
        bad("Server ID မပါပါ", id);
        continue;
      }
      server = rest[si];
      wantRaw = rest.slice(si + 1);
    }
    const want = [];
    for (const raw of wantRaw) {
      const r = raw.toLowerCase();
      let mm;
      if ((mm = r.match(/^x(\d{1,2})$/)) && want.length) { want[want.length - 1].qty = Number(mm[1]); continue; }
      if (pickPackage(entries, r, group.key)) { want.push({ tok: r, qty: 1 }); continue; }
      mm = r.match(/^(\d+\+?)x(\d{1,2})$/) || r.match(/^([a-z]+)(\d{1,2})$/);
      if (mm && pickPackage(entries, mm[1], group.key)) { want.push({ tok: mm[1], qty: Number(mm[2]) }); continue; }
      want.push({ tok: r, qty: 1 });
    }
    if (!want.length) { if (first) return null; bad("Package မပါပါ", id); continue; }
    const merged = [];   // "86/86" = the same package twice -> one row "86 x2"
    for (const w of want) { const p = merged.find((y) => y.tok === w.tok); if (p) p.qty += w.qty; else merged.push({ ...w }); }
    orders.push({ id, server, want: merged });
  }
  if (!group || !orders.length) return null;
  return { group, entries, orders };
}
// "86" -> the package whose first number is 86; "wp" -> Weekly Pass (initials / start of the name); /setpkg shortcuts win.
// Only G2Bulk-linked, priced packages.
// Double diamond packages are named like "50+50 Diamonds" or "Double Diamonds 50".
const isDoublePkg = (a) => /double|\d\s*\+\s*\d/i.test(String(a));
function pickPackage(entries, tok, gkey, any = false) {
  const t = String(tok).toLowerCase();
  const plus = /^\d+\+$/.test(t);          // "50+" = double diamond package; plain "50" never picks one
  const tn = plus ? t.slice(0, -1) : t;
  const ov = ((S.pkgs || {})[gkey] || {})[t];
  const found = [];
  for (const e of entries) {
    for (const p of e.packages) {
      if (!p || (!any && !p.g2bulk) || !(Number(p.price) > 0)) continue;
      const a = String(p.amount || "").toLowerCase();
      const num = (a.match(/\d+(?:\.\d+)?/) || [""])[0];
      const ini = a.split(/[^a-z0-9]+/).filter(Boolean).map((w) => w[0]).join("");
      let ok, exact;
      if (ov) { ok = a.includes(ov); exact = a === ov ? 0 : 1; }
      else {
        ok = /^\d/.test(tn) ? num === tn && isDoublePkg(a) === plus : ini === t || a.replace(/[^a-z0-9]/g, "").startsWith(t);
        exact = a.replace(/\D/g, "") === tn ? 0 : 1;
      }
      if (ok) found.push({ e, p, exact });
    }
  }
  found.sort((x, y) => x.exact - y.exact);
  return found[0] || null;
}
// Price / Cost / USD rate watcher (cron). Reads the games fresh (this also refreshes the bot's own cache, so prices in the bot are never stale),
// compares with the last snapshot in KV and tells the owners what changed, as a table. First run only stores the snapshot.
async function priceWatch(env) {
  if (!env.STATE || S.pricewatch === "off" || S.maint === "on") return;
  GDOCS = { t: 0, docs: GDOCS.docs };
  await env.STATE.delete("fs:games").catch(() => {});
  PKG = { src: null, map: null };
  const docs = await loadGameDocs(env);
  if (!docs.length) return;
  RATE = { t: 0, v: 0, src: "" };
  const rate = await storeRate(env);
  const snap = {};
  for (const o of docs) {
    if (!o || !o.name || !Array.isArray(o.packages)) continue;
    const gname = String(o.name) + (o.serverName ? ` (${o.serverName})` : "");
    for (const p of o.packages) {
      if (!p || !p.amount || !(Number(p.price) > 0)) continue;
      snap[`${gname}|${p.amount}`] = [Number(p.price), Number(p.cost) || 0];
    }
  }
  const prev = await env.STATE.get("pw:snap", "json").catch(() => null);
  await env.STATE.put("pw:snap", JSON.stringify({ rate, snap }));
  if (!prev || !prev.snap) return;
  const prRows = [];   // [game, package, old, now]  (old 0 = new package)
  for (const [k, [pr, co]] of Object.entries(snap)) {
    const old = prev.snap[k];
    const [g, a] = k.split("|");
    if (!old) prRows.push([g, a, 0, pr]);
    else if (old[0] !== pr) prRows.push([g, a, old[0], pr]);   // Store prices only (no cost)
  }
  const lines = [];
  // USD rate changes are not reported (only Store package prices are)
  const total = prRows.length;
  if (!total && !lines.length) return;
  const fmtN = (n) => (n > 0 ? Number(n).toLocaleString("en-US") : "-");
  const pct = (a, b) => (a > 0 ? `${b >= a ? "+" : "-"}${Math.abs(((b - a) / a) * 100).toFixed(1)}%` : "New");
  if (total > 60) {   // a rate change rescales every cost: one summary line instead of hundreds of rows
    lines.push(`<b>${total}</b> package ရဲ့ ဈေးပြောင်းသွားပါတယ်`);
    return notifyOwners(env, `<b>Price update</b>\n` + lines.join("\n"));
  }
  const tbl = (cap, rs) => (rs.length
    ? `<p>${cap}</p><table bordered striped><tr>${["Package", "Old", "Now", "Change"].map((c) => `<td align="center"><b>${c}</b></td>`).join("")}</tr>` +
      rs.map((r) => `<tr><td align="center">${esc(r[1])}</td><td align="center">${fmtN(r[2])}</td><td align="center">${fmtN(r[3])}</td><td align="center">${pct(r[2], r[3])}</td></tr>`).join("") + `</table>`
    : "");
  const games = [...new Set(prRows.map((r) => r[0]))];
  const rich = lines.map((l) => `<p>${l}</p>`).join("") + games.map((g) => `<h3>${esc(g)}</h3>` + tbl("Price updated (MMK)", prRows.filter((r) => r[0] === g))).join("");
  const bullets = prRows.map((r) => `• <b>${esc(r[0])}</b> <code>${esc(r[1])}</code> — ${fmtN(r[2])} > ${fmtN(r[3])}`).slice(0, 30);
  const plain = `<b>Price update</b>\n` + [...lines, ...bullets].join("\n");
  await Promise.all(idList(env.OWNER_IDS).map(async (o) => {
    if (S.rich !== "off") {
      const r = await tg(env, "sendRichMessage", { chat_id: o, rich_message: { html: rich } }).catch(() => null);
      if (r?.ok) return;
    }
    await tg(env, "sendMessage", { chat_id: o, text: plain, parse_mode: "HTML" }).catch(() => {});
  }));
}

// Live G2Bulk wallet in USD (null = could not read it; the order call itself is then the check).
async function g2Balance(env) {
  try {
    const r = await fetch("https://api.g2bulk.com/v1/getMe", { headers: { "X-API-Key": env.G2BULK_API_KEY }, signal: AbortSignal.timeout(8000) });
    const j = await r.json().catch(() => null);
    const b = Number(j?.balance ?? j?.data?.balance);
    if (r.ok && Number.isFinite(b)) return b;
  } catch {}
  try {
    const r = await fetch("https://api.g2bulk.com/api/v2", { signal: AbortSignal.timeout(8000), method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ key: env.G2BULK_API_KEY, action: "balance" }) });
    const j = await r.json().catch(() => null);
    const b = Number(j?.balance);
    if (Number.isFinite(b)) return b;
  } catch {}
  return null;
}
// USD -> MMK rate: ONLY the one set in the admin panel (Firestore settings/publicRates, a copy the admin panel writes on every Save of the
// G2Bulk USD rate; settings/g2bulk is tried too). The bot never sets or guesses a rate: 0 = could not read it.
let RATE = { t: 0, v: 0, src: "" };
async function storeRate(env) {
  if (RATE.v && Date.now() - RATE.t < 30 * 1000) return RATE.v;
  for (const docName of ["publicRates", "g2bulk"]) {
    try {
      const qs = new URLSearchParams({ key: env.FIREBASE_API_KEY || FS_KEY });
      qs.append("mask.fieldPaths", "usdRate");
      const r = await fetch(`https://firestore.googleapis.com/v1/projects/${FS_PROJECT}/databases/(default)/documents/settings/${docName}?${qs}`);
      if (!r.ok) continue;
      const v = Number(fv({ mapValue: { fields: (await r.json()).fields || {} } })?.usdRate);
      if (v > 0) { RATE = { t: Date.now(), v, src: "store" }; return v; }
    } catch {}
  }
  RATE = { t: 0, v: 0, src: "" };
  return 0;
}
const NO_RATE = "Admin panel ရဲ့ USD rate ကို မဖတ်နိုင်ပါ (Firestore rules မှာ settings/publicRates ဖတ်ခွင့် + admin မှာ rate Save လုပ်ထားမှ ရပါမယ်)";
// Same table helper as the buy result (bordered rich table, plain monospace fallback), no emoji.
async function showTable(env, chat, t, ms) {
  if (S.rich !== "off" && !env.bc && (await sendRichHtml(env, chat, t.rich, ms).catch(() => false))) return;
  return sendCard(env, chat, t.plain, {}, ms);
}
// G2Bulk wallet (Admin / Owner): button "Balance" in the /start menu + owner keyboard, or /balance. USD is what G2Bulk holds; Ks uses the admin panel rate.
async function showBalance(env, chat) {
  if (!env.G2BULK_API_KEY) return sendCard(env, chat, "G2BULK_API_KEY မထည့်ရသေးပါ", {}, 60 * 1000);
  const bal = await g2Balance(env);
  if (bal === null) return sendCard(env, chat, "Balance မဖတ်နိုင်ပါ၊ ခဏနေ ပြန်စမ်းပါ", {}, 60 * 1000);
  const rate = await storeRate(env);
  const lines = ["<b>💰 G2Bulk Wallet</b>", `<blockquote><b>${bal.toFixed(2)} USD</b>${rate ? ` · ${Math.round(bal * rate).toLocaleString("en-US")} Ks\nRate ${rate}` : ""}</blockquote>`];
  if (!rate) lines.push(esc(NO_RATE));
  return sendCard(env, chat, lines.join("\n"), {}, 2 * 60 * 1000);
}
// /health (owner): one screen with everything that can break.
async function showHealth(env, chat) {
  const t0 = Date.now();
  const [groups, pay, rate, bal, wh] = await Promise.all([
    loadGroups(env).catch(() => []),
    getPayMethods(env).catch(() => []),
    storeRate(env).catch(() => 0),
    env.G2BULK_API_KEY ? g2Balance(env).catch(() => null) : Promise.resolve(undefined),
    tg(env, "getWebhookInfo", {}).catch(() => null),
  ]);
  const ok = (b) => (b ? "✅" : "❌");
  const age = GDOCS.t ? Math.round((Date.now() - GDOCS.t) / 1000) + " စက္ကန့်အရင်" : "—";
  const w = wh?.result || {};
  const down = ["G2Bulk"].filter((p) => PH.get(p)?.down);
  const lines = [
    "🩺 <b>System အခြေအနေ</b>",
    "",
    `${ok(groups.length)} Game list: ${groups.length} (Firestore ဖတ်ထားတာ ${age})`,
    `${ok(pay.length)} Payment method: ${pay.length}`,
    `${ok(rate)} USD rate: ${rate ? rate + " (Admin panel)" : "မဖတ်နိုင် — settings/publicRates စစ်ပါ"}`,
    `${ok(!down.length)} Provider: ${down.length ? "🚨 ကျနေ — " + down.join(", ") : "G2Bulk ကောင်း"}`,
    bal === undefined ? "➖ Wallet: G2BULK_API_KEY မထည့်ရသေး" : `${ok(bal !== null)} Wallet: ${bal === null ? "မဖတ်နိုင်" : bal.toFixed(2) + " USD (" + (rate ? "~" + Math.round(bal * rate).toLocaleString("en-US") + " Ks" : "rate မရ") + ")"}`,
    `${ok(env.STATE)} Storage: ${env.DB ? "D1" : env.STATE ? "KV" : "မရှိ (auto-delete / မှတ်တမ်း မရ)"}`,
    `${ok(!w.last_error_message)} Webhook: pending ${w.pending_update_count ?? "?"}${w.last_error_message ? " · " + esc(String(w.last_error_message).slice(0, 80)) : ""}`,
    `${S.maint === "on" ? "🛠 Maintenance ဖွင့်ထား" : "🟢 Maintenance ပိတ်ထား"}`,
    `⏱ ${Date.now() - t0} ms`,
  ];
  return sendCard(env, chat, lines.join("\n"), {}, 5 * 60 * 1000);
}
// Clear table, no emoji: rich message (bordered table) first, plain monospace table as the fallback.
function buyTable(title, head, rows, right, foot) {
  const al = (c) => (right.includes(c) ? ' align="right"' : "");
  const rich =
    `<p><b>${esc(title)}</b></p><table compact><tr>${head.map((h, c) => `<td${al(c)}><b>${esc(h)}</b></td>`).join("")}</tr>` +
    rows.map((r) => `<tr>${r.map((v, c) => `<td${al(c)}>${c === 0 ? `<code>${esc(v)}</code>` : esc(v)}</td>`).join("")}</tr>`).join("") +
    `</table>` + (foot ? `<p>${foot}</p>` : "");
  const all = [head, ...rows].map((r) => r.map(String));
  const w = head.map((_, c) => Math.max(...all.map((r) => vlen(r[c]))));
  const pad = (v, n, left) => (left ? " ".repeat(Math.max(0, n - vlen(v))) + v : v + " ".repeat(Math.max(0, n - vlen(v))));
  const fmt = (r) => r.map((v, c) => (c === head.length - 1 ? v : pad(v, w[c], right.includes(c)))).join("  ");
  const bar = "-".repeat(w.reduce((x, y) => x + y, 0) + 2 * (head.length - 1));
  const plain = `<b>${esc(title)}</b>\n<pre>${esc([fmt(all[0]), bar, ...all.slice(1).map(fmt)].join("\n"))}</pre>` + (foot ? `\n${foot}` : "");
  return { rich, plain };
}
async function doBuy(env, m, chat, plan) {
  const { group, orders } = plan;
  const say = (html) => sendCard(env, chat, html);
  const show = async (t) => {
    if (S.rich !== "off" && (await sendRichHtml(env, chat, t.rich).catch(() => false))) return;
    await say(t.plain);
  };
  const idTxt = (o) => `${o.id}${o.server ? `(${o.server})` : ""}`;
  if (orders.length > BUY_MAX_ACCOUNTS) { await say(`တစ်ကြိမ်ကို account ${BUY_MAX_ACCOUNTS} ခုအထိပဲ ဝယ်လို့ရပါတယ် (ပို့တာ ${orders.length} ခု)`); return; }
  // prices / packages come live from the store (cache is only a few seconds)
  const live = (await freshPackages(env, group)).filter((e) => e.code);
  const entries = live.length ? live : plan.entries;
  // 1) check every line first. One bad line = nothing is bought.
  const problems = [];
  for (const o of orders) {
    if (o.err) { problems.push([o.id ? idTxt(o) : o.line.slice(0, 40), o.err]); continue; }
    const items = [], bad = [];
    for (const w of o.want) {
      const hit = w.qty >= 1 ? pickPackage(entries, w.tok, group.key) : null;
      if (hit) items.push({ ...w, ...hit }); else bad.push(w.tok);
    }
    if (bad.length) problems.push([idTxt(o), `Package မတွေ့: ${bad.join(" ")}`]);
    else o.items = items;
  }
  if (problems.length) {
    await show(buyTable(group.name, ["ID (Server)", "ပြဿနာ"], problems, [], `<b>ဘာမှ မဝယ်ရသေးပါ</b> — ပြင်ပြီး ပြန်ပို့ပါ<br><code>/pkgs ${esc(group.key)}</code> နဲ့ package အတိုကောက် ကြည့်နိုင်ပါတယ် (double diamond = <code>50+</code> <code>150+</code>)`.replace("<br>", "\n")));
    return;
  }
  const units = orders.reduce((s, o) => s + o.items.reduce((t, x) => t + x.qty, 0), 0);
  if (units > BUY_MAX_UNITS) { await say(`တစ်ကြိမ်ကို စုစုပေါင်း ${BUY_MAX_UNITS} ခုအထိပဲ ဝယ်လို့ရပါတယ် (ပို့တာ ${units} ခု)`); return; }
  if (env.STATE) {   // Telegram may deliver the same message twice: buy once
    const k = `buy:${chat}:${m.message_id}`;
    if (await env.STATE.get(k).catch(() => null)) return;
    await env.STATE.put(k, "1", { expirationTtl: 86400 }).catch(() => {});
  }
  // 2) same ID + Server + package within 2 minutes (or twice in this message) is skipped, the other accounts still go through
  const seen = new Set();
  for (const o of orders) {
    const sig = `bd:${group.key}:${o.id}:${o.server}:${o.items.map((x) => x.tok + "x" + x.qty).join(",")}`;
    o.sig = sig;
    o.dup = seen.has(sig) || !!(env.STATE && (await env.STATE.get(sig).catch(() => null)));
    seen.add(sig);
  }
  const todo = orders.filter((o) => !o.dup);
  // 3) wallet must cover everything that will be bought
  RATE = { t: 0, v: 0, src: "" };   // a buy always reads the admin rate fresh
  const rate = await storeRate(env);
  if (!rate) { await say(`<b>ဘာမှ မဝယ်ရသေးပါ</b>\n${esc(NO_RATE)}`); return; }
  const mmk = (x) => (Number(x.p.cost) > 0 ? Number(x.p.cost) : Number(x.p.price));
  const need = todo.reduce((s, o) => s + o.items.reduce((t, x) => t + mmk(x) * x.qty, 0), 0);
  if (todo.length) {
    const bal = await g2Balance(env);
    if (bal !== null && bal * rate < need) {
      const lack = need - bal * rate;
      await show(buyTable("Wallet မလောက်ပါ", ["", "Ks", "USD"], [
        ["လိုငွေ", Math.round(need).toLocaleString("en-US"), (need / rate).toFixed(2)],
        ["ရှိငွေ", Math.round(bal * rate).toLocaleString("en-US"), bal.toFixed(2)],
        ["လိုနေတာ", Math.round(lack).toLocaleString("en-US"), (lack / rate).toFixed(2)],
      ], [1, 2], `<b>ဘာမှ မဝယ်ရသေးပါ</b> — Balance အရင်ဖြည့်ပါ (rate ${rate})`));
      return;
    }
    if (env.STATE) for (const o of todo) await env.STATE.put(o.sig, "1", { expirationTtl: 120 }).catch(() => {});
  }
  // 4) buy: accounts run at the same time (4 at once), the packages of one account run one after another
  let total = 0, halt = false;
  const buyOne = async (o) => {
    let stop = false;
    for (const x of o.items) {
      const row = { x, ok: 0, pend: 0, skip: 0, err: "" };
      o.rows.push(row);
      for (let k = 0; k < x.qty; k++) {
        if (stop || halt) { row.skip = x.qty - k; break; }
        let status = "", err = "";
        try {
          const r = await fetch(`https://api.g2bulk.com/v1/games/${encodeURIComponent(x.e.code)}/order`, {
            method: "POST",
            headers: { "X-API-Key": env.G2BULK_API_KEY, "X-Idempotency-Key": crypto.randomUUID(), "content-type": "application/json" },
            signal: AbortSignal.timeout(20000),
            body: JSON.stringify({ catalogue_name: x.p.g2bulk, player_id: o.id, server_id: o.server || undefined, remark: `NameCheck ${chat}:${m.message_id}` }),
          });
          const j = await r.json().catch(() => ({}));
          if (!r.ok || j.success === false) err = String(j.message || j.error || (j.detail && (j.detail.message || j.detail)) || `HTTP ${r.status}`).slice(0, 60);
          else status = String(j.status || j.order?.status || "PENDING").toUpperCase();
        } catch (e) { err = e && e.name === "TimeoutError" ? "timeout — G2Bulk မှာ order စာရင်း စစ်ပါ" : "network"; }
        if (!err && /FAIL|CANCEL/.test(status)) err = status.toLowerCase();
        if (err) {
          stop = true; row.err = err; row.skip = x.qty - k - 1;
          if (/balance|insufficient|wallet|api.?key|unauthor/i.test(err)) halt = true;   // the same error would hit every account
          break;
        }
        total += Number(x.p.price);
        if (/COMPLETED|SUCCESS/.test(status)) row.ok++; else row.pend++;
      }
    }
  };
  orders.forEach((o) => { o.rows = []; });
  const queue = todo.slice();
  await Promise.all(Array.from({ length: Math.min(4, queue.length) }, async () => { for (let o; (o = queue.shift()); ) await buyOne(o); }));
  orders.filter((o) => o.dup).forEach((o) => o.items.forEach((x) => o.rows.push({ x, ok: 0, pend: 0, skip: x.qty, err: "", note: "Skipped (၂ မိနစ်အတွင်း ပို့ပြီး)" })));
  const placed = orders.reduce((s, o) => s + o.rows.reduce((t, d) => t + d.ok + d.pend, 0), 0);
  if (placed && env.STATE) {
    let sp = 0, sc = 0, costOk = true;
    orders.forEach((o) => o.rows.forEach((d) => { const n = d.ok + d.pend; if (!n) return; sp += Number(d.x.p.price) * n; if (Number(d.x.p.cost) > 0) sc += Number(d.x.p.cost) * n; else costOk = false; }));
    const now = Date.now();
    await env.STATE.put(`sale:${dayStr()}:${String(now).padStart(14, "0")}:${chat}:${m.message_id}`, "1", {
      expirationTtl: ORDER_TTL_S,
      metadata: { a: ([m.from?.first_name, m.from?.last_name].filter(Boolean).join(" ") || String(m.from?.id)).slice(0, 30), t: now, g: group.name.slice(0, 40), p: Math.round(sp), c: costOk ? Math.round(sc) : 0 },
    }).catch(() => {});
  }
  const label = (d) => `${String(d.x.p.amount)}${d.x.qty > 1 ? ` x${d.x.qty}` : ""}`;
  const sub = (d) => Number(d.x.p.price) * (d.ok + d.pend);
  const state = (d) => d.note || [
    d.ok ? `Done${d.ok > 1 ? " x" + d.ok : ""}` : "",
    d.pend ? `Processing${d.pend > 1 ? " x" + d.pend : ""}` : "",
    d.err ? `Failed: ${d.err}` : "",
    d.skip ? `Not sent${d.skip > 1 ? " x" + d.skip : ""}` : "",
  ].filter(Boolean).join(", ");
  if (placed) {
    if (!idList(env.OWNER_IDS).includes(String(env.uid)))   // an admin bought: the owners get a short report
      await notifyOwners(env, `<b>Admin order</b> ${esc(group.name)}\n` + orders.map((o) => `<code>${esc(idTxt(o))}</code> ${o.rows.map((d) => `${esc(String(d.x.p.amount))}${d.x.qty > 1 ? ` x${d.x.qty}` : ""}`).join(", ")}`).join("\n") + `\nTotal: ${total.toLocaleString("en-US")} Ks\nAdmin: ${esc([m.from?.first_name, m.from?.last_name].filter(Boolean).join(" ") || String(m.from?.id))}`).catch(() => {});
    const lb = Number(S.lowbal);
    if (lb > 0) {
      const b2 = await g2Balance(env);
      if (b2 !== null && b2 < lb) await notifyOwners(env, `<b>Wallet နည်းနေပါပြီ</b>\n${b2.toFixed(2)} USD ကျန် (သတိပေးမယ့်ကန့်သတ် ${lb} USD)`).catch(() => {});
    }
  }
  const rows = orders.flatMap((o) => o.rows.map((d) => [idTxt(o), label(d), sub(d) ? sub(d).toLocaleString("en-US") : "-", state(d)]));
  await show(buyTable(group.name, ["ID (Server)", "Package", "Ks", "Status"], rows, [2], `<b>Total: ${total.toLocaleString("en-US")} Ks</b> | ${orders.length} account`));
}

// Telegram Business: the owner connects the bot in Settings > Business > Chatbots. Customers who write to the owner's own account are
// answered by this bot (payment info, FAQ, prices, name check). Admin commands, moderation and the post composer never run there.
const BIZ = new Map();
async function onBizConn(c, env) {
  if (env.STATE && c.id && c.user?.id) await env.STATE.put("bc:" + c.id, String(c.user.id), { expirationTtl: 400 * 86400 }).catch(() => {});
  const canReply = c.rights ? c.rights.can_reply !== false : c.can_reply !== false;
  await notifyOwners(env, c.is_enabled === false ? "🔌 Chat automation ဖြုတ်လိုက်ပါပြီ" : "✅ <b>Chat automation ချိတ်ပြီးပါပြီ</b>\nCustomer တွေ ဆက်သွယ်ရင် Bot က ဖြေပေးပါမယ်" + (canReply ? "" : "\n⚠️ Bot မှာ <b>Reply to messages</b> ခွင့် မရှိသေးပါ (Business settings မှာ ဖွင့်ပေးပါ)"));
}
async function bizOwnerIs(env, m) {
  if (idList(env.OWNER_IDS).includes(String(m.from.id))) return true;
  const id = m.business_connection_id;
  let owner = BIZ.get(id);
  if (!owner && env.STATE) owner = await env.STATE.get("bc:" + id).catch(() => null);
  if (!owner) owner = String((await tg(env, "getBusinessConnection", { business_connection_id: id }).catch(() => null))?.result?.user?.id || "");
  if (owner) BIZ.set(id, owner);
  return String(m.from.id) === String(owner);   // the account owner's own messages in the chat are never answered
}
async function handle(u, env) {
  if (u.business_connection) return onBizConn(u.business_connection, env);
  if (u.business_message) {
    const bm = u.business_message;
    if (!bm.business_connection_id || bm.chat?.type !== "private") return;
    return handle({ message: bm }, { ...env, bc: bm.business_connection_id, biz: true });
  }
  if (u.callback_query) return onCallback(u.callback_query, env);
  if (u.my_chat_member) return onMyChat(u.my_chat_member, env);
  const m = u.message;
  if (!m) return;
  const chat = m.chat.id;
  const isGroup = m.chat.type === "group" || m.chat.type === "supergroup";
  const isPrivate = m.chat.type === "private";
  if (!isGroup && !isPrivate) return;
  if (env.biz && (!m.from || m.from.is_bot || (await bizOwnerIs(env, m)))) return;
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
  if (isPrivate && owners.length && !isOwnerUser && !env.biz && S.dmopen === "off")
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

  // Calculator: /calc, or a message that is clearly a calculation (see calcHandle). Never touches ID / Server messages.
  if (await calcHandle(env, m, chat, text, isGroup).catch((e) => { console.error("calc", e); return false; })) return;

  if (isPrivate && !isOwnerUser && /^\/(start|help|menu)(@\w+)?(\s|$)/i.test(text)) return sendCustomerMenu(env, chat, m.from?.id);
  const ucm = text.match(/^\/(myids|myorders|price|language|menu)(?:@\w+)?(?:\s+([\s\S]*))?$/i);
  if (ucm) return userCommand(env, m, chat, ucm[1].toLowerCase(), (ucm[2] || "").trim(), isPrivate);
  // "List" / "list." / "/list": every game as a button, tap one = its price list (Copy + Close under it)
  if (/^\/?lists?[\s.!။]*$/i.test(text)) return sendPricePicker(env, chat, await getLang(env, m.from?.id));
  if (/^\/(start|help)(@\w+)?(\s|$)/i.test(text)) {
    if (isPrivate && env.STATE && owners.includes(String(m.from?.id)) && !(await env.STATE.get("kbon:" + m.from.id).catch(() => null))) {   // bottom keyboard: sent once, it stays until removed
      await env.STATE.put("kbon:" + m.from.id, "1", { expirationTtl: 7 * 86400 }).catch(() => {});
      await send({ ...env, replyTo: 0 }, chat, "⌨️ <b>Menu keyboard</b> ဖွင့်ပြီးပါပြီ", { reply_markup: mainKb() });
    }
    const isAdm = owners.includes(String(m.from?.id)) || (isGroup && (await isAdmin(env, chat, m.from?.id)));   // the Admin button is shown to admins only
    return sendUi(env, chat, MENU_TEXT, helpRows(isAdm, isPrivate), 10 * 60 * 1000);
  } // group: removed after 10 min
  if (/^\/health(@\w+)?\s*$/i.test(text)) return isOwnerUser ? showHealth({ ...env, replyTo: 0 }, chat) : undefined;
  if (/^\/balance(@\w+)?\s*$/i.test(text)) {
    if (isOwnerUser || (isGroup && (await isAdmin(env, chat, m.from?.id)))) return showBalance({ ...env, replyTo: 0 }, chat);
    return;
  }
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
    GDOCS = { t: 0, docs: null };
    if (env.STATE) await env.STATE.delete("fs:games").catch(() => {});
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

  // "ml 86 x3 wp" (game + packages, no ID) -> price total. Only when every word is a known package, so chatter is left alone.
  if (S.quote !== "off" && !text.startsWith("/") && !/\d{5,}/.test(text) && text.length <= 80 && /^[A-Za-z]/.test(text) && !(isGroup && isFormatted(m))) {
    const q = await parseQuote(env, text).catch(() => null);
    if (q) return sendQuote(env, chat, q);
  }
  // A game short name on its own ("ml", "pubgm") -> that game's price list (table).
  if (!text.startsWith("/") && !/\d{5,}/.test(text) && /^[A-Za-z][A-Za-z0-9 ]{1,29}$/.test(text) && text.split(/\s+/).length <= 3) {
    const hit = abbrGroups(await loadGroups(env), text, isPrivate);
    if (hit.length === 1) return sendPrice(env, chat, hit[0], await getLang(env, m.from?.id));
    if (hit.length > 1) return sendPricePicker(env, chat, await getLang(env, m.from?.id), hit);
  }
  // Admin buy: "ml 123456789 2002 86" -> no name check, buys straight from the G2Bulk wallet when it is enough. Admins only.
  if (S.buy !== "off" && env.G2BULK_API_KEY && /^\.?[A-Za-z]{1,12}\b/.test(text) && /\d{5,}/.test(text) && !isFormatted(m)) {
    if (isOwnerUser || (isGroup && (await isAdmin(env, chat, m.from?.id)))) {
      const plan = await parseBuy(env, text);
      if (plan) return doBuy(env, m, chat, plan);
    }
  }
  // Customer order ("ml 123456789 2002 86 x3"; admins too when they cannot buy): the ID is checked and the card also shows packages + total.
  if (S.orderpv !== "off" && /^\.?[A-Za-z]{1,12}\b/.test(text) && /\d{5,}/.test(text) && text.length <= 600 && !isFormatted(m)) {
    const plan = await parseBuy(env, text).catch(() => null);
    if (plan && (await orderPreview(env, m, chat, plan, isGroup))) return;
  }
  // Groups: a number is only treated as a Player ID when it is written as ID(Server), or has "id" in front of it (or answers the bot's
  // own prompt / result card). Price lists, order numbers and chatter are left alone. /set idprefix off turns this off.
  const idStripped = isGroup ? stripIdWord(text) : null;
  const rt0 = m.reply_to_message?.text || "";
  const answersBot = !!m.reply_to_message?.from?.is_bot && (/🎮/.test(rt0) || isCardText(rt0));
  const bracketForm = isGroup && (/\d{5,}\s*[(（]\s*\d{1,6}\s*[)）]/.test(text) || !!(() => { const q = parseInput(text); return q.id && q.server && /^\d{1,6}$/.test(q.server) && !q.query; })());   // "123456789(2002)" is clear enough without "id"
  if (isGroup && S.idprefix === "on" && idStripped === null && !bracketForm && !answersBot) return;
  const p = parseInput(idStripped !== null ? idStripped : text);
  const repliedToBot = !!m.reply_to_message?.from?.is_bot;
  // In groups stay silent on normal chatter: only react to messages that look like a check.
  if (isGroup && (!p.id || (S.idprefix === "on" && !p.server && !p.query && !repliedToBot))) return;

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
    // ID only, no game name -> check the games that need no Server ID (name + region); if there is none, ask for the Server ID.
    if (groups.some((g) => !g.dropdown && g.idOnly)) return autoScan(env, chat, groups, id, "");
    if (isGroup) return;   // group: a bare number with no ID-only game to check stays silent
    return send(env, chat, "🖥 Server ID လိုပါတယ်\nဥပမာ: <code>" + esc(id) + "(2002)</code>");
  } else {
    group = known;
  }
  if (!group) return isGroup ? undefined : isOwnerUser ? sendUi(env, chat, MENU_TEXT, helpRows(true, false)) : sendCustomerMenu(env, chat, m.from?.id);
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
  "payment", "pay", "paying", "transfer", "bank", "banking", "mobile banking", "pay လုပ်", "pay နံပါတ်", "account number", "acc number", "ငွေလွှဲ", "ငွေလွဲ", "ငွေပေးချေ", "ငွေသွင်း", "ငွေပေး",
  "ဘဏ်", "လွှဲရ", "လွဲရ", "လွှဲမယ်", "လွဲမယ်", "ပေးရမ", "ပေးမယ်", "ပေးချေ", "ကျသင့်ငွေ", "ဘယ်လောက်လွှဲ", "ပိုက်ဆံလွှဲ", "ငွေကြေး",
  "အကောင့်နံပါတ်", "ဘယ်ကိုလွှဲ", "ဘယ်လိုလွှဲ", "ဘယ်လိုပေး", "ဘယ်နံပါတ်", "ဘဏ်နံပါတ်",
];
let PAYM = { t: 0, list: [] };
async function getPayMethods(env) {
  if (PAYM.list.length && Date.now() - PAYM.t < 10 * 60 * 1000) return PAYM.list;
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
  if (forced || PAY_GENERIC.some((w) => t.includes(w))) return { list: methods, all: true };
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
      chat_id: chat, photo: one.qrImage, caption: html, parse_mode: "HTML", reply_markup: markup, ...(env.bc ? { business_connection_id: env.bc } : {}),
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
  const note = env.biz ? null : await send(env, chat, `🔍 <b>စစ်နေပါတယ်...</b>\n🆔 <code>${esc(id)}</code>${server ? ` (${esc(server)})` : ""}`);
  const noteId = note?.result?.message_id;
  const started = Date.now();

  // Unique provider calls (identical G2Bulk codes are shared across regions & groups).
  const calls = new Map(); // key -> { run, result }
  const plan = groups.map((group) => ({
    group,
    items: group.entries.map((g) => {
      const g2 = true;
      const key = "g:" + g.g2bulkCode + "|" + id + "|" + server;
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

  if (tag === "bl") {   // Balance button: owners and group admins only
    const okb = owners.includes(String(q.from.id)) || (inGroup && (await isAdmin(env, chat, q.from.id)));
    if (!okb) return tg(env, "answerCallbackQuery", { callback_query_id: q.id, text: "⛔ Admin ပဲ ကြည့်လို့ရပါတယ်", show_alert: true });
    await tg(env, "answerCallbackQuery", { callback_query_id: q.id });
    return showBalance({ ...env, replyTo: 0 }, chat);
  }
  if (["mi", "pr", "mo", "pm", "lg", "px"].includes(tag)) return customerCallback(env, q, chat, tag, gid, id);

  // Post composer buttons (owner, private chat): target picker, schedule / channel / template / sent-post actions.
  if (["pt", "ps", "pc", "pa", "pz", "pk"].includes(tag)) {
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
    const rows = gid === "0" ? helpRows(owners.includes(String(q.from.id)) || (inGroup && (await isAdmin(env, chat, q.from.id))), priv) : gid === "a" ? adminRows() : [[{ text: "⬅️ ပြန်သွားရန်", data: "h:" + (gid[0] === "a" ? "a" : "0"), style: "primary" }, ...(priv ? [CLOSE_BTN] : [])]];
    await tg(env, "deleteMessage", { chat_id: chat, message_id: q.message.message_id }).catch(() => {});
    return sendUi({ ...env, replyTo: 0 }, chat, page, rows, inGroup ? 10 * 60 * 1000 : undefined);
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
    let ci = cardInfo(text);
    if (!ci.id && env.STATE) {
      const sv = await env.STATE.get(`ci:${chat}:${q.message.message_id}`, "json").catch(() => null);
      if (sv) ci = { game: sv.g || "", id: sv.i || "", server: sv.s || "" };
    }
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
    const list = g2 || [];
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
  if (env.biz && opts.length) return send(env, chat, `🎮 <b>${esc(group.name)}</b> <code>${esc(id)}</code>\n\nServer နာမည် ရိုက်ပြီး ပြန်ပို့ပါ:\n` + opts.map((o) => "• " + esc(o.label)).join("\n"));
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
  if (env.biz) return send(env, chat, "🎮 Game နာမည်အပြည့် ရိုက်ပြီး ပြန်ပို့ပါ:\n" + list.map((g) => "• " + esc(g.name)).join("\n"));
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
    // ID-only check (no Server ID): the card shows name + region. Region = what the provider reports, else the Server ID table.
    const showServer = !group.idOnly && !!server;
    const region = showServer ? "" : fmtRegion((r.geo && r.geo.region) || regionFromServerId(g.g2bulkCode, server));
    const ox = env.orderExtra;   // customer order: packages + total under the ID line
    const card = cardText(group.name, `✅ ${esc(r.name)}`, `<code>${esc(id)}</code>${showServer ? ` (${esc(server)})` : ""}${region ? `\n🌍 ${esc(region)}` : ""}${ox ? `\n\n${ox.html}` : ""}`);
    const copyBtn =
      S.copyid === "restricted" && env.requester
        ? { text: "Copy ID", callback_data: `i:${env.requester}`, style: "primary", ...ic(env, "ICON_COPY") }   // only the asker / admins / owners
        : copyIdButton(env, !group.idOnly && !group.dropdown && server ? `${id}(${server})` : id);              // native: anyone can tap
    const rows = [[copyBtn]];
    const store = await getStore(env);
    if (store) rows.push([{ text: "Store ဝင်ရန်", url: store, style: "primary", ...ic(env, "ICON_STORE") }]);
    const wantsDone = env.requester && (Number(chat) > 0 ? env.ownerKb : env.hasReceipt);   // group: only image + ID gets Done / Reject
    if (wantsDone) rows.push(doneRejectRow(env.requester, env));   // group: admins mark the order done or rejected (side by side, one row)
    // Details as a bordered table (rich message). Same buttons as before ride along as the normal reply_markup, so Copy / Store / Done / Reject behave exactly the same.
    // Falls back to the plain card when rich messages are off, Telegram refuses it, or Copy ID is "restricted" (a tappable <code> cannot be restricted).
    let sent = null, rich = false;
    if (S.rich !== "off" && S.richcard !== "off" && !env.bc && !(S.copyid === "restricted" && env.requester)) {
      const row = (k, v) => `<tr><td><b>${k}</b></td><td>${v}</td></tr>`;
      let h = `<table bordered>${row("Game", esc(group.name))}${row("Name", `<b>${esc(r.name)}</b>`)}${row("ID", `<code>${esc(id)}</code>`)}` +
        (showServer ? row("Server", `<code>${esc(server)}</code>`) : "") + (region ? row("Region", esc(region)) : "") + `</table>`;
      if (ox && ox.items && ox.items.length) {
        h += `<table bordered><tr>${["Package", "Qty", "Price (Ks)"].map((c) => `<td align="center"><b>${c}</b></td>`).join("")}</tr>` +
          ox.items.map((it) => `<tr><td>${esc(it[0])}</td><td align="center">${it[1]}</td><td align="right">${fmtKs(it[2])}</td></tr>`).join("") +
          `<tr><td><b>Total</b></td><td></td><td align="right"><b>${fmtKs(ox.price)}</b></td></tr></table>`;
      }
      sent = await sendRichCard(env, chat, h, { reply_markup: { inline_keyboard: rows } }, autodelMs());
      rich = !!sent;
    }
    if (!sent) sent = await sendCard(env, chat, bq(card), { reply_markup: { inline_keyboard: rows } });
    const info = { g: group.name, i: id, s: group.idOnly ? "" : server };
    // A rich card has no text to parse back: keep game / ID / server in storage for Done, Reject and Copy ID.
    if (rich && env.STATE && sent?.result?.message_id) await env.STATE.put(`ci:${chat}:${sent.result.message_id}`, JSON.stringify(info), { expirationTtl: ORDER_TTL_S }).catch(() => {});
    if (ox && env.STATE && sent?.result?.message_id) await env.STATE.put(`pv:${chat}:${sent.result.message_id}`, JSON.stringify({ p: Math.round(ox.price), c: Math.round(ox.cost || 0), n: ox.n }), { expirationTtl: ORDER_TTL_S }).catch(() => {});
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
