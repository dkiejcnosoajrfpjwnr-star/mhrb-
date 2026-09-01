/**
 * بوت حماية وإدارة مجموعات تيليجرام - يعمل على Cloudflare Workers
 * ==================================================================
 * التخزين: Cloudflare KV (namespace binding: BOT_KV)
 *
 * المتغيرات المطلوبة:
 *   BOT_TOKEN       -> توكن البوت من BotFather   (Secret)
 *   DEV_ID          -> آيدي المطور الرقمي (رقم فقط)  (Variable أو Secret)
 *   WEBHOOK_SECRET  -> كلمة سرية لحماية رابط الويبهوك (اختياري لكن يفضل ضبطها) (Secret)
 *
 * راجع ملف README.md لطريقة الرفع على Cloudflare وربط الويبهوك.
 *
 * هذا الملف مبني بشكل معياري (modular) ليسهل إضافة أوامر ومزايا جديدة لاحقاً
 * كما ذكرت أنك تريد إكمال البوت على مراحل.
 */

// ==================== أدوات تليجرام الأساسية ====================

const api = (env) => `https://api.telegram.org/bot${env.BOT_TOKEN}`;

async function tg(env, method, payload) {
  const res = await fetch(`${api(env)}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload || {}),
  });
  const data = await res.json().catch(() => ({}));
  if (!data.ok) {
    console.log("TG_ERROR", method, JSON.stringify(payload).slice(0, 300), JSON.stringify(data));
  }
  return data;
}

function sendMessage(env, chat_id, text, extra = {}) {
  return tg(env, "sendMessage", { chat_id, text, parse_mode: "HTML", ...extra });
}

function editMessageText(env, chat_id, message_id, text, extra = {}) {
  return tg(env, "editMessageText", { chat_id, message_id, text, parse_mode: "HTML", ...extra });
}

function answerCallback(env, callback_query_id, text = "", show_alert = false) {
  return tg(env, "answerCallbackQuery", { callback_query_id, text, show_alert });
}

function deleteMessage(env, chat_id, message_id) {
  return tg(env, "deleteMessage", { chat_id, message_id });
}

function copyMessage(env, chat_id, from_chat_id, message_id, extra = {}) {
  return tg(env, "copyMessage", { chat_id, from_chat_id, message_id, ...extra });
}

// إزالة التشكيل والتطويل من النص العربي حتى تتطابق كلمات الأوامر/الردود
// سواء كتبها العضو بحركات (تشكيل) أو بدونها
const TASHKEEL_REGEX = /[\u0610-\u061A\u064B-\u065F\u06D6-\u06DC\u06DF-\u06E8\u06EA-\u06ED\u0670\u0640]/g;
function normalizeArabic(text) {
  if (!text) return "";
  return text.replace(TASHKEEL_REGEX, "").replace(/\s+/g, " ").trim();
}

function mentionHtml(user) {
  const name = escapeHtml(user?.first_name || user?.username || "عضو");
  const id = user?.id;
  return `<a href="tg://user?id=${id}">${name}</a>`;
}

// معرّف تيليجرام الخاص بحساب "المشرف المجهول" الذي تُرسَل منه الرسائل
// عندما يفعّل مشرف خيار "إخفاء الهوية" في المجموعة
const ANONYMOUS_ADMIN_ID = 1087968824;

// يكتشف إن كانت الرسالة مُرسلة من مشرف مجهول الهوية (باسم المجموعة نفسها)
// في هذه الحالة msg.from لا يمثل صاحب الرسالة الحقيقي، لذا لا يجوز الاعتماد
// على getChatMember به مباشرة، بل نفترض أنه مشرف (لأن غير المشرف لا يمكنه
// إرسال رسائل بهذه الطريقة أصلاً).
function isAnonymousAdminMessage(msg) {
  if (msg.sender_chat && msg.chat && String(msg.sender_chat.id) === String(msg.chat.id)) return true;
  if (msg.from && Number(msg.from.id) === ANONYMOUS_ADMIN_ID) return true;
  return false;
}

// نص "بواسطة: ..." الذي يظهر في ردود البوت، يدعم حالة المشرف المجهول
function actorMentionHtml(msg) {
  if (isAnonymousAdminMessage(msg)) {
    return `${escapeHtml(msg.chat.title || "المجموعة")} (مشرف)`;
  }
  return mentionHtml(msg.from);
}

function escapeHtml(s) {
  if (!s) return "";
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function isDev(env, userId) {
  return String(userId) === String(env.DEV_ID);
}

function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// ==================== طبقة تخزين KV ====================
// كل بيانات المجموعة الواحدة (تفعيل، مكتومين، مقيدين، قوانين، ترحيب، ردود...)
// تُخزَّن في مفتاح واحد لتقليل عدد عمليات القراءة/الكتابة على KV.

function defaultGroupData(chatId, title) {
  return {
    id: chatId,
    title: title || "",
    active: false, // يصبح true بعد أن يصبح البوت مشرفاً فعلياً في الكروب
    pending: true, // بانتظار ترقية البوت لمشرف
    adminsCount: 0,
    managers: [], // [{id, name, permissions}]
    admins: [], // [{id, name, permissions}]
    specialMembers: [], // [{id, name}]
    knownUsers: [], // [{id, first_name, last_name, username}]
    muted: [], // [{id, name}]
    restricted: [], // [{id, name}]
    banned: [], // [{id, name}]
    rules: "",
    welcome: "",
    welcomeEnabled: true,
    rulesEnabled: true,
    locks: {
      links: false,
      mention: false,
      edit: false,
      chat: false,
      photo: false,
      document: false,
      sticker: false,
      video: false,
      forward: false,
      media: false,
    },
    replies: [], // [{id, trigger, type, content}]
    recentMessageIds: [], // لأمر "مسح 100"
    warnings: [], // [{id, name, count}] — نظام الإنذارات (٣ كحد أقصى قبل اقتراح عقوبة)
  };
}

const ROLE_PERMISSION_KEYS = ["ban", "kick", "mute", "promote"];

function defaultRolePermissions() {
  return { ban: true, kick: true, mute: true, promote: true };
}

function normalizeRoleEntry(entry, withPermissions = true) {
  const normalized = {
    id: entry.id,
    name: entry.name || String(entry.id),
    username: entry.username || "",
  };
  if (withPermissions) {
    normalized.permissions = {
      ...defaultRolePermissions(),
      ...(entry.permissions || {}),
    };
  }
  return normalized;
}

function normalizeRoleList(list, withPermissions = true) {
  return Array.isArray(list)
    ? list.filter((entry) => entry && entry.id !== undefined).map((entry) => normalizeRoleEntry(entry, withPermissions))
    : [];
}

// يضمن توافق بيانات المجموعات القديمة مع الحقول الجديدة (بدون الحاجة لترحيل يدوي)
function normalizeGroup(group) {
  if (!group) return group;
  group.banned = group.banned || [];
  group.muted = group.muted || [];
  group.restricted = group.restricted || [];
  group.replies = group.replies || [];
  group.recentMessageIds = group.recentMessageIds || [];
  group.warnings = group.warnings || [];
  group.managers = normalizeRoleList(group.managers);
  group.admins = normalizeRoleList(group.admins);
  group.specialMembers = normalizeRoleList(group.specialMembers, false);
  group.knownUsers = Array.isArray(group.knownUsers)
    ? group.knownUsers.filter((user) => user && user.id !== undefined)
    : [];
  group.locks = group.locks || {};
  const lockKeys = ["links", "mention", "edit", "chat", "photo", "document", "sticker", "video", "forward", "media"];
  for (const k of lockKeys) {
    if (group.locks[k] === undefined) group.locks[k] = false;
  }
  if (group.welcomeEnabled === undefined) group.welcomeEnabled = true;
  if (group.rulesEnabled === undefined) group.rulesEnabled = true;
  return group;
}

async function getGroup(env, chatId) {
  const raw = await env.BOT_KV.get(`group:${chatId}`);
  return raw ? normalizeGroup(JSON.parse(raw)) : null;
}

async function saveGroup(env, group) {
  await env.BOT_KV.put(`group:${group.id}`, JSON.stringify(group));
}

async function deleteGroupData(env, chatId) {
  await env.BOT_KV.delete(`group:${chatId}`);
  const list = await getDevGroupsList(env);
  const updated = list.filter((g) => String(g.id) !== String(chatId));
  await env.BOT_KV.put("dev:groups", JSON.stringify(updated));
}

async function getDevGroupsList(env) {
  const raw = await env.BOT_KV.get("dev:groups");
  return raw ? JSON.parse(raw) : [];
}

async function upsertDevGroupsList(env, chatId, title) {
  const list = await getDevGroupsList(env);
  const idx = list.findIndex((g) => String(g.id) === String(chatId));
  if (idx === -1) list.push({ id: chatId, title: title || "" });
  else list[idx].title = title || list[idx].title;
  await env.BOT_KV.put("dev:groups", JSON.stringify(list));
}

// حالة المطور داخل الخاص (بانتظار إرسال آيدي/رابط كروب لتفعيله أو حذفه)
async function getDevState(env) {
  const raw = await env.BOT_KV.get(`state:dev:${env.DEV_ID}`);
  return raw ? JSON.parse(raw) : null;
}
async function setDevState(env, state) {
  const key = `state:dev:${env.DEV_ID}`;
  if (!state) return env.BOT_KV.delete(key);
  await env.BOT_KV.put(key, JSON.stringify(state));
}

// حالة المسؤول داخل مجموعة معيّنة (بانتظار إرسال قوانين/ترحيب/رد ...)
async function getAdminState(env, chatId, userId) {
  const raw = await env.BOT_KV.get(`state:${chatId}:${userId}`);
  return raw ? JSON.parse(raw) : null;
}
async function setAdminState(env, chatId, userId, state) {
  const key = `state:${chatId}:${userId}`;
  if (!state) return env.BOT_KV.delete(key);
  await env.BOT_KV.put(key, JSON.stringify(state));
}

// تتبع "بانتظار ترقية البوت لمشرف" لكل مجموعة كي نفعّلها تلقائياً عند الترقية
async function setPendingActivation(env, chatId, devChatId) {
  await env.BOT_KV.put(`pending_activation:${chatId}`, JSON.stringify({ devChatId }));
}
async function getPendingActivation(env, chatId) {
  const raw = await env.BOT_KV.get(`pending_activation:${chatId}`);
  return raw ? JSON.parse(raw) : null;
}
async function clearPendingActivation(env, chatId) {
  await env.BOT_KV.delete(`pending_activation:${chatId}`);
}

async function getBotInfo(env) {
  const raw = await env.BOT_KV.get("bot:info");
  if (raw) return JSON.parse(raw);
  const res = await tg(env, "getMe", {});
  if (res.ok) {
    await env.BOT_KV.put("bot:info", JSON.stringify(res.result));
    return res.result;
  }
  return null;
}

async function getStartText(env) {
  return (await env.BOT_KV.get("bot:start_text")) || TXT.startUser;
}

async function setStartText(env, text) {
  await env.BOT_KV.put("bot:start_text", text);
}

async function getActiveDevGroups(env) {
  const registered = await getDevGroupsList(env);
  const active = [];
  for (const item of registered) {
    const group = await getGroup(env, item.id);
    if (group?.active) {
      active.push({
        id: item.id,
        title: group.title || item.title || String(item.id),
      });
    }
  }
  return active;
}

async function getGroupLink(env, chatId) {
  const chat = await tg(env, "getChat", { chat_id: chatId });
  if (chat.ok && chat.result?.username) {
    return `https://t.me/${chat.result.username}`;
  }
  if (chat.ok && chat.result?.invite_link) return chat.result.invite_link;

  const invite = await tg(env, "exportChatInviteLink", { chat_id: chatId });
  return invite.ok ? invite.result : null;
}

// ==================== نصوص وكليشات ثابتة ====================

const TXT = {
  startUser:
    "👋 أهلاً بك\n" +
    "عملي • حماية وإدارة المجموعات.\n\n" +
    "💎 للتفعيل: أضفني لمجموعتك كـ (مشرف) وارسل كلمة تفعيل.",

  startDev: "👋 أهلاً بك انت مطور •",

  askGroupForActivation: "┃ ✦ أرسل رابط أو آيدي الكروب الذي تريد تفعيله",
  askGroupForDeletion: "┃ ✦ أرسل رابط أو آيدي الكروب الذي تريد حذف تفعيله",
  askStartText: "┃ ✦ أرسل كليشة /start الجديدة الآن",
  startTextSaved: "✅ تم تغيير كليشة /start بنجاح.",

  groupNeedsAdmin: (title) => `تم تفعيل الكروب يجب ان يكون مشرف في المجموعة ( ${title} )•`,

  groupActivatedInGroup:
    "✅ تم تفعيل الكروب بنجاح!\n" +
    "↢ تم حفظ عدد المشرفين وتخزينهم.\n" +
    "↢ البوت الآن جاهز لحماية المجموعة .",

  punishCliche:
    "┃ ✦ أوامر الإدارة والعقوبات 👮‍♂️\n" +
    "┃ ✧ يمكن استخدامها بالرد على العضو، أو بذكر اليوزر/الآيدي بعد الأمر\n\n" +
    "┃ ✦ العقوبات الأساسية\n" +
    "┃ ✧ كتم ➖ الغاء كتم (أو: رفع كتم)\n" +
    "┃ ✧ حظر ➖ الغاء حظر (أو: رفع حظر)\n" +
    "┃ ✧ طرد\n" +
    "┃ ✧ تقييد ➖ الغاء تقييد (أو: رفع تقييد)\n" +
    "┃ ✧ رفع القيود (يرفع كل العقوبات دفعة واحدة: كتم + حظر + تقييد)\n" +
    "┃ ✧ ملاحظة: المكتوم تبقى الكتابة ظاهرة له وتُحذف رسائله تلقائياً، أما المقيّد فتختفي عنه لوحة الكتابة كلياً\n\n" +
    "┃ ✦ الإنذارات\n" +
    "┃ ✧ انذار (٣ حد أقصى، ثم تظهر أزرار عقوبة سريعة)\n" +
    "┃ ✧ يعمل على الأعضاء العاديين فقط، وليس أصحاب الرتب\n\n" +
    "┃ ✦ التنظيف والإعدادات\n" +
    "┃ ✧ مسح 100 (يحذف آخر 100 رسالة)\n" +
    "┃ ✧ مسح (بالرد، يحذف الرسالة)\n" +
    "┃ ✧ المكتومين (لعرض قائمة المكتومين)\n" +
    "┃ ✧ المقيديين ( لعرض قائمة المقيديين )\n" +
    "┃ ✧ المحظورين ( لعرض قائمة المحظورين )\n" +
    "┃ ✧ وضع / مسح (قوانين، ترحيب، رد)\n" +
    "┃ ✧ مسح المكتومين ➖ مسح المحظورين ➖ مسح المقيدين\n" +
    "┃ ✧ مسح الادمنية ➖ مسح المميزين ➖ مسح المدراء",

  lockCliche:
    "✦ اوامر القفل والفتح \n\n" +
    "• قفل - فتح ↢ الروابط\n" +
    "• قفل - فتح ↢ المعرف\n" +
    "• قفل - فتح ↢ التعديل\n" +
    "• قفل - فتح ↢ الدردشه\n" +
    "• قفل - فتح ↢ الصور\n" +
    "• قفل - فتح ↢ الملفات\n" +
    "• قفل - فتح ↢ الكلايش\n" +
    "• قفل - فتح ↢ الفيديو\n" +
    "• قفل - فتح ↢ التوجيه\n" +
    "• قفل - فتح ↢ الميديا",

  toggleCliche:
    "✦ اوامر التفعيل والتعطيل \n\n" + "• تفعيل - تعطيل ↢ الترحيب\n" + "• تفعيل - تعطيل ↢ القوانين",

  welcomeLocked: "× الترحيب مقفول\n• لتفعيله اكتب تفعيل الترحيب",
  rulesLocked: "× القوانين مقفولة\n• لتفعيلها اكتب تفعيل القوانين",

  askRules: "┃ ✦ ارسل القوانين التي تريد وضعها\n┃ ✧ ثم ارسل كلمة القوانين لتراها",
  rulesSaved: "✓ تم حفظ القوانين",
  rulesCleared: "✓ تم مسح القوانين",

  askWelcome: "✦ ارسل كليشة الترحيب",
  welcomeSaved: "✓ تم حفظ الترحيب",
  welcomeCleared: "✓ تم مسح الترحيب",

  askReplyTrigger: "✦ ارسل نص للرد عليه ✦",
  askReplyContent: "✦ ارسل رد للنص ويشمل كل الميديا مثل فيديو او صورة او ملف إلى اخره ✦",
  replySaved: "✓ تم حفظ الرد بنجاح",

  askEditReplyTrigger: "✦ ارسل نص جديد للرد عليه ✦",
  askEditReplyContent: "✦ ارسل رد للنص جديد ويشمل كل الميديا مثل فيديو او صورة او ملف إلى اخره ✦",
};

