// Ведение прогулки из карточки заказа (KAN-504): «Вышел» → «Забрал» → «Завершить»
// (у передержки — «Собаку привезли» → «Завершить», KAN-519),
// фото, кнопки активности, просьба выйти раньше. Те же ручки /sessions/*, что у бота
// (bot/app/backend_client.py: walk_action и соседи), и те же слова в отказах.
//
// Статус заказа мини-апп сам не двигает и не угадывает: после каждого шага карточка
// перечитывается из ядра, кнопка очередного шага рисуется только по order.status.
// Бот состояние прогулки тоже берёт из ядра (KAN-498), поэтому шаг отсюда ему не мешает.
import { api } from "../api.js";
import { esc, haptic, registerActions, render } from "../core.js";

const ACTIVE = ["accepted", "on_the_way", "walking"];

// словари активности — sessions/schemas.py: у передержки свой (KAN-242), food общий
const ACTIVITY = {
  drink: ["💧 Попил", "попил"],
  toilet: ["🚻 Туалет", "сходил в туалет"],
  food: ["🍖 Поел", "поел"],
  walk: ["🐕 Погуляли", "погуляли"],
  play: ["🎾 Поиграли", "поиграли"],
};
const WALK_ACTIVITY = ["drink", "toilet", "food"];
const BOARDING_ACTIVITY = ["food", "walk", "play"];

// как на iOS (KAN-459): длинная сторона 2048, JPEG q0.8 — камера телефона отдаёт
// 5–12 МБ, а предел ядра 10 МБ; заодно перекодирование срезает EXIF с координатами
const PHOTO_MAX_SIDE = 2048;
const PHOTO_QUALITY = 0.8;
const PHOTO_KEEP_BYTES = 1_500_000;

const LIVE_LOCATION = "скрепка → «Геопозиция» → «Транслировать»";

// KAN-519: к няне собаку привозит клиент — «Вышел» у передержки нет, первый шаг
// сразу «Собаку привезли» (ядро пускает accepted → walking той же ручкой /start)
const ARRIVED = "🏠 Собаку привезли";

const fresh = (orderId) => ({
  orderId,
  busy: false,
  notice: null, // {kind: "ok" | "error", text}
  tooEarly: false, // ядро ответило order_too_early — показываем путь «попросить клиента»
  boarding: false, // передержка — отказы и подсказки про заезд, а не про «Вышел»
  confirming: false, // «Завершить» ждёт второго нажатия
  upload: null, // {done, total} — идёт отправка фото
  report: null, // {photos, events: {type: count}} — что уже в отчёте клиенту
});

let walk = fresh(null);
let refresh = async () => {}; // «перечитать открытый заказ из ядра» — даёт карточка, см. initWalk

// --- отрисовка -----------------------------------------------------------------

export function walkBlock(order) {
  if (order.id !== walk.orderId) walk = fresh(order.id);
  const notice = walk.notice
    ? `<p class="notice ${walk.notice.kind}">${esc(walk.notice.text)}</p>`
    : "";
  if (!ACTIVE.includes(order.status)) return notice;
  if (order.status === "walking" && !walk.report) loadReport(order.id);

  const boarding = order.type === "boarding";
  walk.boarding = boarding;
  const off = walk.busy ? "disabled" : "";
  let body;
  if (boarding && ["accepted", "on_the_way"].includes(order.status)) body = boardingWaitStep(order, off);
  else if (order.status === "accepted") body = acceptedStep(order, off);
  else if (order.status === "on_the_way") {
    body = `<p class="muted">Вы в пути. Как заберёте собаку — начинайте прогулку.</p>
      <button class="btn wide" data-act="walk-step" data-step="start" ${off}>🐕 Забрал собаку, начать</button>`;
  } else body = walkingStep(boarding, off);

  return `${notice}<section class="card walk">${body}</section>`;
}

