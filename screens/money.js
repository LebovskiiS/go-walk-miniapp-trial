// «Мои деньги» (KAN-509). В боте это пока заглушка (KAN-212, MONEY_TEXT), но
// ядро уже отдаёт ведомость выплат ситтера — GET /walker/me/payouts (KAN-179):
// к выплате — завершённые оплаченные заказы, не вошедшие в выплату, за вычетом
// удержаний (сумма их walker_payout_kopecks); ниже — прошлые выплаты с чеком НПД.
// Своих расчётов не делаем: показываем ровно то, по чему платит админ.
import { api } from "../api.js";
import { SPINNER, dayFmt, esc, fmtMoney, registerActions, registerOverlay, render, stateBlock } from "../core.js";
import { addCabinetLink } from "./cabinet.js";

const STATUS = {
  pending: ["в обработке", "wait"],
  succeeded: ["переведено", "ok"],
  canceled: ["отменена", "off"],
};

function plural(n, one, few, many) {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
}

let money = null; // null — закрыто; {loading, error, data}

async function open() {
  money = { loading: true, error: null, data: null };
  window.scrollTo(0, 0);
  render();
  try {
    money.data = await api("GET", "/walker/me/payouts");
  } catch (err) {
    if (money) money.error = err.message;
  }
  if (!money) return;
  money.loading = false;
  render();
}

function payoutRow(p) {
  const [label, kind] = STATUS[p.status] || [p.status, "wait"];
  const when = dayFmt.format(new Date(p.paid_at || p.created_at));
  const orders = p.order_ids.length;
  const receipt = p.status !== "succeeded"
    ? ""
    : p.receipt
      ? `<span class="muted">чек № ${esc(p.receipt.number)}</span>`
      : `<span class="warn">чек не прислан</span>`;
  return `<div class="card payout-card">
    <div class="payout-top"><b>${esc(fmtMoney(p.amount_kopecks))}</b><span class="pill ${kind}">${esc(label)}</span></div>
    <div class="muted">${esc(when)} · ${orders} ${plural(orders, "заказ", "заказа", "заказов")}</div>
    ${receipt}${p.note ? `<div class="muted">${esc(p.note)}</div>` : ""}</div>`;
}

function view() {
  const head = `<h2>💰 Мои деньги</h2>`;
  if (money.loading) return `<section class="page">${head}${SPINNER}</section>`;
  if (money.error) {
    return `<section class="page">${head}${stateBlock("⚠️", "Не получилось загрузить выплаты", money.error, "money-open", "Повторить")}</section>`;
  }
  const { due_kopecks: due, due_orders: dueOrders, receipt_missing: receiptMissing, payouts } = money.data;
  const receiptWarn = receiptMissing
    ? `<div class="notice error">Пришлите чек из «Мой налог» по прошлой выплате — без него следующая не уйдёт. Чек можно отправить в поддержку.</div>`
    : "";
  const history = payouts.length
    ? payouts.map(payoutRow).join("")
    : `<p class="muted">Выплат пока не было.</p>`;
  return `<section class="page">${head}
    <div class="card money-due"><div class="muted">К выплате</div><div class="money-sum">${esc(fmtMoney(due))}</div>
      <div class="muted">${dueOrders
        ? `за ${dueOrders} ${plural(dueOrders, "завершённый заказ", "завершённых заказа", "завершённых заказов")}`
        : "завершённых заказов вне выплат нет"}</div></div>
    ${receiptWarn}
    <h3>Выплаты</h3>${history}
    <p class="muted small">Цена каждого заказа фиксированная — вы видите её в карточке предложения до того, как принять.
      Выплаты идут через самозанятость: до первой выплаты понадобится статус самозанятого (оформляется в приложении
      «Мой налог» за 10 минут). Вопросы про деньги — в поддержку, вкладка «💬 Чаты».</p>
  </section>`;
}

registerOverlay({ isOpen: () => money !== null, view, close: () => { money = null; } });

registerActions({ "money-open": () => open() });

addCabinetLink({ act: "money-open", icon: "💰", label: "Мои деньги", hint: "К выплате и прошлые выплаты" });