// ==================== لوحات المفاتيح (Inline Keyboards) ====================

function kbUserStart(botUsername) {
  const url = botUsername ? `https://t.me/${botUsername}?startgroup=true` : "https://t.me/";
  return { inline_keyboard: [[{ text: "➕ أضفني إلى مجموعتك", url }]] };
}

function kbDevStart() {
  return {
    inline_keyboard: [
      [{ text: "✅ تفعيل كروب", callback_data: "dev_activate" }],
      [{ text: "🗑 حذف كروب", callback_data: "dev_delete" }],
      [{ text: "📋 الكروبات المفعّلة", callback_data: "dev_active_groups" }],
      [{ text: "✏️ تغيير كليشة /start", callback_data: "dev_start_text" }],
    ],
  };
}

function kbDevActiveGroups(groups) {
  const rows = groups.map((group) => [
    { text: `📁 ${group.title}`, callback_data: `dev_group:${group.id}` },
  ]);
  rows.push([{ text: "رجوع", callback_data: "dev_home", style: "danger" }]);
  return { inline_keyboard: rows };
}

function kbDevGroupDetails(chatId, link) {
  const rows = [];
  if (link) rows.push([{ text: "🔗 فتح رابط الكروب", url: link }]);
  rows.push([{ text: "🗑 مسح المجموعة", callback_data: `dev_group_delete:${chatId}` }]);
  rows.push([{ text: "🔙 الكروبات المفعّلة", callback_data: "dev_active_groups" }]);
  return { inline_keyboard: rows };
}

// نافذة "اوامر" الرئيسية — أزرار خضراء (success) كأقسام رئيسية
function kbCommandsMenu() {
  return {
    inline_keyboard: [
      [
        { text: "- أوامر الإدارة والعقوبات", callback_data: "menu_punish", style: "success" },
        { text: "- أوامر الكروب", callback_data: "menu_group", style: "success" },
      ],
      [
        { text: "- القوانين والترحيب", callback_data: "menu_rules_welcome", style: "success" },
        { text: "- الردود التلقائية", callback_data: "menu_autoreply", style: "success" },
      ],
      [{ text: "- معلومات البوت", callback_data: "menu_info", style: "success" }],
    ],
  };
}

// نافذة "أوامر الكروب" — أزرار زرقاء (primary) للأقسام الفرعية، وأحمر (danger) للرجوع
function kbGroupMenu() {
  return {
    inline_keyboard: [
      [{ text: "⤶ القفل والفتح", callback_data: "menu_group_lock", style: "primary" }],
      [{ text: "⤶ التفعيل والتعطيل", callback_data: "menu_group_toggle", style: "primary" }],
      [{ text: "⤶ الترقية", callback_data: "menu_roles", style: "primary" }],
      [{ text: "رجوع", callback_data: "menu_back", style: "danger" }],
    ],
  };
}

function kbBack() {
  return { inline_keyboard: [[{ text: "رجوع", callback_data: "menu_back", style: "danger" }]] };
}

function kbBackTo(callback_data) {
  return { inline_keyboard: [[{ text: "رجوع", callback_data, style: "danger" }]] };
}

// أزرار "مسح/حذف" الجماعية — كلها حمراء (danger)
function kbDeleteAllMuted() {
  return { inline_keyboard: [[{ text: "- حذف كل المكتومين", callback_data: "unmute_all", style: "danger" }]] };
}

function kbDeleteAllRestricted() {
  return { inline_keyboard: [[{ text: "- حذف كل المقيديين", callback_data: "unrestrict_all", style: "danger" }]] };
}

function kbDeleteAllBanned() {
  return { inline_keyboard: [[{ text: "- حذف كل المحظورين", callback_data: "unban_all", style: "danger" }]] };
}

function kbDeleteAllManagers() {
  return { inline_keyboard: [[{ text: "- مسح المدراء", callback_data: "managers_clear", style: "danger" }]] };
}

function kbDeleteAllAdmins() {
  return { inline_keyboard: [[{ text: "- مسح الادمنية", callback_data: "admins_clear", style: "danger" }]] };
}

function kbDeleteAllSpecials() {
  return { inline_keyboard: [[{ text: "- مسح المميزين", callback_data: "specials_clear", style: "danger" }]] };
}

// تظهر بعد تجاوز العضو لعدد الإنذارات — شبكة 2×2 (نافذة جانب نافذة)، بدون إيموجيات
function kbWarnActions(targetId) {
  return {
    inline_keyboard: [
      [
        { text: "كتم", callback_data: `warn_act:mute:${targetId}` },
        { text: "حظر", callback_data: `warn_act:ban:${targetId}` },
      ],
      [
        { text: "تقييد", callback_data: `warn_act:restrict:${targetId}` },
        { text: "طرد", callback_data: `warn_act:kick:${targetId}` },
      ],
    ],
  };
}

// لوحة القائمة عند عرضها ضمن قائمة "الترقية" التفاعلية (نفس الرسالة): زر مسح (أحمر) + زر رجوع (أحمر)
function kbRoleListCallback(role) {
  const clearBtn =
    role === "manager"
      ? { text: "- مسح المدراء", callback_data: "managers_clear", style: "danger" }
      : role === "admin"
        ? { text: "- مسح الادمنية", callback_data: "admins_clear", style: "danger" }
        : { text: "- مسح المميزين", callback_data: "specials_clear", style: "danger" };
  return {
    inline_keyboard: [[clearBtn], [{ text: "رجوع", callback_data: "menu_roles", style: "danger" }]],
  };
}

// نافذة "الترقية" — أزرار زرقاء (primary) للفئات، وأحمر (danger) للرجوع
function kbRoleLists() {
  return {
    inline_keyboard: [
      [
        { text: "• المدراء", callback_data: "role_list:manager", style: "primary" },
        { text: "• الادمنية", callback_data: "role_list:admin", style: "primary" },
      ],
      [{ text: "• المميزين", callback_data: "role_list:special", style: "primary" }],
      [{ text: "رجوع", callback_data: "menu_group", style: "danger" }],
    ],
  };
}

function kbRolePermissions(role, id, permissions) {
  const check = (key) => (permissions?.[key] === false ? "✗" : "✓");
  return {
    inline_keyboard: [
      [
        { text: `الحظر ${check("ban")}`, callback_data: `roleperm:${role}:${id}:ban` },
        { text: `الطرد ${check("kick")}`, callback_data: `roleperm:${role}:${id}:kick` },
      ],
      [
        { text: `الكتم ${check("mute")}`, callback_data: `roleperm:${role}:${id}:mute` },
        { text: `الرفع ${check("promote")}`, callback_data: `roleperm:${role}:${id}:promote` },
      ],
    ],
  };
}

function kbGroupPicker(list, action) {
  const rows = list.map((g) => [
    { text: `${g.title || g.id}`, callback_data: `${action}:${g.id}` },
  ]);
  return { inline_keyboard: rows.length ? rows : [[{ text: "لا توجد كروبات", callback_data: "noop" }]] };
}

function kbReplyEntry(id) {
  return {
    inline_keyboard: [
      [{ text: "- تعديل", callback_data: `rep_editmenu:${id}` }],
      [{ text: "- حذف", callback_data: `rep_del:${id}` }],
    ],
  };
}

function kbReplyEditChoice(id) {
  return {
    inline_keyboard: [
      [{ text: "- تعديل نص الرد", callback_data: `rep_edittrigger:${id}` }],
      [{ text: "- تعديل رد النص", callback_data: `rep_editcontent:${id}` }],
    ],
  };
}

function kbMemberProfile(member) {
  const label = member.first_name || member.username || "العضو الجديد";
  return { inline_keyboard: [[{ text: `• ${label}`, url: `tg://user?id=${member.id}` }]] };
}

// ==================== أدوات تليجرام مساعدة ====================

async function getBotId(env) {
  const info = await getBotInfo(env);
  return info?.id;
}

async function getMemberStatus(env, chatId, userId) {
  const res = await tg(env, "getChatMember", { chat_id: chatId, user_id: userId });
  return res.ok ? res.result.status : null;
}

async function isGroupAdmin(env, chatId, userId) {
  const status = await getMemberStatus(env, chatId, userId);
  return status === "creator" || status === "administrator";
}

function findRoleEntry(group, role, userId) {
  const list =
    role === "manager"
      ? group.managers
      : role === "admin"
        ? group.admins
        : group.specialMembers;
  return list?.find((entry) => String(entry.id) === String(userId)) || null;
}

function storedRole(group, userId) {
  if (findRoleEntry(group, "manager", userId)) return "manager";
  if (findRoleEntry(group, "admin", userId)) return "admin";
  if (findRoleEntry(group, "special", userId)) return "special";
  return null;
}

async function getActorRole(env, group, chatId, userId, msg = null) {
  const status = await getMemberStatus(env, chatId, userId);
  if (status === "creator") return "owner";
  const customRole = storedRole(group, userId);
  if (customRole) return customRole;
  return "member";
}

function canModerate(role) {
  return ["owner", "manager", "admin"].includes(role);
}

function canUseLocks(role) {
  return canModerate(role) || role === "special";
}

function canUseSettings(role) {
  return role === "owner" || role === "manager";
}

function canUseToggles(role) {
  return role === "owner" || role === "manager";
}

function roleLabel(role) {
  return {
    owner: "المالك",
    manager: "المدير",
    admin: "الادمن",
    special: "المميز",
    telegram_admin: "المشرف",
    member: "العضو",
  }[role] || "العضو";
}

function roleListFor(group, role) {
  return role === "manager"
    ? group.managers
    : role === "admin"
      ? group.admins
      : group.specialMembers;
}

function removeFromRoleLists(group, userId) {
  group.managers = group.managers.filter((entry) => String(entry.id) !== String(userId));
  group.admins = group.admins.filter((entry) => String(entry.id) !== String(userId));
  group.specialMembers = group.specialMembers.filter((entry) => String(entry.id) !== String(userId));
}

function roleActionPermission(role, entry, permission) {
  if (role === "owner") return true;
  if (!["manager", "admin"].includes(role)) return false;
  return entry?.permissions?.[permission] !== false;
}

function canManageAssignedRole(actorRole, targetRole) {
  if (actorRole === "owner") return true;
  if (actorRole === "manager") return targetRole !== "manager";
  if (actorRole === "admin") return targetRole === "special";
  return false;
}

function roleRank(role) {
  return {
    member: 0,
    special: 1,
    admin: 2,
    manager: 3,
    owner: 4,
  }[role] ?? 0;
}

async function getTargetRole(env, group, chatId, userId) {
  const status = await getMemberStatus(env, chatId, userId);
  if (status === "creator") return "owner";
  return storedRole(group, userId) || "member";
}

// نفس isGroupAdmin لكن يتعامل أيضاً مع رسائل "المشرف المجهول"
async function isSenderAdmin(env, msg) {
  if (isAnonymousAdminMessage(msg)) return true;
  const group = await getGroup(env, msg.chat.id);
  if (!group) return isGroupAdmin(env, msg.chat.id, msg.from.id);
  return canModerate(await getActorRole(env, group, msg.chat.id, msg.from.id, msg));
}

async function actorRoleLabel(env, chatId, userId) {
  const status = await getMemberStatus(env, chatId, userId);
  return status === "creator" ? "مالك" : "مشرف";
}

// يحاول تحويل نص (رابط / يوزرنيم / آيدي رقمي) إلى بيانات الشات عبر getChat
async function resolveChatFromText(env, text) {
  let ref = text.trim();
  const linkMatch = ref.match(/t\.me\/([A-Za-z0-9_]+)/i);
  if (linkMatch) ref = "@" + linkMatch[1];
  else if (/^[A-Za-z0-9_]+$/.test(ref) && !/^-?\d+$/.test(ref) && !ref.startsWith("@")) {
    ref = "@" + ref;
  }
  const res = await tg(env, "getChat", { chat_id: ref });
  return res.ok ? res.result : null;
}

function rememberKnownUser(group, user) {
  if (!user || user.id === undefined) return;
  const existing = group.knownUsers.find((entry) => String(entry.id) === String(user.id));
  const normalized = {
    id: user.id,
    first_name: user.first_name || "",
    last_name: user.last_name || "",
    username: user.username || "",
  };
  if (existing) Object.assign(existing, normalized);
  else group.knownUsers.push(normalized);
  if (group.knownUsers.length > 2000) group.knownUsers = group.knownUsers.slice(-2000);
}

