// Точка входа мини-аппа ситтера. Вкладки идут в порядке импорта экранов:
// новый экран — файл в screens/ с registerScreen() и одна строка импорта здесь.
import { boot } from "./core.js";
import "./screens/schedule.js";
import "./screens/orders.js";
import "./screens/offers.js";
import "./screens/cabinet.js";
import "./screens/profile.js";

boot();
