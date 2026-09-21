// Прототип мини-аппа ситтера (KAN-492, проба эпика KAN-490).
// Без сборки и библиотек: состояние → render() → строка HTML, клики — делегированием
// по data-act. Всё, что пришло с сервера, проходит через esc().
import { api, ApiError, insideTelegram } from "./api.js";
import { TZ, TZ_OFFSET_HOURS } from "./config.js";

const tg = window.Telegram?.WebApp;
const root = document.getElementById("app");

const DAYS = [
  ["mon", "Пн"], ["tue", "Вт"], ["wed", "Ср"], ["thu", "Чт"],
  ["fri", "Пт"], ["sat", "Сб"], ["sun", "Вс"],
];
const WORKDAYS = DAYS.slice(0, 5).map(([key]) => key);
const ALL_DAYS = DAYS.map(([key]) => key);

// Слоты дня и пресеты недели — те же величины, что в боте (bot/app/schedule.py)
const CHIPS = [
  { key: "morning", label: "Утро", from: "06:00", to: "12:00" },
  { key: "daytime", label: "День", from: "12:00", to: "18:00" },
  { key: "evening", label: "Вечер", from: "18:00", to: "23:00" },
];
const fill = (days, slots) => Object.fromEntries(days.map((day) => [day, slots]));
const PRESETS = [
  ["Будни утро+вечер", fill(WORKDAYS, [["06:00", "12:00"], ["18:00", "23:00"]])],
  ["Будни весь день", fill(WORKDAYS, [["06:00", "23:00"]])],
  ["Каждый день", fill(ALL_DAYS, [["06:00", "23:00"]])],
  ["Только выходные", fill(["sat", "sun"], [["08:00", "22:00"]])],
];

const ORDER_TABS = [
  ["active", "Активные"],
  ["completed", "Завершённые"],
  ["cancelled", "Отменённые"],
];
const ACTIVE_STATUSES = ["accepted", "on_the_way", "walking"];
const PAGE = 10;

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

const state = {
  screen: "loading", // loading | outside | gate | fatal | main
  message: "",
  tab: "schedule",
  profile: null,
  draft: null, // расписание в правке; null = «не задано»
  openDay: null,
  busy: false,
  notice: null, // {kind: "ok" | "error", text}
  orders: { tab: "active", items: [], offset: 0, hasMore: false, loading: false, error: null },
  order: null, // {loading, data, error}
};

// --- утилиты -----------------------------------------------------------------

const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (ch) => ESC[ch]);

const dayFmt = new Intl.DateTimeFormat("ru-RU", { timeZone: TZ, day: "numeric", month: "short" });
const timeFmt = new Intl.DateTimeFormat("ru-RU", { timeZone: TZ, hour: "2-digit", minute: "2-digit" });
const keyFmt = new Intl.DateTimeFormat("en-CA", { timeZone: TZ }); // YYYY-MM-DD

function fmtWhen(iso) {
  if (!iso) return "";
  const date = new Date(iso);
  const today = keyFmt.format(new Date());
  const tomorrow = keyFmt.format(new Date(Date.now() + 86400000));
  const key = keyFmt.format(date);
  const day = key === today ? "сегодня" : key === tomorrow ? "завтра" : dayFmt.format(date);
  return `${day}, ${timeFmt.format(date)}`;
}

const fmtMoney = (kopecks) => `${Math.round(kopecks / 100).toLocaleString("ru-RU")} ₽`;
const shortId = (id) => "№" + String(id).slice(0, 8);

function haptic(kind) {
  try {
    tg?.HapticFeedback?.notificationOccurred(kind);
  } catch {
    // старый клиент без HapticFeedback — не критично
  }
}

// --- расписание: чистая логика --------------------------------------------------

function normalize(schedule) {
  // канонический вид для сравнения и отправки: дни по порядку, пустые не храним
  const result = {};
  for (const day of ALL_DAYS) {
    const slots = schedule?.[day];
    if (Array.isArray(slots) && slots.length) result[day] = slots.map(([from, to]) => [from, to]);
  }
  return result;
}

const isEmpty = (schedule) => Object.keys(normalize(schedule)).length === 0;
const same = (a, b) => JSON.stringify(normalize(a)) === JSON.stringify(normalize(b));

