// Экран «Анкета» (KAN-507): поля профиля, услуги, размеры собак, рабочая зона,
// передержка. Запись — PATCH /walker/me; имя и email живут на users, но пишутся
// тем же PATCH (ядро само раскладывает по таблицам), а читаются из GET /me.
//
// Расписание заездов передержки (boarding_availability) — во вкладке
// «Расписание» (KAN-510), здесь на него только ссылка.
import { api, ApiError } from "../api.js";
import {
  applyProfile, esc, haptic, registerScreen, render, state, tg,
} from "../core.js";

const SIZES = [
  ["small", "Маленькие", "до 10 кг"],
  ["medium", "Средние", "10–25 кг"],
  ["large", "Крупные", "от 25 кг"],
];
const ALL_SIZES = SIZES.map(([key]) => key);

// Тексты — те же, что в боте (bot/app/texts.py): правила у анкеты в боте и здесь одни
const T = {
  nameLocked: "Имя сверено с паспортом — изменить его можно через поддержку.",
  lastNameLocked: "Фамилия уже указана. Изменить её можно через поддержку.",
  lastNameHint: "Нужна для проверки документов и поддержки; клиенты её не видят.",
  emailHint: "Второй способ связи, если Telegram будет недоступен.",
  needEmail: "Похоже на некорректный email. Введите в формате name@example.com.",
  bioHint: "Опыт, с какими собаками работаете. Это видят клиенты при выборе.",
  noServices: "Услуги не выбраны — новые заказы приходить не будут. Остальные настройки сохранятся.",
  needSize: "Выберите хотя бы один размер собак.",
  boardingAddressHint: "Где будут жить собаки: город, улица, дом. Клиент увидит адрес только после того, как вы примете заказ.",
  extHint: "Сколько отзывов у вас на других площадках. Если нет — 0.",
  needExt: "Нужно число от 0 до 100000. Если отзывов нет — поставьте 0.",
  zoneNotOther: "Это не адрес передержки и не трекинг прогулки — только точка, рядом с которой вы берёте заказы. По ней вас находят клиенты рядом.",
  noZone: "Рабочая зона ещё не задана — клиенты рядом вас не находят.",
  imprecise: "Не нашёл такой адрес с точностью хотя бы до улицы. Напишите полнее — город, улица и дом (например: Москва, Тверская 1) — или нажмите «Моя геопозиция». Ничего не сохранил.",
  geocoderDown: "Сервис распознавания адресов сейчас недоступен — с вашим адресом всё в порядке. Повторите через минуту или нажмите «Моя геопозиция»: она сохраняется без распознавания. Рабочая зона пока не менялась.",
  zoneSaved: "✅ Рабочая зона обновлена.",
  saved: "✅ Сохранено.",
};

let me = null; // GET /me: имя и email
let draft = null; // правки анкеты до «Сохранить»
let busy = false;
let started = false;
let notice = null; // {kind, text} — про анкету
let zone = { label: null, key: null, busy: false, notice: null, input: "" };

// --- черновик -------------------------------------------------------------------

function fromProfile(profile) {
  return {
    last_name: profile.last_name ?? "",
    email: me?.email ?? "",
    bio: profile.bio ?? "",
    does_walk: profile.does_walk,
    does_boarding: profile.does_boarding,
    // null в ядре = «любые»: показываем как три выбранных
    pet_sizes: new Set(profile.pet_sizes ?? ALL_SIZES),
    boarding_address: profile.boarding_address ?? "",
    boarding_max_pets: profile.boarding_max_pets ?? null,
    claimed_external_reviews:
      profile.claimed_external_reviews == null ? "" : String(profile.claimed_external_reviews),
  };
}

const sizesValue = (set) =>
  set.size === ALL_SIZES.length ? null : ALL_SIZES.filter((key) => set.has(key));

