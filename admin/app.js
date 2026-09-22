// Точка входа мини-аппа админа (KAN-524). Оболочка та же, что у кабинета ситтера
// (../core.js): вкладки в порядке импорта, экраны регистрируются сами. Открывается
// из @bosupport_bot и повторяет разделы админ-бота и бота поддержки.
import { ApiError } from "../api.js";
import { boot, state } from "../core.js";
import { loadSummary } from "./screens/home.js";
import "./screens/support.js";
import "./screens/applications.js";
import "./screens/photos.js";
import "./screens/users.js";
import "./screens/orders.js";
import "./screens/disputes.js";
import "./screens/collars.js";
import "./screens/db.js";

boot({
  outsideTitle: "Админка открывается внутри Telegram",
  outsideText: "Откройте бота @bosupport_bot и перейдите по ссылке на админку.",
  gateIcon: "🔒",
  gateTitle: "Нет доступа",
  fatalTitle: "Не получилось открыть админку",
  // Роль проверяет ядро: первый же админский запрос отвечает 403 не-админу
  load: async () => {
    await loadSummary();
    state.screen = "main";
  },
  onLoadError: (err) => {
    if (err instanceof ApiError && err.status === 403) {
      state.screen = "gate";
      state.message = "Админка доступна только администраторам go_walk.";
      return true;
    }
    return false;
  },
});