function acceptedStep(order, off) {
  const hints = [];
  if (order.early_start_confirmed_at) {
    hints.push("✅ Клиент согласен на ранний выход — можно выходить.");
  } else if (order.early_start_requested_at) {
    hints.push("🙋 Клиента спросили о раннем выходе — ждём ответа. До этого выходить рано.");
  }
  const canAsk = walk.tooEarly && !order.early_start_requested_at && !order.early_start_confirmed_at;
  return `${hints.map((hint) => `<p class="muted">${hint}</p>`).join("")}
    <button class="btn wide" data-act="walk-step" data-step="on-the-way" ${off}>🚶 Вышел</button>
    ${canAsk ? `<button class="btn ghost wide" data-act="walk-early" ${off}>🙋 Попросить клиента выйти раньше</button>` : ""}`;
}

// on_the_way у передержки — начатые старой кнопкой «Вышел» до KAN-519: тот же шаг
function boardingWaitStep(order, off) {
  const hints = ["Ждём собаку — клиент привезёт её к вам. Как привезёт — жмите кнопку ниже."];
  if (order.early_start_confirmed_at) hints.push("✅ Клиент подтвердил ранний заезд.");
  else if (order.early_start_requested_at) hints.push("🙋 Клиента спросили о раннем заезде — ждём ответа.");
  const canAsk = walk.tooEarly && !order.early_start_requested_at && !order.early_start_confirmed_at;
  return `${hints.map((hint) => `<p class="muted">${hint}</p>`).join("")}
    <button class="btn wide" data-act="walk-step" data-step="start" ${off}>${ARRIVED}</button>
    ${canAsk ? `<button class="btn ghost wide" data-act="walk-early" ${off}>🙋 Попросить клиента подтвердить ранний заезд</button>` : ""}`;
}

function walkingStep(boarding, off) {
  if (walk.confirming) {
    return `<b>${boarding ? "Завершить передержку?" : "Завершить прогулку?"}</b>
      <p class="muted">Отменить завершение нельзя: клиент сразу получит отчёт, а заказ уйдёт в выплату.
        Фото и отметки после этого не принимаются.</p>
      <div class="row gap">
        <button class="btn ghost grow" data-act="walk-keep" ${off}>${boarding ? "Ещё не забрали" : "Ещё гуляем"}</button>
        <button class="btn danger grow" data-act="walk-step" data-step="complete" ${off}>
          ${walk.busy ? "Завершаю…" : "Да, завершить"}</button>
      </div>`;
  }
  const chips = (boarding ? BOARDING_ACTIVITY : WALK_ACTIVITY)
    .map((type) => {
      const count = walk.report?.events[type];
      return `<button class="chip" data-act="walk-event" data-type="${type}" ${off}>
        ${ACTIVITY[type][0]}${count ? ` <span class="count">${count}</span>` : ""}</button>`;
    })
    .join("");
  const sending = walk.upload;
  const photos = walk.report?.photos;
  return `<div class="muted">Отмечайте по ходу — клиент видит это в приложении</div>
    <div class="chips">${chips}</div>
    <button class="btn ghost wide" data-act="walk-pick" ${off}>
      ${sending ? `Отправляю фото ${sending.done + 1} из ${sending.total}…`
        : `📷 Добавить фото${photos ? ` · в отчёте ${photos}` : ""}`}</button>
    <button class="btn wide" data-act="walk-finish" ${off}>🏁 Завершить</button>`;
}

// --- отказы — словами, как в боте (texts.py, блок «ведение прогулки») -----------

const GONE = "Это действие уже недоступно: заказ могли отменить или он ушёл дальше. Карточка обновлена.";

const BOARDING_EXPLAIN = {
  order_too_early: "⏰ До заезда ещё далеко, поэтому принять собаку пока нельзя. Если клиент хочет " +
    `привезти её раньше — попросите его подтвердить ранний заезд. Подтвердит — «${ARRIVED}» сработает сразу.`,
  order_not_confirmed: "Клиент ещё не подтвердил передержку — принять собаку пока нельзя. " +
    "Напишите ему в боте, если он молчит.",
  order_not_early: `Уже можно — жмите «${ARRIVED}».`,
};

