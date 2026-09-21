// Экран «Кабинет» (KAN-505): сводка, история прогулок, отзывы — аналог хаба бота (KAN-111).
// Только чтение: GET /walker/me/overview, /walker/me/walks, /walker/me/reviews.
import { api } from "../api.js";
import { TZ } from "../config.js";
import {
  esc, fetchPage, fmtMoney, fmtWhen, registerScreen, render, SPINNER, stateBlock, timeFmt,
} from "../core.js";
import { openOrder } from "./orders.js";

const CATEGORY_LABEL = { amateur: "любитель", groomer: "грумер", cynologist: "кинолог" };

const newList = (path) => ({ path, items: [], offset: 0, hasMore: false, loading: false, loaded: false, error: null });
const LISTS = {
  walks: { label: "Прогулки", box: newList("/walker/me/walks"), row: walkRow,
    empty: ["🗂", "Завершённых прогулок пока нет", "Они появятся здесь после первой."] },
  reviews: { label: "Отзывы", box: newList("/walker/me/reviews"), row: reviewRow,
    empty: ["💬", "Отзывов пока нет", "Клиент может оставить отзыв после завершённой прогулки."] },
};

const overview = { loading: false, data: null, error: null };
let section = "walks";
const LINKS = []; // строки «Ещё»: разделы без своей вкладки (обучение, деньги)

// {act, icon, label, hint?} — обработчик data-act регистрирует тот, кто добавил ссылку
export function addCabinetLink(link) {
  LINKS.push(link);
}

// --- утилиты -----------------------------------------------------------------

const dateFmt = new Intl.DateTimeFormat("ru-RU", { timeZone: TZ, day: "numeric", month: "short" });
const dateYearFmt = new Intl.DateTimeFormat("ru-RU", { timeZone: TZ, day: "numeric", month: "short", year: "numeric" });
const yearFmt = new Intl.DateTimeFormat("ru-RU", { timeZone: TZ, year: "numeric" });

function fmtDate(iso) {
  // год — только у прошлогодних записей: история длинная, «12 сент.» без года путает
  const date = new Date(iso);
  return yearFmt.format(date) === yearFmt.format(new Date()) ? dateFmt.format(date) : dateYearFmt.format(date);
}

function plural(count, [one, few, many]) {
  const tail = count % 100;
  if (tail >= 11 && tail <= 14) return many;
  return [many, one, few, few, few][count % 10] || many;
}

const stars = (rating) => {
  const filled = Math.max(0, Math.min(5, Math.round(rating)));
  return "★".repeat(filled) + "☆".repeat(5 - filled);
};

// --- загрузка ------------------------------------------------------------------

async function loadOverview() {
  overview.loading = true;
  overview.error = null;
  render();
  try {
    overview.data = await api("GET", "/walker/me/overview");
  } catch (err) {
    overview.error = err.message;
  }
  overview.loading = false;
  render();
}

async function loadList(box, reset) {
  if (reset) Object.assign(box, { items: [], offset: 0, hasMore: false, loaded: false });
  box.loading = true;
  box.error = null;
  render();
  try {
    const page = await fetchPage(box.path, box.offset);
    box.hasMore = page.hasMore;
    box.items = box.items.concat(page.items);
    box.offset += page.items.length;
    box.loaded = true;
  } catch (err) {
    box.error = err.message;
  }
  box.loading = false;
  render();
}

function openCabinet() {
  // цифры сводки обновляем при каждом входе на вкладку, списки — один раз
  const box = LISTS[section].box;
  const jobs = [];
  if (!overview.loading) jobs.push(loadOverview());
  if (!box.loaded && !box.loading) jobs.push(loadList(box, true));
  return Promise.all(jobs);
}

// --- отрисовка -----------------------------------------------------------------

