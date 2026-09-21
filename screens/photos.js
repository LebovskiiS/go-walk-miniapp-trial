// «Фото и документы» (KAN-508): фото профиля, галерея «Мои фото», документы проверки.
// Отдельный экран поверх вкладок — открывается из «Анкеты» (кнопка data-act="photosOpen").
//
// Картинки — presigned-ссылки S3 (хост в CSP img-src, index.html). Правила и тексты
// отказов — те же, что в боте (bot/app/texts.py, KAN-474 / KAN-489 / KAN-369).
import { api, ApiError } from "../api.js";
import {
  applyProfile, esc, haptic, registerActions, registerOverlay, render, state,
} from "../core.js";

const GALLERY_LIMIT = 10;
const MAX_FILE_BYTES = 10 * 1024 * 1024; // потолок ядра (core/uploads) — не шлём заведомый отказ
const IMAGE_EXT = /\.(jpe?g|png|heic|heif)$/i;

const DOC_CAPTION = {
  passport: "Паспорт",
  selfie: "Селфи",
  cynology_certificate: "Сертификат кинолога",
  other: "Документ",
};
const DOC_STATUS = {
  approved: ["ok", "✅ принят"],
  reupload: ["warn", "🔄 нужно прислать заново"],
  rejected: ["warn", "❌ не принят"],
};
const PHOTO_STATUS = {
  pending: "⏳ на проверке",
  approved: "✅ опубликовано",
  rejected: "❌ снято",
};

const T = {
  rules: [
    "Сюда — фото, где вы с собаками: на прогулке, на передержке, на занятии. "
      + `Клиент видит их, когда выбирает ситтера. До ${GALLERY_LIMIT} фото; первое — обложка.`,
    "Нельзя: чужие люди и дети в кадре; телефоны, адреса, таблички домов; реклама и "
      + "водяные знаки других сервисов; чужие и стоковые картинки.",
    "Собаки клиентов — только с согласия владельца. Нажимая кнопку, вы подтверждаете, "
      + "что оно у вас есть. По жалобе владельца фото снимаем.",
    "Фото публикуется сразу. Администратор просматривает галереи и снимает то, что нарушает "
      + "правила, — причину пришлём в бота. Геометка из файла срезается при загрузке.",
  ],
  galleryEmpty: "Пока пусто. Фото с собаками — главный довод для клиента: по ним он решает, кому доверить питомца.",
  galleryFull: `В галерее уже ${GALLERY_LIMIT} фото — это предел. Удалите одно из старых, чтобы добавить новое.`,
  notImage: "Этот файл — не картинка. Подойдут JPEG, PNG и HEIC.",
  tooBig: "Файл больше 10 МБ — такой не примем. Пришлите фото поменьше.",
  unreadable: "Не получилось прочитать файл как фото. Подойдут JPEG, PNG и HEIC.",
  rateLimited: "Слишком много загрузок за час. Попробуйте позже.",
  deleteAsk: "Удалить это фото? Клиенты перестанут его видеть сразу.",
  deleted: "Фото удалено.",
  madeFirst: "Теперь это фото первое — обложка галереи.",
  gone: "Этого фото уже нет.",
  avatarHint: "Портрет, где хорошо видно лицо. Клиенты видят его в списке ситтеров и в вашей карточке.",
  avatarNone: "Фото пока нет — в карточке показываются инициалы. С фото ситтера выбирают охотнее.",
  avatarHas: "Фото загружено — клиенты видят его в списке и карточке.",
  avatarPending: "⏳ Новое фото на проверке — клиенты увидят его после одобрения.",
  avatarSentKeepsOld: "🖼 Фото отправлено на проверку. Пока администратор не решит, клиенты видят прежнее фото.",
  avatarSentFirst: "🖼 Фото отправлено на проверку. Пока администратор не решит, в карточке остаются инициалы.",
  avatarDeleteAsk: "Убрать фото профиля? В карточке снова будут инициалы.",
  avatarDeleted: "Фото профиля убрано — в карточке снова инициалы.",
  docsHint: "Паспорт и селфи нужны только для проверки — клиентам их не показывают.",
  docSaved: (type) => `📎 ${DOC_CAPTION[type] ?? type}: получено, ожидает проверки. Результат пришлём в бота.`,
};

