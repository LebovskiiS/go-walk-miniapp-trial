// Экран «Новые» (KAN-506): предложения заказов ситтеру — принять / отказаться, отклик на
// экспресс эстимейтом и «Написать клиенту» до решения. Повторяет кнопки бота
// (bot/app/handlers.py: handle_order_response, _send_express_eta, handle_client_chat);
// уведомление о новом предложении по-прежнему приходит сообщением бота.
import { api, ApiError } from "../api.js";
import {
  esc, fmtMoney, fmtWhen, haptic, registerOverlay, registerScreen, render, shortId, SPINNER,
  stateBlock, tg,
} from "../core.js";

// proposed — адресное предложение (order_proposals); dispatching — веер экспресса.
// Веер предложений не заводит, и /orders/mine его сейчас не отдаёт (разрыв ядра —
// KAN-511): запрос оставлен, чтобы экспресс появился здесь без правок мини-аппа.
const OFFER_STATUSES = ["proposed", "dispatching"];
const ETA_PRESETS = [10, 20, 30];
const ETA_MAX = 120; // как в боте; потолок ядра — express_max_eta_minutes, иначе 422 его текстом

const TYPE_LABEL = { urgent: "⚡ Экспресс-выгул", booked: "🐕 Выгул", boarding: "🏠 Передержка" };
const SIZE_LABEL = { small: "маленькая", medium: "средняя", large: "крупная" };

// 409 закрытого окна — штатный исход гонки «первый откликнулся, поехал» (KAN-418);
// остальные причины (занят, приглашали не вас) ядро объясняет само (KAN-262)
const WINDOW_CLOSED = "Окно откликов уже закрыто — заказ разобран или отменён.";
const OFFER_GONE = "Это предложение уже недоступно — его отменили, приняли или истёк срок.";

const box = { items: [], loading: false, error: null, loaded: false };
// открытое предложение: {id, loading, data, error, busy, result, chat}
// result — {kind, text} итог действия; после него кнопки решения не рисуются
let card = null;

// --- загрузка ------------------------------------------------------------------

async function loadOffers() {
  box.loading = true;
  box.error = null;
  render();
  try {
    // ручка фильтрует по одному статусу — запрос на статус, как у «Активных»
    const pages = await Promise.all(
      OFFER_STATUSES.map((status) => api("GET", `/orders/mine?status=${status}&limit=50`)),
    );
    // экспресс горит минутами — наверх; остальное по времени выгула
    box.items = pages.flat().sort((a, b) =>
      (a.status === "dispatching" ? 0 : 1) - (b.status === "dispatching" ? 0 : 1)
      || a.scheduled_at.localeCompare(b.scheduled_at));
    box.loaded = true;
  } catch (err) {
    box.error = err.message;
  }
  box.loading = false;
  render();
}

async function openOffer(id) {
  card = { id, loading: true, data: null, error: null, busy: false, result: null, chat: null };
  const current = card;
  render();
  try {
    current.data = await api("GET", `/orders/${id}`);
  } catch (err) {
    // 404 — предложение закрыли, пока список висел открытым: ядро чужое не раскрывает
    current.error = err instanceof ApiError && err.status === 404 ? OFFER_GONE : err.message;
  }
  current.loading = false;
  render();
}

function dropFromList(id) {
  box.items = box.items.filter((order) => order.id !== id);
}

// действие по открытому предложению: busy на время запроса, итог — в card.result
async function act(run, onConflict) {
  const current = card;
  current.busy = true;
  render();
  try {
    current.result = { kind: "ok", text: await run() };
    dropFromList(current.id);
    haptic("success");
  } catch (err) {
    const gone = err instanceof ApiError && (err.status === 409 || err.status === 404);
    current.result = { kind: "error", text: gone ? onConflict(err) : err.message };
    if (gone) dropFromList(current.id);
    haptic("error");
  }
  current.busy = false;
  render();
}

const accept = () =>
  act(async () => {
    await api("POST", `/orders/${card.id}/accept`);
    return "✅ Заказ ваш. Он во вкладке «📋 Заказы → Активные»; вести прогулку — в боте.";
  }, (err) => (err.status === 404 ? OFFER_GONE : err.message));

async function decline() {
  if (!(await confirmAsk("Отказаться от этого заказа? Вернуть предложение будет нельзя."))) return;
  await act(async () => {
    await api("POST", `/orders/${card.id}/decline`);
    return "Вы отказались от заказа.";
  }, (err) => (err.status === 404 ? OFFER_GONE : err.message));
}

function respond(minutes) {
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > ETA_MAX) {
    card.result = null;
    card.etaError = `Укажите число минут от 1 до ${ETA_MAX}.`;
    return render();
  }
  card.etaError = null;
  return act(async () => {
    await api("POST", `/orders/${card.id}/respond`, { eta_minutes: minutes });
    return `🎉 Заказ ваш! Вы обещали быть через ~${minutes} мин — клиент уже ждёт, выходите.`;
  }, (err) => (err.code === "express_window_closed" || err.status === 404 ? WINDOW_CLOSED : err.message));
}

