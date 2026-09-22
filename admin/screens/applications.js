// «Заявки» — модерация анкет ситтеров, как /pending в админ-боте (KAN-88/406/407/217):
// очередь анкет и очередь документов уже одобренных, карточка анкеты, документы
// (тап — во весь размер), решение по документу (принят / перезалить / отклонён),
// категория (кинолог — только при сертификате), вердикт, переписка по заявке.
//
// Вердикт ядро ситтеру не сообщает — в боте это делал сам админ-бот через токен
// основного бота. Здесь после вердикта шлём то же уведомление сообщением по
// заявке: оно уходит ситтеру через outbox основного бота (KAN-407).
import { api } from "../../api.js";
import {
  SPINNER, esc, fmtWhen, haptic, registerActions, registerOverlay, registerScreen, render, stateBlock,
} from "../../core.js";
import {
  ACTIONS as KIT_ACTIONS, POLL_OPEN_MS, bubbles, clearDraft, composer, draft, photoPicker, poller, rerender,
} from "../../screens/chatkit.js";
import { shrink } from "../../screens/walk.js";
import {
  CATEGORY, DOC_REVIEW, DOC_TYPE, askForm, kv, label, listState, notice, onAskCancel, when, who, yesNo,
} from "../kit.js";

const VERDICT_APPROVED =
  "Вашу анкету одобрили — можно принимать заказы.\n\nВключить приём — /work, поставить на паузу — /pause.";
const VERDICT_REJECTED =
  "К сожалению, заявку отклонили. Чаще всего причина — нечитаемые фото документов. Если считаете это ошибкой, напишите в поддержку.";
const VERDICT_NO_AVATAR =
  "Остался один шаг — фото профиля. Паспорт и селфи, которые вы присылали, видит только проверка; клиентам в списке и карточке показывают отдельное фото профиля, без него там инициалы.";
const CATEGORY_REASON = "модерация анкеты в админке";

const queue = { items: [], docs: [], loading: false, error: null, loaded: false };
let card = null; // {entry, documents, loading, error, busy, notice, verdict}
let chat = null; // {walkerId, name, items, pending, loading, error, busy, notice}

// --- очереди -----------------------------------------------------------------

async function loadQueue() {
  if (!queue.loaded) {
    queue.loading = true;
    render();
  }
  try {
    [queue.items, queue.docs] = await Promise.all([
      api("GET", "/walker/pending"),
      api("GET", "/walker/documents/review-queue"),
    ]);
    queue.error = null;
    queue.loaded = true;
  } catch (err) {
    queue.error = err.message;
  }
  queue.loading = false;
  render();
}

function queueView() {
  const empty = listState(queue, "Очередь пуста — новых анкет нет.");
  const rows = empty
    ? empty
    : queue.items
        .map(
          (e) => `<button class="card row item-link" data-act="appl-open" data-id="${esc(e.user_id)}">
        <span><b>${esc(who([e.name, e.last_name].filter(Boolean).join(" "), e.user_id))}</b>
          <span class="muted">${esc(label(CATEGORY, e.category))} · документов: ${e.documents_count} · ${esc(fmtWhen(e.created_at))}</span></span>
        <span class="badge offer">анкета</span></button>`,
        )
        .join("");
  // документы, которые дослали уже одобренные ситтеры (сертификат, перезалив)
  const docs = queue.docs.filter((d) => d.walker_status === "approved" && !d.review_status);
  const docRows = docs.length
    ? `<h2>Документы одобренных</h2>${docs
        .map(
          (d) => `<div class="card doc"><button class="msg-photo" data-act="photo-open" data-url="${esc(d.url)}">
            <img src="${esc(d.url)}" alt="" loading="lazy"></button>
          <div class="grow"><b>${esc(who(d.user_name, d.user_id))}</b>
            <div class="muted">${esc(label(DOC_TYPE, d.doc_type))} · ${esc(label(CATEGORY, d.category))} · ${esc(fmtWhen(d.created_at))}</div>
            ${docButtons(d.id, d.user_id)}</div></div>`,
        )
        .join("")}`
    : "";
  return `<section class="list"><h2>Заявки на проверку</h2>${rows}${docRows}</section>`;
}

