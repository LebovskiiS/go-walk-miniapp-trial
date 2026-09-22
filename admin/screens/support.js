// «Обращения» — рабочее место оператора, как в @bosupport_bot (KAN-359/360/361):
// список диалогов («Имя Фамилия · ID», кто — клиент/ситтер, ждёт ответа),
// переписка, ответ текстом и фото (до пяти), «Завершить диалог» → архив.
// Курсор доставки бота (/admin/support/incoming/delivered) не трогаем: бот
// продолжает присылать уведомления о новых сообщениях.
import { api } from "../../api.js";
import {
  SPINNER, esc, fmtWhen, haptic, registerActions, registerOverlay, registerScreen, render, stateBlock,
} from "../../core.js";
import {
  ACTIONS as KIT_ACTIONS, POLL_LIST_MS, POLL_OPEN_MS, bubbles, clearDraft, composer, draft,
  photoPicker, poller, rerender,
} from "../../screens/chatkit.js";
import { shrink } from "../../screens/walk.js";
import { USER_KIND, label, listState, who } from "../kit.js";

const MAX_PHOTOS = 5;
const PAGE = 200; // ручка отдаёт последние N (desc → reversed), не первые

const list = { items: [], loading: false, error: null, loaded: false };
let chat = null; // {conv, items, pending, loading, error, busy, notice, closing, archived}

// --- список --------------------------------------------------------------------

async function loadList() {
  if (!list.loaded) {
    list.loading = true;
    render();
  }
  try {
    list.items = await api("GET", "/admin/support/conversations?limit=100");
    list.error = null;
    list.loaded = true;
  } catch (err) {
    list.error = err.message;
  }
  list.loading = false;
  render();
}

const listPoll = poller(POLL_LIST_MS, () => chat === null, loadList);

function listView() {
  const empty = listState(list, "Обращений нет — все диалоги закрыты.");
  if (empty) return `<section class="list"><h2>Обращения</h2>${empty}</section>`;
  const rows = list.items
    .map(
      (c) => `<button class="card row item-link" data-act="support-open" data-user="${esc(c.user_id)}">
        <span><b>${esc(who(c.user_name, c.user_id))}</b>
          <span class="muted">${esc(label(USER_KIND, c.user_kind))} · ${esc(fmtWhen(c.last_message_at))}</span>
          <span class="muted">${esc(c.last_message_text.slice(0, 80))}</span></span>
        ${c.needs_reply ? `<span class="badge express">ждёт</span>` : ""}</button>`,
    )
    .join("");
  return `<section class="list"><h2>Обращения</h2>${rows}</section>`;
}

// --- переписка ------------------------------------------------------------------

function toItem(m) {
  if (m.author === "system") return { id: m.id, side: "system", text: m.text, photos: [], at: m.created_at };
  return {
    id: m.id,
    side: m.author === "support" ? "mine" : "theirs",
    author: m.author === "support" ? (m.mine ? null : m.author_name || "Поддержка") : null,
    text: m.order_id ? `[заказ №${String(m.order_id).slice(0, 8)}] ${m.text}` : m.text,
    photos: m.photos.map((p) => p.url),
    at: m.created_at,
  };
}

async function loadChat() {
  const userId = chat.conv.user_id;
  const archived = chat.archived ? "&archived=true" : "";
  const messages = await api("GET", `/admin/support/conversations/${userId}/messages?limit=${PAGE}${archived}`);
  if (!chat || chat.conv.user_id !== userId) return false;
  const last = (items) => (items.length ? items[items.length - 1].id : null);
  const changed = messages.length !== chat.items.length || last(messages) !== last(chat.items);
  chat.items = messages.map(toItem);
  return changed;
}

const chatPoll = poller(POLL_OPEN_MS, () => chat !== null, async () => {
  if (await loadChat()) rerender("keep");
});

async function openChat(userId) {
  const conv = list.items.find((c) => c.user_id === userId) ?? { user_id: userId, user_name: null, user_kind: null };
  chat = { conv, items: [], pending: [], loading: true, error: null, busy: false, notice: null, closing: false, archived: false };
  clearDraft(DRAFT); // черновик — на один диалог
  render();
  try {
    await loadChat();
  } catch (err) {
    if (chat) chat.error = err.message;
  }
  if (!chat) return;
  chat.loading = false;
  rerender("bottom");
  chatPoll.start();
}

function closeChat() {
  chat = null;
  chatPoll.stop();
  loadList();
}

const pendingItem = (text) => ({ id: "pending", side: "mine", text, photos: [], at: new Date().toISOString(), pending: true });