let isOpen = false;
let loading = false;
let photos = null; // GET /walker/me/photos
let docs = null; // GET /walker/documents
let avatarUrl = null; // опубликованное фото — из публичной карточки
let busy = false;
let notice = null; // {kind, text}
let confirm = null; // {kind: "photo", id} | {kind: "avatar"}

// --- загрузка файлов ------------------------------------------------------------------

// Отказ ядра по файлу → текст для ситтера (как reject_outcome в bot/app/gallery.py)
function fileProblem(err) {
  if (!(err instanceof ApiError)) return err.message;
  if (err.code === "photo_limit_exceeded") return T.galleryFull;
  if (err.code === "rate_limited" || err.status === 429) return T.rateLimited;
  if (err.status === 413) return T.tooBig;
  if (err.status === 415) return T.unreadable;
  return err.message;
}

function precheck(file) {
  if (!(file.type.startsWith("image/") || IMAGE_EXT.test(file.name))) return T.notImage;
  if (file.size > MAX_FILE_BYTES) return T.tooBig;
  return null;
}

function formWith(file, extra = {}) {
  const form = new FormData();
  for (const [key, value] of Object.entries(extra)) form.append(key, value);
  form.append("file", file, file.name || "photo.jpg");
  return form;
}

// Файл уходит на сервер, только если прошёл проверку в браузере; итог — в notice
async function upload(files, send, okText) {
  busy = true;
  notice = null;
  confirm = null;
  render();
  let accepted = 0;
  const problems = [];
  for (const file of files) {
    const bad = precheck(file);
    if (bad) {
      problems.push(bad);
      continue;
    }
    try {
      await send(file);
      accepted += 1;
    } catch (err) {
      problems.push(fileProblem(err));
      if (err instanceof ApiError && (err.code === "photo_limit_exceeded" || err.status === 429)) break;
    }
  }
  if (files.length === 1) {
    notice = problems.length ? { kind: "error", text: problems[0] } : { kind: "ok", text: okText() };
  } else {
    const lines = [`Принято ${accepted} из ${files.length}, лимит — ${GALLERY_LIMIT} фото.`];
    for (const text of new Set(problems)) {
      const count = problems.filter((item) => item === text).length;
      lines.push(`• ${text}${count > 1 ? ` (×${count})` : ""}`);
    }
    notice = { kind: problems.length ? "error" : "ok", text: lines.join("\n") };
  }
  haptic(problems.length ? "error" : "success");
  await reload();
  busy = false;
  render();
}

// --- данные ---------------------------------------------------------------------------

async function reload() {
  const [photoList, docList, card] = await Promise.all([
    api("GET", "/walker/me/photos").catch(() => photos),
    api("GET", "/walker/documents").catch(() => docs),
    // опубликованное фото профиля ситтер видит так же, как клиент: из своей карточки
    api("GET", `/walkers/${state.profile.user_id}`).catch(() => null),
  ]);
  photos = photoList ?? [];
  docs = docList ?? [];
  avatarUrl = card?.avatar_url ?? null;
}

async function show() {
  isOpen = true;
  notice = null;
  confirm = null;
  loading = true;
  render();
  window.scrollTo(0, 0);
  try {
    await reload();
  } catch (err) {
    notice = { kind: "error", text: err.message };
  }
  loading = false;
  render();
}

async function run(action) {
  busy = true;
  notice = null;
  render();
  try {
    notice = { kind: "ok", text: await action() };
    haptic("success");
  } catch (err) {
    notice = { kind: "error", text: err instanceof ApiError && err.status === 404 ? T.gone : err.message };
    haptic("error");
  }
  // свежий список и после отказа: 404 значит «фото уже нет» — его надо убрать с экрана
  await reload().catch(() => {});
  confirm = null;
  busy = false;
  render();
}

// --- отрисовка ------------------------------------------------------------------------

const noticeHtml = () =>
  notice ? `<p class="notice ${notice.kind} pre">${esc(notice.text)}</p>` : "";

// Кнопка выбора файла — обычная data-act: само поле живёт вне #app (см. picker ниже)
function pickButton(label, kind, { type = "", ghost = false } = {}) {
  return `<button class="btn ${ghost ? "ghost" : ""} grow" data-act="photosPick" data-kind="${kind}"
    data-type="${esc(type)}" ${busy ? "disabled" : ""}>${label}</button>`;
}