function chipsToSlots(keys) {
  // соседние слоты склеиваем: «утро+день» = 06–18, а не два интервала (ядро пускает ≤ 2)
  const slots = [];
  for (const chip of CHIPS) {
    if (!keys.has(chip.key)) continue;
    const last = slots[slots.length - 1];
    if (last && last[1] === chip.from) last[1] = chip.to;
    else slots.push([chip.from, chip.to]);
  }
  return slots;
}

function slotsToChips(slots) {
  // null — день задан «своим» интервалом (например, из бота текстом), в слоты не раскладывается
  const keys = new Set(
    CHIPS.filter((chip) => slots.some(([from, to]) => from <= chip.from && chip.to <= to)).map(
      (chip) => chip.key,
    ),
  );
  return JSON.stringify(chipsToSlots(keys)) === JSON.stringify(slots) ? keys : null;
}

const slotsLabel = (slots) =>
  slots?.length ? slots.map(([from, to]) => `${from}–${to}`).join(", ") : "выходной";

function validSlots(slots) {
  if (slots.length > 2) return "Не больше двух интервалов на день";
  let prevEnd = "";
  for (const [from, to] of slots) {
    if (!from || !to) return "Заполните время начала и конца";
    if (from >= to) return "Конец интервала должен быть позже начала";
    if (from < prevEnd) return "Интервалы не должны пересекаться";
    prevEnd = to;
  }
  return null;
}

function mskDate(offsetDays) {
  // «сейчас» в зоне сервиса, как набор UTC-полей
  const shifted = new Date(Date.now() + TZ_OFFSET_HOURS * 3600000);
  return [shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate() + offsetDays];
}

// --- загрузка ------------------------------------------------------------------

async function boot() {
  tg?.ready();
  tg?.expand();
  tg?.BackButton?.onClick(() => {
    state.order = null;
    render();
  });
  if (!insideTelegram()) {
    state.screen = "outside";
    return render();
  }
  try {
    applyProfile(await api("GET", "/walker/me"));
  } catch (err) {
    if (err instanceof ApiError && err.code === "walker_profile_not_found") {
      state.screen = "gate";
      state.message = "Анкета ситтера ещё не заполнена. Заполните её в боте — и возвращайтесь.";
    } else {
      state.screen = "fatal";
      state.message = err.message;
    }
  }
  render();
}

function applyProfile(profile) {
  state.profile = profile;
  state.draft = normalize(profile.availability);
  if (profile.status === "approved") {
    state.screen = "main";
  } else {
    state.screen = "gate";
    state.message =
      profile.status === "rejected"
        ? "Анкета отклонена. Подробности и что делать дальше — в боте, раздел «Моя анкета»."
        : "Анкета на проверке. Кабинет откроется после одобрения — мы напишем в боте.";
  }
}

async function patchProfile(body, okText) {
  state.busy = true;
  state.notice = null;
  render();
  try {
    applyProfile(await api("PATCH", "/walker/me", body));
    state.notice = { kind: "ok", text: okText };
    haptic("success");
  } catch (err) {
    state.notice = { kind: "error", text: err.message };
    haptic("error");
  }
  state.busy = false;
  render();
}

async function loadOrders(reset) {
  const box = state.orders;
  if (reset) Object.assign(box, { items: [], offset: 0, hasMore: false });
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
      // просим на один больше: лишний — только признак «дальше есть»
      const page = await api(
        "GET",
        `/orders/mine?status=${box.tab}&limit=${PAGE + 1}&offset=${box.offset}`,
      );
      box.hasMore = page.length > PAGE;
      box.items = box.items.concat(page.slice(0, PAGE));
      box.offset += PAGE;
    }
  } catch (err) {
    box.error = err.message;
  }
  box.loading = false;
  render();
}

async function openOrder(id) {
  state.order = { loading: true, data: null, error: null, id };
  render();
  try {
    state.order.data = await api("GET", `/orders/${id}`);
  } catch (err) {
    state.order.error = err.message;
  }
  state.order.loading = false;
  render();
}

// --- отрисовка -----------------------------------------------------------------

function render() {
  const showBack = state.screen === "main" && state.order !== null;
  if (showBack) tg?.BackButton?.show();
  else tg?.BackButton?.hide();
  root.innerHTML = view();
}

