// Клиент API. Токен живёт только в памяти вкладки: при каждом открытии мини-апп
// заново меняет свежий initData на JWT, в localStorage ничего не кладём.
import { API_BASE } from "./config.js";

let accessToken = null;

export class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function initData() {
  return window.Telegram?.WebApp?.initData || "";
}

export function insideTelegram() {
  return initData() !== "";
}

async function parseError(resp) {
  // конверт ядра: {"detail": {"code", "message"}}; у 422 detail бывает списком
  let code = "http_" + resp.status;
  let message = "Ошибка сервера (" + resp.status + ")";
  try {
    const detail = (await resp.json()).detail;
    if (detail && typeof detail === "object" && !Array.isArray(detail)) {
      code = detail.code || code;
      message = detail.message || message;
      const first = Array.isArray(detail.errors) && detail.errors[0];
      if (first && first.msg) message += ": " + first.msg;
    }
  } catch {
    // тело не JSON (502 от прокси) — остаётся текст по статусу
  }
  return new ApiError(resp.status, code, message);
}

async function send(path, options) {
  try {
    return await fetch(API_BASE + path, options);
  } catch {
    throw new ApiError(0, "network", "Нет связи с сервером. Проверьте интернет и повторите.");
  }
}

export async function login() {
  const resp = await send("/auth/telegram/webapp", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ init_data: initData() }),
  });
  if (!resp.ok) throw await parseError(resp);
  accessToken = (await resp.json()).access_token;
}

export async function api(method, path, body) {
  for (let attempt = 0; ; attempt++) {
    if (!accessToken) await login();
    const headers = { Authorization: "Bearer " + accessToken };
    // FormData (фото) уходит как есть: Content-Type с boundary браузер ставит сам
    const isForm = body instanceof FormData;
    if (body !== undefined && !isForm) headers["Content-Type"] = "application/json";
    const resp = await send(path, {
      method,
      headers,
      body: body === undefined || isForm ? body : JSON.stringify(body),
    });
    // access живёт 15 минут: один раз входим заново и повторяем запрос
    if (resp.status === 401 && attempt === 0) {
      accessToken = null;
      continue;
    }
    if (!resp.ok) throw await parseError(resp);
    return resp.status === 204 ? null : resp.json();
  }
}
