// Единственное место с адресом API. Стенд go-walk-prod — в него же ходят живые боты.
export const API_BASE = "https://api.go-lab.online";

// Все времена показываем и задаём в зоне сервиса (availability_tz), а не телефона:
// расписание «06:00–12:00» — это московские шесть утра, где бы ни был ситтер.
export const TZ = "Europe/Moscow";
export const TZ_OFFSET_HOURS = 3;