function view() {
  switch (state.screen) {
    case "loading":
      return `<div class="state"><div class="spinner"></div></div>`;
    case "outside":
      return stateBlock("🐾", "Кабинет ситтера открывается внутри Telegram",
        "Откройте бота @go_walk_sitter_bot и перейдите по ссылке на кабинет.");
    case "gate":
      return stateBlock("📋", "Кабинет пока недоступен", state.message, "close", "Закрыть");
    case "fatal":
      return stateBlock("⚠️", "Не получилось открыть кабинет", state.message, "reload", "Повторить");
    default:
      return state.order ? orderView() : mainView();
  }
}

function stateBlock(icon, title, text, act, button) {
  return `<div class="state"><div class="state-icon">${icon}</div><h2>${esc(title)}</h2>
    <p class="muted">${esc(text)}</p>
    ${act ? `<button class="btn" data-act="${act}">${esc(button)}</button>` : ""}</div>`;
}

function mainView() {
  const tabs = [["schedule", "📅 Расписание"], ["orders", "📋 Заказы"]]
    .map(([key, label]) =>
      `<button class="tab ${state.tab === key ? "on" : ""}" data-act="tab" data-tab="${key}">${label}</button>`)
    .join("");
  return `<nav class="tabs">${tabs}</nav>${state.tab === "schedule" ? scheduleView() : ordersView()}`;
}

function statusLine(profile) {
  const snoozed = profile.snooze_until && new Date(profile.snooze_until) > new Date();
  if (!profile.is_available) return ["off", "⏸ Приём заказов выключен", "Включите, чтобы вернуться в подбор"];
  if (snoozed) return ["off", `⏸ Пауза до ${fmtWhen(profile.snooze_until)}`, "Снимется сама"];
  if (profile.available_now) {
    const until = profile.available_until ? ` до ${fmtWhen(profile.available_until)}` : "";
    return ["on", `🟢 Вы в подборе${until}`, "Клиенты видят вас в поиске"];
  }
  const next = profile.next_available_at ? fmtWhen(profile.next_available_at) : "не задано";
  return ["idle", `⚪ Следующее окно: ${next}`, "Сейчас нерабочее время по расписанию"];
}

function scheduleView() {
  const profile = state.profile;
  const [kind, title, hint] = statusLine(profile);
  const snoozed = profile.snooze_until && new Date(profile.snooze_until) > new Date();
  const dirty = !same(state.draft, profile.availability);
  const notSet = isEmpty(state.draft);
  const disabled = state.busy ? "disabled" : "";

  const days = DAYS.map(([day, label]) => dayRow(day, label)).join("");
  const presets = PRESETS.map(
    ([label], index) =>
      `<button class="chip" data-act="preset" data-index="${index}" ${disabled}>${esc(label)}</button>`,
  ).join("");

  let emptyNote = "";
  if (notSet && isEmpty(profile.availability)) {
    emptyNote = `<p class="note">Расписание не задано — вы в подборе в любое время. Выберите готовый вариант недели или настройте дни.</p>`;
  } else if (notSet) {
    emptyNote = `<p class="note warn">Все дни выходные — это то же, что «расписание не задано»: вы будете доступны ВСЕГДА. Чтобы не получать заказы, выключите приём заказов выше.</p>`;
  }

  return `
    <section class="card status ${kind}"><b>${esc(title)}</b><span class="muted">${esc(hint)}</span></section>
    ${state.notice ? `<p class="notice ${state.notice.kind}">${esc(state.notice.text)}</p>` : ""}
    <section class="card row">
      <div><b>Принимаю заказы</b><div class="muted">Главный выключатель</div></div>
      <button class="switch ${profile.is_available ? "on" : ""}" data-act="toggle" ${disabled}
        aria-label="Принимаю заказы"><i></i></button>
    </section>
    <section class="card">
      <div class="row gap">
        ${snoozed
          ? `<button class="btn ghost grow" data-act="unpause" ${disabled}>▶️ Снять паузу</button>`
          : `<button class="btn ghost grow" data-act="pause" ${disabled}>⏸ Пауза до завтра</button>`}
        <label class="btn ghost grow vacation">🏖 Отпуск до…
          <input type="date" data-change="vacation" min="${keyFmt.format(new Date())}" ${disabled}></label>
      </div>
    </section>
    <h3>Готовая неделя</h3>
    <div class="chips">${presets}</div>
    <h3>По дням <span class="muted">· время московское</span></h3>
    ${emptyNote}
    <section class="card days">${days}</section>
    <div class="savebar ${dirty ? "show" : ""}">
      <button class="btn ghost" data-act="reset" ${disabled}>Отменить</button>
      <button class="btn grow" data-act="save" ${disabled}>${state.busy ? "Сохраняю…" : "Сохранить расписание"}</button>
    </div>`;
}

