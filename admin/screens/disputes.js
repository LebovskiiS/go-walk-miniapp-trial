// «Споры» — как ⚖️ в админ-боте (KAN-295/354/393…395): открытые споры по заказам,
// карточка с фото клиента и фактами прогулки, решение — отказать / вернуть
// частично / вернуть полностью, с заметкой; удержание из выплаты ситтера — по
// желанию. Спорное — в пользу платформы: возврат только по проверке.
import { api } from "../../api.js";
import { esc, fmtWhen, haptic, registerActions, registerChanges, registerOverlay, registerScreen, render } from "../../core.js";
import { ACTIONS as KIT_ACTIONS, clearDraft, draft } from "../../screens/chatkit.js";
import {
  DISPUTE_REASON, DISPUTE_STATUS, ORDER_STATUS, ORDER_TYPE, PAYMENT, kv, label, listState, money, notice, when, who,
} from "../kit.js";
import { openSupportChat } from "./support.js";

const FILTERS = [["open", "Открытые"], ["all", "Все"]];

const disputes = { filter: "open", items: [], loading: false, error: null, loaded: false };
let card = null; // {dispute, loading, error, busy, notice, outcome, refund, hold}

async function load() {
  disputes.loading = true;
  disputes.error = null;
  render();
  try {
    const status = disputes.filter === "open" ? "&status=open" : "";
    disputes.items = await api("GET", `/admin/disputes?limit=50${status}`); // le=50 у ручки
    disputes.loaded = true;
  } catch (err) {
    disputes.error = err.message;
  }
  disputes.loading = false;
  render();
}

function listView() {
  const chips = FILTERS.map(
    ([v, t]) => `<button class="chip small ${disputes.filter === v ? "on" : ""}" data-act="dispute-filter" data-value="${v}">${esc(t)}</button>`,
  ).join("");
  const empty = listState(disputes, "Споров нет.");
  const rows = empty ?? disputes.items
    .map(
      (d) => `<button class="card row item-link" data-act="dispute-open" data-id="${esc(d.id)}">
        <span><b>${esc(label(DISPUTE_REASON, d.reason))} · ${money(d.price_kopecks)}</b>
          <span class="muted">${esc(d.client_name ?? "клиент?")} ↔ ${esc(d.walker_name ?? "ситтер?")} · ${esc(fmtWhen(d.created_at))}</span>
          <span class="muted">${esc(d.text.slice(0, 80))}</span></span>
        <span class="badge ${d.status === "open" ? "express" : d.status === "rejected" ? "cancelled" : "completed"}">${esc(label(DISPUTE_STATUS, d.status))}</span></button>`,
    )
    .join("");
  return `<section class="list"><h2>Споры</h2><div class="chips tight">${chips}</div>${rows}</section>`;
}

async function openCard(id) {
  card = { id, dispute: null, loading: true, error: null, busy: false, notice: null, outcome: null, refund: "", hold: "" };
  clearDraft("dispute-note");
  render();
  try {
    card.dispute = await api("GET", `/admin/disputes/${id}`);
    card.refund = String(Math.round(card.dispute.price_kopecks / 100));
  } catch (err) {
    card.error = err.message;
  }
  if (card?.id !== id) return;
  card.loading = false;
  render();
}

function resolveForm(d) {
  const c = card;
  const off = c.busy ? "disabled" : "";
  const outcomes = [["rejected", "✋ Отказать"], ["partial", "↩️ Вернуть частично"], ["full", "💸 Вернуть полностью"]];
  const chips = outcomes
    .map(([v, t]) => `<button class="chip small ${c.outcome === v ? "on" : ""}" data-act="dispute-outcome" data-value="${v}" ${off}>${esc(t)}</button>`)
    .join("");
  const amount = c.outcome === "partial"
    ? `<div class="field"><span class="field-label">Вернуть клиенту, ₽ (из ${money(d.price_kopecks - d.already_refunded_kopecks)})</span>
        <input class="input" type="number" min="1" data-change="dispute-refund" value="${esc(c.refund)}" ${off}></div>`
    : "";
  const hold = c.outcome && c.outcome !== "rejected"
    ? `<div class="field"><span class="field-label">Удержать из выплаты ситтера, ₽ (необязательно)</span>
        <input class="input" type="number" min="0" data-change="dispute-hold" value="${esc(c.hold)}" placeholder="0" ${off}></div>`
    : "";
  return `<div class="card stack"><b>Решение</b>
    <div class="chips tight">${chips}</div>${amount}${hold}
    <div class="field"><span class="field-label">Заметка (увидят клиент и ситтер)</span>
      <textarea class="input" rows="2" data-draft="dispute-note" placeholder="Что проверили и почему так решили">${esc(draft("dispute-note"))}</textarea></div>
    <button class="btn wide" data-act="dispute-resolve" ${off || !c.outcome ? "disabled" : ""}>Применить решение</button></div>`;
}