function confirmHtml(text, yesAct, yesLabel, data = "") {
  return `<div class="confirm"><p>${esc(text)}</p><div class="row gap">
    <button class="btn ghost grow" data-act="photosKeep">Оставить</button>
    <button class="btn danger grow" data-act="${yesAct}" ${data} ${busy ? "disabled" : ""}>${yesLabel}</button>
  </div></div>`;
}

function avatarSection() {
  const profile = state.profile;
  const lines = [profile.has_avatar ? T.avatarHas : T.avatarNone];
  if (profile.avatar_pending) lines.push(T.avatarPending);
  else if (profile.avatar_reject_reason) {
    lines.push(`❌ Последнее фото не приняли: ${profile.avatar_reject_reason}. Пришлите другое.`);
  }
  const picture = avatarUrl
    ? `<img class="avatar" src="${esc(avatarUrl)}" alt="Фото профиля">`
    : `<div class="avatar empty">🙂</div>`;
  const canDelete = profile.has_avatar || profile.avatar_pending;
  return `<h3>🖼 Фото профиля</h3>
    <section class="card stack">
      <div class="row start">${picture}<div>${lines.map((line) => `<p class="muted">${esc(line)}</p>`).join("")}</div></div>
      <p class="note">${esc(T.avatarHint)}</p>
      ${confirm?.kind === "avatar"
        ? confirmHtml(T.avatarDeleteAsk, "avatarDelete", "Да, убрать")
        : `<div class="row gap">${pickButton("📷 Загрузить фото", "avatar")}
            ${canDelete ? `<button class="btn ghost grow" data-act="avatarAsk" ${busy ? "disabled" : ""}>🗑 Убрать</button>` : ""}</div>`}
    </section>`;
}

function gallerySection() {
  const head = `<h3>📸 Мои фото <span class="muted">· ${photos.length} из ${GALLERY_LIMIT}</span></h3>`;
  if (!state.profile.gallery_rules_accepted_at) {
    return `${head}<section class="card stack">
      <b>Правила галереи</b>
      ${T.rules.map((text) => `<p class="muted">${esc(text)}</p>`).join("")}
      <button class="btn wide" data-act="galleryAccept" ${busy ? "disabled" : ""}>Понятно, согласен</button>
    </section>`;
  }
  const tiles = photos.map((photo, index) => {
    const status = PHOTO_STATUS[photo.status] ?? photo.status;
    const reason = photo.status === "rejected" && photo.reject_reason ? `: ${photo.reject_reason}` : "";
    const actions = confirm?.kind === "photo" && confirm.id === photo.id
      ? confirmHtml(T.deleteAsk, "photoDelete", "Да, удалить", `data-id="${esc(photo.id)}"`)
      : `<div class="row gap">
          ${index > 0 ? `<button class="chip small" data-act="photoFirst" data-id="${esc(photo.id)}" ${busy ? "disabled" : ""}>⭐ Первым</button>` : `<span class="chip small on">обложка</span>`}
          <button class="chip small" data-act="photoAsk" data-id="${esc(photo.id)}" ${busy ? "disabled" : ""}>🗑</button>
        </div>`;
    return `<div class="tile">
      <img src="${esc(photo.thumb_url)}" alt="Фото ${index + 1}" loading="lazy">
      <div class="muted">${index + 1}. ${esc(status + reason)}</div>
      ${actions}
    </div>`;
  }).join("");
  const add = photos.length < GALLERY_LIMIT
    ? pickButton("➕ Добавить фото", "gallery")
    : `<p class="note">${esc(T.galleryFull)}</p>`;
  return `${head}<section class="card stack">
    ${photos.length ? `<div class="grid">${tiles}</div>` : `<p class="muted">${esc(T.galleryEmpty)}</p>`}
    <p class="note">Клиенты видят только опубликованные. Можно выбрать несколько сразу.</p>
    <div class="row gap">${add}</div>
  </section>`;
}

function docRow(doc) {
  const [kind, label] = DOC_STATUS[doc.review_status] ?? ["", "⏳ на проверке"];
  const redo = doc.review_status === "reupload" || doc.review_status === "rejected";
  return `<div class="doc">
    <img src="${esc(doc.url)}" alt="" loading="lazy">
    <div class="grow">
      <b>${esc(DOC_CAPTION[doc.doc_type] ?? doc.doc_type)}</b>
      <div class="muted ${kind}">${esc(label)}</div>
      ${doc.review_note ? `<div class="muted">Комментарий проверяющего: ${esc(doc.review_note)}</div>` : ""}
      ${redo ? `<div class="row gap">${pickButton("📎 Загрузить заново", "doc", { type: doc.doc_type, ghost: true })}</div>` : ""}
    </div>
  </div>`;
}

