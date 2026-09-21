// Переписка с поддержкой (KAN-509): текст, фото (до пяти за раз), «Завершить
// диалог» (KAN-360). Открывается строкой в списке «Чаты». Закрытый диалог ядро
// человеку не показывает — после завершения переписка пустая, следующее
// сообщение начнёт новый диалог (архив прошлых диалогов — у операторов, в боте
// поддержки).
import { api } from "../api.js";
import { SPINNER, esc, haptic, registerActions, registerOverlay, render, stateBlock, tg } from "../core.js";
import { MAX_TEXT, POLL_OPEN_MS, bubbles, clearDraft, composer, draft, photoPicker, poller, rerender } from "./chatkit.js";
import { shrink } from "./walk.js";

const MAX_PHOTOS = 5; // MAX_PHOTOS_PER_MESSAGE в ядре

let support = null; // {items, pending, loading, error, busy, notice}

function toItem(m) {
  if (m.author === "system") return { id: m.id, side: "system", text: m.text, photos: [], at: m.created_at };
  return {
    id: m.id,
    side: m.mine ? "mine" : "theirs",
    author: m.mine ? null : "Поддержка",
    text: m.text,
    photos: m.photos.map((photo) => photo.url),
    at: m.created_at,
  };
}

async function load() {
  const messages = await api("GET", "/support/messages");
  if (!support) return false;
  // ручка отдаёт тред целиком: перерисовываем, только если что-то поменялось
  const last = (items) => (items.length ? items[items.length - 1].id : null);
  const changed = messages.length !== support.items.length || last(messages) !== last(support.items);
  support.items = messages.map(toItem);
  return changed;
}

const poll = poller(POLL_OPEN_MS, () => support !== null, async () => {
  if (await load()) rerender("keep");
});

export async function openSupport() {
  support = { items: [], pending: [], loading: true, error: null, busy: false, notice: null };
  render();
  try {
    await load();
  } catch (err) {
    if (support) support.error = err.message;
  }
  if (!support) return;
  support.loading = false;
  rerender("bottom");
  poll.start();
}

function close() {
  support = null;
  poll.stop();
}

async function send(makeRequest, preview) {
  support.pending.push(preview);
  support.busy = true;
  support.notice = null;
  rerender("bottom");
  try {
    await makeRequest();
    await load();
    haptic("success");
  } catch (err) {
    if (support) support.notice = err.message;
    haptic("error");
  }
  if (!support) return;
  support.pending = support.pending.filter((item) => item !== preview);
  support.busy = false;
  rerender("bottom");
}

const pendingItem = (text) => ({ id: "pending", side: "mine", text, photos: [], at: new Date().toISOString(), pending: true });

function sendText() {
  const text = draft("support").trim();
  if (!text || support.busy) return;
  if (text.length > MAX_TEXT) {
    support.notice = `Сообщение длиннее ${MAX_TEXT} символов — разбейте на части.`;
    return;
  }
  clearDraft("support");
  return send(() => api("POST", "/support/messages", { text }), pendingItem(text));
}

function sendPhotos(files) {
  if (!support || support.busy) return;
  if (files.length > MAX_PHOTOS) {
    support.notice = `За раз — не больше ${MAX_PHOTOS} фото.`;
    return render();
  }
  const caption = draft("support").trim().slice(0, MAX_TEXT);
  clearDraft("support");
  const label = files.length === 1 ? "📷 Фото" : `📷 ${files.length} фото`;
  return send(
    async () => {
      // ужимаем как фото прогулки (KAN-459): пять снимков камеры иначе не пролезут
      const form = new FormData();
      for (const file of files) form.append("files", await shrink(file));
      form.append("text", caption);
      return api("POST", "/support/messages/photo", form);
    },
    pendingItem(caption ? `${label}: ${caption}` : label),
  );
}

function confirm(text) {
  // showConfirm — Bot API 6.2+; в старом клиенте спросим обычным диалогом браузера
  return new Promise((resolve) => {
    try {
      if (tg?.showConfirm) return tg.showConfirm(text, (ok) => resolve(Boolean(ok)));
    } catch {
      // не поддерживается — ниже
    }
    resolve(window.confirm(text));
  });
}

async function finish() {
  if (!(await confirm("Завершить диалог с поддержкой? Переписка уберётся, следующее сообщение начнёт новый диалог."))) return;
  support.busy = true;
  render();
  try {
    await api("POST", "/support/close");
    support.items = [];
    support.notice = null;
    support.closed = true;
    haptic("success");
  } catch {
    support.notice = "Завершить диалог сейчас не получилось — попробуйте чуть позже.";
    haptic("error");
  }
  support.busy = false;
  render();
}

function view() {
  const head = `<header class="chat-head"><div class="avatar avatar-empty">🛟</div>
    <div><b>Поддержка</b><div class="chat-order">Отвечаем здесь и в боте</div></div>
    ${support.items.length && !support.busy
      ? `<button class="btn ghost small" data-act="support-finish">Завершить</button>` : ""}</header>`;
  if (support.loading) return head + SPINNER;
  if (support.error) {
    return head + stateBlock("⚠️", "Не получилось открыть поддержку", support.error, "support-retry", "Повторить");
  }
  const empty = support.items.length || support.pending.length
    ? ""
    : `<p class="muted center">${support.closed
      ? "✅ Диалог с поддержкой завершён, переписка убрана. Понадобится помощь — просто напишите, начнётся новый диалог."
      : "Опишите вопрос — оператор ответит сюда и сообщением в боте. Можно приложить фото."}</p>`;
  const notice = support.notice ? `<div class="notice error">${esc(support.notice)}</div>` : "";
  return `<section class="chat">${head}${empty}
    <div class="msgs">${bubbles([...support.items, ...support.pending])}</div>${notice}
    ${composer({ key: "support", placeholder: "Сообщение в поддержку", busy: support.busy })}
  </section>`;
}

// первая строка списка «Чаты»
export function supportRow() {
  return `<button class="chat-row pinned" data-act="support-open">
    <div class="avatar avatar-empty">🛟</div>
    <span class="chat-row-body"><span class="chat-row-top"><b>Поддержка</b></span>
      <span class="chat-row-bottom"><span class="muted ellipsis">Вопрос по заказу, деньгам, анкете — пишите</span></span>
    </span></button>`;
}

registerOverlay({ isOpen: () => support !== null, view, close });

registerActions({
  "support-send": () => sendText(),
  "support-retry": () => openSupport(),
  "support-finish": () => finish(),
  "support-pick": photoPicker({ multiple: true, onFiles: sendPhotos }),
});
