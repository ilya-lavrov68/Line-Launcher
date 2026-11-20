# Модель A: сессия провайдера — спецификация

Реализация обмена одноразового launch ticket на сессию провайдера и проверки этой
сессии игровым сервером. Часть контракта, которая **не** зафиксирована лаунчером:
формат ответа обмена и формат проверки выбирает провайдер.

Контракт лаунчера, на который это опирается — [PROVIDER.md](PROVIDER.md).

## 0. Границы: что фиксировано, а что наше решение

| Элемент                                 | Кто определяет | Значение                   |
| --------------------------------------- | -------------- | -------------------------- |
| Запрос мода → `session_exchange_url`    | **лаунчер**    | пять полей, см. §2.1       |
| HTTP-статус ответа обмена               | **лаунчер**    | `200` = успех, иначе отказ |
| Тело ответа обмена                      | **провайдер**  | эта спецификация, §2.2     |
| Как сессия проверяется игровым сервером | **провайдер**  | эта спецификация, §3       |
| Лимит тела ответа                       | **лаунчер**    | 16 КиБ                     |
| Таймауты обмена                         | **лаунчер**    | connect 10 с, запрос 30 с  |
| Редиректы обмена                        | **лаунчер**    | запрещены                  |

Лаунчер ответ обмена **не читает**. Он передаёт моду `exchange_url` через приватный
IPC и на этом участие лаунчера заканчивается: тело читает и разбирает только мод.
Поэтому формат ниже не может «сломать лаунчер» — он может сломать только мод и ваш
игровой сервер, и обе стороны пишете вы.

## 1. Общая схема

```text
лаунчер ──POST launch_ticket_url──▶ провайдер        выдаёт ticket (TTL ≤ 120 с)
   │                                    ▲
   │ IPC: ticket + exchange_url         │ POST exchange {ticket, …}
   ▼                                    │
  мод ──────────────────────────────────┘  получает session_id + session_secret
   │
   │ login plugin message: session_id, nonce, proof
   ▼
игровой сервер ──POST /v1/session/verify──▶ провайдер   valid / отказ
```

`access_token` провайдера (долгоживущий, 1–86400 с, открывает все серверы проекта)
в этой схеме **не участвует**: он остаётся внутри лаунчера и моду не передаётся
никогда.

## 2. Обмен ticket → сессия

### 2.1. Запрос — зафиксирован лаунчером, менять нельзя

```http
POST https://auth.example.com/v1/launcher/exchange
Content-Type: application/json
Accept: application/json
```

```json
{
  "ticket": "one-shot-ticket",
  "server_id": "survival",
  "sha256": "<64 lowercase hex>",
  "channel_id": "0f8a8800-0000-4000-8000-000000000000",
  "username": "Player_1"
}
```

Порядок проверок на стороне провайдера:

| Проверка                       | Отказ                     |
| ------------------------------ | ------------------------- |
| `ticket` известен              | `401 unknown_ticket`      |
| `ticket` ещё не использован    | `409 ticket_already_used` |
| TTL не истёк                   | `401 ticket_expired`      |
| `server_id` совпал с выданным  | `403 binding_mismatch`    |
| `sha256` совпал с выданным     | `403 binding_mismatch`    |
| `channel_id` совпал с выданным | `403 binding_mismatch`    |
| `username` совпал с выданным   | `403 binding_mismatch`    |

Пометка «использован» обязана быть атомарной, иначе две одновременные попытки
пройдут обе. В SQL это одно выражение, а не «прочитать → проверить → записать»:

```sql
UPDATE launch_tickets
   SET used_at = now()
 WHERE ticket = $1 AND used_at IS NULL
RETURNING server_id, pack_sha256, channel_id, username, expires_at;
```

Пустая строка результата означает replay (ticket уже использован) или
неизвестный ticket — различить их можно отдельным `SELECT`, но только для лога;
ответ в обоих случаях корректен как `409`/`401`.