// Только изменённые поля: PATCH частичный, а лишнее поле может упереться в
// замок (фамилия) или стереть то, что правили в боте параллельно.
function changes() {
  const profile = state.profile;
  const base = fromProfile(profile);
  const body = {};
  const text = (key) => draft[key].trim();
  if (text("last_name") !== base.last_name && text("last_name")) body.last_name = text("last_name");
  if (text("email") !== base.email) body.email = text("email") || null;
  if (text("bio") !== base.bio) body.bio = text("bio") || null;
  if (draft.does_walk !== base.does_walk) body.does_walk = draft.does_walk;
  if (draft.does_boarding !== base.does_boarding) body.does_boarding = draft.does_boarding;
  if (JSON.stringify(sizesValue(draft.pet_sizes)) !== JSON.stringify(sizesValue(base.pet_sizes))) {
    body.pet_sizes = sizesValue(draft.pet_sizes);
  }
  if (text("boarding_address") !== base.boarding_address) {
    body.boarding_address = text("boarding_address") || null;
  }
  if (draft.boarding_max_pets !== base.boarding_max_pets) body.boarding_max_pets = draft.boarding_max_pets;
  if (text("claimed_external_reviews") !== base.claimed_external_reviews) {
    const raw = text("claimed_external_reviews");
    body.claimed_external_reviews = raw === "" ? null : Number(raw);
  }
  return body;
}

function problem(body) {
  if (draft.pet_sizes.size === 0) return T.needSize;
  if (body.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(body.email)) return T.needEmail;
  const ext = body.claimed_external_reviews;
  if (ext != null && !(Number.isInteger(ext) && ext >= 0 && ext <= 100000)) return T.needExt;
  return null;
}

// --- рабочая зона -----------------------------------------------------------------

async function loadZoneLabel() {
  const { lat, lon } = state.profile;
  const key = lat == null ? null : `${lat},${lon}`;
  if (key === zone.key) return;
  zone.key = key;
  zone.label = null;
  if (key === null) return;
  const coords = `точка ${lat.toFixed(5)}, ${lon.toFixed(5)}`;
  try {
    const found = await api("GET", `/geo/reverse?lat=${lat}&lon=${lon}`);
    zone.label = found.address;
  } catch (err) {
    // 404 — рядом нет адресов (парк, вода); 502 — геокодер лежит. Точка сохранена в любом случае.
    zone.label = err instanceof ApiError && err.status === 404
      ? `${coords} (адрес рядом не определился, координаты сохранены)`
      : coords;
  }
  if (zone.key === key) render();
}

function zoneError(err) {
  if (err instanceof ApiError && err.code === "address_imprecise") return T.imprecise;
  if (err instanceof ApiError && err.code === "geocoder_unavailable") return T.geocoderDown;
  return err.message;
}

async function saveZone(body, okText) {
  zone.busy = true;
  zone.notice = null;
  render();
  try {
    applyProfile(await api("PATCH", "/walker/me", body));
    zone.notice = { kind: "ok", text: okText };
    zone.input = "";
    haptic("success");
    loadZoneLabel();
  } catch (err) {
    // ввод не теряем: при 502 адрес ни при чём, его можно просто отправить ещё раз
    zone.notice = { kind: "error", text: zoneError(err) };
    haptic("error");
  }
  zone.busy = false;
  render();
}

// Геопозиция: LocationManager Telegram (Bot API 8.0+) — он же спрашивает
// разрешение у пользователя; в старых клиентах — обычный navigator.geolocation.
async function currentPosition() {
  const lm = tg?.LocationManager;
  if (lm && tg.isVersionAtLeast?.("8.0")) {
    if (!lm.isInited) await new Promise((resolve) => lm.init(resolve));
    if (!lm.isLocationAvailable) {
      throw new Error("На этом устройстве геопозиция недоступна — напишите адрес текстом.");
    }
    const data = await new Promise((resolve) => lm.getLocation(resolve));
    if (!data) {
      throw new Error(
        "Нет доступа к геопозиции. Разрешите его в настройках кабинета (⋯ → Настройки) или напишите адрес текстом.",
      );
    }
    return { lat: data.latitude, lon: data.longitude };
  }
  if (!navigator.geolocation) throw new Error("Геопозиция здесь недоступна — напишите адрес текстом.");
  return new Promise((resolve, reject) => {
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ lat: pos.coords.latitude, lon: pos.coords.longitude }),
      () => reject(new Error("Не получилось определить геопозицию — напишите адрес текстом.")),
      { enableHighAccuracy: true, timeout: 15000 },
    );
  });
}

// --- отрисовка ----------------------------------------------------------------------

const noticeHtml = (item) =>
  item ? `<p class="notice ${item.kind}">${esc(item.text)}</p>` : "";

function field(key, label, { hint = "", type = "text", max = 500, area = false, attrs = "" } = {}) {
  const value = esc(draft[key]);
  const input = area
    ? `<textarea class="input" data-field="${key}" maxlength="${max}" rows="4" ${attrs}>${value}</textarea>`
    : `<input class="input" type="${type}" data-field="${key}" maxlength="${max}" value="${value}" ${attrs}>`;
  return `<label class="field"><span class="field-label">${esc(label)}</span>${input}
    ${hint ? `<span class="note">${esc(hint)}</span>` : ""}</label>`;
}