function explain(err) {
  if (walk.boarding && BOARDING_EXPLAIN[err.code]) return BOARDING_EXPLAIN[err.code];
  switch (err.code) {
    case "order_too_early":
      return "⏰ До заказа ещё далеко, поэтому выйти прямо сейчас нельзя. Если вы уже готовы, а клиенту " +
        "так даже удобнее — попросите его подтвердить ранний выход. Подтвердит — «🚶 Вышел» сработает сразу.";
    case "order_not_confirmed":
      return "Клиент ещё не подтвердил встречу — «🚶 Вышел» сработает после подтверждения. " +
        "Напишите ему в боте, если он молчит.";
    case "order_not_early":
      return "Уже можно выходить — жмите «🚶 Вышел».";
    case "session_status_conflict":
    case "session_not_found":
      return GONE;
    case "http_413":
      return "Файл слишком большой — не больше 10 МБ."; // 413 от прокси, без конверта ядра
    default:
      return err.message; // фото (лимит, 413, 415), сеть — текст ядра как есть
  }
}

const stale = (err) => err.code === "session_status_conflict" || err.code === "session_not_found";

function fail(current, err) {
  current.tooEarly = err.code === "order_too_early";
  current.notice = { kind: "error", text: explain(err) };
  haptic("error");
}

function stepDone(step, order, result) {
  const boarding = order.type === "boarding";
  if (step === "on-the-way") {
    return boarding
      ? `🏠 Ждём собаку. Как клиент привезёт её вам — жмите «${ARRIVED}».`
      : `🚶 Вы в пути. Включите трансляцию геопозиции в чате с ботом (${LIVE_LOCATION}) — клиент увидит, где вы.`;
  }
  if (step === "complete") {
    return boarding ? "🏁 Передержка завершена. Спасибо за работу!" : "🏁 Прогулка завершена. Спасибо за работу!";
  }
  if (boarding) return "🏠 Собака у вас! Отмечайте, когда покормили, погуляли или поиграли, и добавляйте фото.";
  // KAN-180: вердикт проверки ошейника — чьим треком клиент смотрит маршрут
  if (result?.track_source === "collar") {
    return `🐕 Прогулка началась! 🟢 Ошейник работает — клиент видит маршрут с него. Трансляцию геопозиции в чате с ботом всё равно включите (${LIVE_LOCATION}) — это резерв.`;
  }
  if (result?.track_source === "walker_phone") {
    return `🐕 Прогулка началась! 🟡 Ошейник не прошёл проверку — маршрут идёт с вашего телефона. Обязательно включите трансляцию геопозиции в чате с ботом: ${LIVE_LOCATION}.`;
  }
  return `🐕 Прогулка началась! Включите трансляцию геопозиции в чате с ботом (${LIVE_LOCATION}) — клиент увидит маршрут.`;
}

// --- действия ------------------------------------------------------------------

// Одно действие за раз: пока идёт запрос, кнопки блока выключены. `work` возвращает
// текст успеха; любой исход, меняющий заказ (успех шага, «уже недоступно»), —
// повод перечитать карточку из ядра. `current` — состояние заказа, с которого нажали:
// пока шёл запрос, ситтер мог открыть другую карточку.
async function run(work, { reread = false } = {}) {
  if (walk.busy) return;
  const current = walk;
  current.busy = true;
  current.notice = null;
  render();
  try {
    const text = await work(current);
    if (text) current.notice = { kind: "ok", text };
    haptic(current.notice?.kind === "error" ? "error" : "success");
  } catch (err) {
    fail(current, err);
    reread = stale(err);
  }
  current.confirming = false;
  if (reread) await refresh();
  current.busy = false;
  render();
}

async function loadReport(orderId) {
  // что уже лежит в отчёте (в том числе отправленное из бота); дальше считаем сами
  const report = { photos: 0, events: {} };
  walk.report = report;
  try {
    const data = await api("GET", `/sessions/${orderId}`);
    report.photos += data.photos.length;
    for (const event of data.events) {
      if (ACTIVITY[event.type]) report.events[event.type] = (report.events[event.type] || 0) + 1;
    }
    render();
  } catch {
    // счётчики — удобство, а не статус: без них блок работает так же
  }
}

