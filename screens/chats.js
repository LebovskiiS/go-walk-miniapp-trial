// Вкладка «Чаты» (KAN-509): список диалогов с клиентами и переписка с ними.
// Поддержка закреплена первой строкой списка (сам экран — support.js). Новое
// подтягиваем опросом, пока экран открыт; уведомления по-прежнему шлёт бот.
import { api } from "../api.js";
import {
  SPINNER, esc, fmtWhen, haptic, registerActions, registerOverlay,
  registerScreen, render, state, stateBlock, tg,
} from "../core.js";
import {
  ACTIONS as KIT_ACTIONS, MAX_TEXT, POLL_LIST_MS, POLL_OPEN_MS, bubbles, clearDraft,
  composer, draft, newClientId, photoPicker, poller, rerender,
} from "./chatkit.js";
import { shrink } from "./walk.js";
import { openSupport, supportRow } from "./support.js";

const LIST_LIMIT = 50;
const PAGE = 50; // сообщений на страницу истории

const TYPE_LABEL = { urgent: "Экспресс-выгул", booked: "Выгул", boarding: "Передержка" };
const STATUS_LABEL = {
  proposed: "предложен", dispatching: "ищем ситтера", accepted: "принят",
  on_the_way: "вы в пути", walking: "идёт", completed: "завершён", cancelled: "отменён",
};

const list = { items: [], loading: false, error: null, loaded: false };
// открытая переписка; null — показываем список
let chat = null; // {conv, items, pending, hasOlder, loading, error, busy, notice}

const myId = () => state.profile?.user_id;

// --- список --------------------------------------------------------------------

async function loadList() {
  const first = !list.loaded;
  if (first) {
    list.loading = true;
    render();
  }
  try {
    list.items = await api("GET", `/chats?limit=${LIST_LIMIT}`);
    list.error = null;
    list.loaded = true;
  } catch (err) {
    // упавший фоновый опрос не прячет уже показанный список
    if (!list.loaded) list.error = err.message;
  }
  list.loading = false;
  if (state.tab === "chats" && !chat) render();
}

const listPoll = poller(POLL_LIST_MS, () => state.tab === "chats", async () => {
  if (!chat) await loadList();
});

function avatar(url, name) {
  const letter = esc((name || "?").trim().charAt(0).toUpperCase());
  return url
    ? `<img class="avatar" src="${esc(url)}" alt="">`
    : `<div class="avatar avatar-empty">${letter}</div>`;
}

function orderLine(order) {
  if (!order) return "";
  const status = order.status === "completed" || order.status === "cancelled"
    ? STATUS_LABEL[order.status]
    : fmtWhen(order.scheduled_at);
  return `${TYPE_LABEL[order.type] || "Заказ"} · ${status}`;
}

function listView() {
  // на вкладку попали не кликом (ссылка ?tab=chats) — open() не звали, грузим сами
  if (!list.loaded && !list.loading && !list.error) {
    listPoll.start();
    loadList();
  }
  if (list.loading) return SPINNER;
  if (list.error) return stateBlock("⚠️", "Не получилось загрузить чаты", list.error, "chats-reload", "Повторить");
  const rows = list.items
    .map((conv) => {
      const unread = conv.unread_count
        ? `<span class="unread">${conv.unread_count > 99 ? "99+" : conv.unread_count}</span>`
        : "";
      const preview = conv.last_message_text ?? (conv.last_message_at ? "📷 Фото" : "Сообщений пока нет");
      return `<button class="chat-row" data-act="chat-open" data-id="${esc(conv.id)}">
        ${avatar(conv.peer_avatar_url, conv.peer_name)}
        <span class="chat-row-body">
          <span class="chat-row-top"><b>${esc(conv.peer_name || "Клиент")}</b>
            <span class="muted">${esc(fmtWhen(conv.last_message_at))}</span></span>
          <span class="chat-row-bottom"><span class="muted ellipsis">${esc(preview)}</span>${unread}</span>
        </span></button>`;
    })
    .join("");
  const empty = list.items.length
    ? ""
    : `<p class="muted center">Переписки с клиентами пока нет. Написать клиенту можно из карточки заказа.</p>`;
  return `<section class="chats">${supportRow()}${rows}${empty}</section>`;
}

