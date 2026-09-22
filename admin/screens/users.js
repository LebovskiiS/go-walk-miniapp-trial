// «Пользователи» — как раздел 👤 в админ-боте (KAN-94/96/361/515): поиск или все,
// карточка, заказы человека, блокировка (обратимая) / разблокировка, удаление
// (необратимо, с подтверждением), правка профиля ситтера (имя, фамилия, о себе,
// приём заказов, категория, радиус, отзывы с площадок, запрос скриншотов),
// обращение в поддержке. Каждое действие — с причиной в журнал admin_actions.
import { api } from "../../api.js";
import { esc, fmtWhen, haptic, registerActions, registerChanges, registerOverlay, registerScreen, render, state } from "../../core.js";
import { clearDraft, draft } from "../../screens/chatkit.js";
import {
  CATEGORY, ROLE, WALKER_STATUS, askForm, kv, label, listState, notice, onAskCancel, reasonOf, when, who, yesNo,
} from "../kit.js";
import { showOrdersOf } from "./orders.js";
import { openSupportChat } from "./support.js";

const users = { q: "", items: [], loading: false, error: null, loaded: false };
let card = null; // {user, loading, error, busy, notice, ask, edit}

// --- список --------------------------------------------------------------------

async function search(all = false) {
  users.loading = true;
  users.error = null;
  render();
  try {
    const q = all ? "" : users.q.trim();
    users.items = await api("GET", `/admin/users?limit=100${q ? "&q=" + encodeURIComponent(q) : ""}`);
    users.loaded = true;
  } catch (err) {
    users.error = err.message;
  }
  users.loading = false;
  render();
}

function listView() {
  const empty = users.loaded ? listState(users, "Никого не нашли.") : users.loading ? listState(users, "") : "";
  const rows = empty ?? users.items
    .map(
      (u) => `<button class="card row item-link" data-act="user-open" data-id="${esc(u.id)}">
        <span><b>${esc(who(u.name, u.id))}</b>
          <span class="muted">${esc(label(ROLE, u.role))}${u.phone ? " · " + esc(u.phone) : ""}${u.email ? " · " + esc(u.email) : ""}</span></span>
        ${u.blocked_at ? `<span class="badge cancelled">блок</span>` : ""}</button>`,
    )
    .join("");
  return `<section class="list"><h2>Пользователи</h2>
    <div class="row gap"><input class="input grow" data-change="user-q" value="${esc(users.q)}" placeholder="Имя, телефон, email или id" enterkeyhint="search">
      <button class="btn" data-act="user-search" ${users.loading ? "disabled" : ""}>Найти</button></div>
    <div class="chips tight"><button class="chip small" data-act="user-all">Показать всех</button></div>
    ${rows}</section>`;
}

// --- карточка -------------------------------------------------------------------

async function openCard(id) {
  card = { user: null, id, loading: true, error: null, busy: false, notice: null, ask: null, edit: null };
  render();
  try {
    card.user = await api("GET", `/admin/users/${id}`);
  } catch (err) {
    card.error = err.message;
  }
  if (card?.id !== id) return;
  card.loading = false;
  render();
}

const isWalker = (u) => u.walker_status !== null && u.walker_status !== undefined;

function editForm(u, busy) {
  const e = card.edit;
  const off = busy ? "disabled" : "";
  const cats = Object.entries(CATEGORY)
    .map(([code, text]) => `<button class="chip small ${e.category === code ? "on" : ""}" data-act="user-edit-cat" data-value="${code}" ${off}>${esc(text)}</button>`)
    .join("");
  return `<div class="card stack">
    <b>Профиль ситтера</b>
    <div class="field"><span class="field-label">Имя</span><input class="input" data-change="user-edit" data-field="name" value="${esc(e.name)}" ${off}></div>
    <div class="field"><span class="field-label">Фамилия</span><input class="input" data-change="user-edit" data-field="last_name" value="${esc(e.last_name)}" ${off}></div>
    <div class="field"><span class="field-label">О себе</span><textarea class="input" rows="3" data-change="user-edit" data-field="bio" ${off}>${esc(e.bio)}</textarea></div>
    <div class="field"><span class="field-label">Категория</span><div class="chips tight">${cats}</div></div>
    <div class="field"><span class="field-label">Радиус выезда, км</span><input class="input" type="number" min="1" max="100" data-change="user-edit" data-field="radius_km" value="${esc(e.radius_km)}" ${off}></div>
    <div class="field"><span class="field-label">Отзывов на других площадках (0–10, 11 = «10+»)</span><input class="input" type="number" min="0" max="11" data-change="user-edit" data-field="claimed_external_reviews" value="${esc(e.claimed_external_reviews)}" ${off}></div>
    <div class="field"><label class="row"><span>Приём заказов включён</span><input type="checkbox" data-change="user-edit" data-field="is_available" ${e.is_available ? "checked" : ""} ${off}></label></div>
    <div class="field"><label class="row"><span>Запросить скриншоты отзывов</span><input type="checkbox" data-change="user-edit" data-field="ext_reviews_proof_requested" ${e.ext_reviews_proof_requested ? "checked" : ""} ${off}></label></div>
    <div class="field"><span class="field-label">Причина правки</span><textarea class="input" rows="2" data-draft="user-edit-reason" placeholder="Что и почему меняем">${esc(draft("user-edit-reason"))}</textarea></div>
    <div class="row gap"><button class="btn" data-act="user-edit-save" ${off}>Сохранить</button>
      <button class="btn ghost" data-act="user-edit-cancel" ${off}>Отмена</button></div></div>`;
}