async function resolveTargetUser(env, group, msg, reference) {
  if (!reference) return msg.reply_to_message?.from || null;
  const ref = reference.trim().replace(/^@/, "").toLowerCase();
  const knownUser = group.knownUsers.find(
    (user) => user.username && user.username.toLowerCase() === ref,
  );
  if (knownUser) return knownUser;

  if (/^-?\d+$/.test(reference.trim())) {
    // مهم: التيليجرام يتوقع user_id كرقم صحيح (Integer)، وليس نصاً — وإلا يفشل الطلب بصمت
    const numericId = Number(reference.trim());
    const member = await tg(env, "getChatMember", {
      chat_id: msg.chat.id,
      user_id: numericId,
    });
    if (member.ok && member.result?.user) return member.result.user;
    return null; // آيدي رقمي واضح لكن غير موجود في هذه المجموعة تحديداً
  }

  const chat = await resolveChatFromText(env, reference);
  if (!chat || chat.type !== "private" || chat.id === undefined) return null;
  return {
    id: chat.id,
    first_name: chat.first_name || chat.title || "",
    last_name: chat.last_name,
    username: chat.username,
  };
}

function matchCommandWithTarget(text, commands) {
  const ordered = [...commands].sort((a, b) => b.length - a.length);
  for (const command of ordered) {
    if (text === command) return { command, reference: null };
    if (text.startsWith(`${command} `)) {
      const reference = text.slice(command.length).trim();
      if (reference) return { command, reference };
    }
  }
  return null;
}

// ==================== منطق تفعيل / حذف تفعيل المجموعات ====================

// يحاول تفعيل الكروب مباشرة إن كان البوت مشرفاً فيه بالفعل،
// وإلا يضعه في حالة "انتظار" ويفعّله تلقائياً لاحقاً عند ترقيته (عبر my_chat_member).
async function activateGroupFlow(env, devChatId, chat) {
  const botId = await getBotId(env);
  const status = await getMemberStatus(env, chat.id, botId);

  await upsertDevGroupsList(env, chat.id, chat.title);

  if (status === "administrator" || status === "creator") {
    await finalizeActivation(env, chat.id, chat.title);
    await sendMessage(env, devChatId, `✅ تم تفعيل الكروب ( ${chat.title} ) بنجاح.`);
  } else {
    let group = await getGroup(env, chat.id);
    if (!group) group = defaultGroupData(chat.id, chat.title);
    group.title = chat.title;
    group.active = false;
    group.pending = true;
    await saveGroup(env, group);
    await setPendingActivation(env, chat.id, devChatId);
    await sendMessage(env, devChatId, TXT.groupNeedsAdmin(chat.title));
  }
}

// يُستدعى عندما يصبح البوت فعلياً مشرفاً في الكروب (سواء فور الطلب أو لاحقاً)
async function finalizeActivation(env, chatId, title) {
  let group = await getGroup(env, chatId);
  if (!group) group = defaultGroupData(chatId, title);

  const admins = await tg(env, "getChatAdministrators", { chat_id: chatId });
  const adminsCount = admins.ok ? admins.result.length : 0;

  group.title = title || group.title;
  group.active = true;
  group.pending = false;
  group.adminsCount = adminsCount;
  await saveGroup(env, group);
  await clearPendingActivation(env, chatId);
  await upsertDevGroupsList(env, chatId, group.title);

  await sendMessage(env, chatId, TXT.groupActivatedInGroup);
}

async function deactivateGroupFlow(env, devChatId, chat) {
  const existed = await getGroup(env, chat.id);
  await deleteGroupData(env, chat.id);
  await clearPendingActivation(env, chat.id);
  if (existed) {
    await sendMessage(env, devChatId, `🗑 تم حذف تفعيل الكروب ( ${chat.title || existed.title} ).`);
  } else {
    await sendMessage(env, devChatId, `⚠️ هذا الكروب غير مُفعّل أصلاً.`);
  }
}

// ==================== محادثة المطور في الخاص ====================

async function handleDevPrivateMessage(env, msg) {
  const devChatId = msg.chat.id;
  const state = await getDevState(env);
  if (!state) return false; // ليس في منتصف عملية معيّنة

  const text = (msg.text || "").trim();
  if (!text) return true;

  if (state.action === "awaiting_start_text") {
    if (text.length > 3900) {
      await sendMessage(env, devChatId, "⚠️ الكليشة طويلة جداً. أرسل نصاً أقل من 3900 حرف.");
      return true;
    }
    await setStartText(env, text);
    await setDevState(env, null);
    await sendMessage(env, devChatId, TXT.startTextSaved, { reply_markup: kbDevStart() });
    return true;
  }

  const chat = await resolveChatFromText(env, text);
  if (!chat) {
    await sendMessage(env, devChatId, "⚠️ لم أستطع التعرف على هذا الكروب، تأكد من الرابط أو الآيدي وحاول مجدداً.");
    return true;
  }

  if (state.action === "awaiting_activate") {
    await activateGroupFlow(env, devChatId, chat);
  } else if (state.action === "awaiting_delete") {
    await deactivateGroupFlow(env, devChatId, chat);
  }

  await setDevState(env, null);
  return true;
}

async function handleDevCallback(env, cq) {
  const devChatId = cq.message.chat.id;
  const data = cq.data;

  if (data === "dev_home") {
    await answerCallback(env, cq.id);
    await editMessageText(env, devChatId, cq.message.message_id, TXT.startDev, {
      reply_markup: kbDevStart(),
    });
    return true;
  }

  if (data === "dev_activate") {
    await setDevState(env, { action: "awaiting_activate" });
    await answerCallback(env, cq.id);
    await sendMessage(env, devChatId, TXT.askGroupForActivation);
    return true;
  }

  if (data === "dev_delete") {
    await setDevState(env, { action: "awaiting_delete" });
    await answerCallback(env, cq.id);
    await sendMessage(env, devChatId, TXT.askGroupForDeletion);
    return true;
  }

  if (data === "dev_start_text") {
    await setDevState(env, { action: "awaiting_start_text" });
    await answerCallback(env, cq.id);
    await sendMessage(env, devChatId, TXT.askStartText);
    return true;
  }

  if (data === "dev_active_groups") {
    const groups = await getActiveDevGroups(env);
    if (!groups.length) {
      await answerCallback(env, cq.id, "لا توجد كروبات مفعّلة حالياً.", true);
      return true;
    }
    await answerCallback(env, cq.id);
    await editMessageText(env, devChatId, cq.message.message_id, "📋 الكروبات المفعّلة:", {
      reply_markup: kbDevActiveGroups(groups),
    });
    return true;
  }

  if (data.startsWith("dev_group_delete:")) {
    const chatId = data.slice("dev_group_delete:".length);
    const existed = await getGroup(env, chatId);
    await deleteGroupData(env, chatId);
    await clearPendingActivation(env, chatId);
    await answerCallback(env, cq.id, existed ? "تم مسح المجموعة" : "المجموعة غير موجودة");

    const groups = await getActiveDevGroups(env);
    if (groups.length) {
      await editMessageText(env, devChatId, cq.message.message_id, "📋 الكروبات المفعّلة:", {
        reply_markup: kbDevActiveGroups(groups),
      });
    } else {
      await editMessageText(env, devChatId, cq.message.message_id, "لا توجد كروبات مفعّلة حالياً.", {
        reply_markup: kbDevStart(),
      });
    }
    return true;
  }

  if (data.startsWith("dev_group:")) {
    const chatId = data.slice("dev_group:".length);
    const groups = await getActiveDevGroups(env);
    const group = groups.find((item) => String(item.id) === String(chatId));
    if (!group) {
      await answerCallback(env, cq.id, "الكروب غير موجود أو غير مفعّل.", true);
      return true;
    }
    const link = await getGroupLink(env, chatId);
    const linkLine = link
      ? `🔗 الرابط: <a href="${escapeHtml(link)}">${escapeHtml(link)}</a>`
      : "⚠️ تعذر الحصول على رابط الكروب.";
    await answerCallback(env, cq.id);
    await editMessageText(
      env,
      devChatId,
      cq.message.message_id,
      `📁 اسم الكروب: ${escapeHtml(group.title)}\n🆔 الآيدي: <code>${escapeHtml(group.id)}</code>\n${linkLine}`,
      { reply_markup: kbDevGroupDetails(chatId, link) },
    );
    return true;
  }

  return false;
}

// ==================== أوامر العقوبات الأساسية ====================
// كل هذه الأوامر تُستخدم بالرد (reply) على رسالة العضو المستهدف

// ملاحظة: "الكتم" لم يعد يستخدم هذا الكائن — أصبح كتماً "ناعماً" ينفّذه البوت
// بحذف رسائل المستخدم بدل تقييده فعلياً عبر تيليجرام (انظر handlePunishCommand + enforceLocks).
// يُستخدم الآن فقط في أمر "تقييد" (حظر كامل حقيقي تخفي معه لوحة الكتابة).
const FULL_MUTE_PERMS = {
  can_send_messages: false,
  can_send_audios: false,
  can_send_documents: false,
  can_send_photos: false,
  can_send_videos: false,
  can_send_video_notes: false,
  can_send_voice_notes: false,
  can_send_polls: false,
  can_send_other_messages: false,
  can_add_web_page_previews: false,
};

// غير مُستخدَم حالياً بعد تعديل آلية الكتم/التقييد، أُبقي عليه للرجوع إليه مستقبلاً عند الحاجة
const PARTIAL_RESTRICT_PERMS = {
  can_send_messages: true,
  can_send_audios: false,
  can_send_documents: false,
  can_send_photos: false,
  can_send_videos: false,
  can_send_video_notes: false,
  can_send_voice_notes: false,
  can_send_polls: false,
  can_send_other_messages: false,
  can_add_web_page_previews: false,
};

const FULL_PERMS = {
  can_send_messages: true,
  can_send_audios: true,
  can_send_documents: true,
  can_send_photos: true,
  can_send_videos: true,
  can_send_video_notes: true,
  can_send_voice_notes: true,
  can_send_polls: true,
  can_send_other_messages: true,
  can_add_web_page_previews: true,
};

function punishResultText(icon, label, target, actorMentionStr) {
  return (
    `${icon} ${label}\n` +
    `- المستخدم: ${mentionHtml(target)}\n` +
    `- بواسطة: ${actorMentionStr}`
  );
}

function addToList(list, user) {
  if (!list.find((u) => String(u.id) === String(user.id))) {
    list.push({
      id: user.id,
      name: user.first_name || user.username || String(user.id),
      username: user.username || "",
    });
  }
}
function removeFromList(list, userId) {
  return list.filter((u) => String(u.id) !== String(userId));
}

// يفحص إن كان المستخدم ضمن قائمة "المكتومين" الداخلية للبوت
// (الكتم لم يعد يعتمد على تقييد تيليجرام، بل على حذف رسائله بعد إرسالها)
function isMuted(group, userId) {
  if (userId === undefined || userId === null) return false;
  return (group.muted || []).some((u) => String(u.id) === String(userId));
}

function linkedUserHtml(user) {
  return mentionHtml({
    id: user.id,
    first_name: user.name || user.first_name || user.username || String(user.id),
  });
}

function roleListText(list) {
  return list.map((entry, index) => `${index + 1}- ${linkedUserHtml(entry)}`).join("\n");
}

function rolePermissionText(role) {
  return role === "manager" ? "المدير" : role === "admin" ? "الادمن" : "المميز";
}

// editCtx = {chatId, messageId} لتعديل رسالة قائمة "الترقية" التفاعلية بدل إرسال رسالة جديدة
async function sendRoleList(env, group, chatId, role, msg, editCtx = null) {
  const list = roleListFor(group, role);
  const label = rolePermissionText(role);
  const text = list.length ? `${label}:\n${roleListText(list)}` : `لا يوجد ${label} مسجلون حالياً.`;

  if (editCtx) {
    await editMessageText(env, editCtx.chatId, editCtx.messageId, text, {
      reply_markup: kbRoleListCallback(role),
    });
    return true;
  }

  const replyOpts = msg ? { reply_to_message_id: msg.message_id } : {};
  const keyboard =
    role === "manager" ? kbDeleteAllManagers() : role === "admin" ? kbDeleteAllAdmins() : kbDeleteAllSpecials();
  await sendMessage(env, chatId, text, { ...replyOpts, reply_markup: keyboard });
  return true;
}

async function sendRolePermissionPanel(env, group, chatId, role, entry, msg) {
  const label = rolePermissionText(role);
  const replyOpts = msg ? { reply_to_message_id: msg.message_id } : {};
  await sendMessage(
    env,
    chatId,
    `✦ وضع قيود لل${label}\n👤 المستخدم: ${linkedUserHtml(entry)}\n\nاضغط على الأمر لتفعيله أو تعطيله:`,
    {
      ...replyOpts,
      reply_markup: kbRolePermissions(role, entry.id, entry.permissions),
    },
  );
}