function dayRow(day, label) {
  const slots = state.draft[day] || [];
  const chips = slotsToChips(slots);
  const open = state.openDay === day;
  const chipButtons = CHIPS.map(
    (chip) =>
      `<button class="chip small ${chips?.has(chip.key) ? "on" : ""}" data-act="chip" data-day="${day}"
        data-chip="${chip.key}">${chip.label}</button>`,
  ).join("");

  let editor = "";
  if (open) {
    const rows = (slots.length ? slots : [["", ""]])
      .map(
        ([from, to], index) => `<div class="row gap interval">
          <input type="time" value="${esc(from)}" data-change="time" data-day="${day}" data-index="${index}" data-edge="0">
          <span>—</span>
          <input type="time" value="${esc(to)}" data-change="time" data-day="${day}" data-index="${index}" data-edge="1">
          <button class="icon" data-act="del-interval" data-day="${day}" data-index="${index}" aria-label="Убрать">✕</button>
        </div>`,
      )
      .join("");
    editor = `<div class="editor">${rows}
      ${slots.length < 2 ? `<button class="link" data-act="add-interval" data-day="${day}">+ ещё интервал</button>` : ""}
      <div class="row gap">
        <button class="link" data-act="copy" data-day="${day}" data-to="work">Скопировать на будни</button>
        <button class="link" data-act="copy" data-day="${day}" data-to="all">На все дни</button>
      </div></div>`;
  }

  return `<div class="day">
    <button class="day-head" data-act="open-day" data-day="${day}">
      <b>${label}</b><span class="${slots.length ? "" : "muted"}">${esc(slotsLabel(slots))}</span>
      <span class="chev">${open ? "▾" : "▸"}</span>
    </button>
    <div class="chips tight">${chipButtons}</div>${editor}</div>`;
}

