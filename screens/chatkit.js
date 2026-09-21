// Общее у переписки с клиентом и с поддержкой (KAN-509): пузыри, опрос, черновик,
// прокрутка. core перерисовывает экран целиком (innerHTML), поэтому всё, что живёт
// в DOM между перерисовками — набранный текст, фокус, прокрутка, — держим здесь.
import { dayFmt, esc, keyFmt, render, timeFmt, tg } from "../core.js";

// Те же интервалы, что ядро раздаёт приложению в /config (poll_chat_seconds,
// poll_chat_background_seconds): открытая переписка и список диалогов.
export const POLL_OPEN_MS = 5000;
export const POLL_LIST_MS = 30000;

export const MAX_TEXT = 4000; // MessageCreate.text / SupportMessageCreate.text
export const PHOTO_ACCEPT = "image/jpeg,image/png,image/heic,image/heif";

// --- черновики -----------------------------------------------------------------

const drafts = {}; // ключ поля (data-draft) → набранный текст

document.addEventListener("input", (event) => {
  const field = event.target.closest?.("[data-draft]");
  if (field) drafts[field.dataset.draft] = field.value;
});

export const draft = (key) => drafts[key] || "";
export const clearDraft = (key) => delete drafts[key];

// --- перерисовка без потерь ---------------------------------------------------

const atBottom = () => window.innerHeight + window.scrollY >= document.body.scrollHeight - 80;

// mode: "keep" — прокрутку не трогаем (новое пришло, пока читают старое),
// "bottom" — к последнему сообщению, "older" — подгрузили историю сверху: держим
// на экране то же сообщение, что было. Фокус и курсор в поле ввода переживают
// перерисовку — опрос раз в 5 секунд иначе выбивал бы клавиатуру.
export function rerender(mode = "keep") {
  const active = document.activeElement;
  const focusKey = active?.dataset?.draft;
  const caret = focusKey ? [active.selectionStart, active.selectionEnd] : null;
  const stick = mode === "bottom" || (mode === "keep" && atBottom());
  const fromBottom = document.body.scrollHeight - window.scrollY;
  render();
  if (focusKey) {
    const field = document.querySelector(`[data-draft="${focusKey}"]`);
    if (field) {
      field.focus({ preventScroll: true });
      field.setSelectionRange(...caret);
    }
  }
  if (stick) window.scrollTo(0, document.body.scrollHeight);
  else if (mode === "older") window.scrollTo(0, document.body.scrollHeight - fromBottom);
}

// --- опрос ---------------------------------------------------------------------

// Таймер, который сам молчит, пока вкладка Telegram свёрнута, и останавливается,
// как только active() вернул false (ушли с экрана). Второй тик не стартует, пока
// не закончился первый: медленная сеть не копит очередь запросов.
export function poller(ms, active, tick) {
  let timer = null;
  let running = false;
  const stop = () => {
    clearInterval(timer);
    timer = null;
  };
  return {
    start() {
      stop();
      timer = setInterval(async () => {
        if (!active()) return stop();
        if (document.hidden || running) return;
        running = true;
        try {
          await tick();
        } catch {
          // сеть моргнула — следующий тик попробует снова, экран не ломаем
        }
        running = false;
      }, ms);
    },
    stop,
  };
}

// --- отрисовка -----------------------------------------------------------------

function dayLabel(iso) {
  const key = keyFmt.format(new Date(iso));
  if (key === keyFmt.format(new Date())) return "Сегодня";
  if (key === keyFmt.format(new Date(Date.now() - 86400000))) return "Вчера";
  return dayFmt.format(new Date(iso));
}

// items: [{id, side: "mine"|"theirs"|"system", author?, text, photos: [url], at}]
export function bubbles(items) {
  let lastDay = "";
  return items
    .map((item) => {
      const day = keyFmt.format(new Date(item.at));
      const divider = day !== lastDay ? `<div class="msg-day">${esc(dayLabel(item.at))}</div>` : "";
      lastDay = day;
      if (item.side === "system") {
        return `${divider}<div class="msg-system">${esc(item.text)}</div>`;
      }
      const photos = item.photos
        .map(
          (url) =>
            `<button class="msg-photo" data-act="photo-open" data-url="${esc(url)}">` +
            `<img src="${esc(url)}" alt="Фото" loading="lazy"></button>`,
        )
        .join("");
      const author = item.author ? `<div class="msg-author">${esc(item.author)}</div>` : "";
      const text = item.text ? `<div class="msg-text">${esc(item.text)}</div>` : "";
      const pending = item.pending ? " pending" : "";
      return `${divider}<div class="msg ${item.side}${pending}">${author}${photos}${text}
        <div class="msg-time">${item.pending ? "отправляется…" : esc(timeFmt.format(new Date(item.at)))}</div></div>`;
    })
    .join("");
}

// Поле выбора фото живёт в body, вне #app: опрос перерисовывает переписку каждые
// 5 секунд, и поле внутри разметки отцепилось бы, пока открыта галерея, — выбранные
// фото молча пропали бы (грабля KAN-504). Прячем за край экрана, а не hidden:
// старые iOS WebView не открывают галерею у скрытого поля.
// Создаётся при первом нажатии скрепки, не при загрузке: кто не открывал чат, лишних
// полей в DOM не получает.
export function photoPicker({ multiple, onFiles }) {
  let picker = null;
  return () => {
    if (!picker) {
      picker = document.createElement("input");
      Object.assign(picker, { type: "file", accept: PHOTO_ACCEPT, multiple, className: "offscreen" });
      document.body.append(picker);
      picker.addEventListener("change", () => {
        const files = [...picker.files];
        picker.value = ""; // иначе повторный выбор того же файла не даст change
        if (files.length) onFiles(files);
      });
    }
    picker.click();
  };
}

// Поле ввода со скрепкой. Фото уходит с набранным текстом как подписью — так же,
// как в Telegram. Скрепка — обычная data-act="<key>-pick", она зовёт picker.click().
export function composer({ key, placeholder, busy }) {
  const off = busy ? "disabled" : "";
  return `<div class="composer">
    <button class="attach" data-act="${key}-pick" ${off} aria-label="Прикрепить фото">📎</button>
    <textarea data-draft="${key}" rows="1" maxlength="${MAX_TEXT}"
      placeholder="${esc(placeholder)}">${esc(draft(key))}</textarea>
    <button class="send" data-act="${key}-send" ${off} aria-label="Отправить">➤</button>
  </div>`;
}

export const newClientId = () =>
  crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;

export const ACTIONS = {
  // presigned-ссылка открывается во внешнем просмотрщике Telegram в полном размере
  "photo-open": ({ url }) => {
    if (tg?.openLink) tg.openLink(url);
    else window.open(url, "_blank", "noopener");
  },
};