// переписка ничего не решает за ситтера: заказ не принят и не зарезервирован,
// кнопки решения остаются на месте (как в боте, KAN-422)
async function sendToClient() {
  const field = document.getElementById("offer-msg");
  const text = field?.value.trim() || "";
  const chat = card.chat;
  if (!text) {
    chat.error = "Напишите сообщение.";
    return render();
  }
  Object.assign(chat, { text, sending: true, error: null });
  render();
  try {
    const conversation = await api("POST", `/chats/with/${card.data.client_id}`);
    await api("POST", `/chats/${conversation.id}/messages`, { text });
    Object.assign(chat, { text: "", sent: true });
    haptic("success");
  } catch (err) {
    chat.error = err instanceof ApiError && err.status === 404 ? OFFER_GONE : err.message;
    haptic("error");
  }
  chat.sending = false;
  render();
}

function confirmAsk(text) {
  return new Promise((resolve) => {
    try {
      if (tg?.showConfirm) return tg.showConfirm(text, (ok) => resolve(Boolean(ok)));
    } catch {
      // клиент Telegram старше 6.2 — ниже обычный confirm
    }
    return resolve(window.confirm(text));
  });
}

// --- обратный отсчёт окна экспресса --------------------------------------------
// Раз в секунду правим только текст таймеров: полный render() стёр бы набранное
// в полях (своё время, сообщение клиенту).

function leftText(iso) {
  const left = Math.floor((new Date(iso) - Date.now()) / 1000);
  if (left <= 0) return "окно откликов закрылось";
  const minutes = Math.floor(left / 60);
  const seconds = String(left % 60).padStart(2, "0");
  return `осталось ${minutes}:${seconds}`;
}

setInterval(() => {
  for (const node of document.querySelectorAll("[data-deadline]")) {
    node.textContent = leftText(node.dataset.deadline);
  }
}, 1000);

const countdown = (iso) =>
  iso ? `<span class="countdown" data-deadline="${esc(iso)}">${esc(leftText(iso))}</span>` : "";

// --- отрисовка -----------------------------------------------------------------

function when(order) {
  if (order.type === "boarding" && order.boarding_start_at) {
    return `${fmtWhen(order.boarding_start_at)} — ${fmtWhen(order.boarding_end_at)}`;
  }
  if (order.status === "dispatching") return "прямо сейчас";
  return fmtWhen(order.scheduled_at);
}

function offersView() {
  let body;
  if (box.error) {
    body = stateBlock("⚠️", "Не получилось загрузить предложения", box.error, "offers-reload", "Повторить");
  } else if (!box.items.length && (box.loading || !box.loaded)) {
    body = SPINNER;
  } else if (!box.items.length) {
    body = stateBlock("🔔", "Новых предложений нет",
      "О новом заказе бот напишет сообщением — ответить можно там или здесь.",
      "offers-reload", "Обновить");
  } else {
    body = `<section class="card list">${box.items.map(offerRow).join("")}</section>
      <button class="btn ghost wide" data-act="offers-reload" ${box.loading ? "disabled" : ""}>
        ${box.loading ? "Обновляю…" : "Обновить"}</button>`;
  }
  return `${body}<p class="note">Экспресс-заказы пока приходят и принимаются только в боте.</p>`;
}

function offerRow(order) {
  const express = order.status === "dispatching";
  return `<button class="item" data-act="offer" data-id="${esc(order.id)}">
    <div class="row"><b>${esc(TYPE_LABEL[order.type] || order.type)}</b>
      <span class="badge ${express ? "express" : "offer"}">${express ? "откликнуться" : "ждёт ответа"}</span></div>
    <div>${esc(when(order))} ${express ? countdown(order.dispatch_deadline_at) : ""}</div>
    <div class="muted">${esc(order.pet_names.join(", ") || "питомец не указан")} · ${shortId(order.id)}</div>
  </button>`;
}