// --- переписка -----------------------------------------------------------------

function toItem(m) {
  return {
    id: m.id,
    side: m.sender_id === myId() ? "mine" : "theirs",
    text: m.text,
    photos: m.photo_url ? [m.photo_url] : [],
    at: m.created_at,
  };
}

function merge(messages) {
  // опрос и ответ на отправку могут принести одно и то же сообщение
  const known = new Set(chat.items.map((item) => item.id));
  for (const m of messages) if (!known.has(m.id)) chat.items.push(toItem(m));
  chat.items.sort((a, b) => a.id - b.id);
}

const lastId = () => (chat.items.length ? chat.items[chat.items.length - 1].id : 0);

async function openChat(conv) {
  chat = { conv, items: [], pending: [], hasOlder: false, loading: true, error: null, busy: false, notice: null };
  render();
  try {
    const page = await api("GET", `/chats/${conv.id}/messages?latest=true&limit=${PAGE}`);
    if (chat?.conv.id !== conv.id) return;
    merge(page);
    chat.hasOlder = page.length === PAGE;
    // latest=true помечает диалог прочитанным — гасим бейдж в списке сразу
    conv.unread_count = 0;
  } catch (err) {
    if (chat?.conv.id !== conv.id) return;
    chat.error = err.message;
  }
  chat.loading = false;
  rerender("bottom");
  chatPoll.start();
}

const chatPoll = poller(POLL_OPEN_MS, () => chat !== null, async () => {
  const conv = chat.conv;
  const fresh = await api("GET", `/chats/${conv.id}/messages?after_id=${lastId()}&limit=${PAGE}`);
  if (chat?.conv.id !== conv.id || !fresh.length) return;
  merge(fresh);
  rerender("keep");
});

function closeChat() {
  chat = null;
  chatPoll.stop();
  loadList(); // превью и непрочитанное могли измениться, пока переписка была открыта
}

async function loadOlder() {
  chat.busy = true;
  render();
  try {
    const page = await api("GET", `/chats/${chat.conv.id}/messages?before_id=${chat.items[0].id}&limit=${PAGE}`);
    merge(page);
    chat.hasOlder = page.length === PAGE;
  } catch (err) {
    chat.notice = err.message;
  }
  chat.busy = false;
  rerender("older");
}

async function send(makeRequest, preview) {
  // пока ждём ответ, сообщение уже на экране — бледным, со «отправляется…»
  const conv = chat.conv;
  chat.pending.push(preview);
  chat.busy = true;
  chat.notice = null;
  rerender("bottom");
  try {
    const message = await makeRequest();
    if (chat?.conv.id === conv.id) merge([message]);
    haptic("success");
  } catch (err) {
    if (chat?.conv.id === conv.id) chat.notice = err.message;
    haptic("error");
  }
  if (chat?.conv.id !== conv.id) return;
  chat.pending = chat.pending.filter((item) => item !== preview);
  chat.busy = false;
  rerender("bottom");
}

function sendText() {
  const text = draft("chat").trim();
  if (!text || chat.busy) return;
  if (text.length > MAX_TEXT) {
    chat.notice = `Сообщение длиннее ${MAX_TEXT} символов — разбейте на части.`;
    return;
  }
  clearDraft("chat");
  // client_message_id: повтор после таймаута вернёт то же сообщение, а не второе
  const body = { text, client_message_id: newClientId() };
  return send(
    () => api("POST", `/chats/${chat.conv.id}/messages`, body),
    { id: "pending", side: "mine", text, photos: [], at: new Date().toISOString(), pending: true },
  );
}