function docsSection() {
  // одна строка на тип — последний загруженный (ядро отдаёт все версии)
  const latest = new Map();
  for (const doc of [...docs].sort((a, b) => a.created_at.localeCompare(b.created_at))) {
    latest.set(doc.doc_type, doc);
  }
  const rows = [...latest.values()].map(docRow).join("");
  const addCert = latest.has("cynology_certificate")
    ? ""
    : pickButton("➕ Сертификат кинолога", "doc", { type: "cynology_certificate", ghost: true });
  return `<h3>📎 Документы</h3>
    <section class="card stack">
      ${rows || `<p class="muted">Документов пока нет.</p>`}
      <p class="note">${esc(T.docsHint)}</p>
      ${addCert ? `<div class="row gap">${addCert}</div>` : ""}
    </section>`;
}

function photosView() {
  const back = `<button class="link back" data-act="back">‹ Анкета</button>`;
  if (loading || photos === null) return `${back}<div class="state"><div class="spinner"></div></div>`;
  return `${back}<h2>Фото и документы</h2>${noticeHtml()}
    ${avatarSection()}${gallerySection()}${docsSection()}`;
}

// --- регистрация -------------------------------------------------------------------------

registerOverlay({
  isOpen: () => isOpen,
  view: photosView,
  close: () => {
    isOpen = false;
  },
});

registerActions({
  photosOpen: () => show(),
  photosKeep: () => {
    confirm = null;
  },
  avatarAsk: () => {
    confirm = { kind: "avatar" };
  },
  avatarDelete: () =>
    run(async () => {
      applyProfile(await api("DELETE", "/walker/me/avatar"));
      avatarUrl = null;
      return T.avatarDeleted;
    }),
  galleryAccept: () =>
    run(async () => {
      applyProfile(await api("POST", "/walker/me/photos/rules-accept"));
      return "Спасибо, согласие записали.";
    }),
  photoAsk: ({ id }) => {
    confirm = { kind: "photo", id };
  },
  photoDelete: ({ id }) =>
    run(async () => {
      await api("DELETE", `/walker/me/photos/${id}`);
      return T.deleted;
    }),
  photoFirst: ({ id }) =>
    run(async () => {
      photos = await api("PUT", "/walker/me/photos/order", { ids: [id] });
      return T.madeFirst;
    }),
});

// Что делать с выбранными файлами — по назначению кнопки, которой открыли выбор
const PICKED = {
  avatar: (files) => {
    // текст «прежнее фото остаётся» — по состоянию ДО загрузки, как avatar_sent в боте
    const hadAvatar = state.profile.has_avatar;
    upload(
      files.slice(0, 1),
      async (file) => applyProfile(await api("PUT", "/walker/me/avatar", formWith(file))),
      () => (hadAvatar ? T.avatarSentKeepsOld : T.avatarSentFirst),
    );
  },
  gallery: (files) =>
    upload(
      files,
      (file) => api("POST", "/walker/me/photos", formWith(file)),
      () => "Фото опубликовано — клиенты уже видят его в вашей галерее.",
    ),
  doc: (files, type) =>
    upload(
      files.slice(0, 1),
      (file) => api("POST", "/walker/documents", formWith(file, { doc_type: type })),
      () => T.docSaved(type),
    ),
};

// Поле выбора живёт вне #app (грабля KAN-504): render() пересобирает разметку целиком,
// и поле внутри неё могло исчезнуть, пока открыта галерея телефона, — выбранные фото
// тогда терялись бы молча. Спрятано .offscreen, не display:none: старые iOS WebView
// не открывают галерею у скрытого поля.
let pickTarget = null; // {kind, type} — какой кнопкой открыт выбор
const picker = document.createElement("input");
Object.assign(picker, { type: "file", accept: "image/*,.heic,.heif", className: "offscreen" });
document.body.append(picker);
picker.addEventListener("change", () => {
  const files = [...picker.files];
  picker.value = ""; // иначе повторный выбор того же файла не даст change
  const target = pickTarget;
  pickTarget = null;
  if (files.length && target) PICKED[target.kind](files, target.type);
});

registerActions({
  photosPick: ({ kind, type }) => {
    pickTarget = { kind, type };
    picker.multiple = kind === "gallery";
    picker.click();
  },
});