const docButtons = (docId, walkerId, busy) => `<div class="chips tight">
  <button class="chip small" data-act="doc-review" data-doc="${esc(docId)}" data-walker="${esc(walkerId)}" data-decision="approved" ${busy ? "disabled" : ""}>✅ Принят</button>
  <button class="chip small" data-act="doc-review" data-doc="${esc(docId)}" data-walker="${esc(walkerId)}" data-decision="reupload" ${busy ? "disabled" : ""}>🔄 Перезалить</button>
  <button class="chip small" data-act="doc-review" data-doc="${esc(docId)}" data-walker="${esc(walkerId)}" data-decision="rejected" ${busy ? "disabled" : ""}>❌ Отклонён</button></div>`;

// --- карточка анкеты ------------------------------------------------------------

async function openCard(walkerId) {
  const entry = queue.items.find((e) => e.user_id === walkerId);
  if (!entry) return;
  card = { entry, documents: [], loading: true, error: null, busy: false, notice: null, verdict: null };
  render();
  try {
    card.documents = await api("GET", `/walker/${walkerId}/documents`);
  } catch (err) {
    card.error = err.message;
  }
  if (card?.entry.user_id !== walkerId) return;
  card.loading = false;
  render();
}

const hasCertificate = () => card.documents.some((d) => d.doc_type === "cynology_certificate");

function cardView() {
  const c = card;
  const e = c.entry;
  if (c.loading) return SPINNER;
  const cats = Object.entries(CATEGORY)
    .filter(([code]) => code !== "cynologist" || hasCertificate())
    .map(
      ([code, text]) => `<button class="chip small ${e.category === code ? "on" : ""}" data-act="appl-category"
        data-category="${code}" ${c.busy ? "disabled" : ""}>${esc(text)}</button>`,
    )
    .join("");
  const docs = c.documents.length
    ? c.documents
        .map(
          (d) => `<div class="doc"><button class="msg-photo" data-act="photo-open" data-url="${esc(d.url)}">
          <img src="${esc(d.url)}" alt="" loading="lazy"></button>
          <div class="grow"><b>${esc(label(DOC_TYPE, d.doc_type))}</b>
            <div class="muted ${d.review_status === "approved" ? "ok" : d.review_status ? "warn" : ""}">
              ${esc(d.review_status ? label(DOC_REVIEW, d.review_status) : "не проверен")}${d.review_note ? " · " + esc(d.review_note) : ""}</div>
            ${docButtons(d.id, e.user_id, c.busy)}</div></div>`,
        )
        .join("")
    : `<p class="muted">Документов нет</p>`;
  const verdict = c.verdict
    ? askForm(
        {
          key: "appl-verdict",
          title: c.verdict === "approve" ? "Одобрить анкету?" : "Отклонить анкету?",
          hint: "Ситтер получит уведомление в боте. Дополнение к тексту — по желанию.",
          placeholder: "Что добавить к уведомлению (необязательно)",
          act: "appl-verdict-go",
          data: { verdict: c.verdict },
          submit: c.verdict === "approve" ? "Одобрить" : "Отклонить",
          danger: c.verdict === "reject",
        },
        c.busy,
      )
    : `<div class="row gap">
        <button class="btn" data-act="appl-verdict" data-verdict="approve" ${c.busy ? "disabled" : ""}>✅ Одобрить</button>
        <button class="btn ghost" data-act="appl-verdict" data-verdict="reject" ${c.busy ? "disabled" : ""}>❌ Отклонить</button>
        <button class="btn ghost" data-act="appl-chat" ${c.busy ? "disabled" : ""}>💬 Написать</button></div>`;
  return `<section class="list">
    <h2>${esc(who([e.name, e.last_name].filter(Boolean).join(" "), e.user_id))}</h2>
    ${notice(c.notice)}
    <div class="card">
      ${kv("Подана", esc(when(e.created_at)))}
      ${kv("Телефон", esc(e.phone ?? "—"))}${kv("Email", esc(e.email ?? "—"))}
      ${kv("Выгул", yesNo(e.does_walk))}${kv("Передержка", yesNo(e.does_boarding))}
      ${e.does_boarding ? kv("Адрес передержки", esc(e.boarding_address ?? "—")) + kv("Питомцев максимум", e.boarding_max_pets ?? "—") : ""}
      ${kv("Отзывов на площадках", e.claimed_external_reviews ?? "—")}
      ${kv("Согласие с политикой", esc(when(e.consent_at)))}
      ${kv("Геопозиция", e.lat ? `${e.lat.toFixed(4)}, ${e.lon.toFixed(4)}` : "—")}
    </div>
    <div class="card"><div class="field-label">О себе</div><p>${esc(e.bio ?? "—")}</p></div>
    <div class="card"><div class="field-label">Категория</div>${cats}
      ${hasCertificate() ? "" : `<p class="muted">Кинолог — только при загруженном сертификате</p>`}</div>
    <div class="card stack"><div class="field-label">Документы</div>${c.error ? `<div class="notice error">${esc(c.error)}</div>` : docs}</div>
    ${verdict}
  </section>`;
}

