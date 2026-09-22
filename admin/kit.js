// Общее для экранов админки (KAN-524): подписи статусов как в админ-боте
// (bot/app/texts.py), строки «ключ — значение», форма с полем причины.
// Каждое изменяющее действие ядра требует reason — форма одна на всех.
import { esc, fmtWhen, registerActions } from "../core.js";
import { draft } from "../screens/chatkit.js";

export const ORDER_STATUS = {
  proposed: "предложен", dispatching: "ищем ситтера", accepted: "принят",
  on_the_way: "в пути", walking: "идёт", completed: "завершён", cancelled: "отменён",
};
export const ORDER_TYPE = { urgent: "Экспресс", booked: "Выгул", boarding: "Передержка" };
export const PAYMENT = {
  unpaid: "не оплачен", pending: "ждёт оплаты", paid: "оплачен",
  refunded: "возврат", partially_refunded: "частичный возврат",
};
export const WALKER_STATUS = { pending: "на проверке", approved: "одобрен", rejected: "отклонён" };
export const CATEGORY = { amateur: "Любитель", groomer: "Грумер", cynologist: "Кинолог" };
export const ROLE = { client: "клиент", walker: "ситтер", admin: "админ" };
export const DOC_TYPE = {
  passport: "Паспорт", selfie: "Селфи с паспортом", cynology_certificate: "Сертификат кинолога", other: "Другое",
};
export const DOC_REVIEW = { approved: "принят", reupload: "перезалить", rejected: "отклонён" };
export const DISPUTE_REASON = {
  walker_no_show: "ситтер не пришёл", late: "опоздание", short_walk: "прогулка короче",
  services_not_done: "услуги не выполнены", pet_harmed: "питомец пострадал", other: "другое",
};
export const DISPUTE_STATUS = {
  open: "открыт", approved_full: "возврат полностью", approved_partial: "возврат частично", rejected: "отказано",
};
export const USER_KIND = { walker: "ситтер", client: "клиент" };

export const label = (map, value) => map[value] ?? value ?? "—";
export const yesNo = (value) => (value === null || value === undefined ? "—" : value ? "да" : "нет");
export const when = (iso) => (iso ? fmtWhen(iso) : "—");

// «Имя Фамилия · ID» — как в админке бота (KAN-361)
export const who = (name, id) => `${name || "Без имени"} · ${String(id ?? "").slice(0, 8)}`;

export const kv = (label, value) =>
  `<div class="kv"><span class="muted">${esc(label)}</span><span>${value ?? "—"}</span></div>`;

export const notice = (n) => (n ? `<div class="notice ${n.kind}">${esc(n.text)}</div>` : "");

// Форма «причина + подтвердить». ask = {key, title, placeholder?, act, data?, submit, danger?, hint?}
// Текст живёт в черновике chatkit (data-draft) и переживает перерисовку.
export function askForm(ask, busy) {
  if (!ask) return "";
  const data = Object.entries(ask.data ?? {})
    .map(([k, v]) => ` data-${k}="${esc(v)}"`)
    .join("");
  const off = busy ? "disabled" : "";
  return `<div class="card stack ${ask.danger ? "confirm" : ""}">
    <b>${esc(ask.title)}</b>
    ${ask.hint ? `<p class="muted">${esc(ask.hint)}</p>` : ""}
    ${ask.noText ? "" : `<textarea class="input" data-draft="${esc(ask.key)}" rows="2" maxlength="500"
      placeholder="${esc(ask.placeholder ?? "Причина (её увидит журнал действий)")}">${esc(draft(ask.key))}</textarea>`}
    <div class="row gap">
      <button class="btn ${ask.danger ? "" : ""}" data-act="${esc(ask.act)}"${data} ${off}>${esc(ask.submit)}</button>
      <button class="btn ghost" data-act="ask-cancel" ${off}>Отмена</button>
    </div></div>`;
}

// Причина обязательна: ядро отвечает 422 на пустую, лучше сказать сразу
export function reasonOf(key) {
  const text = draft(key).trim();
  if (!text) throw new Error("Напишите причину — без неё действие не выполняется.");
  return text;
}

export const chips = (items, current, act, extra = "") =>
  `<div class="chips tight">${items
    .map(([value, text]) => `<button class="chip small ${value === current ? "on" : ""}" data-act="${act}" data-value="${esc(value)}"${extra}>${esc(text)}</button>`)
    .join("")}</div>`;

export const money = (kopecks) => `${Math.round((kopecks ?? 0) / 100).toLocaleString("ru-RU")} ₽`;

// Список пуст / ошибка / загрузка — одинаково на всех экранах
export function listState({ loading, error, items }, empty) {
  if (loading) return `<div class="state"><div class="spinner"></div></div>`;
  if (error) return `<div class="notice error">${esc(error)}</div>`;
  if (!items.length) return `<p class="muted center">${esc(empty)}</p>`;
  return null;
}

// «Отмена» у формы причины одна на все экраны: каждый экран сообщает, как ему
// закрыть свою форму, а действие ask-cancel зовёт всех — чужие просто ничего не найдут.
const CANCELS = [];
export const onAskCancel = (fn) => CANCELS.push(fn);
registerActions({ "ask-cancel": () => CANCELS.forEach((fn) => fn()) });