### 2.2. Ответ `200`

```json
{
  "session_id": "7c9e6679-7425-40de-944b-e07fc1f90ae7",
  "session_secret": "<43 characters of base64url, generated per session>",
  "username": "Player_1",
  "uuid": "357b224b-7284-4b0b-9604-24bce67c4b7d",
  "server_id": "survival",
  "expires_in": 120
}
```

| Поле             | Тип    | Обязательно | Правила                                                        |
| ---------------- | ------ | ----------- | -------------------------------------------------------------- |
| `session_id`     | string | да          | UUID v4 или 32–64 hex; непрозрачный, случайный, ≥ 128 бит      |
| `session_secret` | string | да          | 32 байта в base64url (43 символа); нужен для `proof`, см. §3.3 |
| `username`       | string | да          | тот же, что в запросе                                          |
| `uuid`           | string | да          | канонический UUID аккаунта проекта, см. §5                     |
| `server_id`      | string | да          | тот же, что в запросе — мод сверяет его сам                    |
| `expires_in`     | number | да          | секунды, **30–600**; рекомендуется 120                         |

Тело должно быть одним JSON-объектом, ≤ 16 КиБ, без переносов строк. Поля с
неизвестными именами мод обязан отвергать (strict).

Чего в ответе быть **не должно**:

- `access_token` провайдера — долгоживущий, открывает все серверы проекта;
- `ticket` — уже израсходован, но передавать его дальше всё равно нельзя;
- пароль, хеш пароля, e-mail, любые данные аккаунта сверх `uuid`/`username`.

### 2.3. Коды ошибок

| Код   | `error`                             | Когда                               | Что делает мод                                                           |
| ----- | ----------------------------------- | ----------------------------------- | ------------------------------------------------------------------------ |
| `400` | `bad_request`                       | нет поля, лишнее поле, неверный тип | не повторять, сообщить игроку                                            |
| `401` | `unknown_ticket` / `ticket_expired` | не найден, истёк                    | не повторять, «запустите игру заново из лаунчера»                        |
| `403` | `binding_mismatch`                  | не совпало одно из привязок         | не повторять, это ошибка провайдера/сборки                               |
| `409` | `ticket_already_used`               | replay                              | не повторять: повторный обмен того же ticket запрещён                    |
| `429` | `rate_limited`                      | слишком часто                       | не повторять в этом запуске                                              |
| `5xx` | —                                   | сбой провайдера                     | допустим один повтор через 1–2 с, если ticket ещё не отправлялся успешно |

Повторять запрос по IPC нельзя: канал одноразовый (одно соединение, один запрос,
один ответ). Значит после неудачного обмена новый ticket мод получить не может —
игра должна завершиться с понятным сообщением, а не зависнуть.

## 3. Проверка сессии игровым сервером

### 3.1. Endpoint

```http
POST https://auth.example.com/v1/session/verify
Authorization: Bearer <server-api-key>
Content-Type: application/json
```

Это **server-to-server** вызов: его делает плагин игрового сервера, а не игрок.
Поэтому здесь уместен отдельный ключ на каждый игровой сервер — если ключ утечёт,
скомпрометирован один сервер, а не вся сеть. Ключ выдаётся вручную и ротируется.

```json
{
  "session_id": "7c9e6679-7425-40de-944b-e07fc1f90ae7",
  "username": "Player_1",
  "server_id": "survival",
  "nonce": "b7f3c1d9e0a2488f",
  "proof": "9f2c…"
}
```

`nonce` и `proof` нужны только в варианте с подтверждением (§3.3); в базовом
варианте их нет.

### 3.2. Ответ `200`

```json
{
  "valid": true,
  "username": "Player_1",
  "uuid": "357b224b-7284-4b0b-9604-24bce67c4b7d",
  "server_id": "survival",
  "expires_in": 96
}
```

`expires_in` — сколько секунд сессия ещё жива. Плагин может кэшировать результат
на это время, чтобы не ходить к провайдеру на каждый реконнект.

