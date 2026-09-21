// Экран «Заказы» (KAN-492): три списка и карточка заказа поверх вкладок. Активный заказ
// ведётся прямо из карточки — блок шагов прогулки живёт в walk.js (KAN-504).
import { api } from "../api.js";
import {
  esc, fetchPage, fmtMoney, fmtWhen, registerOverlay, registerScreen, render, shortId, SPINNER,
  stateBlock,
} from "../core.js";
import { initWalk, walkBlock } from "./walk.js";

const ORDER_TABS = [
  ["active", "Активные"],
  ["completed", "Завершённые"],
  ["cancelled", "Отменённые"],
];
const UUID = /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const ACTIVE_STATUSES = ["accepted", "on_the_way", "walking"];

const TYPE_LABEL = { urgent: "⚡ Экспресс-выгул", booked: "🐕 Выгул", boarding: "🏠 Передержка" };
const STATUS_LABEL = {
  proposed: "предложен", dispatching: "ищем ситтера", accepted: "принят",
  on_the_way: "вы в пути", walking: "идёт", completed: "завершён", cancelled: "отменён",
};
const CANCEL_LABEL = {
  cancelled_by_client: "отменил клиент", cancelled_by_walker: "отменили вы",
  cancelled_by_admin: "отменила поддержка", proposal_expired: "предложение истекло",
  expired: "просрочен", express_no_walkers: "не нашлось ситтеров",
  express_no_response: "никто не откликнулся", payment_expired: "не оплачен вовремя",
};

const box = { tab: "active", items: [], offset: 0, hasMore: false, loading: false, error: null };
let card = null; // открытая карточка: {id, loading, data, error}

// --- загрузка ------------------------------------------------------------------

async function loadOrders(reset, keep = false) {
  // keep — перечитать, не пряча показанное: «Активные» всё равно заменяются целиком
  if (reset) Object.assign(box, { items: keep ? box.items : [], offset: 0, hasMore: false });
  box.loading = true;
  box.error = null;
  render();
  try {
    if (box.tab === "active") {
      // ручка фильтрует по одному статусу — три запроса, как у бота (KAN-368)
      const pages = await Promise.all(
        ACTIVE_STATUSES.map((status) => api("GET", `/orders/mine?status=${status}&limit=50`)),
      );
      box.items = pages.flat().sort((a, b) => a.scheduled_at.localeCompare(b.scheduled_at));
    } else {
      const page = await fetchPage(`/orders/mine?status=${box.tab}`, box.offset);
      box.hasMore = page.hasMore;
      box.items = box.items.concat(page.items);
      box.offset += page.items.length;
    }
  } catch (err) {
    box.error = err.message;
  }
  box.loading = false;
  render();
}

// quiet — перечитать уже открытую карточку без спиннера на весь экран
export async function openOrder(id, { quiet = false } = {}) {
  if (!(quiet && card?.id === id && card.data)) card = { id, loading: true, data: null, error: null };
  const current = card;
  render();
  try {
    current.data = await api("GET", `/orders/${id}`);
    current.error = null;
  } catch (err) {
    current.error = err.message;
  }
  current.loading = false;
  render();
}

// После шага прогулки: карточка — из ядра, а список за ней устарел (статус сменился,
// завершённый заказ уехал из «Активных») — перечитываем и его.
async function refreshOrder() {
  if (!card) return;
  const before = card.data?.status;
  await openOrder(card.id, { quiet: true });
  if (card?.data && card.data.status !== before) loadOrders(true, true);
}

initWalk({ getOrder: () => card?.data ?? null, refreshOrder });

// --- отрисовка -----------------------------------------------------------------

function ordersView() {
  const tabs = ORDER_TABS.map(
    ([key, label]) =>
      `<button class="chip ${box.tab === key ? "on" : ""}" data-act="orders-tab" data-tab="${key}">${label}</button>`,
  ).join("");
  let body;
  if (box.error) {
    body = stateBlock("⚠️", "Не получилось загрузить заказы", box.error, "orders-retry", "Повторить");
  } else if (!box.items.length && box.loading) {
    body = SPINNER;
  } else if (!box.items.length) {
    const empty = { active: "Активных заказов нет", completed: "Завершённых заказов пока нет", cancelled: "Отменённых заказов нет" };
    body = stateBlock("🐕", empty[box.tab], "Новые предложения приходят сообщением в боте.");
  } else {
    body = `<section class="card list">${box.items.map(orderRow).join("")}</section>
      ${box.hasMore ? `<button class="btn ghost wide" data-act="orders-more" ${box.loading ? "disabled" : ""}>
        ${box.loading ? "Загружаю…" : "Показать ещё"}</button>` : ""}`;
  }
  return `<div class="chips">${tabs}</div>${body}
    <p class="note">Вести прогулку («Вышел», «Забрал», «Завершить», фото) — в карточке активного заказа.</p>`;
}

function orderWhen(order) {
  if (order.type === "boarding" && order.boarding_start_at) {
    return `${fmtWhen(order.boarding_start_at)} — ${fmtWhen(order.boarding_end_at)}`;
  }
  return fmtWhen(order.scheduled_at);
}