async function send(makeRequest, preview) {
  chat.pending.push(preview);
  chat.busy = true;
  chat.notice = null;
  rerender("bottom");
  try {
    await makeRequest();
    await loadChat();
    haptic("success");
  } catch (err) {
    if (chat) chat.notice = err.message;
    haptic("error");
  }
  if (!chat) return;
  chat.pending = chat.pending.filter((item) => item !== preview);
  chat.busy = false;
  rerender("bottom");
}

const DRAFT = "support";

async function sendText() {
  const text = draft(DRAFT).trim();
  if (!text || chat.busy) return;
  const userId = chat.conv.user_id;
  clearDraft(DRAFT);
  await send(() => api("POST", `/admin/support/conversations/${userId}/messages`, { text }), pendingItem(text));
}

const pick = photoPicker({
  multiple: true,
  onFiles: async (files) => {
    if (!chat || chat.busy) return;
    const userId = chat.conv.user_id;
    const text = draft(DRAFT).trim();
    clearDraft(DRAFT);
    const batch = files.slice(0, MAX_PHOTOS);
    await send(async () => {
      const form = new FormData();
      for (const file of batch) form.append("files", await shrink(file));
      if (text) form.append("text", text);
      await api("POST", `/admin/support/conversations/${userId}/messages/photo`, form);
    }, pendingItem(text || `📷 ${batch.length} фото`));
  },
});

async function closeConversation() {
  if (!chat || chat.busy) return;
  const userId = chat.conv.user_id;
  chat.busy = true;
  render();
  try {
    await api("POST", `/admin/support/conversations/${userId}/close`);
    haptic("success");
    closeChat();
    render();
    return;
  } catch (err) {
    if (chat) chat.notice = err.message;
    haptic("error");
  }
  if (chat) {
    chat.busy = false;
    chat.closing = false;
  }
  render();
}

function chatView() {
  const c = chat;
  const title = who(c.conv.user_name, c.conv.user_id);
  const sub = c.conv.user_kind ? label(USER_KIND, c.conv.user_kind) : "";
  const body = c.loading
    ? SPINNER
    : c.error
      ? stateBlock("⚠️", "Не открылась переписка", c.error, "support-retry", "Повторить")
      : `<div class="msgs">${bubbles([...c.items, ...c.pending]) || `<p class="muted center">Сообщений нет</p>`}</div>`;
  const closing = c.closing
    ? `<div class="card confirm"><p>Завершить диалог? Он уйдёт в архив, человек начнёт новый с чистого листа.</p>
        <div class="row gap"><button class="btn" data-act="support-close-yes" ${c.busy ? "disabled" : ""}>Завершить</button>
        <button class="btn ghost" data-act="support-close-no">Отмена</button></div></div>`
    : "";
  const off = c.busy || c.loading ? "disabled" : "";
  // архив (KAN-360): прошлые диалоги с этим человеком, только чтение
  const head = c.archived
    ? `<button class="btn ghost small" data-act="support-archive" data-on="0" ${off}>⬅️ К текущему</button>`
    : `<button class="btn ghost small" data-act="support-archive" data-on="1" ${off}>🗂 Прошлые</button>
       <button class="btn ghost small" data-act="support-close-ask" ${off}>Завершить</button>`;
  return `<section class="chat">
    <div class="chat-head"><div><b>${esc(title)}</b><div class="chat-order">${esc(c.archived ? "прошлые диалоги" : sub)}</div></div>${head}</div>
    ${closing}
    ${c.archived && !c.loading && !c.items.length ? `<p class="muted center">Прошлых диалогов с этим человеком нет.</p>` : body}
    ${c.notice ? `<div class="notice error">${esc(c.notice)}</div>` : ""}
    ${c.archived ? "" : composer({ key: DRAFT, placeholder: "Ответ от поддержки", busy: c.busy || c.loading })}
  </section>`;
}

registerOverlay({ isOpen: () => chat !== null, view: chatView, close: closeChat });

registerActions({
  ...KIT_ACTIONS,
  "support-open": ({ user }) => openChat(user),
  "support-retry": () => openChat(chat.conv.user_id),
  "support-close-ask": () => {
    chat.closing = true;
  },
  "support-close-no": () => {
    chat.closing = false;
  },
  "support-close-yes": closeConversation,
  "support-archive": async ({ on }) => {
    chat.archived = on === "1";
    chat.loading = true;
    chat.items = [];
    render();
    try {
      await loadChat();
    } catch (err) {
      chat.error = err.message;
    }
    chat.loading = false;
    rerender("bottom");
  },
  "support-send": () => sendText(),
  "support-pick": () => pick(),
});

registerScreen({
  key: "support",
  label: "Обращения",
  view: listView,
  open: () => {
    loadList();
    listPoll.start();
  },
});

export const openSupportChat = openChat;