### 3.3. Подтверждение (`proof`) — рекомендуется

Трафик Minecraft с `online-mode=false` **не шифруется**: сервер не запрашивает
шифрование, поэтому login plugin message идёт открытым текстом. Голый
`session_id` — это предъявительский токен, который любой на пути может прочитать
и переиспользовать.

Схема с подтверждением убирает пассивный перехват:

1. Сервер в login-запросе отправляет `nonce` (16+ случайных байт, hex).
2. Клиент отвечает `proof = base64url(HMAC-SHA256(session_secret, nonce))`.
3. Сервер передаёт `session_id`, `nonce`, `proof` в `/v1/session/verify`.
4. Провайдер сам вычисляет HMAC и сравнивает постоянным по времени сравнением.

`session_secret` никогда не идёт по проводу — только `proof`. Активный
человек-посередине такую схему всё ещё может ретранслировать, но пассивный
наблюдатель — уже нет. Для лаунчера игрового сервера это адекватный уровень;
полноценный TLS-туннель потребовал бы своего протокола поверх Minecraft.

Если схема с `proof` не нужна, `session_secret` из ответа обмена всё равно
выдавайте — он пригодится позже, а стоит он ноль.

### 3.4. Коды ошибок проверки

| Код   | `error`                                                   | Когда                                        |
| ----- | --------------------------------------------------------- | -------------------------------------------- |
| `401` | `unknown_session` / `session_expired` / `session_revoked` | сессии нет, истекла, отозвана                |
| `403` | `server_mismatch`                                         | сессия выдана для другого `server_id`        |
| `403` | `user_mismatch`                                           | `username` не тот, для кого выдана сессия    |
| `403` | `bad_proof`                                               | HMAC не совпал или `nonce` отсутствует       |
| `403` | `bad_api_key`                                             | неизвестный/отозванный ключ игрового сервера |
| `429` | `rate_limited`                                            | слишком много проверок                       |

Различать `unknown_session` и `session_expired` для server-to-server вызова можно:
это помогает в отладке и не даёт игроку преимущества, потому что эндпоинт закрыт
ключом.

## 4. Состояние на стороне провайдера

### 4.1. Схема (PostgreSQL)

```sql
CREATE TABLE launch_tickets (
  ticket       TEXT PRIMARY KEY,
  server_id    TEXT NOT NULL,
  pack_sha256  TEXT NOT NULL,
  channel_id   TEXT NOT NULL,
  username     TEXT NOT NULL,
  issued_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at   TIMESTAMPTZ NOT NULL,
  used_at      TIMESTAMPTZ
);

CREATE TABLE launch_sessions (
  session_id     TEXT PRIMARY KEY,
  session_secret TEXT NOT NULL,
  username       TEXT NOT NULL,
  uuid           TEXT NOT NULL,
  server_id      TEXT NOT NULL,
  pack_sha256    TEXT NOT NULL,
  channel_id     TEXT NOT NULL,
  issued_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at     TIMESTAMPTZ NOT NULL,
  bound_at       TIMESTAMPTZ,
  revoked_at     TIMESTAMPTZ
);

CREATE INDEX launch_sessions_expiry ON launch_sessions (expires_at);
CREATE INDEX launch_tickets_expiry ON launch_tickets (expires_at);
```

Чистка: удалять строки с `expires_at < now() - interval '1 hour'` по расписанию.
Держать истёкшие дольше часа смысла нет, а таблица иначе растёт бесконечно.

### 4.2. Жизненный цикл сессии

| Событие                           | Что происходит                                                                           |
| --------------------------------- | ---------------------------------------------------------------------------------------- |
| обмен ticket                      | создаётся `launch_sessions`, `bound_at = NULL`                                           |
| первая успешная проверка          | `bound_at = now()` — фиксируется первый вход                                             |
| повторная проверка в пределах TTL | разрешена: реконнект не должен требовать перезапуска игры                                |
| `expires_at` прошёл               | `401 session_expired`                                                                    |
| выход из аккаунта в лаунчере      | лаунчер стирает свой `access_token`; **сессии уже выданные не отзываются автоматически** |