function offerView() {
  const back = `<button class="link back" data-act="back">‹ К предложениям</button>`;
  if (card.loading) return back + SPINNER;
  if (card.error) return back + stateBlock("⚠️", "Предложение не открылось", card.error, "offer-retry", "Повторить");

  const order = card.data;
  const express = order.status === "dispatching";
  const lines = [];
  const add = (label, value) =>
    value && lines.push(`<div class="kv"><span class="muted">${label}</span><span>${esc(value)}</span></div>`);
  add("Когда", when(order));
  add("Длительность", order.duration_minutes ? `${order.duration_minutes} мин` : "");
  add("Тариф", order.tariff_class === "cynologist" ? "С кинологом" : "Базовый");
  add("Вам к выплате", order.walker_payout_kopecks != null ? fmtMoney(order.walker_payout_kopecks) : "");

  // до принятия ядро отдаёт только сам адрес: подъезд, квартира, домофон — после (KAN-110)
  // KAN-519: у передержки собаку привозит клиент — его адрес няне не нужен
  const where = order.type === "boarding" ? order.boarding_address || "" : order.address?.full_text || "";

  const pets = (order.pets.length ? order.pets : order.pet ? [order.pet] : [])
    .map((pet) => {
      const facts = [pet.breed, pet.age_years != null && `${pet.age_years} лет`, SIZE_LABEL[pet.size]]
        .filter(Boolean);
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
        ${express ? countdown(order.dispatch_deadline_at) : ""}</div>
      <div class="muted">${shortId(order.id)}</div>
      ${lines.join("")}
    </section>
    ${where ? `<h3>Адрес</h3><section class="card">${esc(where)}
      <div class="muted">Подъезд, квартира и домофон откроются после принятия.</div></section>` : ""}
    ${pets ? `<h3>Питомцы</h3><section class="card stack">${pets}</section>` : ""}
    ${services ? `<h3>Доп. услуги</h3><section class="card">${services}</section>` : ""}
    ${card.result ? `<p class="notice ${card.result.kind}">${esc(card.result.text)}</p>` : decisionView(order)}
    ${card.result ? "" : chatView(order)}`;
}

function decisionView(order) {
  const disabled = card.busy ? "disabled" : "";
  if (order.status === "proposed") {
    return `<div class="row gap decide">
      <button class="btn ghost grow" data-act="offer-decline" ${disabled}>Отказаться</button>
      <button class="btn grow" data-act="offer-accept" ${disabled}>${card.busy ? "Отправляю…" : "Принять"}</button>
    </div>`;
  }
  if (order.status === "dispatching") {
    const presets = ETA_PRESETS.map(
      (minutes) => `<button class="btn grow" data-act="offer-eta" data-minutes="${minutes}" ${disabled}>
        ${minutes} мин</button>`,
    ).join("");
    return `<h3>Буду через</h3>
      <p class="note">Кто откликнулся первым — забирает заказ.</p>
      <div class="row gap decide">${presets}</div>
      <div class="row gap eta-custom">
        <input id="offer-eta" type="number" inputmode="numeric" min="1" max="${ETA_MAX}"
          placeholder="Своё время, мин" ${disabled}>
        <button class="btn ghost" data-act="offer-eta-custom" ${disabled}>Отправить</button>
      </div>
      ${card.etaError ? `<p class="notice error">${esc(card.etaError)}</p>` : ""}`;
  }
  // заказ ушёл из предложений, пока карточка открывалась
  return `<p class="notice error">${esc(OFFER_GONE)}</p>`;
}

function chatView(order) {
  if (!order.client_id || !["proposed", "dispatching"].includes(order.status)) return "";
  const chat = card.chat;
  if (!chat) {
    return `<button class="btn ghost wide" data-act="offer-chat">💬 Написать клиенту</button>`;
  }
  const disabled = chat.sending ? "disabled" : "";
  return `<h3>Сообщение клиенту</h3>
    <section class="card stack">
      ${chat.sent ? `<p class="notice ok">Отправлено. Ответ клиента придёт в бот.</p>` : ""}
      <textarea id="offer-msg" rows="3" maxlength="4000" placeholder="Например: уточните, где встречаемся"
        ${disabled}>${esc(chat.text)}</textarea>
      ${chat.error ? `<p class="notice error">${esc(chat.error)}</p>` : ""}
      <button class="btn wide" data-act="offer-send" ${disabled}>${chat.sending ? "Отправляю…" : "Отправить"}</button>
      <p class="note">Переписка не принимает заказ: решение — кнопками выше.</p>
    </section>`;
}

registerScreen({
  key: "offers",
  label: "🔔 Новые",
  view: offersView,
  // предложения живут часами, экспресс — минутами: при каждом входе — свежий список
  open: () => (box.loading ? undefined : loadOffers()),
  actions: {
    "offers-reload": () => loadOffers(),
    offer: ({ id }) => openOffer(id),
    "offer-retry": () => openOffer(card.id),
    "offer-accept": () => accept(),
    "offer-decline": () => decline(),
    "offer-eta": ({ minutes }) => respond(Number(minutes)),
    "offer-eta-custom": () => respond(Number(document.getElementById("offer-eta")?.value)),
    "offer-chat": () => {
      card.chat = { text: "", sending: false, sent: false, error: null };
    },
    "offer-send": () => sendToClient(),
  },
});

registerOverlay({
  isOpen: () => card !== null,
  view: offerView,
  close: () => {
    card = null;
  },
});
