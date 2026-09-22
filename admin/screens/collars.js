// «Трекеры» — как 🐕 в админ-боте (KAN-209): GPS-ошейники, привязанные к ситтерам:
// список с последней точкой, привязать (id устройства + id ситтера), снять
// привязку, номер SIM.
import { api } from "../../api.js";
import { esc, fmtWhen, haptic, registerActions, registerChanges, registerScreen, render } from "../../core.js";
import { kv, listState, notice, who } from "../kit.js";

const collars = { items: [], loading: false, error: null, busy: false, notice: null, form: null, phoneFor: null };
// walker: выбранный ситтер {id, name}; found — результаты поиска по имени (как в боте:
// id руками не вводят, выбирают из найденных)
const draft = { device_id: "", walker: null, q: "", found: [], searching: false, phone: "" };

async function load() {
  collars.loading = true;
  collars.error = null;
  render();
  try {
    collars.items = await api("GET", "/admin/collars");
  } catch (err) {
    collars.error = err.message;
  }
  collars.loading = false;
  render();
}

function view() {
  const off = collars.busy ? "disabled" : "";
  const empty = listState(collars, "Привязанных трекеров нет.");
  const rows = empty ?? collars.items
    .map(
      (c) => `<div class="card">
        <b>${esc(c.device_id)}</b>
        ${kv("Ситтер", esc(who(c.walker_name, c.walker_user_id)))}
        ${kv("Последняя точка", esc(c.last_point_at ? fmtWhen(c.last_point_at) : "не было"))}
        ${kv("Привязан", esc(fmtWhen(c.assigned_at)))}
        ${kv("SIM", esc(c.phone ?? "—"))}
        ${collars.phoneFor === c.device_id
          ? `<div class="row gap"><input class="input grow" data-change="collar-phone" value="${esc(draft.phone)}" placeholder="+7…" inputmode="tel">
              <button class="btn" data-act="collar-phone-save" data-id="${esc(c.device_id)}" ${off}>Сохранить</button>
              <button class="btn ghost" data-act="collar-phone-cancel" ${off}>Отмена</button></div>`
          : `<div class="chips tight">
              <button class="chip small" data-act="collar-phone-ask" data-id="${esc(c.device_id)}" data-phone="${esc(c.phone ?? "")}" ${off}>📱 Номер SIM</button>
              <button class="chip small" data-act="collar-unassign" data-id="${esc(c.device_id)}" ${off}>✂️ Снять привязку</button></div>`}
      </div>`,
    )
    .join("");
  const picked = draft.walker
    ? `<div class="notice ok">Ситтер: ${esc(who(draft.walker.name, draft.walker.id))} <button class="chip small" data-act="collar-walker-clear">сменить</button></div>`
    : `<div class="row gap"><input class="input grow" data-change="collar-q" value="${esc(draft.q)}" placeholder="Имя, телефон или email ситтера" enterkeyhint="search">
        <button class="btn" data-act="collar-search" ${draft.searching ? "disabled" : ""}>Найти</button></div>
       <div class="chips tight">${draft.found
         .map((u) => `<button class="chip small" data-act="collar-walker-pick" data-id="${esc(u.id)}" data-name="${esc(u.name)}">${esc(who(u.name, u.id))}</button>`)
         .join("")}</div>`;
  const form = collars.form
    ? `<div class="card stack"><b>Привязать трекер</b>
        <div class="field"><span class="field-label">Id устройства (IMEI / серийный)</span><input class="input" data-change="collar-device" value="${esc(draft.device_id)}"></div>
        <div class="field"><span class="field-label">Ситтер</span>${picked}</div>
        <div class="row gap"><button class="btn" data-act="collar-assign" ${off || !draft.walker ? "disabled" : ""}>Привязать</button>
          <button class="btn ghost" data-act="collar-form-close" ${off}>Отмена</button></div></div>`
    : `<button class="btn ghost wide" data-act="collar-form-open">➕ Привязать трекер</button>`;
  return `<section class="list"><h2>Трекеры</h2>${notice(collars.notice)}${form}${rows}</section>`;
}

async function act(fn, ok) {
  collars.busy = true;
  collars.notice = null;
  render();
  try {
    await fn();
    collars.notice = ok ? { kind: "ok", text: ok } : null;
    haptic("success");
    collars.busy = false;
    await load();
    return;
  } catch (err) {
    collars.notice = { kind: "error", text: err.message };
    haptic("error");
  }
  collars.busy = false;
  render();
}

registerChanges({
  "collar-device": (input) => {
    draft.device_id = input.value.trim();
  },
  "collar-q": (input) => {
    draft.q = input.value.trim();
  },
  "collar-phone": (input) => {
    draft.phone = input.value.trim();
  },
});

registerActions({
  "collar-form-open": () => {
    collars.form = true;
  },
  "collar-form-close": () => {
    collars.form = null;
  },
  "collar-search": async () => {
    draft.searching = true;
    render();
    try {
      draft.found = draft.q ? await api("GET", `/admin/users?limit=20&q=${encodeURIComponent(draft.q)}`) : [];
      if (!draft.found.length) collars.notice = { kind: "error", text: "Никого не нашли." };
    } catch (err) {
      collars.notice = { kind: "error", text: err.message };
    }
    draft.searching = false;
    render();
  },
  "collar-walker-pick": ({ id, name }) => {
    draft.walker = { id, name };
    draft.found = [];
    collars.notice = null;
  },
  "collar-walker-clear": () => {
    draft.walker = null;
  },
  "collar-assign": () =>
    act(async () => {
      if (!draft.device_id || !draft.walker) throw new Error("Нужны id устройства и ситтер.");
      await api("POST", "/admin/collars", { device_id: draft.device_id, walker_user_id: draft.walker.id });
      draft.device_id = "";
      draft.walker = null;
      collars.form = null;
    }, "Трекер привязан"),
  "collar-unassign": ({ id }) => act(() => api("DELETE", `/admin/collars/${encodeURIComponent(id)}`), "Привязка снята"),
  "collar-phone-ask": ({ id, phone }) => {
    collars.phoneFor = id;
    draft.phone = phone;
  },
  "collar-phone-cancel": () => {
    collars.phoneFor = null;
  },
  "collar-phone-save": ({ id }) =>
    act(async () => {
      await api("PATCH", `/admin/collars/${encodeURIComponent(id)}/phone`, { phone: draft.phone || null });
      collars.phoneFor = null;
    }, "Номер сохранён"),
});

registerScreen({ key: "collars", label: "Трекеры", view, open: load });