Последний пункт — осознанное решение, а не недосмотр. Лаунчер не имеет обратного
канала к провайдеру при выходе: он просто забывает свой токен
(`line_logout` очищает состояние лаунчера). Если нужен немедленный отзыв, у
провайдера должен быть свой эндпоинт отзыва, который вызывается отдельно —
например, кнопка в веб-кабинете или фоновая задача по `pack_sha256` при снятии
сборки. Практическое следствие: **делайте TTL коротким** (120 с), тогда «плохая»
сессия живёт недолго, и отзыв не нужен.

### 4.3. Привязка к сборке

`pack_sha256` в обеих таблицах — это не украшение. Он приходит в запросе обмена
(мод получил его из IPC вместе с ticket) и позволяет:

- отказать в сессии, если игрок запустил старую сборку (сравнить с текущей
  опубликованной версией сервера);
- связать сессию с конкретным релизом при разборе инцидентов;
- увидеть в метриках, какая доля игроков ещё на прошлой версии.

## 5. UUID аккаунта

Лаунчер передаёт клиенту `--uuid`, вычисленный так:

```text
sha256("line-launcher:player:" + username)[0..16]
→ проставить биты версии 4 и варианта RFC 4122
```

Готовые значения для проверки вашей реализации:

| username   | uuid                                   |
| ---------- | -------------------------------------- |
| `Player_1` | `357b224b-7284-4b0b-9604-24bce67c4b7d` |
| `Player_2` | `80070112-5d51-465e-9297-e3ac873b8ea8` |
| `demo`     | `512d625f-4762-4ab9-ba3b-d311a6552146` |

Свойства: одинаковый ник → одинаковый UUID (миры сохраняют владельца), разные
ники → разные UUID.

**Это не средство аутентификации.** Любой может вычислить этот UUID локально по
нику. В `src-tauri/src/line/launch.rs` об этом прямо написано: «This is _not_ an
authentication artefact — the provider's session exchange decides the real
profile». Использовать `--uuid` как доказательство личности нельзя; доказывает
только `session_id` + `proof`.

## 6. Что делает мод

1. Читает `-DlineLauncher.sessionChannel=<uuid>`. Свойства нет → игра запущена вне
   лаунчера: сообщение «Запустите игру через лаунчер проекта», без стектрейса.
2. Открывает канал (`\\.\pipe\line-launcher-<uuid>` на Windows,
   `/tmp/line-ipc-<uuid>/ticket.sock` на Linux), шлёт одну строку запроса, читает
   одну строку ответа, закрывает. Лимит 16 КиБ, дедлайн `min(expires_in, 60)`.
3. Делает `POST exchange_url` с пятью полями. Проверяет: `200`, `server_id`
   совпадает с полученным по IPC, `username` совпадает, `expires_in` в разумных
   пределах, `uuid` — валидный UUID.
4. Держит `session_id` и `session_secret` **только в памяти**. Не пишет в файл,
   не логирует, не кладёт в чат, не передаёт в аргументы.
5. В фазе login отвечает на `nonce` сервера подтверждением `proof`.
6. При отказе — внятное сообщение игроку и завершение подключения, а не зависание.

Мод **не** отправляет на игровой сервер сам ticket — только результат обмена.

## 7. Что делает плагин игрового сервера

1. В login-фазе отправляет клиенту `nonce`.
2. Ждёт ответ с `session_id` и `proof`, дедлайн 10 с.
3. Вызывает `/v1/session/verify` со своим API-ключом.
4. `valid: true` → пускает; кэширует результат на `expires_in`, чтобы реконнект не
   требовал похода к провайдеру.
5. Любой отказ → `disconnect` с понятным текстом **до** входа в мир.

