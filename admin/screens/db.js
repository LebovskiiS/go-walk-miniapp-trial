// «Данные» — как 🗄 в админ-боте (KAN-363): таблицы БД с числом строк, просмотр
// таблицы постранично с поиском по строке (на клиенте, в загруженной странице).
// Только чтение — ядро других ручек не даёт.
import { api } from "../../api.js";
import { esc, registerActions, registerChanges, registerOverlay, registerScreen, render } from "../../core.js";
import { listState } from "../kit.js";

const PAGE = 50;

const tables = { items: [], loading: false, error: null, loaded: false };
let table = null; // {name, columns, rows, total, offset, loading, error, q}

async function loadTables() {
  tables.loading = true;
  tables.error = null;
  render();
  try {
    tables.items = await api("GET", "/admin/db/tables");
    tables.loaded = true;
  } catch (err) {
    tables.error = err.message;
  }
  tables.loading = false;
  render();
}

function listView() {
  const empty = listState(tables, "Таблиц нет.");
  const rows = empty ?? tables.items
    .map((t) => `<button class="card row item-link" data-act="db-open" data-name="${esc(t.name)}"><b>${esc(t.name)}</b><span class="badge">${t.rows}</span></button>`)
    .join("");
  return `<section class="list"><h2>База данных</h2><p class="muted">Только чтение. Чувствительные поля ядро маскирует само.</p>${rows}</section>`;
}

async function openTable(name, offset = 0) {
  table = { name, columns: [], rows: [], total: 0, offset, loading: true, error: null, q: table?.name === name ? table.q : "" };
  render();
  try {
    const data = await api("GET", `/admin/db/tables/${encodeURIComponent(name)}?limit=${PAGE}&offset=${offset}`);
    Object.assign(table, { columns: data.columns, rows: data.rows, total: data.total });
  } catch (err) {
    table.error = err.message;
  }
  if (table?.name !== name) return;
  table.loading = false;
  render();
}

const cell = (v) => (v === null || v === undefined ? "∅" : typeof v === "object" ? JSON.stringify(v) : String(v));

function tableView() {
  const t = table;
  if (t.loading) return `<div class="state"><div class="spinner"></div></div>`;
  if (t.error) return `<section class="list"><div class="notice error">${esc(t.error)}</div></section>`;
  const q = t.q.trim().toLowerCase();
  const rows = q ? t.rows.filter((r) => r.some((v) => cell(v).toLowerCase().includes(q))) : t.rows;
  const cards = rows.length
    ? rows
        .map(
          (r) => `<div class="card">${t.columns
            .map((c, i) => `<div class="kv"><span class="muted">${esc(c)}</span><span>${esc(cell(r[i]).slice(0, 200))}</span></div>`)
            .join("")}</div>`,
        )
        .join("")
    : `<p class="muted center">Ничего не нашлось на этой странице.</p>`;
  const from = t.offset + 1;
  const to = Math.min(t.offset + PAGE, t.total);
  return `<section class="list"><h2>${esc(t.name)}</h2>
    <p class="muted">${t.total ? `строки ${from}–${to} из ${t.total}` : "пусто"}</p>
    <input class="input" data-change="db-q" value="${esc(t.q)}" placeholder="Поиск по загруженной странице">
    ${cards}
    <div class="row gap">
      <button class="btn ghost" data-act="db-page" data-offset="${Math.max(0, t.offset - PAGE)}" ${t.offset === 0 ? "disabled" : ""}>◀️ Раньше</button>
      <button class="btn ghost" data-act="db-page" data-offset="${t.offset + PAGE}" ${to >= t.total ? "disabled" : ""}>Ещё ▶️</button></div>
  </section>`;
}

registerOverlay({
  isOpen: () => table !== null,
  view: tableView,
  close: () => {
    table = null;
  },
});

registerChanges({
  "db-q": (input) => {
    if (table) {
      table.q = input.value;
      render();
    }
  },
});

registerActions({
  "db-open": ({ name }) => openTable(name),
  "db-page": ({ offset }) => openTable(table.name, Number(offset)),
});

registerScreen({ key: "db", label: "Данные", view: listView, open: () => (tables.loaded ? undefined : loadTables()) });