function overviewView() {
  const data = overview.data;
  if (!data) {
    return overview.error
      ? stateBlock("⚠️", "Не получилось загрузить сводку", overview.error, "cabinet-retry", "Повторить")
      : SPINNER;
  }
  const rating = data.rating == null
    ? `<b class="big">⭐ —</b><span class="muted">пока без оценок</span>`
    : `<b class="big">⭐ ${esc(Number(data.rating).toLocaleString("ru-RU", { maximumFractionDigits: 2 }))}</b>
       <span class="muted">${data.reviews_count} ${plural(data.reviews_count, ["оценка", "оценки", "оценок"])}</span>`;
  const declines = Math.round(data.decline_rate * 100);

  let collar;
  if (!data.collar_device_id) {
    collar = `<b>📟 Трекер не привязан</b>
      <span class="muted">Если вам выдали ошейник, привяжите его номер в боте: «Кабинет» → «Трекер».</span>`;
  } else {
    const seen = data.collar_last_point_at
      ? `последняя точка — ${fmtWhen(data.collar_last_point_at)}`
      : "на связь ещё не выходил — включите его";
    collar = `<b>📟 Трекер ${esc(data.collar_device_id)}</b><span class="muted">${esc(seen)}</span>`;
  }

  return `
    <section class="card">
      <div class="row"><div class="rating">${rating}</div>
        <span class="badge">${esc(CATEGORY_LABEL[data.category] || data.category)}</span></div>
      <div class="stats">
        <div><b>${data.walks_total}</b><span class="muted">${plural(data.walks_total, ["прогулка", "прогулки", "прогулок"])}</span></div>
        <div><b>${data.clients_total}</b><span class="muted">${plural(data.clients_total, ["клиент", "клиента", "клиентов"])}</span></div>
        <div><b class="${declines ? "warn" : ""}">${declines}%</b><span class="muted">отказов</span></div>
      </div>
      <p class="note flat">Отказы — сколько предложений вы отклонили из тех, на которые ответили. По этому же числу вас ранжирует подбор: чем меньше, тем выше вы в выдаче.</p>
    </section>
    <section class="card status ${data.collar_device_id && data.collar_last_point_at ? "on" : ""}">${collar}</section>`;
}

function walkRow(walk) {
  const facts = [`${fmtDate(walk.walked_at)}, ${timeFmt.format(new Date(walk.walked_at))}`];
  if (walk.duration_minutes) facts.push(`${walk.duration_minutes} мин`);
  // заработок ситтера, не клиентский чек (KAN-216): price_kopecks не показываем
  const payout = walk.walker_payout_kopecks != null ? `<b class="payout">+${esc(fmtMoney(walk.walker_payout_kopecks))}</b>` : "";
  const rating = walk.client_rating != null
    ? `<span class="stars">${stars(walk.client_rating)}</span>`
    : `<span class="muted">без оценки</span>`;
  return `<button class="item" data-act="cabinet-walk" data-id="${esc(walk.order_id)}">
    <div class="row"><b>${esc(walk.pet_name || "Питомец")}</b>${payout}</div>
    <div class="row"><span class="muted">${esc(facts.join(" · "))}</span>${rating}</div>
  </button>`;
}

function reviewRow(review) {
  return `<div class="item">
    <div class="row"><b>${esc(review.author_name)}</b><span class="stars">${stars(review.rating)}</span></div>
    ${review.comment ? `<div class="comment">${esc(review.comment)}</div>` : `<div class="muted">Без текста</div>`}
    <div class="muted">${esc(fmtDate(review.created_at))}</div>
  </div>`;
}

function listView({ box, row, empty }) {
  if (!box.items.length) {
    if (box.error) return stateBlock("⚠️", "Не получилось загрузить", box.error, "cabinet-list-retry", "Повторить");
    if (!box.loaded) return SPINNER;
    return stateBlock(...empty);
  }
  // ошибка догрузки не прячет уже показанное: строка с причиной и та же кнопка как «повторить»
  return `<section class="card list">${box.items.map(row).join("")}</section>
    ${box.error ? `<p class="notice error">${esc(box.error)}</p>` : ""}
    ${box.hasMore ? `<button class="btn ghost wide" data-act="cabinet-more" ${box.loading ? "disabled" : ""}>
      ${box.loading ? "Загружаю…" : box.error ? "Повторить" : "Показать ещё"}</button>` : ""}`;
}

function cabinetView() {
  const chips = Object.entries(LISTS).map(
    ([key, { label }]) =>
      `<button class="chip ${section === key ? "on" : ""}" data-act="cabinet-section" data-section="${key}">${label}</button>`,
  ).join("");
  const links = LINKS.map(
    ({ act, icon, label, hint }) => `<button class="item link-row" data-act="${esc(act)}">
      <div class="row"><span>${esc(icon)} <b>${esc(label)}</b></span><span class="chev">›</span></div>
      ${hint ? `<div class="muted">${esc(hint)}</div>` : ""}</button>`,
  ).join("");
  return `${overviewView()}
    <div class="chips">${chips}</div>
    ${listView(LISTS[section])}
    ${links ? `<h3>Ещё</h3><section class="card list">${links}</section>` : ""}`;
}

registerScreen({
  key: "cabinet",
  label: "👤 Кабинет",
  view: cabinetView,
  open: openCabinet,
  actions: {
    "cabinet-retry": () => loadOverview(),
    "cabinet-section": (data) => {
      section = data.section;
      const box = LISTS[section].box;
      return !box.loaded && !box.loading ? loadList(box, true) : undefined;
    },
    "cabinet-list-retry": () => loadList(LISTS[section].box, true),
    "cabinet-more": () => loadList(LISTS[section].box, false),
    "cabinet-walk": ({ id }) => openOrder(id),
  },
});