Сервер обязан работать с `online-mode=false`: лаунчер не подделывает сессию
Mojang и не обходит `online-mode=true`.

## 8. Тесты, без которых не готово

| #   | Сценарий                               | Ожидание                                                   |
| --- | -------------------------------------- | ---------------------------------------------------------- |
| 1   | обмен правильным ticket                | `200`, поля по §2.2, `session_id` уникален между запусками |
| 2   | повторный обмен того же ticket         | `409`, второго `session_id` не появилось                   |
| 3   | два обмена одного ticket параллельно   | ровно один `200`, второй `409` (проверка атомарности)      |
| 4   | ticket просрочен                       | `401 ticket_expired`                                       |
| 5   | `sha256` не тот                        | `403 binding_mismatch`                                     |
| 6   | `server_id` не тот                     | `403 binding_mismatch`                                     |
| 7   | `channel_id` не тот                    | `403 binding_mismatch`                                     |
| 8   | проверка живой сессии                  | `200 valid:true`, `uuid` совпадает с §5                    |
| 9   | проверка сессии для чужого `server_id` | `403 server_mismatch`                                      |
| 10  | проверка сессии для чужого `username`  | `403 user_mismatch`                                        |
| 11  | проверка после `expires_at`            | `401 session_expired`                                      |
| 12  | `proof` от другого `nonce`             | `403 bad_proof`                                            |
| 13  | проверка без API-ключа / с чужим       | `403 bad_api_key`                                          |
| 14  | реконнект в пределах TTL               | `200`, повторный вход разрешён                             |
| 15  | в логах провайдера                     | нет `ticket`, `session_secret`, пароля, `access_token`     |

Пункт 3 — тот, который обычно ловит баг. Референсная реализация
(`examples/provider/server.mjs`) хранит tickets в `Map` и проверяет
`used` отдельно от записи; для продакшена так нельзя.

## 9. Пример реализации обмена (Node, без фреймворка)

```js
// POST /v1/launcher/exchange
const { ticket, server_id, sha256, channel_id, username } = body;

const claimed = await db.query(
  `UPDATE launch_tickets SET used_at = now()
    WHERE ticket = $1 AND used_at IS NULL
    RETURNING server_id, pack_sha256, channel_id, username, expires_at`,
  [ticket],
);
const row = claimed.rows[0];
if (!row) {
  // Либо не существует, либо уже использован — оба ответа честные.
  const known = await db.query(
    `SELECT 1 FROM launch_tickets WHERE ticket = $1`,
    [ticket],
  );
  if (known.rowCount) return json(res, 409, { error: "ticket_already_used" });
  return json(res, 401, { error: "unknown_ticket" });
}
if (new Date(row.expires_at) <= new Date()) {
  return json(res, 401, { error: "ticket_expired" });
}
for (const field of ["server_id", "channel_id", "username"]) {
  if (body[field] !== row[field])
    return json(res, 403, { error: "binding_mismatch", field });
}
if (sha256 !== row.pack_sha256)
  return json(res, 403, { error: "binding_mismatch", field: "sha256" });

const sessionId = randomBytes(16).toString("hex");
const sessionSecret = randomBytes(32).toString("base64url");
const ttl = 120;
await db.query(
  `INSERT INTO launch_sessions
     (session_id, session_secret, username, uuid, server_id, pack_sha256, channel_id, expires_at)
   VALUES ($1, $2, $3, $4, $5, $6, $7, now() + ($8 || ' seconds')::interval)`,
  [
    sessionId,
    sessionSecret,
    username,
    playerUuid(username),
    server_id,
    row.pack_sha256,
    channel_id,
    ttl,
  ],
);

log("session issued", { server_id, username }); // ticket и secret — никогда
return json(res, 200, {
  session_id: sessionId,
  session_secret: sessionSecret,
  username,
  uuid: playerUuid(username),
  server_id,
  expires_in: ttl,
});
```