// экспорт — для фото в чате и поддержке (KAN-509): те же пределы, одна реализация
export async function shrink(file) {
  if (file.size <= PHOTO_KEEP_BYTES || !window.createImageBitmap) return file;
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, PHOTO_MAX_SIDE / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close?.();
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", PHOTO_QUALITY));
    return blob && blob.size < file.size ? new File([blob], "walk.jpg", { type: "image/jpeg" }) : file;
  } catch {
    return file; // браузер не разобрал формат — пусть решает ядро (оно читает и HEIC)
  }
}

async function sendPhotos(current, orderId, files) {
  current.upload = { done: 0, total: files.length };
  let problem = null;
  for (const file of files) {
    render();
    try {
      const form = new FormData();
      form.append("file", await shrink(file));
      await api("POST", `/sessions/${orderId}/photos`, form);
      current.upload.done += 1;
      if (current.report) current.report.photos += 1;
    } catch (err) {
      problem = err;
      // лимит, конец прогулки, нет сети — остальные файлы ждёт то же самое
      if (err.status === 409 || err.status === 404 || err.status === 0) break;
    }
  }
  const { done, total } = current.upload;
  current.upload = null;
  if (problem && !done) throw problem;
  if (problem) {
    // часть дошла — это не провал, но причину остальным назвать надо
    current.notice = { kind: "error", text: `📸 В отчёт добавлено ${done} из ${total}. ${explain(problem)}` };
    if (stale(problem)) await refresh();
    return null;
  }
  return done === 1 ? "📸 Фото добавлено в отчёт клиента." : `📸 Добавлено фото: ${done}. Клиент уже видит их в приложении.`;
}

// Карточка заказа живёт в screens/orders.js: она отдаёт сюда открытый заказ и способ
// его перечитать, а сама вставляет walkBlock(order) в свою разметку.
export function initWalk({ getOrder, refreshOrder }) {
  refresh = refreshOrder;
  registerActions({
    "walk-step": ({ step }) => {
      const order = getOrder();
      return run(
        async () => stepDone(step, order, await api("POST", `/sessions/${order.id}/${step}`)),
        { reread: true },
      );
    },
    "walk-early": () =>
      run(async () => {
        await api("POST", `/sessions/${getOrder().id}/early-start`);
        return "🙋 Спросили клиента. Ответ придёт сообщением в боте; до этого выходить рано.";
      }, { reread: true }),
    "walk-event": ({ type }) =>
      run(async (current) => {
        await api("POST", `/sessions/${getOrder().id}/events`, { type });
        if (current.report) current.report.events[type] = (current.report.events[type] || 0) + 1;
        return `${ACTIVITY[type][0].split(" ")[0]} Записали: ${ACTIVITY[type][1]}. Клиент это видит.`;
      }),
    "walk-finish": () => {
      walk.confirming = true;
      walk.notice = null;
    },
    "walk-keep": () => {
      walk.confirming = false;
    },
  });

  // Поле выбора фото живёт вне #app: render() пересобирает разметку целиком, и поле
  // внутри неё могло исчезнуть, пока открыта галерея (карточка перечиталась, сменилась
  // тема) — выбранные фото тогда терялись бы молча.
  const picker = document.createElement("input");
  Object.assign(picker, { type: "file", accept: "image/*", multiple: true, className: "offscreen" });
  document.body.append(picker);
  picker.addEventListener("change", () => {
    const files = [...picker.files];
    picker.value = ""; // иначе повторный выбор того же файла не даст change
    const order = getOrder();
    if (files.length && order) run((current) => sendPhotos(current, order.id, files));
  });
  registerActions({ "walk-pick": () => picker.click() });

  // Ответ клиента на ранний выход, отмена, шаг из бота приходят мимо мини-аппа:
  // вернулся из чата в кабинет — карточка активного заказа перечитывается.
  document.addEventListener("visibilitychange", () => {
    const order = getOrder();
    if (document.visibilityState !== "visible" || !order || walk.busy) return;
    if (ACTIVE.includes(order.status)) refresh().then(render);
  });
}
