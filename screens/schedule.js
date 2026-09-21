// Экран «Расписание» (KAN-492): чтение и запись расписаний, пауза, отпуск, выключатель.
// KAN-510: расписаний два — выгул (availability) и заезды на передержку
// (boarding_availability, KAN-160). Редактор один, у каждого расписания свой черновик.
import { TZ_OFFSET_HOURS } from "../config.js";
import {
  dayFmt, esc, fmtWhen, haptic, keyFmt, onProfile, patchProfile, registerScreen, render, state,
} from "../core.js";

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

// Услуга → поле профиля и подписи. У передержки интервал значит «когда можно привезти
// собаку», а не «когда работаю» — формулировки те же, что в боте (SCHEDULE_BOARDING_INTRO).
const MODES = {
  walk: {
    field: "availability",
    flag: "does_walk",
    tab: "🐕 Выгул",
    daysTitle: "Когда гуляю",
    dayOff: "выходной",
    save: "Сохранить расписание выгула",
    saved: "Расписание выгула сохранено",
    notSet: "Расписание не задано — вы в подборе в любое время. Выберите готовый вариант недели или настройте дни.",
    allOff: "Все дни выходные — это то же, что «расписание не задано»: вы будете доступны ВСЕГДА. Чтобы не получать заказы, выключите приём заказов выше.",
  },
  boarding: {
    field: "boarding_availability",
    flag: "does_boarding",
    tab: "🏠 Передержка",
    daysTitle: "Когда принимаю заезды",
    dayOff: "заезды не принимаю",
    save: "Сохранить расписание передержки",
    saved: "Расписание передержки сохранено",
    notSet: "Расписание не задано — вы принимаете заезды в любое время. Выберите готовый вариант недели или настройте дни.",
    allOff: "Ни одного окна — это то же, что «расписание не задано»: заезды принимаются ВСЕГДА. Чтобы не получать заказы на передержку, выключите приём заказов выше.",
  },
};

let mode = "walk"; // какое расписание открыто
const drafts = { walk: null, boarding: null }; // расписание в правке; пустой объект = «не задано»
const seen = { walk: null, boarding: null }; // что пришло с сервера в прошлый раз
let saving = null; // услуга, чьё расписание сейчас уходит в PATCH
let openDay = null;

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
  slots?.length ? slots.map(([from, to]) => `${from}–${to}`).join(", ") : MODES[mode].dayOff;

// какие расписания показывать: только услуги, которые ситтер оказывает (KAN-364).
// does_walk у старого ядра нет вовсе — отсутствие поля значит «выгул есть»
function modesOf(profile) {
  return Object.keys(MODES).filter((key) =>
    key === "walk" ? profile.does_walk !== false : Boolean(profile[MODES[key].flag]));
}

const isDirty = (key) => !same(drafts[key], state.profile[MODES[key].field]);

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

function statusLine(profile) {
  const snoozed = profile.snooze_until && new Date(profile.snooze_until) > new Date();
  if (!profile.is_available) return ["off", "⏸ Приём заказов выключен", "Включите, чтобы вернуться в подбор"];
  if (snoozed) return ["off", `⏸ Пауза до ${fmtWhen(profile.snooze_until)}`, "Снимется сама"];
  // «в подборе до…» ядро считает по расписанию ВЫГУЛА; для передержки таких полей
  // в профиле нет — статус не выдумываем, показываем только само расписание
  if (mode === "boarding") return null;
  if (profile.available_now) {
    const until = profile.available_until ? ` до ${fmtWhen(profile.available_until)}` : "";
    return ["on", `🟢 Вы в подборе${until}`, "Клиенты видят вас в поиске"];
  }
  const next = profile.next_available_at ? fmtWhen(profile.next_available_at) : "не задано";
  return ["idle", `⚪ Следующее окно: ${next}`, "Сейчас нерабочее время по расписанию"];
}