function ordersView() {
  const box = state.orders;
  const tabs = ORDER_TABS.map(
    ([key, label]) =>
      `<button class="chip ${box.tab === key ? "on" : ""}" data-act="orders-tab" data-tab="${key}">${label}</button>`,
  ).join("");
  let body;
  if (box.error) {
    body = stateBlock("⚠️", "Не получилось загрузить заказы", box.error, "orders-retry", "Повторить");
  } else if (!box.items.length && box.loading) {
    body = `<div class="state"><div class="spinner"></div></div>`;
  } else if (!box.items.length) {
    const empty = { active: "Активных заказов нет", completed: "Завершённых заказов пока нет", cancelled: "Отменённых заказов нет" };
    body = stateBlock("🐕", empty[box.tab], "Новые предложения приходят сообщением в боте.");
  } else {
    body = `<section class="card list">${box.items.map(orderRow).join("")}</section>
      ${box.hasMore ? `<button class="btn ghost wide" data-act="orders-more" ${box.loading ? "disabled" : ""}>
        ${box.loading ? "Загружаю…" : "Показать ещё"}</button>` : ""}`;
  }
  return `<div class="chips">${tabs}</div>${body}
    <p class="note">Вести прогулку («Вышел», «Забрал», «Завершить», фото) пока нужно в боте.</p>`;
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
  const { loading, data: order, error } = state.order;
  const back = `<button class="link back" data-act="back">‹ К списку</button>`;
  if (loading) return `${back}<div class="state"><div class="spinner"></div></div>`;
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
    ${where.length ? `<h3>Адрес</h3><section class="card stack">${where.map((line) => `<div>${line}</div>`).join("")}</section>` : ""}
    ${pets ? `<h3>Питомцы</h3><section class="card stack">${pets}</section>` : ""}
    ${services ? `<h3>Доп. услуги</h3><section class="card">${services}</section>` : ""}
    <p class="note">Действия по заказу — в боте, раздел «📋 Заказы».</p>`;
}

// --- события -------------------------------------------------------------------

function setDay(day, slots) {
  const next = { ...state.draft };
  if (slots.length) next[day] = slots;
  else delete next[day];
  state.draft = next;
  state.notice = null;
}

const ACTIONS = {
  close: () => tg?.close(),
  reload: () => location.reload(),
  back: () => {
    state.order = null;
  },
  tab: ({ tab }) => {
    state.tab = tab;
    state.notice = null;
    if (tab === "orders" && !state.orders.items.length && !state.orders.loading) return loadOrders(true);
  },
  toggle: () => patchProfile(
    { is_available: !state.profile.is_available },
    state.profile.is_available ? "Приём заказов выключен" : "Приём заказов включён",
  ),
  pause: () => {
    const [year, month, day] = mskDate(1);
    const until = new Date(Date.UTC(year, month, day, 6 - TZ_OFFSET_HOURS));
    return patchProfile({ snooze_until: until.toISOString() }, "Пауза до завтра, 06:00");
  },
  unpause: () => patchProfile({ snooze_until: null }, "Пауза снята"),
  preset: ({ index }) => {
    state.draft = normalize(PRESETS[Number(index)][1]);
    state.openDay = null;
    state.notice = null;
  },
  chip: ({ day, chip }) => {
    const keys = slotsToChips(state.draft[day] || []) || new Set();
    if (keys.has(chip)) keys.delete(chip);
    else keys.add(chip);
    setDay(day, chipsToSlots(keys));
  },
  "open-day": ({ day }) => {
    state.openDay = state.openDay === day ? null : day;
  },
  "add-interval": ({ day }) => setDay(day, [...(state.draft[day] || []), ["", ""]]),
  "del-interval": ({ day, index }) =>
    setDay(day, (state.draft[day] || []).filter((_, i) => i !== Number(index))),
  copy: ({ day, to }) => {
    const slots = state.draft[day] || [];
    for (const target of to === "work" ? WORKDAYS : ALL_DAYS) setDay(target, slots);
  },
  reset: () => {
    state.draft = normalize(state.profile.availability);
    state.notice = null;
  },
  save: () => {
    // интервалы дня — по возрастанию: «вечер» можно вписать раньше «утра»
    for (const day of Object.keys(state.draft)) {
      state.draft[day] = [...state.draft[day]].sort((a, b) => a[0].localeCompare(b[0]));
    }
    for (const [day, label] of DAYS) {
      const problem = validSlots(state.draft[day] || []);
      if (problem) {
        state.openDay = day;
        state.notice = { kind: "error", text: `${label}: ${problem}` };
        haptic("error");
        return undefined;
      }
    }
    return patchProfile({ availability: normalize(state.draft) }, "Расписание сохранено");
  },
  "orders-tab": ({ tab }) => {
    state.orders.tab = tab;
    return loadOrders(true);
  },
  "orders-retry": () => loadOrders(true),
  "orders-more": () => loadOrders(false),
  order: ({ id }) => openOrder(id),
  "order-retry": () => openOrder(state.order.id),
};

root.addEventListener("click", (event) => {
  const target = event.target.closest("[data-act]");
  if (!target || target.disabled) return;
  const result = ACTIONS[target.dataset.act]?.(target.dataset);
  // асинхронные действия перерисовывают сами; синхронным хватает одного render()
  if (!(result instanceof Promise)) render();
});

root.addEventListener("change", (event) => {
  const input = event.target.closest("[data-change]");
  if (!input) return;
  if (input.dataset.change === "vacation" && input.value) {
    const [year, month, day] = input.value.split("-").map(Number);
    // до конца выбранного дня по Москве
    const until = new Date(Date.UTC(year, month - 1, day, 23 - TZ_OFFSET_HOURS, 59, 59));
    patchProfile({ snooze_until: until.toISOString() }, `Отпуск до ${dayFmt.format(until)} включительно`);
  }
  if (input.dataset.change === "time") {
    const { day, index, edge } = input.dataset;
    const slots = (state.draft[day] || [["", ""]]).map(([from, to]) => [from, to]);
    slots[Number(index)][Number(edge)] = input.value;
    setDay(day, slots);
    render();
  }
});

tg?.onEvent?.("themeChanged", render);
boot();