function locked(label, value, hint) {
  return `<div class="field"><span class="field-label">${esc(label)}</span>
    <div class="row"><b>${esc(value)}</b><span class="muted">🔒</span></div>
    <span class="note">${esc(hint)}</span></div>`;
}

function serviceRow(key, title, hint) {
  return `<div class="row"><div><b>${title}</b><div class="muted">${esc(hint)}</div></div>
    <button class="switch ${draft[key] ? "on" : ""}" data-act="profileToggle" data-key="${key}"
      aria-label="${esc(title)}" ${busy ? "disabled" : ""}><i></i></button></div>`;
}

function profileView() {
  const profile = state.profile;
  if (!me || !draft) {
    if (!started) {
      // вкладка открыта без перехода (первая по порядку) — open() ещё не звали
      started = true;
      queueMicrotask(open);
    }
    return `<div class="state"><div class="spinner"></div></div>`;
  }
  const disabled = busy ? "disabled" : "";
  const dirty = Object.keys(changes()).length > 0;

  const sizes = SIZES.map(
    ([key, label, weight]) =>
      `<button class="chip ${draft.pet_sizes.has(key) ? "on" : ""}" data-act="profileSize"
        data-size="${key}" ${disabled}>${label} · ${weight}</button>`,
  ).join("");

  const pets = draft.boarding_max_pets;
  const boarding = draft.does_boarding
    ? `<h3>Передержка</h3>
      <section class="card stack">
        ${field("boarding_address", "Адрес передержки", { hint: T.boardingAddressHint })}
        <div class="row"><div><b>Собак одновременно</b><div class="muted">${pets ? "" : "не указано"}</div></div>
          <div class="stepper">
            <button class="btn ghost" data-act="profilePets" data-step="-1" ${disabled || pets <= 1 ? "disabled" : ""}>−</button>
            <b>${pets ?? "—"}</b>
            <button class="btn ghost" data-act="profilePets" data-step="1" ${disabled || pets >= 10 ? "disabled" : ""}>+</button>
          </div></div>
        <button class="link" data-act="tab" data-tab="schedule">🗓 Расписание заездов — во вкладке «Расписание» ›</button>
      </section>`
    : "";

  const zoneLabel = profile.lat == null ? T.noZone : zone.label ?? "Определяю адрес…";
  const zoneDisabled = zone.busy ? "disabled" : "";

  return `
    ${noticeHtml(notice)}
    <button class="card item-link" data-act="photosOpen">
      <span><b>🖼 Фото и документы</b>
        <span class="muted">${esc(photosHint(profile))}</span></span>
      <span class="chev">›</span>
    </button>
    <h3>О вас</h3>
    <section class="card stack">
      ${locked("Имя", me.name, T.nameLocked)}
      ${profile.last_name
        ? locked("Фамилия", profile.last_name, T.lastNameLocked)
        : field("last_name", "Фамилия", { hint: T.lastNameHint, max: 100 })}
      ${field("email", "Email", { hint: T.emailHint, type: "email", max: 254, attrs: 'inputmode="email" autocomplete="email"' })}
      ${field("bio", "О себе", { hint: T.bioHint, area: true, max: 2000 })}
    </section>

    <h3>Услуги</h3>
    <section class="card stack">
      ${serviceRow("does_walk", "🐕 Выгул", "Обычные и экспресс-заказы")}
      ${serviceRow("does_boarding", "🏠 Передержка", "Собака живёт у вас")}
      ${!draft.does_walk && !draft.does_boarding ? `<p class="note warn">${esc(T.noServices)}</p>` : ""}
    </section>

    <h3>Размеры собак</h3>
    <div class="chips">${sizes}</div>
    ${draft.pet_sizes.size === 0 ? `<p class="note warn">${esc(T.needSize)}</p>` : ""}

    ${boarding}

    <h3>Отзывы с других площадок</h3>
    <section class="card">
      ${field("claimed_external_reviews", "Количество отзывов", { hint: T.extHint, type: "number", max: 6, attrs: 'inputmode="numeric" min="0" max="100000"' })}
    </section>

    <h3>Рабочая зона</h3>
    <section class="card stack">
      <div><b>${esc(zoneLabel)}</b></div>
      <p class="note">${esc(T.zoneNotOther)}</p>
      ${noticeHtml(zone.notice)}
      <input class="input" type="text" data-zone="input" maxlength="500" value="${esc(zone.input)}"
        placeholder="Город, улица, дом — например: Москва, Тверская 1" ${zoneDisabled}>
      <div class="row gap">
        <button class="btn grow" data-act="zoneAddress" ${zoneDisabled}>${zone.busy ? "Сохраняю…" : "Сохранить адрес"}</button>
        <button class="btn ghost grow" data-act="zoneGeo" ${zoneDisabled}>📍 Моя геопозиция</button>
      </div>
    </section>

    <div class="savebar profile-savebar ${dirty ? "show" : ""}">
      <button class="btn ghost" data-act="profileReset" ${disabled}>Отменить</button>
      <button class="btn grow" data-act="profileSave" ${disabled}>${busy ? "Сохраняю…" : "Сохранить анкету"}</button>
    </div>`;
}