function orderStatus(order) {
  if (order.status === "cancelled" && order.cancel_reason) {
    return CANCEL_LABEL[order.cancel_reason] || STATUS_LABEL.cancelled;
  }
  return STATUS_LABEL[order.status] || order.status;
}

function orderRow(order) {
  return `<button class="item" data-act="order" data-id="${esc(order.id)}">
    <div class="row"><b>${esc(TYPE_LABEL[order.type] || order.type)}</b>
      <span class="badge ${esc(order.status)}">${esc(orderStatus(order))}</span></div>
    <div>${esc(orderWhen(order))}</div>
    <div class="muted">${esc(order.pet_names.join(", ") || "питомец не указан")} · ${shortId(order.id)}</div>
  </button>`;
}

function orderView() {
  const { loading, data: order, error } = card;
  const back = `<button class="link back" data-act="back">‹ К списку</button>`;
  if (loading) return back + SPINNER;
  if (error) {
    return back + stateBlock("⚠️", "Заказ не открылся", error, "order-retry", "Повторить");
  }

  const lines = [];
  const add = (label, value) => value && lines.push(`<div class="kv"><span class="muted">${label}</span><span>${esc(value)}</span></div>`);
  add("Когда", orderWhen(order));
  add("Длительность", order.duration_minutes ? `${order.duration_minutes} мин` : "");
  add("Фактически", order.session_duration_minutes ? `${order.session_duration_minutes} мин` : "");
  add("Тариф", order.tariff_class === "cynologist" ? "С кинологом" : "Базовый");
  add("Вам к выплате", order.walker_payout_kopecks != null ? fmtMoney(order.walker_payout_kopecks) : "");
  if (order.status === "accepted" && order.type === "booked" && !order.client_confirmed_at) {
    add("Клиент", "ещё не подтвердил встречу");
  }

  const address = order.address;
  const where = [];
  if (address) {
    where.push(esc(address.full_text));
    const extra = [
      address.entrance && `подъезд ${address.entrance}`,
      address.floor && `этаж ${address.floor}`,
      address.apartment && `кв. ${address.apartment}`,
      address.intercom_code && `домофон ${address.intercom_code}`,
    ].filter(Boolean);
    if (extra.length) where.push(`<span class="muted">${esc(extra.join(" · "))}</span>`);
    if (address.comment) where.push(`<span class="muted">${esc(address.comment)}</span>`);
  } else if (order.boarding_address) {
    where.push(esc(order.boarding_address));
  }

  const pets = (order.pets.length ? order.pets : order.pet ? [order.pet] : [])
    .map((pet) => {
      const facts = [pet.breed, pet.age_years != null && `${pet.age_years} лет`,
        { small: "маленькая", medium: "средняя", large: "крупная" }[pet.size]].filter(Boolean);
      return `<div class="pet"><b>${esc(pet.name)}</b>
        ${facts.length ? `<div class="muted">${esc(facts.join(" · "))}</div>` : ""}
        ${pet.behavior_notes ? `<div>🐾 ${esc(pet.behavior_notes)}</div>` : ""}
        ${pet.med_notes ? `<div>💊 ${esc(pet.med_notes)}</div>` : ""}</div>`;
    })
    .join("");

  const services = order.services.map((service) => esc(service.name)).join(", ");

  return `${back}
    <section class="card">
      <div class="row"><h2>${esc(TYPE_LABEL[order.type] || order.type)}</h2>
        <span class="badge ${esc(order.status)}">${esc(orderStatus(order))}</span></div>
      <div class="muted">${shortId(order.id)}</div>
      ${lines.join("")}
    </section>
    ${walkBlock(order)}
    ${order.client_id
      ? `<button class="btn ghost wide" data-act="chat-with" data-client="${esc(order.client_id)}">💬 Написать клиенту</button>`
      : ""}
    ${where.length ? `<h3>Адрес</h3><section class="card stack">${where.map((line) => `<div>${line}</div>`).join("")}</section>` : ""}
    ${pets ? `<h3>Питомцы</h3><section class="card stack">${pets}</section>` : ""}
    ${services ? `<h3>Доп. услуги</h3><section class="card">${services}</section>` : ""}
    <p class="note">Трансляция геопозиции — в боте.</p>`;
}

registerScreen({
  key: "orders",
  label: "📋 Заказы",
  view: ordersView,
  open: (params) => {
    // ?order=<id> из бота; id уходит в путь запроса, поэтому пускаем только UUID
    const linked = params?.get("order");
    if (linked && UUID.test(linked)) openOrder(linked);
    if (box.loading) return undefined;
    // «Активные» перечитываем при каждом входе: заказ могли принять на другой вкладке или в боте
    if (box.tab === "active") return loadOrders(true, true);
    return box.items.length ? undefined : loadOrders(true);
  },
  actions: {
    "orders-tab": ({ tab }) => {
      box.tab = tab;
      return loadOrders(true);
    },
    "orders-retry": () => loadOrders(true),
    "orders-more": () => loadOrders(false),
    order: ({ id }) => openOrder(id),
    "order-retry": () => openOrder(card.id),
  },
});

registerOverlay({
  isOpen: () => card !== null,
  view: orderView,
  close: () => {
    card = null;
  },
});