```js
// POST /v1/session/verify — server-to-server
const { session_id, username, server_id, nonce, proof } = body;

const found = await db.query(
  `SELECT * FROM launch_sessions WHERE session_id = $1 AND revoked_at IS NULL`,
  [session_id],
);
const s = found.rows[0];
if (!s) return json(res, 401, { error: "unknown_session" });
if (new Date(s.expires_at) <= new Date())
  return json(res, 401, { error: "session_expired" });
if (s.server_id !== server_id)
  return json(res, 403, { error: "server_mismatch" });
if (s.username !== username) return json(res, 403, { error: "user_mismatch" });

const expected = createHmac(
  "sha256",
  Buffer.from(s.session_secret, "base64url"),
)
  .update(nonce || "", "utf8")
  .digest("base64url");
if (!proof || !timingSafeEqual(Buffer.from(expected), Buffer.from(proof))) {
  return json(res, 403, { error: "bad_proof" });
}

await db.query(
  `UPDATE launch_sessions SET bound_at = COALESCE(bound_at, now()) WHERE session_id = $1`,
  [session_id],
);
return json(res, 200, {
  valid: true,
  username: s.username,
  uuid: s.uuid,
  server_id: s.server_id,
  expires_in: Math.max(
    0,
    Math.floor((new Date(s.expires_at) - Date.now()) / 1000),
  ),
});
```

`playerUuid` — по §5; сравнивать `proof` только постоянным по времени сравнением.

## 10. Правки в промпте для мода

Пункт C прошлого промпта («что уточнить») закрыт. Итоговый текст по обмену:

```text
C. Обмен и передача сессии на сервер — модель A (сессия провайдера)

   C1. После получения ticket по IPC сделай ровно один
       POST на exchange_url (Connection: 10 с, запрос: 30 с, redirects: NEVER,
       Content-Type: application/json, Accept: application/json).
       Тело: {"ticket": …, "server_id": …, "sha256": …, "channel_id": …,
              "username": …}. Поля берутся из ответа IPC, ни одно не придумывается.

   C2. Успех — только HTTP 200 и тело вида:
       {"session_id": "…", "session_secret": "…", "username": "…",
        "uuid": "…", "server_id": "…", "expires_in": <30..600>}
       Проверь сам: server_id совпадает с полученным по IPC, username совпадает,
       expires_in в диапазоне, uuid — валидный UUID. Тело читай с лимитом
       16 КиБ, разбирай строго, неизвестные поля — ошибка.

   C3. Держи session_id и session_secret только в памяти. Никогда: в лог, чат,
       файл, исключение, toString, crash-report, аргументы JVM. В toString
       используй маскирование.

   C4. Игровому серверу отправляй НЕ ticket, а подтверждение:
       сервер в login-фазе присылает nonce (16+ байт),
       клиент отвечает {"session_id": …, "proof": base64url(HMAC_SHA256(
       session_secret, nonce))}. Никогда не отправляй session_secret.

   C5. Посторонние ошибки: 409 → не повторять (replay); 401 → «запустите игру
       заново из лаунчера»; 403 → «сборка не совпадает с опубликованной»;
       сетевой сбой до отправки ticket → один повтор через 1–2 с.
       После окончательного отказа соединение не зависает.
```

## 11. Осталось решить

| Вопрос                            | Варианты                                | Влияние                                                |
| --------------------------------- | --------------------------------------- | ------------------------------------------------------ |
| Нужен ли `proof`                  | с ним / без                             | с ним — пассивный перехват невозможен, стоит ~30 строк |
| Где живёт плагин игрового сервера | тот же репозиторий / отдельный артефакт | на структуру проекта, не на контракт                   |
| TTL сессии                        | 120 с (рекомендуется) / до 600 с        | длиннее TTL — меньше реконнектов, больше окно риска    |
| Отзыв сессии                      | нет / эндпоинт отзыва                   | без отзыва нужен короткий TTL                          |
| Хранение                          | Postgres / Redis с TTL                  | Redis проще для чистки, Postgres — для аудита          |