// строка под входом в «Фото и документы» (KAN-508): что там требует внимания
function photosHint(profile) {
  if (profile.avatar_reject_reason && !profile.avatar_pending) return "Фото профиля не приняли — загрузите другое";
  if (profile.avatar_pending) return "Фото профиля на проверке";
  if (!profile.has_avatar) return "Фото профиля нет — у клиентов инициалы";
  return "Фото профиля, галерея «Мои фото», документы";
}

// --- действия -------------------------------------------------------------------------

async function open() {
  started = true;
  notice = null;
  if (!me) {
    try {
      me = await api("GET", "/me");
    } catch (err) {
      notice = { kind: "error", text: err.message };
      me = { name: "—", email: null };
    }
  }
  // без несохранённых правок черновик берём заново: профиль могли поменять в боте
  // или на другой вкладке, и старый черновик показал бы это как «правку»
  if (!draft || Object.keys(changes()).length === 0) draft = fromProfile(state.profile);
  render();
  loadZoneLabel();
}

async function save() {
  const body = changes();
  const bad = problem(body);
  if (bad) {
    notice = { kind: "error", text: bad };
    haptic("error");
    return render();
  }
  busy = true;
  notice = null;
  render();
  try {
    applyProfile(await api("PATCH", "/walker/me", body));
    if ("email" in body) me = { ...me, email: body.email };
    draft = fromProfile(state.profile);
    notice = { kind: "ok", text: T.saved };
    haptic("success");
  } catch (err) {
    notice = {
      kind: "error",
      text: err instanceof ApiError && err.code === "name_locked" ? T.lastNameLocked : err.message,
    };
    haptic("error");
  }
  busy = false;
  render();
  window.scrollTo(0, 0);
}

registerScreen({
  key: "profile",
  label: "📝 Анкета",
  view: profileView,
  open,
  actions: {
    profileToggle: ({ key }) => {
      draft[key] = !draft[key];
    },
    profileSize: ({ size }) => {
      if (draft.pet_sizes.has(size)) draft.pet_sizes.delete(size);
      else draft.pet_sizes.add(size);
    },
    profilePets: ({ step }) => {
      const next = (draft.boarding_max_pets ?? 0) + Number(step);
      draft.boarding_max_pets = Math.min(10, Math.max(1, next));
    },
    profileReset: () => {
      draft = fromProfile(state.profile);
      notice = null;
    },
    profileSave: save,
    zoneAddress: () => {
      const address = zone.input.trim();
      if (address.length < 3) {
        zone.notice = { kind: "error", text: "Напишите адрес — город, улицу и дом." };
        return;
      }
      return saveZone({ work_address: address }, T.zoneSaved);
    },
    zoneGeo: async () => {
      zone.busy = true;
      zone.notice = null;
      render();
      let point;
      try {
        point = await currentPosition();
      } catch (err) {
        zone.busy = false;
        zone.notice = { kind: "error", text: err.message };
        return render();
      }
      return saveZone(point, T.zoneSaved);
    },
  },
});

// Текст печатается без перерисовки (иначе терялся бы фокус): черновик обновляем
// по input, а панель «Сохранить» показываем/прячем прямо в DOM.
document.getElementById("app").addEventListener("input", (event) => {
  const target = event.target;
  if (target.dataset.zone === "input") {
    zone.input = target.value;
    return;
  }
  const key = target.dataset.field;
  if (!key || !draft) return;
  draft[key] = target.value;
  const dirty = Object.keys(changes()).length > 0;
  document.querySelector(".profile-savebar")?.classList.toggle("show", dirty);
});