function cardView() {
  const c = card;
  if (c.loading) return `<div class="state"><div class="spinner"></div></div>`;
  if (c.error) return `<section class="list"><div class="notice error">${esc(c.error)}</div></section>`;
  const u = c.user;
  const off = c.busy ? "disabled" : "";
  const walker = isWalker(u)
    ? `<div class="card">
        ${kv("Анкета", esc(label(WALKER_STATUS, u.walker_status)))}
        ${kv("Фамилия", esc(u.walker_last_name ?? "—"))}
        ${kv("Категория", esc(label(CATEGORY, u.walker_category)))}
        ${kv("Выгул / передержка", `${yesNo(u.walker_does_walk)} / ${yesNo(u.walker_does_boarding)}`)}
        ${kv("Радиус", u.walker_service_radius_m ? `${Math.round(u.walker_service_radius_m / 1000)} км` : "—")}
        ${kv("Отзывов на площадках", u.walker_claimed_external_reviews === 11 ? "10+" : (u.walker_claimed_external_reviews ?? "—"))}
        ${kv("Проверен", esc(when(u.walker_verified_at)))}
      </div>`
    : "";
  const actions = c.ask || c.edit
    ? ""
    : `<div class="row gap">
        <button class="btn ghost" data-act="user-orders" ${off}>📦 Заказы человека</button>
        <button class="btn ghost" data-act="user-support" ${off}>🛟 Обращение в поддержке</button>
        ${isWalker(u) ? `<button class="btn ghost" data-act="user-edit" ${off}>👣 Изменить профиль ситтера</button>` : ""}
        ${u.blocked_at
          ? `<button class="btn ghost" data-act="user-ask" data-kind="unblock" ${off}>✅ Разблокировать</button>`
          : `<button class="btn ghost" data-act="user-ask" data-kind="block" ${off}>🚫 Заблокировать</button>`}
        <button class="btn ghost" data-act="user-ask" data-kind="delete" ${off}>🗑 Удалить аккаунт</button></div>`;
  return `<section class="list">
    <h2>${esc(who(u.name, u.id))}</h2>
    ${notice(c.notice)}
    <div class="card">
      ${kv("Роль", esc(label(ROLE, u.role)))}
      ${kv("Телефон", esc(u.phone ?? "—"))}${kv("Email", esc(u.email ?? "—"))}
      ${kv("Telegram id", esc(u.telegram_user_id ?? "—"))}
      ${kv("Заказов всего / активных", `${u.total_orders} / ${u.active_orders}`)}
      ${kv("Зарегистрирован", esc(when(u.created_at)))}
      ${u.blocked_at ? kv("Заблокирован", `${esc(when(u.blocked_at))}${u.block_reason ? " · " + esc(u.block_reason) : ""}`) : ""}
    </div>
    ${walker}
    ${c.edit ? editForm(u, c.busy) : ""}
    ${askForm(c.ask, c.busy)}
    ${actions}
  </section>`;
}

async function act(fn, ok) {
  card.busy = true;
  card.notice = null;
  render();
  try {
    await fn();
    haptic("success");
    if (card) card.notice = ok ? { kind: "ok", text: ok } : null;
  } catch (err) {
    if (card) card.notice = { kind: "error", text: err.message };
    haptic("error");
  }
  if (card) card.busy = false;
  render();
}

const ASKS = {
  block: { title: "Заблокировать пользователя", hint: "Активные заказы будут отменены с возвратом. Блокировка обратима.", submit: "Заблокировать", danger: true },
  unblock: { title: "Разблокировать пользователя", submit: "Разблокировать", danger: false },
  delete: {
    title: "Удалить аккаунт безвозвратно",
    hint: "Каскад по данным и фото. При активных заказах ядро откажет — сначала разрулите их.",
    submit: "Да, удалить безвозвратно",
    danger: true,
  },
};

