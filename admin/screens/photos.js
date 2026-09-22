// «Фото» — три очереди модерации из админ-бота: фото профиля (KAN-489, ждут
// одобрения до показа), галерея ситтера (KAN-473/474, публикуется сразу, админ
// снимает) и фото в отзывах (KAN-503, тоже снимаются постфактум). Сетка, решение
// одним тапом; отклонение — с причиной, её увидит ситтер.
import { api } from "../../api.js";
import { esc, fmtWhen, haptic, registerActions, registerScreen, render } from "../../core.js";
import { ACTIONS as KIT_ACTIONS, clearDraft } from "../../screens/chatkit.js";
import { WALKER_STATUS, askForm, label, listState, notice, onAskCancel, reasonOf, who } from "../kit.js";

const SECTIONS = [
  ["avatars", "Фото профиля"],
  ["gallery", "Галерея"],
  ["reviews", "Фото в отзывах"],
];
const PATHS = {
  avatars: "/admin/walker-avatars/incoming?limit=50",
  gallery: "/admin/walker-photos/incoming?limit=50",
  reviews: "/admin/review-photos/incoming?limit=50",
};

const photos = { section: "avatars", items: [], loading: false, error: null, busy: false, notice: null, ask: null };

async function load() {
  photos.loading = true;
  photos.error = null;
  render();
  try {
    photos.items = await api("GET", PATHS[photos.section]);
  } catch (err) {
    photos.error = err.message;
  }
  photos.loading = false;
  render();
}

function tile(item) {
  const s = photos.section;
  const off = photos.busy ? "disabled" : "";
  if (s === "avatars") {
    return `<div class="card tile">
      <button class="msg-photo" data-act="photo-open" data-url="${esc(item.pending_url)}"><img src="${esc(item.pending_url)}" alt="" loading="lazy"></button>
      <div class="muted"><b>${esc(who(item.walker_name, item.walker_user_id))}</b><br>${esc(label(WALKER_STATUS, item.walker_status))} · ${esc(fmtWhen(item.pending_at))}</div>
      ${item.current_url ? `<div class="muted">сейчас: <button class="chip small" data-act="photo-open" data-url="${esc(item.current_url)}">текущее фото</button></div>` : ""}
      <div class="row gap">
        <button class="chip small on" data-act="photo-decide" data-kind="avatar" data-id="${esc(item.walker_user_id)}" data-version="${esc(item.version)}" data-decision="approved" ${off}>✅ Принять</button>
        <button class="chip small" data-act="photo-reject-ask" data-kind="avatar" data-id="${esc(item.walker_user_id)}" data-version="${esc(item.version)}" ${off}>❌ Отклонить</button>
      </div></div>`;
  }
  if (s === "gallery") {
    return `<div class="card tile">
      <button class="msg-photo" data-act="photo-open" data-url="${esc(item.url)}"><img src="${esc(item.thumb_url)}" alt="" loading="lazy"></button>
      <div class="muted"><b>${esc(who(item.walker_name, item.walker_user_id))}</b><br>в галерее одобрено: ${item.approved_count} · ${esc(fmtWhen(item.created_at))}</div>
      <div class="row gap">
        <button class="chip small on" data-act="photo-decide" data-kind="gallery" data-id="${esc(item.id)}" data-decision="approved" ${off}>✅ Оставить</button>
        <button class="chip small" data-act="photo-reject-ask" data-kind="gallery" data-id="${esc(item.id)}" ${off}>❌ Снять</button>
      </div></div>`;
  }
  return `<div class="card tile">
      <button class="msg-photo" data-act="photo-open" data-url="${esc(item.url)}"><img src="${esc(item.thumb_url)}" alt="" loading="lazy"></button>
      <div class="muted"><b>${esc(item.author_name)}</b> → ${esc(item.walker_name)}<br>${"★".repeat(item.rating)} · ${esc(fmtWhen(item.created_at))}</div>
      ${item.comment ? `<div class="muted">${esc(item.comment.slice(0, 120))}</div>` : ""}
      <div class="row gap">
        <button class="chip small on" data-act="photo-decide" data-kind="review" data-id="${esc(item.id)}" data-decision="keep" ${off}>✅ Оставить</button>
        <button class="chip small" data-act="photo-decide" data-kind="review" data-id="${esc(item.id)}" data-decision="remove" ${off}>🗑 Удалить</button>
      </div></div>`;
}

function view() {
  const chips = SECTIONS.map(
    ([key, text]) => `<button class="chip small ${photos.section === key ? "on" : ""}" data-act="photo-section" data-value="${key}">${esc(text)}</button>`,
  ).join("");
  const empty = listState(photos, "Очередь пуста.");
  const grid = empty ?? `<div class="grid">${photos.items.map(tile).join("")}</div>`;
  return `<section class="list"><h2>Фото</h2>
    <div class="chips tight">${chips}</div>
    ${notice(photos.notice)}
    ${askForm(photos.ask, photos.busy)}
    ${grid}
    <button class="btn ghost wide" data-act="photo-refresh" ${photos.loading ? "disabled" : ""}>Обновить</button>
  </section>`;
}

async function decide({ kind, id, version, decision, reasonKey }) {
  photos.busy = true;
  photos.notice = null;
  render();
  try {
    const reason = reasonKey ? reasonOf(reasonKey) : null;
    if (kind === "avatar") {
      await api("POST", `/admin/walker-avatars/${id}/review`, { decision, reason, version });
    } else if (kind === "gallery") {
      await api("POST", `/admin/walker-photos/${id}/review`, { decision, reason });
    } else if (decision === "keep") {
      await api("POST", `/admin/review-photos/${id}/keep`);
    } else {
      await api("DELETE", `/admin/review-photos/${id}`);
    }
    if (reasonKey) clearDraft(reasonKey);
    photos.ask = null;
    haptic("success");
    photos.busy = false;
    await load();
    return;
  } catch (err) {
    photos.notice = { kind: "error", text: err.message };
    haptic("error");
  }
  photos.busy = false;
  render();
}

registerActions({
  ...KIT_ACTIONS,
  "photo-section": ({ value }) => {
    photos.section = value;
    photos.ask = null;
    return load();
  },
  "photo-refresh": load,
  "photo-decide": ({ kind, id, version, decision }) => decide({ kind, id, version, decision }),
  "photo-reject-ask": ({ kind, id, version }) => {
    photos.ask = {
      key: "photo-reject",
      title: kind === "avatar" ? "Отклонить фото профиля" : "Снять фото из галереи",
      placeholder: "Причина — её увидит ситтер",
      act: "photo-reject-go",
      data: { kind, id, version: version ?? "" },
      submit: "Отклонить",
      danger: true,
    };
  },
  "photo-reject-go": ({ kind, id, version }) =>
    decide({ kind, id, version: version || undefined, decision: "rejected", reasonKey: "photo-reject" }),
});

onAskCancel(() => {
  photos.ask = null;
});

registerScreen({ key: "photos", label: "Фото", view, open: load });