function cardView() {
  const c = card;
  if (c.loading) return `<div class="state"><div class="spinner"></div></div>`;
  if (c.error) return `<section class="list"><div class="notice error">${esc(c.error)}</div></section>`;
  const d = c.dispute;
  const photos = d.photos.length
    ? `<div class="grid">${d.photos.map((p) => `<button class="tile msg-photo" data-act="photo-open" data-url="${esc(p.url)}"><img src="${esc(p.url)}" alt="" loading="lazy"></button>`).join("")}</div>`
    : `<p class="muted">Фото от клиента нет.</p>`;
  const resolved = d.status !== "open"
    ? `<div class="notice ok">${esc(label(DISPUTE_STATUS, d.status))} · ${esc(when(d.resolved_at))}${d.resolution_note ? "<br>" + esc(d.resolution_note) : ""}
        ${d.refund_kopecks ? "<br>возврат " + money(d.refund_kopecks) : ""}${d.walker_hold_kopecks ? " · удержано у ситтера " + money(d.walker_hold_kopecks) : ""}</div>`
    : resolveForm(d);
  return `<section class="list">
    <h2>Спор: ${esc(label(DISPUTE_REASON, d.reason))}</h2>
    ${notice(c.notice)}
    <div class="card"><p>${esc(d.text)}</p>
      ${kv("Клиент", esc(d.client_name ? who(d.client_name, d.client_id) : "—"))}
      ${kv("Ситтер", esc(d.walker_name ? who(d.walker_name, d.walker_id) : "—"))}
      ${kv("Подан", esc(when(d.created_at)))}</div>
    <div class="field-label">Заказ</div>
    <div class="card">
      ${kv("Заказ", `<button class="chip small" data-act="dispute-order" data-id="${esc(d.order_id)}">${esc(label(ORDER_TYPE, d.order_type))} №${esc(String(d.order_id).slice(0, 8))}</button>`)}
      ${kv("Статус / оплата", `${esc(label(ORDER_STATUS, d.order_status))} / ${esc(label(PAYMENT, d.payment_status))}`)}
      ${kv("Когда", esc(when(d.scheduled_at)))}${kv("Цена", money(d.price_kopecks))}
      ${kv("Уже возвращено", money(d.already_refunded_kopecks))}
      ${d.walker_payout_kopecks !== null ? kv("Выплата ситтеру", money(d.walker_payout_kopecks)) : ""}
      ${kv("Прогулка", `${esc(when(d.walk_started_at))} → ${esc(when(d.walk_finished_at))}`)}
      ${kv("Точек трека / фото", `${d.walk_points} / ${d.walk_photos}`)}
      ${d.walk_events.length ? `<div class="muted">${d.walk_events.map(esc).join(" → ")}</div>` : ""}
    </div>
    <div class="field-label">Фото клиента</div>${photos}
    ${resolved}
    <div class="row gap">${d.client_id ? `<button class="btn ghost" data-act="dispute-support" data-id="${esc(d.client_id)}">🛟 Обращение клиента</button>` : ""}</div>
  </section>`;
}

async function resolve() {
  const c = card;
  const d = c.dispute;
  c.busy = true;
  c.notice = null;
  render();
  try {
    const note = draft("dispute-note").trim();
    if (!note) throw new Error("Напишите заметку — её увидят обе стороны.");
    const body = { outcome: c.outcome, note };
    if (c.outcome === "partial") {
      const rub = Number(c.refund);
      if (!rub || rub <= 0) throw new Error("Укажите сумму возврата.");
      body.refund_kopecks = Math.round(rub * 100);
    }
    if (c.outcome !== "rejected" && Number(c.hold) > 0) body.walker_hold_kopecks = Math.round(Number(c.hold) * 100);
    card.dispute = await api("POST", `/admin/disputes/${d.id}/resolve`, body);
    clearDraft("dispute-note");
    card.notice = { kind: "ok", text: "Решение применено" };
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

registerChanges({
  "dispute-refund": (input) => {
    if (card) card.refund = input.value;
  },
  "dispute-hold": (input) => {
    if (card) card.hold = input.value;
  },
});

registerActions({
  ...KIT_ACTIONS,
  "dispute-open": ({ id }) => openCard(id),
  "dispute-filter": ({ value }) => {
    disputes.filter = value;
    return load();
  },
  "dispute-outcome": ({ value }) => {
    card.outcome = value;
  },
  "dispute-resolve": resolve,
  "dispute-order": async ({ id }) => {
    const { openOrderCard } = await import("./orders.js");
    card = null;
    return openOrderCard(id);
  },
  "dispute-support": ({ id }) => {
    card = null;
    return openSupportChat(id);
  },
});

registerScreen({ key: "disputes", label: "Споры", view: listView, open: load });