## 12. Сверка с реализацией: что подтверждено, а что нет

Проверено чтением кода: `src-tauri/src/line/ipc.rs`, `launch.rs`, `config.rs`,
`examples/mod-client/LineTicketClient.java`, `examples/provider/server.mjs`,
`scripts/test-java-client.mjs`, `tests/session-model-a.test.ts`.

### 12.1. Подтверждено кодом

| Утверждение спецификации | Где подтверждается |
| --- | --- |
| JVM получает только `-DlineLauncher.sessionChannel=<uuid>` | `launch.rs:243` |
| Канал: `/tmp/line-ipc-<uuid>/ticket.sock` (0700 / 0600) и `\\.\pipe\line-launcher-<uuid>` | `ipc.rs:67–80` |
| Проверка PID/UID дочернего процесса до выдачи ticket | `ipc.rs:139–180` |
| Дедлайн = `min(expires_in, 120)` и не больше 60 с | `ipc.rs:13`, `ipc.rs:125` |
| Лимит сообщения 16 КиБ | `ipc.rs:14`, `LineTicketClient.java:18` |
| Одно соединение, один запрос, один ответ | `ipc.rs::serve_once` |
| `exchange_url` приходит по IPC и валидируется как HTTPS без учётных данных и фрагмента | `launch.rs:769–777`, `config.rs:317` |
| Пять полей запроса обмена | `LineTicketClient.java:163–167` |
| `connectTimeout` 10 с, запрос 30 с, redirect `NEVER` | `LineTicketClient.java:169–172` |
| Лимит тела ответа 16 КиБ (`MAX_MESSAGE + 1`) | `LineTicketClient.java:181–182` |
| UUID аккаунта = `sha256("line-launcher:player:" + username)[0..16]` с битами v4/variant | `launch.rs:110–136` |
| Все коды ошибок обмена и `/verify` | `server.mjs:381–495` |
| `proof` = `base64url(HMAC-SHA256(secret, nonce))`, сравнение постоянным по времени | `server.mjs:461–476` |
| `expires_in` обмена 120 с | `server.mjs` `SESSION_TTL_SECONDS = 120` |

### 12.2. Расхождения — исправить до выпуска мода

#### A. Эталонный клиент не разбирает ответ обмена

`LineTicketClient.exchange()` возвращает **сырой** текст тела
(`LineTicketClient.java:183`). Ни `session_id`, ни `uuid`, ни `server_id`, ни
`expires_in` не проверяются — §6.3 спецификации требует обратного.

Причина, по которой это не поймано тестом: `scripts/test-java-client.mjs:180`
отвечает телом `{"ok":true,"username":"Player_1"}`. Строгого разбора нет, поэтому
неверное тело проходит зелёным.

**Следствие:** клиент, скопированный из `examples/`, отправит на сервер что
угодно, включая отсутствующий `session_id`.

#### B. Кодек не умеет числа — а `expires_in` число

`LineJson.Parser` (`LineTicketClient.java:219–276`) принимает в значениях
**только** строку: `string()` вызывается безусловно, ключ `expires_in: 120`
даёт `IOException("JSON string required")`.

То есть при попытке выполнить §6.3 буквально — «разбери тело строго» — реальный
ответ провайдера из §2.2 **не парсится**. Проверено транспозицией правил парсера
на эталонном теле из §2.2: `IOException("JSON string required")` на `expires_in: 120`.
Ответ, которым отвечает `scripts/test-java-client.mjs:180`
(`{"ok":true,"username":…}`), падает там же — поэтому тест зелёный, а дефект живой.

Это надо решать выбором:

- либо `expires_in` строкой (`"120"`) — но тогда это расходится с §2.2 и с
  референс-провайдером;
- либо добавить в кодек числа (и заодно `null`), оставив `expires_in` числом.