async function handleRoleCommand(env, group, chatId, msg, text, actorRole, targetReference = null) {
  if (text === "المدراء") {
    if (actorRole !== "owner") {
      await sendMessage(env, chatId, "✗ هذا الأمر للمالك فقط.", { reply_to_message_id: msg.message_id });
      return true;
    }
    return sendRoleList(env, group, chatId, "manager", msg);
  }

  if (text === "الادمنية" || text === "الادمنيه") {
    if (!["owner", "manager"].includes(actorRole)) {
      await sendMessage(env, chatId, "✗ هذا الأمر للمدراء والمالك فقط.", { reply_to_message_id: msg.message_id });
      return true;
    }
    return sendRoleList(env, group, chatId, "admin", msg);
  }

  if (text === "المميزين") {
    if (!["owner", "manager", "admin"].includes(actorRole)) {
      await sendMessage(env, chatId, "✗ هذا الأمر للادمنية والمدراء والمالك فقط.", { reply_to_message_id: msg.message_id });
      return true;
    }
    return sendRoleList(env, group, chatId, "special", msg);
  }

  if (["صلاحياته", "صلاحيات", "الصلاحيات"].includes(text)) {
    const target = msg.reply_to_message?.from;
    if (!target) {
      await sendMessage(env, chatId, "⚠️ يجب استخدام الأمر بالرد على المدير أو الادمن.", {
        reply_to_message_id: msg.message_id,
      });
      return true;
    }
    const targetRole = storedRole(group, target.id);
    if (!["manager", "admin"].includes(targetRole)) {
      await sendMessage(env, chatId, "⚠️ هذا المستخدم ليس مديراً أو ادمن.", {
        reply_to_message_id: msg.message_id,
      });
      return true;
    }
    if (actorRole === targetRole || !canManageAssignedRole(actorRole, targetRole)) {
      await sendMessage(env, chatId, "✗ لا يمكنك تعديل صلاحيات هذه الرتبة.", {
        reply_to_message_id: msg.message_id,
      });
      return true;
    }
    const entry = findRoleEntry(group, targetRole, target.id);
    await sendRolePermissionPanel(env, group, chatId, targetRole, entry, msg);
    return true;
  }

  // أمر عام لتنزيل أي عضو من أي رتبة يحملها (مدير/ادمن/مميز) دون تحديد نوعها
  if (text === "تنزيل الكل") {
    const target = await resolveTargetUser(env, group, msg, targetReference);
    if (!target) {
      await sendMessage(env, chatId, "⚠️ لم أجد المستخدم.\nإن كان لم يكتب أي رسالة هنا من قبل، لن يتعرّف عليه البوت عبر اليوزر (قيد من تيليجرام نفسه) — استخدم آيدي رقمي صحيح، أو نفّذ الأمر بالرد على إحدى رسائله إن وُجدت.", {
        reply_to_message_id: msg.message_id,
      });
      return true;
    }
    const existingRole = storedRole(group, target.id);
    if (!existingRole) {
      await sendMessage(env, chatId, "⚠️ هذا المستخدم لا يحمل أي رتبة أصلاً.", {
        reply_to_message_id: msg.message_id,
      });
      return true;
    }
    if (!canManageAssignedRole(actorRole, existingRole)) {
      await sendMessage(env, chatId, "✗ ليست لديك صلاحية تنفيذ هذا الأمر.", {
        reply_to_message_id: msg.message_id,
      });
      return true;
    }
    removeFromRoleLists(group, target.id);
    await saveGroup(env, group);
    await sendMessage(
      env,
      chatId,
      `- المستخدم: ${mentionHtml(target)}\n- تم تنزيله من ${rolePermissionText(existingRole)} بواسطة ${actorMentionHtml(msg)}`,
      { reply_to_message_id: msg.message_id },
    );
    return true;
  }

  const match = text.match(/^(رفع|تنزيل)\s+(مدير|مشرف|ادمن|أدمن|مميز)$/);
  if (!match) return false;

  const target = await resolveTargetUser(env, group, msg, targetReference);
  if (!target) {
    await sendMessage(env, chatId, "⚠️ لم أجد المستخدم.\nإن كان لم يكتب أي رسالة هنا من قبل، لن يتعرّف عليه البوت عبر اليوزر (قيد من تيليجرام نفسه) — استخدم آيدي رقمي صحيح، أو نفّذ الأمر بالرد على إحدى رسائله إن وُجدت.", {
      reply_to_message_id: msg.message_id,
    });
    return true;
  }
  const action = match[1];
  const requestedRole = match[2];
  const targetRole = requestedRole === "مدير"
    ? "manager"
    : requestedRole === "مميز"
      ? "special"
      : "admin";
  const existingRole = storedRole(group, target.id);

  if (target.id === msg.from?.id && action === "رفع") {
    await sendMessage(env, chatId, "✗ لا يمكنك رفع رتبتك بنفسك.", { reply_to_message_id: msg.message_id });
    return true;
  }
  if (targetRole === "manager" && actorRole !== "owner") {
    await sendMessage(env, chatId, "✗ تعيين المدير للمالك فقط.", { reply_to_message_id: msg.message_id });
    return true;
  }
  if (!canManageAssignedRole(actorRole, targetRole)) {
    await sendMessage(env, chatId, "✗ ليست لديك صلاحية تنفيذ هذا الأمر.", { reply_to_message_id: msg.message_id });
    return true;
  }
  const actorEntry = findRoleEntry(group, actorRole, msg.from?.id);
  if (!roleActionPermission(actorRole, actorEntry, "promote")) {
    await sendMessage(env, chatId, "✗ انت ممنوع من هذا الأمر.", { reply_to_message_id: msg.message_id });
    return true;
  }

  if (action === "تنزيل") {
    if (existingRole !== targetRole) {
      await sendMessage(env, chatId, "⚠️ هذا المستخدم لا يحمل هذه الرتبة.", {
        reply_to_message_id: msg.message_id,
      });
      return true;
    }
    removeFromRoleLists(group, target.id);
    await saveGroup(env, group);
    await sendMessage(
      env,
      chatId,
      `- المستخدم: ${mentionHtml(target)}\n- تم تنزيله من ${rolePermissionText(targetRole)} بواسطة ${actorMentionHtml(msg)}`,
      { reply_to_message_id: msg.message_id },
    );
    return true;
  }

  if (existingRole === targetRole) {
    await sendMessage(env, chatId, "⚠️ المستخدم يحمل هذه الرتبة مسبقاً.", {
      reply_to_message_id: msg.message_id,
    });
    return true;
  }

  const currentStatus = await getMemberStatus(env, chatId, target.id);
  if (currentStatus === "creator") {
    await sendMessage(env, chatId, "✗ لا يمكن تغيير رتبة مالك المجموعة.", {
      reply_to_message_id: msg.message_id,
    });
    return true;
  }

  removeFromRoleLists(group, target.id);
  const entry = normalizeRoleEntry(
    {
      id: target.id,
      name: target.first_name || target.username || String(target.id),
      username: target.username || "",
    },
    targetRole !== "special",
  );
  roleListFor(group, targetRole).push(entry);
  await saveGroup(env, group);
  const panel =
    targetRole === "manager" || targetRole === "admin"
      ? kbRolePermissions(targetRole, target.id, entry.permissions)
      : undefined;
  await sendMessage(
    env,
    chatId,
    `- المستخدم: ${mentionHtml(target)}\n- تم رفعه ${rolePermissionText(targetRole)} بواسطة ${actorMentionHtml(msg)}`,
    {
      reply_to_message_id: msg.message_id,
      ...(panel ? { reply_markup: panel } : {}),
    },
  );
  return true;
}

// أسماء بديلة (مرادفات) لبعض أوامر العقوبات — تُطبَّع إلى الاسم الأساسي قبل التنفيذ
const PUNISH_COMMAND_ALIASES = {
  "رفع كتم": "الغاء كتم",
  "رفع الكتم": "الغاء كتم",
  "رفع حظر": "الغاء حظر",
  "رفع الحظر": "الغاء حظر",
  "رفع تقييد": "الغاء تقييد",
  "رفع تقيد": "الغاء تقييد",
  "رفع التقيد": "الغاء تقييد",
};

// أوامر العقوبات "الفعلية" (تطبيق عقوبة على عضو) — الاستثناءات أدناه تخصها فقط،
// وليس أوامر رفعها (الغاء كتم/حظر/تقييد)
const PUNITIVE_APPLY_COMMANDS = ["كتم", "حظر", "تقييد", "طرد"];

// رسالة منع تنفيذ العقوبة على النفس (بالرد على رسالة نفسه، أو بذكر يوزره/آيديه هو)
const SELF_PUNISH_MESSAGES = {
  "كتم": "- ما تكدر تكتم نفسك",
  "حظر": "- ما تكدر حظر نفسك",
  "تقييد": "- ما تكدر تقييد نفسك",
  "طرد": "- ما تكدر طرد نفسك",
};

// صيغة الفعل المستخدمة في رسالة "نزّله من الرتبة أولاً"
const PUNISH_VERB = { "كتم": "تكتم", "حظر": "تحظر", "تقييد": "تقيد", "طرد": "تطرد" };

// خريطة كلمة الأمر -> الدالة المنفذة، لتسهيل الإضافة لاحقاً
async function handlePunishCommand(env, group, chatId, msg, cmdRaw, actorRole, targetReference = null) {
  const cmd = PUNISH_COMMAND_ALIASES[cmdRaw] || cmdRaw;
  const target = await resolveTargetUser(env, group, msg, targetReference);
  const replyOpts = { reply_to_message_id: msg.message_id };
  if (!target) {
    await sendMessage(env, chatId, "⚠️ لم أجد المستخدم.\nإن كان لم يكتب أي رسالة هنا من قبل، لن يتعرّف عليه البوت عبر اليوزر (قيد من تيليجرام نفسه) — استخدم آيدي رقمي صحيح، أو نفّذ الأمر بالرد على إحدى رسائله إن وُجدت.", replyOpts);
    return true;
  }

  const isPunitiveApply = PUNITIVE_APPLY_COMMANDS.includes(cmd);

  // 1) لا يجوز تنفيذ عقوبة على النفس (بالرد على رسالة نفسه أو بذكر يوزره/آيديه)
  if (isPunitiveApply && !isAnonymousAdminMessage(msg) && msg.from && String(target.id) === String(msg.from.id)) {
    await sendMessage(env, chatId, SELF_PUNISH_MESSAGES[cmd], replyOpts);
    return true;
  }

  const targetRole = await getTargetRole(env, group, chatId, target.id);

  // 2) نفس الرتبة (مدير على مدير، أو مشرف على مشرف) ممنوع تماماً — بنفس الصلاحيات
  if (isPunitiveApply && targetRole === actorRole) {
    await sendMessage(env, chatId, "- ما تكدر لأنكم بنفس الصلاحيات !", replyOpts);
    return true;
  }

  if (roleRank(targetRole) > roleRank(actorRole)) {
    await sendMessage(env, chatId, "- رتبته اعلى منك !", replyOpts);
    return true;
  }

  // 3) حتى لو كانت رتبتك أعلى، لا يجوز معاقبة من يحمل رتبة (مدير/مشرف/مميز) قبل تنزيله أولاً
  if (isPunitiveApply && ["manager", "admin", "special"].includes(targetRole)) {
    const verb = PUNISH_VERB[cmd];
    await sendMessage(
      env,
      chatId,
      `- ما تكدر ${verb}ه اولاً نزله من الرتبة\n- لتنزيله : اكتب تنزيل الكل`,
      replyOpts,
    );
    return true;
  }

  const actorMentionStr = `${actorMentionHtml(msg)} (${roleLabel(actorRole)})`;
  const actorEntry = findRoleEntry(group, actorRole, msg.from?.id);
  const permission =
    cmd.includes("حظر") ? "ban" :
      cmd.includes("طرد") ? "kick" :
        cmd.includes("كتم") ? "mute" : null;
  if (permission && !roleActionPermission(actorRole, actorEntry, permission)) {
    await sendMessage(env, chatId, "✗ انت ممنوع من هذا الأمر.", replyOpts);
    return true;
  }

  switch (cmd) {
    // الكتم لا يُقيَّد على مستوى تيليجرام (تبقى لوحة الكتابة ظاهرة له بشكل طبيعي)،
    // لكن البوت يحذف أي رسالة يرسلها طالما هو ضمن قائمة المكتومين (انظر enforceLocks)
    case "كتم": {
      await tg(env, "restrictChatMember", {
        chat_id: chatId,
        user_id: target.id,
        permissions: FULL_PERMS,
      });
      addToList(group.muted, target);
      await saveGroup(env, group);
      await sendMessage(env, chatId, punishResultText("🔇", "تم كتم العضو", target, actorMentionStr), replyOpts);
      return true;
    }
    case "الغاء كتم": {
      const wasMuted = isMuted(group, target.id);
      await tg(env, "restrictChatMember", {
        chat_id: chatId,
        user_id: target.id,
        permissions: FULL_PERMS,
      });
      group.muted = removeFromList(group.muted, target.id);
      await saveGroup(env, group);
      const resultText = wasMuted
        ? punishResultText("🔊", "تم إلغاء كتم العضو", target, actorMentionStr)
        : `⚠️ هذا العضو غير مكتوم أصلاً.\n👤 ${mentionHtml(target)}`;
      await sendMessage(env, chatId, resultText, replyOpts);
      return true;
    }
    case "حظر": {
      await tg(env, "banChatMember", { chat_id: chatId, user_id: target.id });
      addToList(group.banned, target);
      await saveGroup(env, group);
      await sendMessage(env, chatId, punishResultText("⛔", "تم حظر العضو", target, actorMentionStr), replyOpts);
      return true;
    }
    case "الغاء حظر": {
      const wasBanned = group.banned.some((u) => String(u.id) === String(target.id));
      await tg(env, "unbanChatMember", { chat_id: chatId, user_id: target.id, only_if_banned: true });
      group.banned = removeFromList(group.banned, target.id);
      await saveGroup(env, group);
      const resultText = wasBanned
        ? punishResultText("✅", "تم إلغاء حظر العضو", target, actorMentionStr)
        : `⚠️ هذا العضو غير محظور أصلاً.\n👤 ${mentionHtml(target)}`;
      await sendMessage(env, chatId, resultText, replyOpts);
      return true;
    }
    case "طرد": {
      await tg(env, "banChatMember", { chat_id: chatId, user_id: target.id });
      await tg(env, "unbanChatMember", { chat_id: chatId, user_id: target.id, only_if_banned: true });
      await sendMessage(env, chatId, punishResultText("👢", "تم طرد العضو", target, actorMentionStr), replyOpts);
      return true;
    }
    // التقييد يستخدم قفلاً كاملاً فعلياً من تيليجرام: لوحة الكتابة تختفي تماماً عند العضو
    case "تقييد": {
      await tg(env, "restrictChatMember", {
        chat_id: chatId,
        user_id: target.id,
        permissions: FULL_MUTE_PERMS,
      });
      addToList(group.restricted, target);
      await saveGroup(env, group);
      await sendMessage(env, chatId, punishResultText("🚧", "تم تقييد العضو", target, actorMentionStr), replyOpts);
      return true;
    }
    case "الغاء تقييد": {
      const wasRestricted = group.restricted.some((u) => String(u.id) === String(target.id));
      await tg(env, "restrictChatMember", {
        chat_id: chatId,
        user_id: target.id,
        permissions: FULL_PERMS,
      });
      group.restricted = removeFromList(group.restricted, target.id);
      await saveGroup(env, group);
      const resultText = wasRestricted
        ? punishResultText("✅", "تم إلغاء تقييد العضو", target, actorMentionStr)
        : `⚠️ هذا العضو غير مقيّد أصلاً.\n👤 ${mentionHtml(target)}`;
      await sendMessage(env, chatId, resultText, replyOpts);
      return true;
    }
    // يرفع كل العقوبات دفعة واحدة (كتم + حظر + تقييد) أياً كان ما ينطبق على العضو
    case "رفع القيود": {
      const wasMuted = isMuted(group, target.id);
      const wasBanned = group.banned.some((u) => String(u.id) === String(target.id));
      const wasRestricted = group.restricted.some((u) => String(u.id) === String(target.id));

      if (!wasMuted && !wasBanned && !wasRestricted) {
        await sendMessage(env, chatId, `⚠️ لا توجد أي قيود على هذا العضو أصلاً.\n👤 ${mentionHtml(target)}`, replyOpts);
        return true;
      }

      await tg(env, "restrictChatMember", { chat_id: chatId, user_id: target.id, permissions: FULL_PERMS });
      if (wasBanned) {
        await tg(env, "unbanChatMember", { chat_id: chatId, user_id: target.id, only_if_banned: true });
      }
      group.muted = removeFromList(group.muted, target.id);
      group.restricted = removeFromList(group.restricted, target.id);
      group.banned = removeFromList(group.banned, target.id);
      await saveGroup(env, group);

      await sendMessage(
        env,
        chatId,
        `- تم رفع جميع القيود عن ( ${mentionHtml(target)} )\nبواسطة ( ${actorMentionStr} )`,
        replyOpts,
      );
      return true;
    }
    default:
      return false;
  }
}