async function act(fn, ok) {
  card.busy = true;
  card.notice = null;
  render();
  try {
    await fn();
    card.notice = ok ? { kind: "ok", text: ok } : null;
    haptic("success");
  } catch (err) {
    if (card) card.notice = { kind: "error", text: err.message };
    haptic("error");
  }
  if (card) card.busy = false;
  render();
}

async function reviewDocument({ doc, walker, decision }) {
  const run = () => api("POST", `/walker/documents/${doc}/review`, { decision, note: null });
  if (card) {
    await act(async () => {
      await run();
      card.documents = await api("GET", `/walker/${walker}/documents`);
    }, `Документ: ${label(DOC_REVIEW, decision)}`);
  } else {
    try {
      await run();
      haptic("success");
    } catch (err) {
      queue.error = err.message;
      haptic("error");
    }
    await loadQueue();
  }
}

async function setCategory({ category }) {
  await act(async () => {
    await api("PATCH", `/admin/users/${card.entry.user_id}/walker`, { category, reason: CATEGORY_REASON });
    card.entry.category = category;
  }, `Категория: ${label(CATEGORY, category)}`);
}

async function applyVerdict({ verdict }) {
  const extra = draft("appl-verdict").trim();
  const walkerId = card.entry.user_id;
  const approved = verdict === "approve";
  await act(async () => {
    const profile = await api("POST", `/walker/${walkerId}/${approved ? "approve" : "reject"}`);
    let text = approved ? VERDICT_APPROVED : VERDICT_REJECTED;
    if (approved && !profile.has_avatar) text += `\n\n${VERDICT_NO_AVATAR}`;
    if (extra) text += `\n\n${extra}`;
    try {
      await api("POST", `/admin/applications/${walkerId}/messages`, { text });
    } catch {
      // вердикт уже применён; без уведомления ситтер узнает статус в «Моя анкета»
    }
    clearDraft("appl-verdict");
    card = null;
    await loadQueue();
  });
  render();
}

registerOverlay({
  isOpen: () => card !== null && chat === null,
  view: cardView,
  close: () => {
    card = null;
    loadQueue();
  },
});

// --- переписка по заявке (KAN-407) ------------------------------------------------

const DRAFT = "appl-chat";