function scheduleView() {
  const profile = state.profile;
  const modes = modesOf(profile);
  if (!modes.includes(mode)) mode = modes[0] ?? "walk";
  const labels = MODES[mode];
  const status = statusLine(profile);
  const snoozed = profile.snooze_until && new Date(profile.snooze_until) > new Date();
  const dirty = isDirty(mode);
  const notSet = isEmpty(drafts[mode]);
  const disabled = state.busy ? "disabled" : "";

  // переключатель — только когда услуг две; точка — несохранённые правки на вкладке
  const switcher = modes.length > 1
    ? `<div class="chips">${modes.map((key) =>
        `<button class="chip ${key === mode ? "on" : ""}" data-act="sched-mode" data-mode="${key}" ${disabled}>
          ${MODES[key].tab}${isDirty(key) ? " •" : ""}</button>`).join("")}</div>`
    : "";

  const days = DAYS.map(([day, label]) => dayRow(day, label)).join("");
  const presets = PRESETS.map(
    ([label], index) =>
      `<button class="chip" data-act="preset" data-index="${index}" ${disabled}>${esc(label)}</button>`,
  ).join("");

  let emptyNote = "";
  if (notSet && isEmpty(profile[labels.field])) {
    emptyNote = `<p class="note">${labels.notSet}</p>`;
  } else if (notSet) {
    emptyNote = `<p class="note warn">${labels.allOff}</p>`;
  }
  if (!modes.length) {
    emptyNote = `<p class="note warn">Обе услуги выключены — расписание не действует. Включить: бот, «👤 Моя анкета» → «🧰 Услуги».</p>`;
  }

  return `
    ${status ? `<section class="card status ${status[0]}"><b>${esc(status[1])}</b><span class="muted">${esc(status[2])}</span></section>` : ""}
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
      ${modes.length > 1 ? `<p class="note">Выключатель, пауза и отпуск общие — действуют и на выгул, и на передержку.</p>` : ""}
    </section>
    ${switcher}
    ${mode === "boarding" ? `<p class="note">Это окна, когда вы принимаете заезды на передержку — в это время вы в списке нянь. Сами собаки живут у вас и вне этих окон.</p>` : ""}
    <h3>Готовая неделя</h3>
    <div class="chips">${presets}</div>
    <h3>${labels.daysTitle} <span class="muted">· время московское</span></h3>
    ${emptyNote}
    <section class="card days">${days}</section>
    <div class="savebar ${dirty ? "show" : ""}">
      <button class="btn ghost" data-act="reset" ${disabled}>Отменить</button>
      <button class="btn grow" data-act="save" ${disabled}>${state.busy ? "Сохраняю…" : labels.save}</button>
    </div>`;
}

function dayRow(day, label) {
  const slots = drafts[mode][day] || [];
  const chips = slotsToChips(slots);
  const open = openDay === day;
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

function setDay(day, slots) {
  const next = { ...drafts[mode] };
  if (slots.length) next[day] = slots;
  else delete next[day];
  drafts[mode] = next;
  state.notice = null;
}

// applyProfile приходит после загрузки и после ЛЮБОГО PATCH (пауза, выключатель,
// сохранение соседнего расписания). Черновик пересобираем, только если в нём нет
// несохранённых правок или это его только что сохранили, — иначе правки одной
// вкладки пропадали бы при сохранении другой.
onProfile((profile) => {
  for (const key of Object.keys(MODES)) {
    const server = normalize(profile[MODES[key].field]);
    if (drafts[key] === null || saving === key || same(drafts[key], seen[key])) drafts[key] = server;
    seen[key] = server;
  }
});

registerScreen({
  key: "schedule",
  label: "📅 Расписание",
  view: scheduleView,
  actions: {
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
    "sched-mode": ({ mode: next }) => {
      mode = next;
      openDay = null;
      state.notice = null;
    },
    preset: ({ index }) => {
      drafts[mode] = normalize(PRESETS[Number(index)][1]);
      openDay = null;
      state.notice = null;
    },
    chip: ({ day, chip }) => {
      const keys = slotsToChips(drafts[mode][day] || []) || new Set();
      if (keys.has(chip)) keys.delete(chip);
      else keys.add(chip);
      setDay(day, chipsToSlots(keys));
    },
    "open-day": ({ day }) => {
      openDay = openDay === day ? null : day;
    },
    "add-interval": ({ day }) => setDay(day, [...(drafts[mode][day] || []), ["", ""]]),
    "del-interval": ({ day, index }) =>
      setDay(day, (drafts[mode][day] || []).filter((_, i) => i !== Number(index))),
    copy: ({ day, to }) => {
      const slots = drafts[mode][day] || [];
      for (const target of to === "work" ? WORKDAYS : ALL_DAYS) setDay(target, slots);
    },
    reset: () => {
      drafts[mode] = normalize(state.profile[MODES[mode].field]);
      state.notice = null;
    },
    save: () => {
      // интервалы дня — по возрастанию: «вечер» можно вписать раньше «утра»
      const draft = drafts[mode];
      for (const day of Object.keys(draft)) {
        draft[day] = [...draft[day]].sort((a, b) => a[0].localeCompare(b[0]));
      }
      for (const [day, label] of DAYS) {
        const problem = validSlots(draft[day] || []);
        if (problem) {
          openDay = day;
          state.notice = { kind: "error", text: `${label}: ${problem}` };
          haptic("error");
          return undefined;
        }
      }
      // в PATCH уходит ТОЛЬКО открытое расписание: правки соседней вкладки ждут своего «Сохранить»
      saving = mode;
      return patchProfile({ [MODES[mode].field]: normalize(draft) }, MODES[mode].saved).finally(() => {
        saving = null;
      });
    },
  },
  changes: {
    vacation: (input) => {
      if (!input.value) return;
      const [year, month, day] = input.value.split("-").map(Number);
      // до конца выбранного дня по Москве
      const until = new Date(Date.UTC(year, month - 1, day, 23 - TZ_OFFSET_HOURS, 59, 59));
      patchProfile({ snooze_until: until.toISOString() }, `Отпуск до ${dayFmt.format(until)} включительно`);
    },
    time: (input) => {
      const { day, index, edge } = input.dataset;
      const slots = (drafts[mode][day] || [["", ""]]).map(([from, to]) => [from, to]);
      slots[Number(index)][Number(edge)] = input.value;
      setDay(day, slots);
      render();
    },
  },
});