// ==================== نظام الإنذارات ====================

const MAX_WARNINGS = 3;

// مرادفات أمر الإنذار — كلها تُنفَّذ بنفس المنطق
const WARN_COMMANDS = ["انذار", "أنذار", "إنذار", "امر انذار", "امر تحذير"];

function findWarningEntry(group, userId) {
  return group.warnings.find((w) => String(w.id) === String(userId)) || null;
}

function getOrCreateWarningEntry(group, target) {
  let entry = findWarningEntry(group, target.id);
  if (!entry) {
    entry = { id: target.id, name: target.first_name || target.username || String(target.id), count: 0 };
    group.warnings.push(entry);
  }
  return entry;
}

function resetWarnings(group, userId) {
  group.warnings = group.warnings.filter((w) => String(w.id) !== String(userId));
}

async function handleWarnCommand(env, group, chatId, msg, actorRole, targetReference = null) {
  const target = await resolveTargetUser(env, group, msg, targetReference);
  const replyOpts = { reply_to_message_id: msg.message_id };
  if (!target) {
    await sendMessage(env, chatId, "⚠️ لم أجد المستخدم.\nإن كان لم يكتب أي رسالة هنا من قبل، لن يتعرّف عليه البوت عبر اليوزر (قيد من تيليجرام نفسه) — استخدم آيدي رقمي صحيح، أو نفّذ الأمر بالرد على إحدى رسائله إن وُجدت.", replyOpts);
    return true;
  }

  // الإنذار يقتصر على الأعضاء العاديين فقط — لا يجوز إنذار من يحمل رتبة
  const targetRole = await getTargetRole(env, group, chatId, target.id);
  if (targetRole !== "member") {
    await sendMessage(env, chatId, `- عذرا المستخدم يمتلك رتبة ( ${roleLabel(targetRole)} )`, replyOpts);
    return true;
  }

  // لا يجوز إنذار عضو مُطبَّق عليه عقوبة حالياً — نخبر المسؤول بنوعها بدل المتابعة
  // ملاحظة: "الطرد" ليس حالة دائمة (العضو يستطيع العودة فوراً)، لذا لا يوجد ما يُفحص له هنا
  if (group.banned.some((u) => String(u.id) === String(target.id))) {
    await sendMessage(env, chatId, "- المستخدم محظور", replyOpts);
    return true;
  }
  if (isMuted(group, target.id)) {
    await sendMessage(env, chatId, "- المستخدم مكتوم", replyOpts);
    return true;
  }
  if (group.restricted.some((u) => String(u.id) === String(target.id))) {
    await sendMessage(env, chatId, "- المستخدم مقيد", replyOpts);
    return true;
  }

  const entry = getOrCreateWarningEntry(group, target);

  if (entry.count >= MAX_WARNINGS) {
    // تجاوز العدد مسبقاً — نعيد عرض نفس رسالة التجاوز مع الأزرار دون زيادة العدّاد
    await sendMessage(
      env,
      chatId,
      `- المستخدم : ${mentionHtml(target)}\n- تجاوز عدد الانذارات\n- يمكنك استخدام التالي ↯`,
      { reply_markup: kbWarnActions(target.id), ...replyOpts },
    );
    return true;
  }

  entry.count += 1;
  await saveGroup(env, group);

  if (entry.count < MAX_WARNINGS) {
    await sendMessage(env, chatId, `- تم انذاره انذار رقم ↫ ${entry.count}`, replyOpts);
    return true;
  }

  await sendMessage(
    env,
    chatId,
    `- المستخدم : ${mentionHtml(target)}\n- تجاوز عدد الانذارات\n- يمكنك استخدام التالي ↯`,
    { reply_markup: kbWarnActions(target.id), ...replyOpts },
  );
  return true;
}

// يُنفَّذ عند الضغط على أحد أزرار (حظر/كتم/طرد/تقييد) الظاهرة بعد تجاوز الإنذارات
async function handleWarnActionCallback(env, group, chatId, cq, actorRole, action, targetId) {
  const member = await tg(env, "getChatMember", { chat_id: chatId, user_id: Number(targetId) });
  const target = member.ok && member.result?.user ? member.result.user : { id: targetId, first_name: "العضو" };

  const actorEntry = findRoleEntry(group, actorRole, cq.from.id);
  const PERMISSION_BY_ACTION = { ban: "ban", kick: "kick", mute: "mute", restrict: null };
  const permission = PERMISSION_BY_ACTION[action];
  if (permission && !roleActionPermission(actorRole, actorEntry, permission)) {
    await answerCallback(env, cq.id, "أنت ممنوع من هذا الأمر.", true);
    return;
  }

  switch (action) {
    case "ban": {
      await tg(env, "banChatMember", { chat_id: chatId, user_id: target.id });
      addToList(group.banned, target);
      break;
    }
    case "mute": {
      await tg(env, "restrictChatMember", { chat_id: chatId, user_id: target.id, permissions: FULL_PERMS });
      addToList(group.muted, target);
      break;
    }
    case "kick": {
      await tg(env, "banChatMember", { chat_id: chatId, user_id: target.id });
      await tg(env, "unbanChatMember", { chat_id: chatId, user_id: target.id, only_if_banned: true });
      break;
    }
    case "restrict": {
      await tg(env, "restrictChatMember", { chat_id: chatId, user_id: target.id, permissions: FULL_MUTE_PERMS });
      addToList(group.restricted, target);
      break;
    }
    default:
      await answerCallback(env, cq.id);
      return;
  }

  resetWarnings(group, target.id);
  await saveGroup(env, group);
  await answerCallback(env, cq.id, "تم التنفيذ ✅");

  // نعدّل نفس رسالة الكليشة بدل إرسال رسالة جديدة، ونحذف الأزرار بعد التنفيذ
  const ACTION_VERB = {
    mute: "تم كتمه",
    ban: "تم حظره",
    kick: "تم طرده",
    restrict: "تم تقييده",
  };
  await editMessageText(
    env,
    chatId,
    cq.message.message_id,
    `- المستخدم : ${mentionHtml(target)}\n- ${ACTION_VERB[action]}`,
    { reply_markup: { inline_keyboard: [] } },
  );
}

function trackRecentMessage(group, messageId) {
  group.recentMessageIds.push(messageId);
  if (group.recentMessageIds.length > 500) {
    group.recentMessageIds = group.recentMessageIds.slice(-500);
  }
}

async function handleClearCommand(env, group, chatId, msg, text) {
  const replyOpts = { reply_to_message_id: msg.message_id };

  // "مسح" بالرد على رسالة => حذف تلك الرسالة فقط
  if (text === "مسح") {
    if (!msg.reply_to_message) {
      await sendMessage(env, chatId, "⚠️ استخدم هذا الأمر بالرد على الرسالة المراد حذفها.", replyOpts);
      return true;
    }
    await deleteMessage(env, chatId, msg.reply_to_message.message_id);
    await deleteMessage(env, chatId, msg.message_id);
    return true;
  }

  // "مسح 100" => حذف العدد المحدد بالضبط من الرسائل التي تسبق رسالة الأمر مباشرة
  // (آيديات الرسائل في تيليجرام متسلسلة تصاعدياً داخل نفس الكروب، لذا هذا أدق
  // من الاعتماد على قائمة رسائل متتبَّعة قد تكون غير مكتملة)
  const m = text.match(/^مسح\s+(\d+)$/);
  if (m) {
    const count = Math.min(parseInt(m[1], 10), 300);
    const endId = msg.message_id - 1; // الرسالة التي قبل رسالة الأمر مباشرة
    const startId = Math.max(1, endId - count + 1);
    let deletedCount = 0;
    for (let id = endId; id >= startId; id--) {
      const res = await deleteMessage(env, chatId, id);
      if (res && res.ok) deletedCount++;
    }
    await deleteMessage(env, chatId, msg.message_id); // حذف رسالة الأمر نفسها أيضاً
    await sendMessage(
      env,
      chatId,
      `✅ تم مسح ( ${deletedCount} ) رسالة .\n👮‍♂️ بواسطة: ${actorMentionHtml(msg)}`
    );
    return true;
  }

  return false;
}

// ==================== قوائم المكتومين / المقيدين ====================

async function handleListCommand(env, group, chatId, msg, text) {
  const replyOpts = { reply_to_message_id: msg.message_id };

  if (text === "المكتومين") {
    if (!group.muted.length) {
      await sendMessage(env, chatId, "لا يوجد أعضاء مكتومين حالياً.", replyOpts);
      return true;
    }
    const lines = group.muted.map((u, i) => `${i + 1}- ${linkedUserHtml(u)}`).join("\n");
    await sendMessage(env, chatId, `- قائمة المكتومين:\n${lines}`, {
      reply_markup: kbDeleteAllMuted(),
      ...replyOpts,
    });
    return true;
  }
  if (text === "المقيديين" || text === "المقيدين") {
    if (!group.restricted.length) {
      await sendMessage(env, chatId, "لا يوجد أعضاء مقيدين حالياً.", replyOpts);
      return true;
    }
    const lines = group.restricted.map((u, i) => `${i + 1}- ${linkedUserHtml(u)}`).join("\n");
    await sendMessage(env, chatId, `- قائمة المقيدين:\n${lines}`, {
      reply_markup: kbDeleteAllRestricted(),
      ...replyOpts,
    });
    return true;
  }
  if (text === "المحظورين") {
    if (!group.banned.length) {
      await sendMessage(env, chatId, "لا يوجد أعضاء محظورين حالياً.", replyOpts);
      return true;
    }
    const lines = group.banned.map((u, i) => `${i + 1}- ${linkedUserHtml(u)}`).join("\n");
    await sendMessage(env, chatId, `- قائمة المحظورين:\n${lines}`, {
      reply_markup: kbDeleteAllBanned(),
      ...replyOpts,
    });
    return true;
  }
  return false;
}

async function handleUnmuteAll(env, group, chatId) {
  for (const u of group.muted) {
    await tg(env, "restrictChatMember", { chat_id: chatId, user_id: u.id, permissions: FULL_PERMS });
  }
  group.muted = [];
  await saveGroup(env, group);
  await sendMessage(env, chatId, "- تم إلغاء كتم جميع الأعضاء.");
}

async function handleUnrestrictAll(env, group, chatId) {
  for (const u of group.restricted) {
    await tg(env, "restrictChatMember", { chat_id: chatId, user_id: u.id, permissions: FULL_PERMS });
  }
  group.restricted = [];
  await saveGroup(env, group);
  await sendMessage(env, chatId, "- تم إلغاء تقييد جميع الأعضاء.");
}

async function handleUnbanAll(env, group, chatId) {
  for (const u of group.banned) {
    await tg(env, "unbanChatMember", { chat_id: chatId, user_id: u.id, only_if_banned: true });
  }
  group.banned = [];
  await saveGroup(env, group);
  await sendMessage(env, chatId, "- تم إلغاء حظر جميع الأعضاء.");
}

// ==================== أوامر المسح السريعة (بدون الحاجة للضغط على الأزرار) ====================

const QUICK_CLEAR_COMMANDS = [
  "مسح المكتومين",
  "مسح المحظورين",
  "مسح المقيدين",
  "مسح المقيديين",
  "مسح الادمنية",
  "مسح الادمنيه",
  "مسح المميزين",
  "مسح المدراء",
];

// صيغ المفرد/الجمع لكل فئة — تُختار حسب العدد المحذوف فعلياً
const QUICK_CLEAR_LABELS = {
  muted: { singular: "مكتوم", plural: "مكتومين" },
  banned: { singular: "محظور", plural: "محظورين" },
  restricted: { singular: "مقيد", plural: "مقيدين" },
  admin: { singular: "ادمن", plural: "ادمنية" },
  manager: { singular: "مدير", plural: "مدراء" },
  special: { singular: "مميز", plural: "مميزين" },
};

function quickClearLabel(category, count) {
  const { singular, plural } = QUICK_CLEAR_LABELS[category];
  return count === 1 ? singular : plural;
}

