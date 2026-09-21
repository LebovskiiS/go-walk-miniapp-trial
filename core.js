// Общее ядро мини-аппа ситтера (KAN-505): состояние оболочки, утилиты, реестр экранов,
// отрисовка и события. Без сборки и библиотек: состояние → render() → строка HTML,
// клики — делегированием по data-act. Всё, что пришло с сервера, проходит через esc().
//
// Экран — отдельный файл в screens/: своё состояние держит у себя в модуле и
// регистрируется через registerScreen(). core про конкретные экраны не знает.
import { api, ApiError, insideTelegram } from "./api.js";
import { TZ } from "./config.js";

export const tg = window.Telegram?.WebApp;
const root = document.getElementById("app");

export const state = {
  screen: "loading", // loading | outside | gate | fatal | main
  message: "",
  tab: null, // ключ открытой вкладки; по умолчанию — первый зарегистрированный экран
  profile: null,
  busy: false,
  notice: null, // {kind: "ok" | "error", text}
};

// --- утилиты -----------------------------------------------------------------

const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
export const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (ch) => ESC[ch]);

export const dayFmt = new Intl.DateTimeFormat("ru-RU", { timeZone: TZ, day: "numeric", month: "short" });
export const timeFmt = new Intl.DateTimeFormat("ru-RU", { timeZone: TZ, hour: "2-digit", minute: "2-digit" });
export const keyFmt = new Intl.DateTimeFormat("en-CA", { timeZone: TZ }); // YYYY-MM-DD

export function fmtWhen(iso) {
  if (!iso) return "";
  const date = new Date(iso);
  const today = keyFmt.format(new Date());
  const tomorrow = keyFmt.format(new Date(Date.now() + 86400000));
  const key = keyFmt.format(date);
  const day = key === today ? "сегодня" : key === tomorrow ? "завтра" : dayFmt.format(date);
  return `${day}, ${timeFmt.format(date)}`;
}

export const fmtMoney = (kopecks) => `${Math.round(kopecks / 100).toLocaleString("ru-RU")} ₽`;
export const shortId = (id) => "№" + String(id).slice(0, 8);

export function haptic(kind) {
  try {
    tg?.HapticFeedback?.notificationOccurred(kind);
  } catch {
    // старый клиент без HapticFeedback — не критично
  }
}

export const SPINNER = `<div class="state"><div class="spinner"></div></div>`;

export function stateBlock(icon, title, text, act, button) {
  return `<div class="state"><div class="state-icon">${icon}</div><h2>${esc(title)}</h2>
    <p class="muted">${esc(text)}</p>
    ${act ? `<button class="btn" data-act="${act}">${esc(button)}</button>` : ""}</div>`;
}

export const PAGE = 10;

export async function fetchPage(path, offset) {
  // просим на один больше: лишний — только признак «дальше есть»
  const glue = path.includes("?") ? "&" : "?";
  const page = await api("GET", `${path}${glue}limit=${PAGE + 1}&offset=${offset}`);
  return { items: page.slice(0, PAGE), hasMore: page.length > PAGE };
}

// --- реестр экранов ----------------------------------------------------------

const SCREENS = []; // вкладки — в порядке регистрации (порядок импортов в app.js)
const OVERLAYS = []; // экраны поверх вкладок (карточка заказа): {isOpen, view, close}
const PROFILE_HOOKS = [];
const ACTIONS = {
  close: () => tg?.close(),
  reload: () => location.reload(),
  back: () => currentOverlay()?.close(),
  tab: ({ tab }) => {
    state.tab = tab;
    state.notice = null;
    return SCREENS.find((screen) => screen.key === tab)?.open?.();
  },
};
const CHANGES = {};

// data-act → обработчик(dataset). Вернул Promise — перерисовывает сам.
export function registerActions(actions) {
  Object.assign(ACTIONS, actions);
}

// data-change → обработчик(input)
export function registerChanges(changes) {
  Object.assign(CHANGES, changes);
}

// {key, label, view, open?, actions?, changes?}; open() зовётся при переходе на вкладку,
// open(params) — при входе по ссылке (params — URLSearchParams адреса)
export function registerScreen(screen) {
  SCREENS.push(screen);
  if (screen.actions) registerActions(screen.actions);
  if (screen.changes) registerChanges(screen.changes);
}

export function registerOverlay(overlay) {
  OVERLAYS.push(overlay);
}

// экран пересобирает своё состояние из профиля на каждом applyProfile
export function onProfile(hook) {
  PROFILE_HOOKS.push(hook);
}

const currentOverlay = () => OVERLAYS.find((overlay) => overlay.isOpen());

// --- профиль -----------------------------------------------------------------

export function applyProfile(profile) {
  state.profile = profile;
  for (const hook of PROFILE_HOOKS) hook(profile);
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

export async function patchProfile(body, okText) {
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

// --- отрисовка -----------------------------------------------------------------

export function render() {
  const showBack = state.screen === "main" && currentOverlay() !== undefined;
  if (showBack) tg?.BackButton?.show();
  else tg?.BackButton?.hide();
  root.innerHTML = view();
}

function view() {
  switch (state.screen) {
    case "loading":
      return SPINNER;
    case "outside":
      return stateBlock("🐾", "Кабинет ситтера открывается внутри Telegram",
        "Откройте бота @go_walk_sitter_bot и перейдите по ссылке на кабинет.");
    case "gate":
      return stateBlock("📋", "Кабинет пока недоступен", state.message, "close", "Закрыть");
    case "fatal":
      return stateBlock("⚠️", "Не получилось открыть кабинет", state.message, "reload", "Повторить");
    default:
      return currentOverlay()?.view() ?? mainView();
  }
}

function mainView() {
  const tabs = SCREENS.map(
    ({ key, label }) =>
      `<button class="tab ${state.tab === key ? "on" : ""}" data-act="tab" data-tab="${key}">${label}</button>`,
  ).join("");
  const screen = SCREENS.find(({ key }) => key === state.tab);
  return `<nav class="tabs">${tabs}</nav>${screen.view()}`;
}

// --- события и запуск ----------------------------------------------------------

root.addEventListener("click", (event) => {
  const target = event.target.closest("[data-act]");
  if (!target || target.disabled) return;
  const result = ACTIONS[target.dataset.act]?.(target.dataset);
  // асинхронные действия перерисовывают сами; синхронным хватает одного render()
  if (!(result instanceof Promise)) render();
});

root.addEventListener("change", (event) => {
  const input = event.target.closest("[data-change]");
  if (input) CHANGES[input.dataset.change]?.(input);
});

// Ссылки из бота (KAN-494): ?tab=<ключ экрана> открывает вкладку; остальные параметры
// разбирает сам экран в open(params) — «Заказы» по ?order=<id> сразу открывают карточку.
function applyLink() {
  const params = new URLSearchParams(location.search);
  const screen = SCREENS.find(({ key }) => key === params.get("tab"));
  if (!screen) return;
  state.tab = screen.key;
  screen.open?.(params);
}

export async function boot() {
  state.tab = SCREENS[0].key;
  tg?.ready();
  tg?.expand();
  tg?.BackButton?.onClick(() => {
    currentOverlay()?.close();
    render();
  });
  tg?.onEvent?.("themeChanged", render);
  if (!insideTelegram()) {
    state.screen = "outside";
    return render();
  }
  try {
    applyProfile(await api("GET", "/walker/me"));
    if (state.screen === "main") applyLink();
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
