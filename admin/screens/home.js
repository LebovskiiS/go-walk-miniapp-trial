// «Сводка»: очереди модерации (то, что админ-бот присылает раз в час, KAN-489)
// и что ждёт ответа в поддержке. Тап по строке ведёт на вкладку.
import { api } from "../../api.js";
import { esc, registerScreen, render } from "../../core.js";
import { notice } from "../kit.js";

const DAY_MS = 24 * 60 * 60 * 1000;
// Ручке обязателен `since` (с зоной — toISOString даёт …Z), until по умолчанию «сейчас»
const sinceParam = () => "?since=" + encodeURIComponent(new Date(Date.now() - DAY_MS).toISOString());

const home = { summary: null, needsReply: null, loading: false, notice: null };

const QUEUES = [
  ["applications", "Заявки ситтеров", "applications"],
  ["documents", "Документы одобренных", "applications"],
  ["avatars", "Фото профиля", "photos"],
  ["gallery_photos", "Галерея", "photos"],
  ["review_photos", "Фото в отзывах", "photos"],
];

export async function loadSummary() {
  home.summary = await api("GET", "/admin/moderation/summary" + sinceParam());
  try {
    const convs = await api("GET", "/admin/support/conversations?limit=100");
    home.needsReply = convs.filter((c) => c.needs_reply).length;
  } catch {
    home.needsReply = null; // поддержка не критична для сводки
  }
}

async function refresh() {
  home.loading = true;
  home.notice = null;
  render();
  try {
    await loadSummary();
  } catch (err) {
    home.notice = { kind: "error", text: err.message };
  }
  home.loading = false;
  render();
}

function view() {
  const s = home.summary;
  const rows = QUEUES.map(([key, title, tab]) => {
    const { waiting = 0, new_since: fresh = 0 } = s?.[key] ?? {};
    return `<button class="card row item-link" data-act="tab" data-tab="${tab}">
      <span>${esc(title)}</span>
      <span class="badge ${waiting ? "offer" : ""}">${waiting}${fresh ? ` · +${fresh}` : ""}</span></button>`;
  }).join("");
  const support = home.needsReply === null ? "" : `<button class="card row item-link" data-act="tab" data-tab="support">
      <span>Ждут ответа поддержки</span>
      <span class="badge ${home.needsReply ? "express" : ""}">${home.needsReply}</span></button>`;
  return `<section class="list">
    <h2>Очереди</h2><p class="muted">ждёт · +новых за сутки</p>
    ${notice(home.notice)}
    ${support}${rows}
    <button class="btn ghost wide" data-act="home-refresh" ${home.loading ? "disabled" : ""}>Обновить</button>
  </section>`;
}

registerScreen({
  key: "home",
  label: "Сводка",
  view,
  open: () => (home.summary ? refresh() : undefined),
  actions: { "home-refresh": refresh },
});