async function handleQuickClearCommand(env, group, chatId, msg, actorRole, text) {
  const replyOpts = { reply_to_message_id: msg.message_id };
  const actorEntry = findRoleEntry(group, actorRole, msg.from?.id);

  if (text === "مسح المكتومين") {
    const count = group.muted.length;
    if (!count) {
      await sendMessage(env, chatId, "لا يوجد أعضاء مكتومين حالياً.", replyOpts);
      return true;
    }
    for (const u of group.muted) {
      await tg(env, "restrictChatMember", { chat_id: chatId, user_id: u.id, permissions: FULL_PERMS });
    }
    group.muted = [];
    await saveGroup(env, group);
    await sendMessage(env, chatId, `- تم مسح ${count} ${quickClearLabel("muted", count)}`, replyOpts);
    return true;
  }

  if (text === "مسح المحظورين") {
    const count = group.banned.length;
    if (!count) {
      await sendMessage(env, chatId, "لا يوجد أعضاء محظورين حالياً.", replyOpts);
      return true;
    }
    for (const u of group.banned) {
      await tg(env, "unbanChatMember", { chat_id: chatId, user_id: u.id, only_if_banned: true });
    }
    group.banned = [];
    await saveGroup(env, group);
    await sendMessage(env, chatId, `- تم مسح ${count} ${quickClearLabel("banned", count)}`, replyOpts);
    return true;
  }

  if (text === "مسح المقيدين" || text === "مسح المقيديين") {
    const count = group.restricted.length;
    if (!count) {
      await sendMessage(env, chatId, "لا يوجد أعضاء مقيدين حالياً.", replyOpts);
      return true;
    }
    for (const u of group.restricted) {
      await tg(env, "restrictChatMember", { chat_id: chatId, user_id: u.id, permissions: FULL_PERMS });
    }
    group.restricted = [];
    await saveGroup(env, group);
    await sendMessage(env, chatId, `- تم مسح ${count} ${quickClearLabel("restricted", count)}`, replyOpts);
    return true;
  }

  if (text === "مسح الادمنية" || text === "مسح الادمنيه") {
    if (!["owner", "manager"].includes(actorRole)) {
      await sendMessage(env, chatId, "✗ هذا الأمر للمدراء والمالك فقط.", replyOpts);
      return true;
    }
    if (!roleActionPermission(actorRole, actorEntry, "promote")) {
      await sendMessage(env, chatId, "✗ انت ممنوع من هذا الأمر.", replyOpts);
      return true;
    }
    const count = group.admins.length;
    if (!count) {
      await sendMessage(env, chatId, "لا يوجد ادمنية مسجلون حالياً.", replyOpts);
      return true;
    }
    group.admins = [];
    await saveGroup(env, group);
    await sendMessage(env, chatId, `- تم مسح ${count} ${quickClearLabel("admin", count)}`, replyOpts);
    return true;
  }

  if (text === "مسح المميزين") {
    if (!["owner", "manager", "admin"].includes(actorRole)) {
      await sendMessage(env, chatId, "✗ هذا الأمر للادمنية والمدراء والمالك فقط.", replyOpts);
      return true;
    }
    if (!roleActionPermission(actorRole, actorEntry, "promote")) {
      await sendMessage(env, chatId, "✗ انت ممنوع من هذا الأمر.", replyOpts);
      return true;
    }
    const count = group.specialMembers.length;
    if (!count) {
      await sendMessage(env, chatId, "لا يوجد مميزون مسجلون حالياً.", replyOpts);
      return true;
    }
    group.specialMembers = [];
    await saveGroup(env, group);
    await sendMessage(env, chatId, `- تم مسح ${count} ${quickClearLabel("special", count)}`, replyOpts);
    return true;
  }

  if (text === "مسح المدراء") {
    if (actorRole !== "owner") {
      await sendMessage(env, chatId, "✗ هذا الأمر للمالك فقط.", replyOpts);
      return true;
    }
    const count = group.managers.length;
    if (!count) {
      await sendMessage(env, chatId, "لا يوجد مدراء مسجلون حالياً.", replyOpts);
      return true;
    }
    group.managers = [];
    await saveGroup(env, group);
    await sendMessage(env, chatId, `- تم مسح ${count} ${quickClearLabel("manager", count)}`, replyOpts);
    return true;
  }

  return false;
}

// ==================== القوانين / الترحيب / الردود (وضع - مسح) ====================
// آلة حالة بسيطة: عندما يكتب المسؤول "وضع قوانين" مثلاً، نضع state تنتظر رسالته التالية

async function handleSettingsCommand(env, group, chatId, userId, msg, text) {
  const replyOpts = { reply_to_message_id: msg.message_id };

  switch (text) {
    case "وضع قوانين":
      if (group.rulesEnabled === false) {
        await sendMessage(env, chatId, TXT.rulesLocked, replyOpts);
        return true;
      }
      await setAdminState(env, chatId, userId, { action: "awaiting_rules" });
      await sendMessage(env, chatId, TXT.askRules, replyOpts);
      return true;
    case "القوانين": {
      if (!group.rules) {
        await sendMessage(env, chatId, "لا توجد قوانين موضوعة حالياً.", replyOpts);
      } else {
        await sendMessage(env, chatId, group.rules, replyOpts);
      }
      return true;
    }
    case "مسح قوانين":
      group.rules = "";
      await saveGroup(env, group);
      await sendMessage(env, chatId, TXT.rulesCleared, replyOpts);
      return true;

    case "وضع ترحيب":
      if (group.welcomeEnabled === false) {
        await sendMessage(env, chatId, TXT.welcomeLocked, replyOpts);
        return true;
      }
      await setAdminState(env, chatId, userId, { action: "awaiting_welcome" });
      await sendMessage(env, chatId, TXT.askWelcome, replyOpts);
      return true;
    case "مسح ترحيب":
      group.welcome = "";
      await saveGroup(env, group);
      await sendMessage(env, chatId, TXT.welcomeCleared, replyOpts);
      return true;

    case "وضع رد":
      await setAdminState(env, chatId, userId, { action: "awaiting_reply_trigger" });
      await sendMessage(env, chatId, TXT.askReplyTrigger, replyOpts);
      return true;
    case "مسح رد":
      await sendRepliesList(env, group, chatId, msg);
      return true;

    default:
      return false;
  }
}

// ==================== أوامر القفل/الفتح والتفعيل/التعطيل ====================

const LOCK_DEFS = [
  { key: "links", labels: ["الروابط"] },
  { key: "mention", labels: ["المعرف"] },
  { key: "edit", labels: ["التعديل"] },
  { key: "chat", labels: ["الدردشة", "الدردشه"] },
  { key: "photo", labels: ["الصور"] },
  { key: "document", labels: ["الملفات"] },
  { key: "sticker", labels: ["الكلايش"] },
  { key: "video", labels: ["الفيديو"] },
  { key: "forward", labels: ["التوجيه"] },
  { key: "media", labels: ["الميديا"] },
];

const TOGGLE_DEFS = [
  { key: "welcomeEnabled", labels: ["الترحيب"] },
  { key: "rulesEnabled", labels: ["القوانين"] },
];

function findLockDef(label) {
  return LOCK_DEFS.find((d) => d.labels.includes(label));
}
function findToggleDef(label) {
  return TOGGLE_DEFS.find((d) => d.labels.includes(label));
}

async function handleLockCommand(env, group, chatId, msg, action, label) {
  const def = findLockDef(label);
  if (!def) return false;
  group.locks[def.key] = action === "قفل";
  await saveGroup(env, group);
  const verb = action === "قفل" ? "تم قفل" : "تم فتح";
  await sendMessage(env, chatId, `☑ ${verb} ${label}\n- بواسطة : ${actorMentionHtml(msg)}`, {
    reply_to_message_id: msg.message_id,
  });
  return true;
}

async function handleToggleCommand(env, group, chatId, msg, action, label) {
  const def = findToggleDef(label);
  if (!def) return false;
  group[def.key] = action === "تفعيل";
  await saveGroup(env, group);
  const verb = action === "تفعيل" ? "تم تفعيل" : "تم تعطيل";
  await sendMessage(env, chatId, `☑ ${verb} ${label}\n- بواسطة : ${actorMentionHtml(msg)}`, {
    reply_to_message_id: msg.message_id,
  });
  return true;
}

// ==================== تطبيق الأقفال على رسائل غير المشرفين ====================

function messageHasEntityType(msg, types) {
  const entities = [...(msg.entities || []), ...(msg.caption_entities || [])];
  return entities.some((e) => types.includes(e.type));
}

function containsLink(msg) {
  if (messageHasEntityType(msg, ["url", "text_link"])) return true;
  const t = msg.text || msg.caption || "";
  return /(https?:\/\/|www\.|t\.me\/)/i.test(t);
}

function containsMention(msg) {
  if (messageHasEntityType(msg, ["mention", "text_mention"])) return true;
  const t = msg.text || msg.caption || "";
  return /@[A-Za-z0-9_]{3,}/.test(t);
}

function hasAnyMedia(msg) {
  return !!(
    msg.photo ||
    msg.video ||
    msg.document ||
    msg.audio ||
    msg.voice ||
    msg.sticker ||
    msg.animation ||
    msg.video_note
  );
}

function isForwarded(msg) {
  return !!(msg.forward_origin || msg.forward_from || msg.forward_from_chat || msg.forward_date);
}

// يُستدعى فقط لغير المشرفين (المشرفون مستثنون من كل الأقفال)
// يُعيد true إذا تم حذف الرسالة (وبالتالي يجب إيقاف أي معالجة إضافية لها)
async function enforceLocks(env, group, chatId, msg) {
  // المكتوم يمكنه الكتابة والإرسال بشكل طبيعي (لوحة الكتابة تبقى ظاهرة له)،
  // لكن البوت يحذف كل رسالة يرسلها فور وصولها
  if (isMuted(group, msg.from?.id)) {
    await deleteMessage(env, chatId, msg.message_id);
    return true;
  }

  const locks = group.locks || {};

  if (locks.chat) {
    await deleteMessage(env, chatId, msg.message_id);
    return true;
  }
  if (locks.media && hasAnyMedia(msg)) {
    await deleteMessage(env, chatId, msg.message_id);
    return true;
  }
  if (locks.photo && msg.photo) {
    await deleteMessage(env, chatId, msg.message_id);
    return true;
  }
  if (locks.video && msg.video) {
    await deleteMessage(env, chatId, msg.message_id);
    return true;
  }
  if (locks.document && msg.document) {
    await deleteMessage(env, chatId, msg.message_id);
    return true;
  }
  if (locks.sticker && msg.sticker) {
    await deleteMessage(env, chatId, msg.message_id);
    return true;
  }
  if (locks.forward && isForwarded(msg)) {
    await deleteMessage(env, chatId, msg.message_id);
    return true;
  }
  if (locks.links && containsLink(msg)) {
    await deleteMessage(env, chatId, msg.message_id);
    return true;
  }
  if (locks.mention && containsMention(msg)) {
    await deleteMessage(env, chatId, msg.message_id);
    return true;
  }
  return false;
}

// يُستدعى عند تعديل رسالة سابقة (edited_message) للتحقق من قفل "التعديل"
async function handleEditedGroupMessage(env, editedMsg) {
  if (editedMsg.chat.type === "private") return;
  const chatId = editedMsg.chat.id;
  const userId = editedMsg.from?.id;
  if (!userId) return;

  const group = await getGroup(env, chatId);
  if (!group || !group.active) return;

  const senderIsAdmin = await isSenderAdmin(env, editedMsg);
  if (senderIsAdmin) return;

  // المكتوم: أي رسالة يعدّلها تُحذف أيضاً (وليس فقط رسائله الجديدة)
  if (isMuted(group, userId)) {
    await deleteMessage(env, chatId, editedMsg.message_id);
    return;
  }

  if (!group.locks?.edit) return;
  await deleteMessage(env, chatId, editedMsg.message_id);
}

// يعالج رسالة المسؤول التالية أثناء وجوده في إحدى حالات الانتظار أعلاه
async function handleAdminStateInput(env, group, chatId, userId, msg, state) {
  switch (state.action) {
    case "awaiting_rules": {
      if (!msg.reply_to_message) {
        // القوانين تُحفظ من نص رسالته مباشرة (وسيراها لاحقاً بكتابة "القوانين")
      }
      group.rules = msg.text || "";
      await saveGroup(env, group);
      await setAdminState(env, chatId, userId, null);
      await sendMessage(env, chatId, TXT.rulesSaved, { reply_to_message_id: msg.message_id });
      return true;
    }

    case "awaiting_welcome": {
      group.welcome = msg.text || "";
      await saveGroup(env, group);
      await setAdminState(env, chatId, userId, null);
      await sendMessage(env, chatId, TXT.welcomeSaved, { reply_to_message_id: msg.message_id });
      return true;
    }

    case "awaiting_reply_trigger": {
      const trigger = normalizeArabic(msg.text || "");
      if (!trigger) {
        await sendMessage(env, chatId, "⚠️ أرسل نصاً صالحاً ليتم الرد عليه.", {
          reply_to_message_id: msg.message_id,
        });
        return true;
      }
      await setAdminState(env, chatId, userId, { action: "awaiting_reply_content", data: { trigger } });
      await sendMessage(env, chatId, TXT.askReplyContent, { reply_to_message_id: msg.message_id });
      return true;
    }

    case "awaiting_reply_content": {
      const content = extractContent(msg);
      const entry = {
        id: `${Date.now()}${Math.floor(Math.random() * 1000)}`,
        trigger: state.data.trigger,
        type: content.type,
        content, // {type, text?, file_id?, caption?}
      };
      group.replies.push(entry);
      await saveGroup(env, group);
      await setAdminState(env, chatId, userId, null);
      await sendMessage(env, chatId, TXT.replySaved, { reply_to_message_id: msg.message_id });
      return true;
    }

    case "awaiting_edit_reply_trigger": {
      const id = state.data.id;
      const entry = group.replies.find((r) => r.id === id);
      if (entry) {
        entry.trigger = normalizeArabic(msg.text || "") || entry.trigger;
        await saveGroup(env, group);
      }
      await setAdminState(env, chatId, userId, null);
      await sendMessage(env, chatId, "✓ تم تحديث نص الرد", { reply_to_message_id: msg.message_id });
      return true;
    }

    case "awaiting_edit_reply_content": {
      const id = state.data.id;
      const entry = group.replies.find((r) => r.id === id);
      if (entry) {
        entry.content = extractContent(msg);
        entry.type = entry.content.type;
        await saveGroup(env, group);
      }
      await setAdminState(env, chatId, userId, null);
      await sendMessage(env, chatId, "✓ تم تحديث رد النص", { reply_to_message_id: msg.message_id });
      return true;
    }

    default:
      return false;
  }
}

// يستخرج نوع/محتوى أي رسالة (نص، صورة، فيديو، ملف...) لتخزينها كرد تلقائي
function extractContent(msg) {
  if (msg.text) return { type: "text", text: msg.text };
  if (msg.photo) return { type: "photo", file_id: msg.photo[msg.photo.length - 1].file_id, caption: msg.caption || "" };
  if (msg.video) return { type: "video", file_id: msg.video.file_id, caption: msg.caption || "" };
  if (msg.document) return { type: "document", file_id: msg.document.file_id, caption: msg.caption || "" };
  if (msg.voice) return { type: "voice", file_id: msg.voice.file_id, caption: msg.caption || "" };
  if (msg.audio) return { type: "audio", file_id: msg.audio.file_id, caption: msg.caption || "" };
  if (msg.sticker) return { type: "sticker", file_id: msg.sticker.file_id };
  if (msg.animation) return { type: "animation", file_id: msg.animation.file_id, caption: msg.caption || "" };
  return { type: "text", text: "" };
}

const CONTENT_METHOD = {
  photo: "sendPhoto",
  video: "sendVideo",
  document: "sendDocument",
  voice: "sendVoice",
  audio: "sendAudio",
  sticker: "sendSticker",
  animation: "sendAnimation",
};
const CONTENT_FIELD = {
  photo: "photo",
  video: "video",
  document: "document",
  voice: "voice",
  audio: "audio",
  sticker: "sticker",
  animation: "animation",
};

