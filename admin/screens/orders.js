// «Заказы» — как 📦 в админ-боте (KAN-95/316): список с фильтром по статусу (по
// умолчанию активные), заказы конкретного человека из его карточки, карточка
// заказа с ходом прогулки, «Отменить» (возврат сразу) и «Завершить» (без
// движения денег) — оба с причиной.
import { api } from "../../api.js";
import { esc, fmtWhen, haptic, registerActions, registerOverlay, registerScreen, render } from "../../core.js";
import { clearDraft } from "../../screens/chatkit.js";
import {
  ORDER_STATUS, ORDER_TYPE, PAYMENT, askForm, kv, label, listState, money, notice, onAskCancel, reasonOf, when, who,
} from "../kit.js";

const ACTIVE = ["proposed", "dispatching", "accepted", "on_the_way", "walking"];
const FILTERS = [["active", "Активные"], ...Object.entries(ORDER_STATUS), ["all", "Все"]];
const CAN_CANCEL = new Set(["proposed", "dispatching", "accepted", "on_the_way", "walking"]);
const CAN_COMPLETE = new Set(["accepted", "on_the_way", "walking"]);

const orders = { filter: "active", userId: null, items: [], loading: false, error: null, loaded: false };
let card = null; // {order, loading, error, busy, notice, ask}

async function load() {
  orders.loading = true;
  orders.error = null;
  render();
  try {
    const user = orders.userId ? `&user_id=${orders.userId}` : "";
    if (orders.filter === "active" && !orders.userId) {
      // у ручки один status на запрос — активные собираем пятью запросами
      const pages = await Promise.all(ACTIVE.map((s) => api("GET", `/admin/orders?status=${s}&limit=50`)));
      orders.items = pages.flat().sort((a, b) => a.scheduled_at.localeCompare(b.scheduled_at));
    } else {
      const status = orders.filter === "active" || orders.filter === "all" ? "" : `&status=${orders.filter}`;
      orders.items = await api("GET", `/admin/orders?limit=100${status}${user}`);
    }
    orders.loaded = true;
  } catch (err) {
    orders.error = err.message;
  }
  orders.loading = false;
  render();
}

// из карточки пользователя: «📦 Заказы человека»
export async function showOrdersOf(userId) {
  orders.userId = userId;
  orders.filter = "all";
  await load();
}

function row(o) {
  return `<button class="card row item-link" data-act="order-open" data-id="${esc(o.id)}">
    <span><b>${esc(label(ORDER_TYPE, o.type))} · ${esc(fmtWhen(o.scheduled_at))}</b>
      <span class="muted">${esc(o.client_name ?? "клиент?")} → ${esc(o.walker_name ?? "ситтер не назначен")}${o.pet_name ? " · " + esc(o.pet_name) : ""}</span>
      <span class="muted">${money(o.price_kopecks)} · ${esc(label(PAYMENT, o.payment_status))}</span></span>
    <span class="badge ${esc(o.status)}">${esc(label(ORDER_STATUS, o.status))}</span></button>`;
}

function listView() {
  const chips = FILTERS.map(
    ([v, t]) => `<button class="chip small ${orders.filter === v && !orders.userId ? "on" : ""}" data-act="order-filter" data-value="${v}">${esc(t)}</button>`,
  ).join("");
  const scope = orders.userId
    ? `<div class="notice ok">Заказы пользователя ${esc(String(orders.userId).slice(0, 8))} <button class="chip small" data-act="order-filter" data-value="active">все заказы</button></div>`
    : "";
  const empty = listState(orders, "Заказов нет.");
  return `<section class="list"><h2>Заказы</h2>
    <div class="chips tight">${chips}</div>${scope}
    ${empty ?? orders.items.map(row).join("")}
  </section>`;
}

async function openCard(id) {
  card = { id, order: null, loading: true, error: null, busy: false, notice: null, ask: null };
  render();
  try {
    card.order = await api("GET", `/admin/orders/${id}`);
  } catch (err) {
    card.error = err.message;
  }
  if (card?.id !== id) return;
  card.loading = false;
  render();
}