function toItem(m) {
  return {
    id: m.id,
    side: m.author === "admin" ? "mine" : "theirs",
    author: m.author === "admin" ? m.author_name : null,
    text: m.text,
    photos: m.photo_url ? [m.photo_url] : [],
    at: m.created_at,
  };
}

async function loadChat() {
  const walkerId = chat.walkerId;
  const messages = await api("GET", `/admin/applications/${walkerId}/messages?limit=100`);
  if (chat?.walkerId !== walkerId) return false;
  const last = (items) => (items.length ? items[items.length - 1].id : null);
  const changed = messages.length !== chat.items.length || last(messages) !== last(chat.items);
  chat.items = messages.map(toItem);
  return changed;
}

const chatPoll = poller(POLL_OPEN_MS, () => chat !== null, async () => {
  if (await loadChat()) rerender("keep");
});

async function openChat(walkerId, name) {
  chat = { walkerId, name, items: [], pending: [], loading: true, error: null, busy: false, notice: null };
  clearDraft(DRAFT);
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

const pendingItem = (text) => ({ id: "pending", side: "mine", text, photos: [], at: new Date().toISOString(), pending: true });

async function send(makeRequest, preview) {
  chat.pending.push(preview);
  chat.busy = true;
  chat.notice = null;
  rerender("bottom");
  try {
    const sent = await makeRequest();
    if (sent && sent.walker_reachable === false) chat.notice = "Ситтер не запускал бота — сообщение он не увидит.";
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

async function sendText() {
  const text = draft(DRAFT).trim();
  if (!text || chat.busy) return;
  const walkerId = chat.walkerId;
  clearDraft(DRAFT);
  await send(() => api("POST", `/admin/applications/${walkerId}/messages`, { text }), pendingItem(text));
}

const pick = photoPicker({
  multiple: false,
  onFiles: async ([file]) => {
    if (!chat || chat.busy) return;
    const walkerId = chat.walkerId;
    const text = draft(DRAFT).trim();
    clearDraft(DRAFT);
    await send(async () => {
      const form = new FormData();
      form.append("file", await shrink(file));
      if (text) form.append("text", text);
      return api("POST", `/admin/applications/${walkerId}/messages/photo`, form);
    }, pendingItem(text || "📷 фото"));
  },
});

function chatView() {
  const c = chat;
  const body = c.loading
    ? SPINNER
    : c.error
      ? stateBlock("⚠️", "Не открылась переписка", c.error, "appl-chat-retry", "Повторить")
      : `<div class="msgs">${bubbles([...c.items, ...c.pending]) || `<p class="muted center">Сообщений нет — напишите первым.</p>`}</div>`;
  return `<section class="chat">
    <div class="chat-head"><div><b>${esc(c.name)}</b><div class="chat-order">по заявке ситтера</div></div></div>
    ${body}
    ${c.notice ? `<div class="notice error">${esc(c.notice)}</div>` : ""}
    ${composer({ key: DRAFT, placeholder: "Сообщение ситтеру", busy: c.busy || c.loading })}
  </section>`;
}

registerOverlay({
  isOpen: () => chat !== null,
  view: chatView,
  close: () => {
    chat = null;
    chatPoll.stop();
  },
});

registerActions({
  ...KIT_ACTIONS,
  "appl-open": ({ id }) => openCard(id),
  "doc-review": reviewDocument,
  "appl-category": setCategory,
  "appl-verdict": ({ verdict }) => {
    card.verdict = verdict;
  },
  "appl-verdict-go": applyVerdict,
  "appl-chat": () => openChat(card.entry.user_id, who([card.entry.name, card.entry.last_name].filter(Boolean).join(" "), card.entry.user_id)),
  "appl-chat-retry": () => openChat(chat.walkerId, chat.name),
  "appl-chat-send": () => sendText(),
  "appl-chat-pick": () => pick(),
});

onAskCancel(() => {
  if (card) card.verdict = null;
});

registerScreen({ key: "applications", label: "Заявки", view: queueView, open: loadQueue });