async function sendStoredContent(env, chatId, content, extra = {}) {
  if (content.type === "text") {
    return sendMessage(env, chatId, content.text, extra);
  }
  const method = CONTENT_METHOD[content.type];
  const field = CONTENT_FIELD[content.type];
  const payload = { chat_id: chatId, [field]: content.file_id, ...extra };
  if (content.caption) payload.caption = content.caption;
  return tg(env, method, payload);
}

function contentPreview(content) {
  if (content.type === "text") {
    const words = content.text.split(/\s+/).slice(0, 10).join(" ");
    return words + (content.text.split(/\s+/).length > 10 ? " ..." : "");
  }
  const labels = {
    photo: "صورة",
    video: "فيديو",
    document: "ملف",
    voice: "رسالة صوتية",
    audio: "مقطع صوتي",
    sticker: "ملصق",
    animation: "GIF",
  };
  return labels[content.type] || "محتوى";
}

async function sendRepliesList(env, group, chatId, msg) {
  const replyOpts = msg ? { reply_to_message_id: msg.message_id } : {};
  if (!group.replies.length) {
    await sendMessage(env, chatId, "لا توجد ردود محفوظة حالياً.", replyOpts);
    return;
  }
  const lines = group.replies.map(
    (r, i) => `${i + 1}- ${escapeHtml(r.trigger)} ࿓ ${escapeHtml(contentPreview(r.content))}`
  );
  await sendMessage(env, chatId, `قائمة الردود\n${lines.join("\n")}`, replyOpts);
}

// عندما يرد المسؤول برقم على رسالة "قائمة الردود"
async function handleReplyListSelection(env, group, chatId, msg) {
  const replied = msg.reply_to_message;
  if (!replied || !replied.text || !replied.text.startsWith("قائمة الردود")) return false;
  const num = parseInt((msg.text || "").trim(), 10);
  if (!num || num < 1 || num > group.replies.length) return false;

  const entry = group.replies[num - 1];
  const replyOpts = { reply_to_message_id: msg.message_id };
  await sendMessage(env, chatId, `📝 نص الرد:\n${escapeHtml(entry.trigger)}`, {
    reply_markup: kbReplyEntry(entry.id),
    ...replyOpts,
  });
  await sendStoredContent(env, chatId, entry.content, { reply_markup: kbReplyEntry(entry.id), ...replyOpts });
  return true;
}

// مطابقة الرسائل العادية مع الردود التلقائية المخزّنة
async function tryAutoReply(env, group, chatId, msg) {
  if (!msg.text) return false;
  const normalized = normalizeArabic(msg.text);
  const entry = group.replies.find((r) => normalizeArabic(r.trigger) === normalized);
  if (!entry) return false;
  await sendStoredContent(env, chatId, entry.content, { reply_to_message_id: msg.message_id });
  return true;
}

// ==================== قائمة الأوامر (لسهولة الفحص) ====================

const COMMANDS_MENU_TRIGGERS = ["اوامر", "أوامر", "الاوامر", "الأوامر"];
const PUNISH_COMMANDS = [
  "كتم",
  "الغاء كتم",
  "حظر",
  "الغاء حظر",
  "طرد",
  "تقييد",
  "الغاء تقييد",
  "رفع كتم",
  "رفع الكتم",
  "رفع حظر",
  "رفع الحظر",
  "رفع تقييد",
  "رفع تقيد",
  "رفع التقيد",
  "رفع القيود",
];
const SETTINGS_COMMANDS = [
  "وضع قوانين",
  "مسح قوانين",
  "القوانين",
  "وضع ترحيب",
  "مسح ترحيب",
  "وضع رد",
  "مسح رد",
];
const LIST_COMMANDS = ["المكتومين", "المقيديين", "المقيدين", "المحظورين"];
const ROLE_COMMANDS = [
  "المدراء",
  "الادمنية",
  "الادمنيه",
  "المميزين",
  "صلاحياته",
  "صلاحيات",
  "الصلاحيات",
  "رفع مدير",
  "تنزيل مدير",
  "رفع مشرف",
  "رفع ادمن",
  "رفع أدمن",
  "تنزيل مشرف",
  "تنزيل ادمن",
  "تنزيل أدمن",
  "رفع مميز",
  "تنزيل مميز",
  "تنزيل المميز",
];
const ROLE_QUERY_COMMANDS = ["رتبتي", "رتبه", "رتبة"];

// ==================== معالجة الرسائل داخل المجموعات ====================

async function handleGroupMessage(env, msg) {
  const chatId = msg.chat.id;
  const userId = msg.from?.id;
  if (!userId) return;

  let group = await getGroup(env, chatId);

  // عضو جديد ينضم -> رسالة الترحيب (فقط إن كان الكروب مُفعّلاً والترحيب مفعّلاً)
  if (msg.new_chat_members?.length && group?.active) {
    for (const member of msg.new_chat_members) {
      if (group.welcome && group.welcomeEnabled !== false) {
        await sendMessage(env, chatId, group.welcome.replace(/\{name\}/g, member.first_name || ""), {
          reply_markup: kbMemberProfile(member),
        });
      }
    }
    return;
  }

  if (!group || !group.active) return; // الكروب غير مفعّل، تجاهل كل شيء

  const actorRole = await getActorRole(env, group, chatId, userId, msg);
  const senderIsAdmin = canModerate(actorRole);
  const canManageLocks = canUseLocks(actorRole);
  const specialBypassesChatLock = actorRole === "special";

  // الكتم عقوبة، وليس قفلاً قابلاً للتجاوز؛ يُطبَّق دائماً على غير المشرفين
  // حتى لو كان العضو "مميزاً" (المميز يتجاوز الأقفال العادية فقط، وليس الكتم)
  if (!senderIsAdmin && isMuted(group, userId)) {
    await deleteMessage(env, chatId, msg.message_id);
    return;
  }

  // تطبيق الأقفال على غير المشرفين قبل أي معالجة أخرى
  if (!senderIsAdmin && !specialBypassesChatLock) {
    const deleted = await enforceLocks(env, group, chatId, msg);
    if (deleted) return;
  }

  // تتبع الرسائل لأمر "مسح 100"
  trackRecentMessage(group, msg.message_id);
  rememberKnownUser(group, msg.from);
  rememberKnownUser(group, msg.reply_to_message?.from);

  const text = normalizeArabic(msg.text || "");

  if (ROLE_QUERY_COMMANDS.includes(text)) {
    await sendMessage(env, chatId, `- رتبتك في البوت : ${roleLabel(actorRole)}`, {
      reply_to_message_id: msg.message_id,
    });
    return;
  }

  // 1) هل المسؤول في منتصف عملية (قوانين/ترحيب/رد)؟
  const state = await getAdminState(env, chatId, userId);
  if (state) {
    const handled = await handleAdminStateInput(env, group, chatId, userId, msg, state);
    if (handled) return;
  }

  // 2) رد المسؤول برقم على "قائمة الردود"
  if (msg.reply_to_message) {
    const handled = await handleReplyListSelection(env, group, chatId, msg);
    if (handled) return;
  }

  // 3) قائمة الأوامر
  if (senderIsAdmin && COMMANDS_MENU_TRIGGERS.includes(text)) {
    await sendMessage(env, chatId, "اختر القسم الذي تريده 👇", {
      reply_markup: kbCommandsMenu(),
      reply_to_message_id: msg.message_id,
    });
    await saveGroup(env, group);
    return;
  }

  // 4) أوامر العقوبات
  const punishMatch = matchCommandWithTarget(text, PUNISH_COMMANDS);
  if (senderIsAdmin && punishMatch) {
    const handled = await handlePunishCommand(env, group, chatId, msg, punishMatch.command, actorRole, punishMatch.reference);
    if (!handled) {
      await sendMessage(env, chatId, "⚠️ تعذّر تنفيذ هذا الأمر.", { reply_to_message_id: msg.message_id });
    }
    return;
  }

  // 4ب) أمر الإنذار
  const warnMatch = matchCommandWithTarget(text, WARN_COMMANDS);
  if (senderIsAdmin && warnMatch) {
    await handleWarnCommand(env, group, chatId, msg, actorRole, warnMatch.reference);
    return;
  }

  // 4ج) أوامر المسح السريعة (مسح المكتومين / المحظورين / المقيدين / الادمنية / المميزين / المدراء)
  if (senderIsAdmin && QUICK_CLEAR_COMMANDS.includes(text)) {
    await handleQuickClearCommand(env, group, chatId, msg, actorRole, text);
    return;
  }

  // 5) التنظيف (مسح / مسح 100)
  if (senderIsAdmin && /^مسح(\s+\d+)?$/.test(text)) {
    const handled = await handleClearCommand(env, group, chatId, msg, text);
    if (handled) return;
  }

  // 6) قوائم المكتومين / المقيدين / المحظورين
  if (senderIsAdmin && LIST_COMMANDS.includes(text)) {
    const handled = await handleListCommand(env, group, chatId, msg, text);
    if (handled) return;
  }

  // الرتب الخاصة بالبــوت (مدير، ادمن، مميز)
  const roleTargetMatch = text.match(/^(رفع|تنزيل)\s+(مدير|مشرف|ادمن|أدمن|مميز)(?:\s+(.+))?$/);
  const demoteAllMatch = text.match(/^تنزيل الكل(?:\s+(.+))?$/);
  if (senderIsAdmin && (ROLE_COMMANDS.includes(text) || roleTargetMatch || demoteAllMatch)) {
    const handled = await handleRoleCommand(
      env,
      group,
      chatId,
      msg,
      demoteAllMatch ? "تنزيل الكل" : roleTargetMatch ? `${roleTargetMatch[1]} ${roleTargetMatch[2]}` : text,
      actorRole,
      demoteAllMatch ? demoteAllMatch[1] || null : roleTargetMatch?.[3] || null,
    );
    if (handled) return;
  }

  // 7) أوامر الإعدادات (قوانين/ترحيب/رد)
  if (SETTINGS_COMMANDS.includes(text) && !canUseSettings(actorRole)) {
    if (senderIsAdmin) {
      await sendMessage(env, chatId, "- للمدراء والمالك فقط !", {
        reply_to_message_id: msg.message_id,
      });
      return;
    }
  }
  if (canUseSettings(actorRole) && SETTINGS_COMMANDS.includes(text)) {
    const handled = await handleSettingsCommand(env, group, chatId, userId, msg, text);
    if (handled) return;
  }

  // 8) أوامر القفل / الفتح
  if (canManageLocks) {
    const lockMatch = text.match(/^(قفل|فتح)\s+(.+)$/);
    if (lockMatch) {
      const handled = await handleLockCommand(env, group, chatId, msg, lockMatch[1], lockMatch[2].trim());
      if (handled) return;
    }
  }

  // 9) أوامر التفعيل / التعطيل (الترحيب - القوانين)
  if (canUseToggles(actorRole)) {
    const toggleMatch = text.match(/^(تفعيل|تعطيل)\s+(.+)$/);
    if (toggleMatch) {
      const handled = await handleToggleCommand(env, group, chatId, msg, toggleMatch[1], toggleMatch[2].trim());
      if (handled) return;
    }
  }

  await saveGroup(env, group); // حفظ recentMessageIds المحدثة

  // 10) الردود التلقائية (متاحة لأي عضو)
  await tryAutoReply(env, group, chatId, msg);
}

// ==================== معالجة الرسائل الخاصة (Private) ====================

async function handlePrivateMessage(env, msg) {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const text = (msg.text || "").trim();

  if (text === "/start") {
    if (isDev(env, userId)) {
      await sendMessage(env, chatId, TXT.startDev, { reply_markup: kbDevStart() });
    } else {
      const info = await getBotInfo(env);
      const startText = await getStartText(env);
      await sendMessage(env, chatId, escapeHtml(startText), { reply_markup: kbUserStart(info?.username) });
    }
    return;
  }

  if (isDev(env, userId)) {
    const handled = await handleDevPrivateMessage(env, msg);
    if (handled) return;
  }
}

async function handleRolePermissionCallback(env, group, cq, role, id, permission = null) {
  const chatId = cq.message.chat.id;
  const actorRole = await getActorRole(env, group, chatId, cq.from.id, cq.message);
  const target = findRoleEntry(group, role, id);
  if (!target) {
    await answerCallback(env, cq.id, "لم تعد هذه الرتبة موجودة.", true);
    return true;
  }
  if (actorRole === role || !canManageAssignedRole(actorRole, role)) {
    await answerCallback(env, cq.id, "✗ لا يمكنك تعديل صلاحيات هذه الرتبة.", true);
    return true;
  }
  const actorEntry = findRoleEntry(group, actorRole, cq.from.id);
  if (!roleActionPermission(actorRole, actorEntry, "promote")) {
    await answerCallback(env, cq.id, "✗ انت ممنوع من هذا الأمر.", true);
    return true;
  }

  if (permission) {
    target.permissions[permission] = target.permissions[permission] === false;
    await saveGroup(env, group);
    await answerCallback(env, cq.id, "تم تحديث الصلاحية");
  } else {
    await answerCallback(env, cq.id);
  }

  await editMessageText(
    env,
    chatId,
    cq.message.message_id,
    `✦ وضع قيود لل${rolePermissionText(role)}\n👤 المستخدم: ${linkedUserHtml(target)}\n\nاضغط على الأمر لتفعيله أو تعطيله:`,
    { reply_markup: kbRolePermissions(role, target.id, target.permissions) },
  );
  return true;
}

// ==================== معالجة استعلامات الأزرار (Callback Query) ====================