Второй вариант честнее: контракт уже опубликован с числом.

#### C. Эталонный клиент вообще не умеет `proof`

В `LineTicketClient.java` нет ни `session_secret`, ни `nonce`, ни HMAC. Он
умеет ровно шаг «получить ticket и обменять». Всё, что §6.4 и §7 требуют от
мода, живёт пока только в документе — эталона нет.

**Следствие:** интеграция с LineAuth по §3.3 сейчас не обеспечена ни одной
строкой кода, которую можно скопировать.

#### D. У `/v1/session/verify` нет отзыва

Спецификация перечисляет `401 session_revoked` (§3.4) и колонку `revoked_at`
(§4.1), но в референс-провайдере нет ни того, ни другого: проверка идёт по
`issuedSessions.get()` и `expiresAt`. Строка `revoked_at` в примере SQL (§9)
есть, а эндпоинта отзыва нет ни в спецификации, ни в коде.

Это не сломает вход, но означает: **отозвать сессию нельзя**, можно только
дождаться `expires_at`. Для «кикнуть игрока, который уже вошёл» нужен отдельный
эндпоинт, и его в контракте нет.

#### E. `expires_in` из IPC не приходит в ответе канала

§6.2 говорит «дедлайн `min(expires_in, 60)`», и это верно для лаунчера: он
ограничивает **своё** ожидание (`ipc.rs:131`). Но мод получает `expires_in`
только в ответе обмена, не по IPC — в `TicketResponse` этого поля нет. Формулировку
в §6.2 надо читать как «лаунчер ждёт не дольше», а не «мод узнаёт TTL из IPC».

### 12.3. Чего в контракте нет вообще, а для Line DevKit нужно

Эти пункты появились из требования «мод должен 100% работать с лаунчером»:

| Пробел | Почему важен |
| --- | --- |
| **`nonce` и канал login plugin message не зафиксированы** | §3.3 и §7 описывают обмен, но не называют идентификатор канала (`line:session`?), не говорят, кто генерирует `nonce` и что делать при отсутствии ответа 10 с. Плагин сервера и мод надо писать по одному документу с точными именами полей. |
| **Серверный плагин не входит в репозиторий** | §7 — это требования, а не код. `nonce → proof` сейчас реализует только `demo-selftest.mjs`, то есть тест, а не плагин. |
| **Нет правила «что делать при нескольких аккаунтах»** | Если игрок запустил игру второй раз из лаунчера под другим аккаунтом, у него два канала и два ticket. Не описано, какой считается действующим. |
| **Нет версии контракта** | У LineAuth (Forge/Fabric/NeoForge) и лаунчера будут разные релизы. Нужно поле `contract_version` в ответе обмена или в `config.json`, иначе рассинхрон версий будет ловиться в проде. |
| **Нет требования к TLS-пиннингу** | Обмен идёт на `exchange_url` из конфига. §0 запрещает redirect и требует HTTPS, но не говорит, что мод должен отвергать смену сертификата посреди сессии. |

### 12.4. Что спецификация фиксирует верно и менять нельзя

Три вещи уже опубликованы и на них завязан лаунчер — их нельзя менять без
одновременного обновления Rust и всех сборок:

1. Имя свойства `lineLauncher.sessionChannel` и путь к каналу.
2. Формат строки запроса IPC и набор из шести полей ответа (`type`, `ticket`,
   `exchange_url`, `server_id`, `sha256`, `username`).
3. Пять полей запроса обмена — они уходят на провайдера как есть.

### 12.5. Приоритет исправлений

1. **A + B** — без разбора ответа мод неработоспособен. Это блокер.
2. **C** — без `proof` модель A не защищает от пассивного перехвата, а §3.3
   называет это рекомендуемым вариантом.
3. **D** — отзыв нужен для кика; без него жить можно, но TTL обязан быть коротким.
4. **12.3** — до первого публичного релиза LineAuth.