function cardView() {
  const c = card;
  if (c.loading) return `<div class="state"><div class="spinner"></div></div>`;
  if (c.error) return `<section class="list"><div class="notice error">${esc(c.error)}</div></section>`;
  const o = c.order;
  const s = o.session;
  const off = c.busy ? "disabled" : "";
  const session = s
    ? `<div class="card">
        ${kv("Начало", esc(when(s.started_at)))}${kv("Конец", esc(when(s.finished_at)))}
        ${kv("Точек трека / фото", `${s.points} / ${s.photos}`)}
        ${s.events.length ? `<div class="muted">${s.events.map(esc).join(" → ")}</div>` : ""}</div>`
    : `<p class="muted">Прогулка ещё не начиналась.</p>`;
  const factors = o.price_factors?.length
    ? `<div class="muted">${o.price_factors.map((f) => esc(typeof f === "string" ? f : JSON.stringify(f))).join(" · ")}</div>`
    : "";
  const actions = c.ask
    ? ""
    : `<div class="row gap">
        ${CAN_CANCEL.has(o.status) ? `<button class="btn ghost" data-act="order-ask" data-kind="cancel" ${off}>🚫 Отменить заказ</button>` : ""}
        ${CAN_COMPLETE.has(o.status) ? `<button class="btn ghost" data-act="order-ask" data-kind="complete" ${off}>🏁 Завершить прогулку</button>` : ""}
        <button class="btn ghost" data-act="order-user" data-id="${esc(o.client_id ?? "")}" ${o.client_id ? "" : "disabled"}>👤 Клиент</button>
        <button class="btn ghost" data-act="order-user" data-id="${esc(o.walker_id ?? "")}" ${o.walker_id ? "" : "disabled"}>🐕 Ситтер</button></div>`;
  return `<section class="list">
    <h2>${esc(label(ORDER_TYPE, o.type))} №${esc(String(o.id).slice(0, 8))}</h2>
    ${notice(c.notice)}
    <div class="card">
      ${kv("Статус", `<span class="badge ${esc(o.status)}">${esc(label(ORDER_STATUS, o.status))}</span>`)}
      ${kv("Когда", esc(when(o.scheduled_at)))}${o.duration_minutes ? kv("Длительность", `${o.duration_minutes} мин`) : ""}
      ${kv("Клиент", esc(o.client_name ? who(o.client_name, o.client_id) : "—"))}
      ${kv("Ситтер", esc(o.walker_name ? who(o.walker_name, o.walker_id) : "не назначен"))}
      ${kv("Питомец", esc(o.pet_name ?? "—"))}${kv("Адрес", esc(o.address ?? "—"))}
      ${kv("Цена", `${money(o.price_kopecks)}${o.walk_price_kopecks ? " (выгул " + money(o.walk_price_kopecks) + ")" : ""}`)}
      ${kv("Оплата", esc(label(PAYMENT, o.payment_status)))}
      ${kv("Тариф", o.tariff_class === "cynologist" ? "С кинологом" : "Базовый")}${o.is_recurring ? kv("Регулярный", "да") : ""}
      ${kv("Создан", esc(when(o.created_at)))}${factors}
    </div>
    <div class="field-label">Прогулка</div>${session}
    ${askForm(c.ask, c.busy)}
    ${actions}
  </section>`;
}

const ASKS = {
  cancel: { title: "Отменить заказ", hint: "Оплата вернётся клиенту сразу; ситтеру ничего не начислится.", submit: "Отменить заказ", danger: true },
  complete: { title: "Завершить прогулку", hint: "Заказ станет завершённым без движения денег (T5, KAN-316).", submit: "Завершить", danger: false },
};

async function doAsk({ kind }) {
  const id = card.order.id;
  card.busy = true;
  card.notice = null;
  render();
  try {
    const reason = reasonOf(`order-${kind}`);
    await api("POST", `/admin/orders/${id}/${kind}`, { reason });
    clearDraft(`order-${kind}`);
    card.ask = null;
    card.order = await api("GET", `/admin/orders/${id}`);
    card.notice = { kind: "ok", text: kind === "cancel" ? "Заказ отменён" : "Прогулка завершена" };
    haptic("success");
    load();
  } catch (err) {
    card.notice = { kind: "error", text: err.message };
    haptic("error");
  }
  card.busy = false;
  render();
}

registerOverlay({
  isOpen: () => card !== null,
  view: cardView,
  close: () => {
    card = null;
  },
});

registerActions({
  "order-open": ({ id }) => openCard(id),
  "order-filter": ({ value }) => {
    orders.filter = value;
    orders.userId = null;
    return load();
  },
  "order-ask": ({ kind }) => {
    card.ask = { key: `order-${kind}`, act: "order-ask-go", data: { kind }, ...ASKS[kind] };
  },
  "order-ask-go": doAsk,
  "order-user": async ({ id }) => {
    const { openUserCard } = await import("./users.js");
    card = null;
    return openUserCard(id);
  },
});

onAskCancel(() => {
  if (card) card.ask = null;
});

registerScreen({ key: "orders", label: "Заказы", view: listView, open: () => (orders.loaded && !orders.userId ? undefined : load()) });

export const openOrderCard = openCard;