function sendPhoto([file]) {
  // одно фото за отправку — так устроена ручка ядра (KAN-478)
  if (!chat || chat.busy) return;
  const caption = draft("chat").trim().slice(0, MAX_TEXT);
  clearDraft("chat");
  const conv = chat.conv;
  const clientMessageId = newClientId();
  return send(
    async () => {
      // ужимаем как фото прогулки (KAN-459): камера отдаёт 5–12 МБ при пределе ядра 10
      const form = new FormData();
      form.append("file", await shrink(file));
      form.append("text", caption);
      form.append("client_message_id", clientMessageId);
      return api("POST", `/chats/${conv.id}/messages/photo`, form);
    },
    { id: "pending", side: "mine", text: caption ? `📷 ${caption}` : "📷 Фото", photos: [],
      at: new Date().toISOString(), pending: true },
  );
}

function chatHead(conv) {
  const rating = conv.peer_rating ? ` · ★ ${esc(Number(conv.peer_rating).toFixed(1))}` : "";
  const order = conv.order
    ? `<div class="chat-order">${esc(orderLine(conv.order))}${
        conv.order.address_short ? ` · ${esc(conv.order.address_short)}` : ""}</div>`
    : "";
  return `<header class="chat-head">${avatar(conv.peer_avatar_url, conv.peer_name)}
    <div><b>${esc(conv.peer_name || "Клиент")}</b><span class="muted">${rating}</span>${order}</div></header>`;
}

function chatView() {
  const { conv } = chat;
  if (chat.loading) return `${chatHead(conv)}${SPINNER}`;
  if (chat.error) {
    return `${chatHead(conv)}${stateBlock("⚠️", "Не получилось открыть переписку", chat.error, "chat-retry", "Повторить")}`;
  }
  const older = chat.hasOlder
    ? `<button class="btn ghost small" data-act="chat-older" ${chat.busy ? "disabled" : ""}>Показать раньше</button>`
    : "";
  const empty = chat.items.length || chat.pending.length
    ? ""
    : `<p class="muted center">Сообщений пока нет — напишите первым.</p>`;
  const notice = chat.notice ? `<div class="notice error">${esc(chat.notice)}</div>` : "";
  return `<section class="chat">${chatHead(conv)}${older}${empty}
    <div class="msgs">${bubbles([...chat.items, ...chat.pending])}</div>${notice}
    ${composer({ key: "chat", placeholder: "Сообщение клиенту", busy: chat.busy })}
  </section>`;
}

// «Написать клиенту» из карточки заказа: <button data-act="chat-with" data-client="<client_id>">.
// Ядро пускает ситтера только к клиенту, с которым его связывает заказ или
// предложение (KAN-422); диалог один на пару — повторный вызов вернёт тот же.
async function chatWith({ client }) {
  state.busy = true;
  render();
  try {
    const conv = await api("POST", `/chats/with/${client}`);
    state.busy = false;
    // назад из переписки — туда, откуда пришли (карточка заказа), а вкладка под
    // ней уже «Чаты»: список подтянется, когда закроют и карточку
    state.tab = "chats";
    listPoll.start();
    await openChat(conv);
  } catch (err) {
    // кнопка живёт в карточке заказа, где своего места под ошибку нет — всплывашкой
    state.busy = false;
    haptic("error");
    render();
    if (tg?.showAlert) tg.showAlert(err.message);
    else window.alert(err.message);
  }
}

registerScreen({
  key: "chats",
  label: "💬 Чаты",
  view: listView,
  open: () => {
    listPoll.start();
    return loadList();
  },
});

registerOverlay({ isOpen: () => chat !== null, view: chatView, close: closeChat });

registerActions({
  ...KIT_ACTIONS,
  "chats-reload": () => loadList(),
  "chat-open": ({ id }) => {
    const conv = list.items.find((item) => item.id === id);
    if (conv) return openChat(conv);
  },
  "chat-retry": () => openChat(chat.conv),
  "chat-older": () => loadOlder(),
  "chat-send": () => sendText(),
  "chat-pick": photoPicker({ multiple: false, onFiles: sendPhoto }),
  "chat-with": chatWith,
  "support-open": () => openSupport(),
});