async function handleCallbackQuery(env, cq) {
  const data = cq.data;
  const chat = cq.message.chat;
  const userId = cq.from.id;

  // أزرار المطور في الخاص
  if (chat.type === "private" && isDev(env, userId)) {
    const handled = await handleDevCallback(env, cq);
    if (handled) return;
  }

  // أزرار داخل المجموعة (تتطلب صلاحية إشراف)
  if (chat.type !== "private") {
    const group = await getGroup(env, chat.id);
    if (!group || !group.active) {
      await answerCallback(env, cq.id, "الكروب غير مفعّل.", true);
      return;
    }
    const senderRole = await getActorRole(env, group, chat.id, userId, cq.message);
    const senderIsAdmin = canModerate(senderRole);
    if (!senderIsAdmin) {
      await answerCallback(env, cq.id, "هذا الزر مخصص للمشرفين فقط.", true);
      return;
    }

    if (data.startsWith("role_perms:")) {
      const [, role, id] = data.split(":");
      return handleRolePermissionCallback(env, group, cq, role, id);
    }
    if (data.startsWith("warn_act:")) {
      const [, action, targetId] = data.split(":");
      return handleWarnActionCallback(env, group, chat.id, cq, senderRole, action, targetId);
    }
    if (data.startsWith("roleperm:")) {
      const [, role, id, permission] = data.split(":");
      return handleRolePermissionCallback(env, group, cq, role, id, permission);
    }
    if (data === "managers_clear") {
      if (senderRole !== "owner") {
        await answerCallback(env, cq.id, "✗ هذا الزر للمالك فقط.", true);
        return;
      }
      group.managers = [];
      await saveGroup(env, group);
      await answerCallback(env, cq.id, "🗑 تم مسح جميع المدراء.", true);
      await sendRoleList(env, group, chat.id, "manager", null, { chatId: chat.id, messageId: cq.message.message_id });
      return;
    }
    if (data === "admins_clear") {
      if (!["owner", "manager"].includes(senderRole)) {
        await answerCallback(env, cq.id, "✗ هذا الزر للمدراء والمالك فقط.", true);
        return;
      }
      const actorEntry = findRoleEntry(group, senderRole, userId);
      if (!roleActionPermission(senderRole, actorEntry, "promote")) {
        await answerCallback(env, cq.id, "✗ انت ممنوع من هذا الأمر.", true);
        return;
      }
      group.admins = [];
      await saveGroup(env, group);
      await answerCallback(env, cq.id, "🗑 تم مسح جميع الادمنية.", true);
      await sendRoleList(env, group, chat.id, "admin", null, { chatId: chat.id, messageId: cq.message.message_id });
      return;
    }
    if (data === "specials_clear") {
      if (!["owner", "manager", "admin"].includes(senderRole)) {
        await answerCallback(env, cq.id, "✗ هذا الزر للادمنية والمدراء والمالك فقط.", true);
        return;
      }
      const actorEntry = findRoleEntry(group, senderRole, userId);
      if (!roleActionPermission(senderRole, actorEntry, "promote")) {
        await answerCallback(env, cq.id, "✗ انت ممنوع من هذا الأمر.", true);
        return;
      }
      group.specialMembers = [];
      await saveGroup(env, group);
      await answerCallback(env, cq.id, "🗑 تم مسح جميع المميزين.", true);
      await sendRoleList(env, group, chat.id, "special", null, { chatId: chat.id, messageId: cq.message.message_id });
      return;
    }
    if (data.startsWith("role_list:")) {
      const role = data.split(":")[1];
      if (role === "manager" && senderRole !== "owner") {
        await answerCallback(env, cq.id, "✗ هذا الأمر للمالك فقط.", true);
        return;
      }
      if (role === "admin" && !["owner", "manager"].includes(senderRole)) {
        await answerCallback(env, cq.id, "✗ هذا الأمر للمدراء والمالك فقط.", true);
        return;
      }
      await answerCallback(env, cq.id);
      await sendRoleList(env, group, chat.id, role, null, { chatId: chat.id, messageId: cq.message.message_id });
      return;
    }

    if (data === "menu_punish") {
      await answerCallback(env, cq.id);
      await editMessageText(env, chat.id, cq.message.message_id, TXT.punishCliche, { reply_markup: kbBack() });
      return;
    }
    if (data === "menu_group") {
      await answerCallback(env, cq.id);
      await editMessageText(env, chat.id, cq.message.message_id, "• أوامر الكروب — اختر ↓", {
        reply_markup: kbGroupMenu(),
      });
      return;
    }
    if (data === "menu_group_lock") {
      await answerCallback(env, cq.id);
      await editMessageText(env, chat.id, cq.message.message_id, TXT.lockCliche, {
        reply_markup: kbBackTo("menu_group"),
      });
      return;
    }
    if (data === "menu_group_toggle") {
      if (!canUseToggles(senderRole)) {
        await answerCallback(env, cq.id, "للمدراء والمالك فقط!", true);
        return;
      }
      await answerCallback(env, cq.id);
      await editMessageText(env, chat.id, cq.message.message_id, TXT.toggleCliche, {
        reply_markup: kbBackTo("menu_group"),
      });
      return;
    }
    if (data === "menu_roles") {
      await answerCallback(env, cq.id);
      await editMessageText(
        env,
        chat.id,
        cq.message.message_id,
        "✦ اوامر الترقية\n\n" +
          "• رفع - تنزيل ↢ مشرف أو ادمن\n" +
          "• رفع - تنزيل ↢ مدير\n" +
          "• رفع - تنزيل ↢ مميز\n" +
          "• المدراء ↢ يعرض المدراء الموجودين\n" +
          "• الادمنية ↢ يعرض الادمنية الموجودين\n" +
          "• المميزين ↢ يعرض المميزين الموجودين",
        { reply_markup: kbRoleLists() },
      );
      return;
    }
    if (data === "menu_rules_welcome") {
      if (!canUseSettings(senderRole)) {
        await answerCallback(env, cq.id, "للمدراء والمالك فقط!", true);
        return;
      }
      await answerCallback(env, cq.id);
      await editMessageText(
        env,
        chat.id,
        cq.message.message_id,
        "┃ ✦ أوامر القوانين والترحيب\n" +
          "┃ ✧ وضع قوانين ➖ مسح قوانين ➖ القوانين\n" +
          "┃ ✧ وضع ترحيب ➖ مسح ترحيب",
        { reply_markup: kbBack() }
      );
      return;
    }
    if (data === "menu_autoreply") {
      if (!canUseSettings(senderRole)) {
        await answerCallback(env, cq.id, "للمدراء والمالك فقط!", true);
        return;
      }
      await answerCallback(env, cq.id);
      await editMessageText(
        env,
        chat.id,
        cq.message.message_id,
        "┃ ✦ أوامر الردود التلقائية\n" + "┃ ✧ وضع رد ➖ مسح رد",
        { reply_markup: kbBack() }
      );
      return;
    }
    if (data === "menu_info") {
      await answerCallback(env, cq.id);
      await editMessageText(
        env,
        chat.id,
        cq.message.message_id,
        `ℹ️ عدد المشرفين المسجلين: ${group.adminsCount}\n🔇 مكتومين: ${group.muted.length}\n🚧 مقيدين: ${group.restricted.length}`,
        { reply_markup: kbBack() }
      );
      return;
    }
    if (data === "menu_back") {
      await answerCallback(env, cq.id);
      await editMessageText(env, chat.id, cq.message.message_id, "اختر القسم الذي تريده 👇", {
        reply_markup: kbCommandsMenu(),
      });
      return;
    }
    if (data === "unmute_all") {
      if (!group.muted.length) {
        await answerCallback(env, cq.id, "القائمة فارغة !", true);
        return;
      }
      await answerCallback(env, cq.id);
      await handleUnmuteAll(env, group, chat.id);
      return;
    }
    if (data === "unrestrict_all") {
      if (!group.restricted.length) {
        await answerCallback(env, cq.id, "القائمة فارغة !", true);
        return;
      }
      await answerCallback(env, cq.id);
      await handleUnrestrictAll(env, group, chat.id);
      return;
    }
    if (data === "unban_all") {
      if (!group.banned.length) {
        await answerCallback(env, cq.id, "القائمة فارغة !", true);
        return;
      }
      await answerCallback(env, cq.id);
      await handleUnbanAll(env, group, chat.id);
      return;
    }
    if (data.startsWith("rep_editmenu:")) {
      if (!canUseSettings(senderRole)) {
        await answerCallback(env, cq.id, "للمدراء والمالك فقط!", true);
        return;
      }
      const id = data.split(":")[1];
      await answerCallback(env, cq.id);
      await sendMessage(env, chat.id, "اختر ما تريد تعديله:", { reply_markup: kbReplyEditChoice(id) });
      return;
    }
    if (data.startsWith("rep_edittrigger:")) {
      if (!canUseSettings(senderRole)) {
        await answerCallback(env, cq.id, "للمدراء والمالك فقط!", true);
        return;
      }
      const id = data.split(":")[1];
      await setAdminState(env, chat.id, userId, { action: "awaiting_edit_reply_trigger", data: { id } });
      await answerCallback(env, cq.id);
      await sendMessage(env, chat.id, TXT.askEditReplyTrigger);
      return;
    }
    if (data.startsWith("rep_editcontent:")) {
      if (!canUseSettings(senderRole)) {
        await answerCallback(env, cq.id, "للمدراء والمالك فقط!", true);
        return;
      }
      const id = data.split(":")[1];
      await setAdminState(env, chat.id, userId, { action: "awaiting_edit_reply_content", data: { id } });
      await answerCallback(env, cq.id);
      await sendMessage(env, chat.id, TXT.askEditReplyContent);
      return;
    }
    if (data.startsWith("rep_del:")) {
      if (!canUseSettings(senderRole)) {
        await answerCallback(env, cq.id, "للمدراء والمالك فقط!", true);
        return;
      }
      const id = data.split(":")[1];
      group.replies = group.replies.filter((r) => r.id !== id);
      await saveGroup(env, group);
      await answerCallback(env, cq.id, "تم الحذف ✅");
      await sendMessage(env, chat.id, "🗑 تم حذف الرد بنجاح.");
      return;
    }
  }

  await answerCallback(env, cq.id);
}

// ==================== تحديث حالة أي عضو في الكروب (chat_member) ====================
// بخلاف my_chat_member (خاص بالبوت نفسه)، هذا يصل عن أي عضو آخر عند انضمامه أو
// تغيّر حالته. نستخدمه لتخزين بياناته (آيديه ويوزره) حتى لو لم يكتب أي رسالة أبداً،
// فيصبح بالإمكان استهدافه لاحقاً بأوامر العقوبات عبر يوزره أو آيديه.
async function handleChatMemberUpdate(env, update) {
  const chat = update.chat;
  const user = update.new_chat_member?.user;
  if (!chat || !user) return;

  const botId = await getBotId(env);
  if (user.id === botId) return; // حالة البوت نفسه تُعالَج عبر my_chat_member

  const group = await getGroup(env, chat.id);
  if (!group || !group.active) return;

  rememberKnownUser(group, user);
  await saveGroup(env, group);
}

// ==================== تحديث حالة العضوية (my_chat_member) ====================
// يُستخدم لاكتشاف لحظة ترقية البوت إلى مشرف، فنكمل تفعيل الكروب تلقائياً

async function handleMyChatMember(env, update) {
  const chat = update.chat;
  const newStatus = update.new_chat_member?.status;
  const botId = await getBotId(env);
  if (update.new_chat_member?.user?.id !== botId) return;

  const pending = await getPendingActivation(env, chat.id);
  if (pending && (newStatus === "administrator")) {
    await finalizeActivation(env, chat.id, chat.title);
    await sendMessage(env, pending.devChatId, `✅ تم تفعيل الكروب ( ${chat.title} ) تلقائياً بعد ترقية البوت.`);
  }

  // لو أزيل البوت من الكروب، نعطّل الحماية تلقائياً (لكن نُبقي البيانات محفوظة لإعادة التفعيل لاحقاً)
  if (newStatus === "left" || newStatus === "kicked") {
    const group = await getGroup(env, chat.id);
    if (group) {
      group.active = false;
      await saveGroup(env, group);
    }
  }
}

// ==================== نقطة الدخول الرئيسية (fetch) ====================

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // نقطة مساعدة لربط الويبهوك تلقائياً بزيارة الرابط من المتصفح
    if (request.method === "GET" && url.pathname === "/set-webhook") {
      const webhookUrl = `${url.origin}/webhook/${env.WEBHOOK_SECRET || ""}`;
      const res = await tg(env, "setWebhook", {
        url: webhookUrl,
        allowed_updates: ["message", "edited_message", "callback_query", "my_chat_member", "chat_member"],
      });
      return jsonResponse({ webhookUrl, result: res });
    }

    // نقطة تشخيص: تعرض حالة الويبهوك الحالية من تيليجرام (آخر خطأ، عدد التحديثات المعلّقة...)
    // محمية بمعامل ?key= يجب أن يطابق WEBHOOK_SECRET
    if (request.method === "GET" && url.pathname === "/debug/webhook-info") {
      if (env.WEBHOOK_SECRET && url.searchParams.get("key") !== env.WEBHOOK_SECRET) {
        return new Response("Forbidden", { status: 403 });
      }
      const res = await tg(env, "getWebhookInfo", {});
      return jsonResponse(res);
    }

    // نقطة تشخيص: تعرض بيانات كروب معيّن كما هي مخزّنة في KV (مفيدة للتأكد من التفعيل)
    // مثال: /debug/group?id=-1001234567890&key=WEBHOOK_SECRET
    if (request.method === "GET" && url.pathname === "/debug/group") {
      if (env.WEBHOOK_SECRET && url.searchParams.get("key") !== env.WEBHOOK_SECRET) {
        return new Response("Forbidden", { status: 403 });
      }
      const chatId = url.searchParams.get("id");
      if (!chatId) return jsonResponse({ error: "أضف ?id=CHAT_ID في الرابط" }, 400);
      const group = await getGroup(env, chatId);
      return jsonResponse(group || { error: "لا توجد بيانات لهذا الكروب" });
    }

    if (request.method === "GET") {
      return new Response("Telegram Group Guard Bot is running.", { status: 200 });
    }

    if (request.method !== "POST") {
      return new Response("Not found", { status: 404 });
    }

    // حماية الويبهوك بكلمة سرية في المسار
    if (env.WEBHOOK_SECRET) {
      const expectedPath = `/webhook/${env.WEBHOOK_SECRET}`;
      if (url.pathname !== expectedPath) {
        return new Response("Forbidden", { status: 403 });
      }
    }

    let update;
    try {
      update = await request.json();
    } catch (e) {
      return new Response("Bad Request", { status: 400 });
    }

    try {
      if (update.message) {
        const msg = update.message;
        if (msg.chat.type === "private") {
          await handlePrivateMessage(env, msg);
        } else {
          await handleGroupMessage(env, msg);
        }
      } else if (update.callback_query) {
        await handleCallbackQuery(env, update.callback_query);
      } else if (update.my_chat_member) {
        await handleMyChatMember(env, update.my_chat_member);
      } else if (update.chat_member) {
        await handleChatMemberUpdate(env, update.chat_member);
      } else if (update.edited_message) {
        await handleEditedGroupMessage(env, update.edited_message);
      }
    } catch (err) {
      console.log("HANDLER_ERROR", err && err.stack ? err.stack : String(err));
    }

    return new Response("OK", { status: 200 });
  },
};
