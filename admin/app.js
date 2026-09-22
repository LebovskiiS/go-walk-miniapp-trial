// Каркас мини-аппа админа (KAN-524): вход по initData через общий ../api.js,
// проверка роли и сводка очередей модерации. Экраны (обращения, заявки, фото,
// заказы, споры, пользователи) — отдельными тикетами, по одному на экран.
//
// core.js ситтера сюда не тянем: его boot() привязан к /walker/me и статусу
// анкеты. Когда экранов станет больше одного, реестр экранов вынесем в общий
// модуль, а не скопируем.
import { api, ApiError, insideTelegram } from "../api.js";

const tg = window.Telegram?.WebApp;
const root = document.getElementById("app");

const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (ch) => ESC[ch]);

function stateBlock(icon, title, text, act, button) {
  return `<div class="state"><div class="state-icon">${icon}</div><h2>${esc(title)}</h2>
    <p class="muted">${esc(text)}</p>
    ${act ? `<button class="btn" data-act="${act}">${esc(button)}</button>` : ""}</div>`;
}

const QUEUES = [
  ["applications", "Заявки ситтеров"],
  ["documents", "Документы"],
  ["avatars", "Фото профиля"],
  ["gallery_photos", "Галерея"],
  ["review_photos", "Фото в отзывах"],
];

// Окно «новое за период»: сутки назад. Ручке `since` обязателен (со смещением
// зоны — toISOString даёт …Z), `until` по умолчанию «сейчас».
const DAY_MS = 24 * 60 * 60 * 1000;
const sinceParam = () => "?since=" + encodeURIComponent(new Date(Date.now() - DAY_MS).toISOString());

// ModerationQueueCount: {waiting, new_since} — сколько ждёт и сколько из них за сутки
function summaryView(summary) {
  const rows = QUEUES.map(([key, label]) => {
    const { waiting = 0, new_since: fresh = 0 } = summary[key] ?? {};
    return `<div class="card row"><span>${esc(label)}</span>
      <span class="badge ${waiting ? "offer" : ""}">${esc(waiting)}${fresh ? ` · +${esc(fresh)}` : ""}</span></div>`;
  }).join("");
  return `<section class="list"><h2>Очереди модерации</h2><p class="muted">ждёт · +новых за сутки</p>${rows}
    <button class="btn ghost wide" data-act="reload">Обновить</button></section>`;
}

async function load() {
  root.innerHTML = `<div class="state"><div class="spinner"></div></div>`;
  try {
    root.innerHTML = summaryView(await api("GET", "/admin/moderation/summary" + sinceParam()));
  } catch (err) {
    if (err instanceof ApiError && err.status === 403) {
      root.innerHTML = stateBlock("🔒", "Нет доступа", "Админка доступна только администраторам go_walk.", "close", "Закрыть");
    } else {
      root.innerHTML = stateBlock("⚠️", "Не получилось открыть админку", err.message, "reload", "Повторить");
    }
  }
}

root.addEventListener("click", (event) => {
  const act = event.target.closest("[data-act]")?.dataset.act;
  if (act === "reload") load();
  if (act === "close") tg?.close();
});

tg?.ready();
tg?.expand();
if (insideTelegram()) {
  load();
} else {
  root.innerHTML = stateBlock("🐾", "Админка открывается внутри Telegram", "Откройте бота @bosupport_bot и перейдите по ссылке на админку.");
}