async function doAsk({ kind }) {
  const id = card.user.id;
  await act(async () => {
    const reason = reasonOf(`user-${kind}`);
    if (kind === "block") card.user = { ...card.user, ...(await api("POST", `/admin/users/${id}/block`, { reason })) };
    else if (kind === "unblock") card.user = { ...card.user, ...(await api("POST", `/admin/users/${id}/unblock`, { reason })) };
    else {
      await api("DELETE", `/admin/users/${id}?reason=${encodeURIComponent(reason)}`);
      clearDraft(`user-${kind}`);
      card = null;
      users.items = users.items.filter((u) => u.id !== id);
      return;
    }
    clearDraft(`user-${kind}`);
    card.ask = null;
    card.user = await api("GET", `/admin/users/${id}`);
  }, kind === "block" ? "Заблокирован" : kind === "unblock" ? "Разблокирован" : null);
}

function startEdit() {
  const u = card.user;
  card.edit = {
    name: u.name ?? "",
    last_name: u.walker_last_name ?? "",
    bio: "", // ядро в карточке «О себе» не отдаёт: пустое поле = не менять
    category: u.walker_category ?? "",
    radius_km: u.walker_service_radius_m ? Math.round(u.walker_service_radius_m / 1000) : "",
    claimed_external_reviews: u.walker_claimed_external_reviews ?? "",
    is_available: null, // null = не трогать; станет true/false после тапа по галочке
    ext_reviews_proof_requested: false,
  };
}

async function saveEdit() {
  const u = card.user;
  const e = card.edit;
  await act(async () => {
    const reason = reasonOf("user-edit-reason");
    // только изменённые поля: PATCH с прежним значением фамилии упрётся в замок (KAN-138)
    const body = { reason };
    if (e.name.trim() && e.name.trim() !== u.name) body.name = e.name.trim();
    if (e.last_name.trim() && e.last_name.trim() !== (u.walker_last_name ?? "")) body.last_name = e.last_name.trim();
    if (e.bio.trim()) body.bio = e.bio.trim();
    if (e.category && e.category !== u.walker_category) body.category = e.category;
    if (e.radius_km !== "" && Number(e.radius_km) * 1000 !== u.walker_service_radius_m) body.service_radius_m = Number(e.radius_km) * 1000;
    if (e.claimed_external_reviews !== "" && Number(e.claimed_external_reviews) !== u.walker_claimed_external_reviews)
      body.claimed_external_reviews = Number(e.claimed_external_reviews);
    if (e.is_available !== null) body.is_available = e.is_available;
    if (e.ext_reviews_proof_requested) body.ext_reviews_proof_requested = true;
    if (Object.keys(body).length === 1) throw new Error("Ничего не изменено.");
    await api("PATCH", `/admin/users/${u.id}/walker`, body);
    clearDraft("user-edit-reason");
    card.edit = null;
    card.user = await api("GET", `/admin/users/${u.id}`);
  }, "Профиль обновлён");
}

registerOverlay({
  isOpen: () => card !== null,
  view: cardView,
  close: () => {
    card = null;
  },
});

registerChanges({
  "user-q": (input) => {
    users.q = input.value;
  },
  "user-edit": (input) => {
    if (!card?.edit) return;
    const { field } = input.dataset;
    card.edit[field] = input.type === "checkbox" ? input.checked : input.value;
  },
});

registerActions({
  "user-open": ({ id }) => openCard(id),
  "user-search": () => search(),
  "user-all": () => search(true),
  "user-orders": () => {
    const id = card.user.id;
    card = null;
    state.tab = "orders";
    return showOrdersOf(id);
  },
  "user-support": () => {
    const id = card.user.id;
    card = null;
    state.tab = "support";
    return openSupportChat(id);
  },
  "user-edit": () => startEdit(),
  "user-edit-cancel": () => {
    card.edit = null;
  },
  "user-edit-cat": ({ value }) => {
    card.edit.category = value;
  },
  "user-edit-save": saveEdit,
  "user-ask": ({ kind }) => {
    card.ask = { key: `user-${kind}`, act: "user-ask-go", data: { kind }, ...ASKS[kind] };
  },
  "user-ask-go": doAsk,
});

onAskCancel(() => {
  if (card) card.ask = null;
});

// Enter в поле поиска — то же, что «Найти»
document.getElementById("app").addEventListener("keydown", (event) => {
  if (event.key === "Enter" && event.target.dataset?.change === "user-q") {
    event.preventDefault();
    search();
  }
});

registerScreen({ key: "users", label: "Люди", view: listView, open: () => (users.loaded ? undefined : search(true)) });

export const openUserCard = openCard;
