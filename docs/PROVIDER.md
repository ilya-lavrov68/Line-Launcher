# Контракт провайдера Line Launcher v1

Провайдер размещает UTF-8 JSON на HTTPS. Игрок вводит ссылку на документ. Конфигурация и дистрибутив находятся под контролем провайдера; лаунчер не предоставляет централизованный каталог серверов.

Полная типизация: `src/types/line.ts`. Серверная проверка: `src-tauri/src/line/config.rs`. Рабочий структурный пример: `examples/config.json` (его URL, размеры и нулевой хеш — заглушки, не реальный дистрибутив).

## Конфигурация

JSON использует `snake_case`; IPC Tauri — `camelCase`.

| Поле                   | Требование                                                                                                                  |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `schema_version`       | Сейчас ровно `1`                                                                                                            |
| `min_launcher_version` | Строгий SemVer, например `0.1.0`                                                                                            |
| `provider.id`          | Lowercase ASCII slug, до 64 символов                                                                                        |
| `provider.name`        | Непустое название, до 100 символов                                                                                          |
| `provider.logo_url`    | Необязательный HTTPS URL                                                                                                    |
| `cache_ttl_seconds`    | Необязательный, 60–86400; по умолчанию 300                                                                                  |
| `required_features`    | Поддерживаются `custom-auth-v1`, `zip-sha256-v1`, `launch-manifest-v1`, `private-ipc-v1`; неизвестные возможности запрещены |
| `servers`              | 1–100 записей с уникальными `id`                                                                                            |

Сервер содержит `id`, `name`, `description`, `version`, необязательные `logo_url` и `minecraft_version`, объекты `auth` и `distribution`.

`distribution` требует:

- `url`: HTTPS, желательно immutable/versioned;
- `sha256`: 64 lowercase hex символа полного ZIP;
- `size_bytes`: точный размер ZIP, 1 байт–4 ГиБ;
- `unpacked_size_bytes`: точная сумма размеров обычных файлов, 1 байт–16 ГиБ; служебный marker лаунчера не входит.

Не публикуйте архив, меняющийся по тому же URL. При новой сборке меняйте URL, версию и хеш. Поддерживаются ZIP Stored/Deflate без шифрования, symlink и специальных файлов; до 50 000 записей. Не включайте пользовательские миры/настройки в архив, который должен обновляться поверх пользовательских данных: текущая модель устанавливает независимые релизы, overlay-политика будет отдельным контрактом.

Вычисление метаданных при публикации:

```sh
sha256sum release.zip
stat -c %s release.zip
# unpacked_size_bytes вычислите из проверенного manifest сборки,
# суммируя размеры обычных файлов, а не размеры каталогов.
```

## Авторизация

`auth.login_url` обязателен, `auth.register_url` необязателен. Отсутствие register URL скрывает регистрацию. Оба endpoint принимают POST JSON только напрямую по HTTPS; redirects намеренно не выполняются.

Запрос:

```json
{
  "username": "Player_name",
  "password": "password-from-form",
  "server_id": "survival"
}
```

Успешный ответ HTTP 200:

```json
{
  "access_token": "provider-session-token",
  "expires_in": 3600,
  "username": "Player_name"
}
```

`access_token` обязателен; `expires_in` — секунды, 1–86400; `username` необязателен. Ответ ограничен 16 КиБ. Не возвращайте пароль. Не логируйте request/response на стороне провайдера. Rate limiting, проверка паролей, блокировки и отзыв сессий — ответственность API провайдера.

Ошибки: 401/403 — отказ авторизации; 409 — логин занят; 429 — rate limit; 5xx — временная недоступность. Тело ошибки не показывается игроку и не должно содержать секретов.

Токен не возвращается frontend. Обмен launch ticket использует отдельный одноразовый короткоживущий credential; долгоживущий `access_token` не предназначен для JVM-аргументов.

## Запуск игры и одноразовый ticket

Для включения запуска сервер должен задать **оба** поля `auth.launch_ticket_url` и
`auth.session_exchange_url` (HTTPS, без redirect для ticket endpoint). Дистрибутив
должен содержать `line-launch.json` у корня ZIP; пример — `examples/line-launch.json`.

Манифест сборки:

```json
{
  "schema_version": 1,
  "java_major": 21,
  "main_class": "net.minecraft.client.main.Main",
  "classpath": ["client.jar", "libraries/example.jar"],
  "minecraft_version": "1.21.1",
  "asset_index": "21",
  "assets_dir": "assets",
  "natives_dir": "natives"
}
```

Поля строго проверяются. Запрещены неизвестные поля, абсолютные пути, `..`,
symlink, classpath-каталоги/glob и произвольные JVM-аргументы. `asset_index` и
`assets_dir` задаются только вместе. Java ищется локально (`JAVA_HOME`, `PATH`,
стандартные каталоги ОС) и проверяется запуском `java -version`; требуется точное
совпадение `java_major`.

Launcher POST-ит на `launch_ticket_url` с заголовком
`Authorization: Bearer <provider access_token>`:

```json
{
  "server_id": "survival",
  "sha256": "<хеш установленного релиза>",
  "channel_id": "<uuid приватного канала>",
  "username": "Player_name"
}
```

Ответ HTTP 200:

```json
{ "ticket": "one-shot-ticket", "expires_in": 60 }
```

`expires_in` — 1–120 секунд. Ticket должен быть привязан к серверу, релизу,
каналу и пользователю, использоваться один раз и истекать на стороне провайдера.
Launcher передаёт ticket моду только через приватный IPC: Unix socket
`/tmp/line-ipc-<uuid>/ticket.sock` (каталог `0700`, socket `0600`) или Windows
named pipe `\\.\pipe\line-launcher-<uuid>` с ACL текущего пользователя. Listener
создаётся до spawn Java; проверяется PID/UID дочернего процесса. JVM получает
лишь `-DlineLauncher.sessionChannel=<uuid>`. Весь обмен ограничен одним deadline
(не более 60 с и не более `expires_in`), сообщение — 16 КиБ.

Мод отправляет в канал одну строку JSON:

```json
{ "type": "line.launch-ticket.request", "channel": "<uuid>" }
```

Launcher отвечает одной строкой:

```json
{
  "type": "line.launch-ticket.response",
  "ticket": "one-shot-ticket",
  "exchange_url": "https://auth.example.com/v1/launcher/exchange",
  "server_id": "survival",
  "sha256": "<хеш релиза>",
  "username": "Player_name"
}
```

Мод немедленно POST-ит на `exchange_url` без redirect:

```json
{
  "ticket": "one-shot-ticket",
  "server_id": "survival",
  "sha256": "<хеш релиза>",
  "channel_id": "<uuid приватного канала>",
  "username": "Player_name"
}
```

Формат успешного ответа обмена — ответственность провайдера и мода (игровая
сессия/Minecraft profile). Повторное использование, истечение и несоответствие
любой привязки (`server_id`, `sha256`, `channel_id`, `username`) должны
отклоняться сервером. Справочный Java-клиент канала находится в
`examples/mod-client/LineTicketClient.java`: строгий flat-JSON codec, HTTPS без
redirect, таймауты и лимиты размера. Интеграция с конкретным mod loader остаётся
на стороне провайдера. Не логируйте ticket и не передавайте его через аргументы
JVM. Воспроизводимый интеграционный тест клиента против локального HTTPS
provider stub и IPC peer: `npm run test:java` (требуется JDK 17+; CI запускает его
на Linux/Windows/macOS).

## Конфигурация и кэш

- Каждый redirect проверяется; URL с username/password и fragment запрещены.
- Конфиг ограничен 1 МиБ.
- Ответ 304 используется только при наличии сохранённого валидного конфига.
- При сетевой ошибке показывается старый конфиг с отметкой stale; вход/установка через stale-конфигу в UI заблокированы.
- Новая схема, неизвестная обязательная feature, невалидный JSON/хеш не заменяются старым кэшем.
- Сервер должен отдавать корректный `Content-Type: application/json`; лаунчер валидирует содержимое независимо от MIME.

## Откат и хранение релизов

Launcher ведёт `history.json` и позволяет явно откатить `current.json` на ранее
установленный полный релиз. По умолчанию хранятся текущий релиз и два самых
недавних других; запущенный релиз дополнительно защищён от удаления. Установка,
откат, очистка и весь жизненный цикл запущенной игры выполняются под одним
cross-process lock: другой процесс лаунчера не может удалить живой релиз.
Во время запуска/игры установка/откат/смена конфигурации и выход из аккаунта
блокируются. Повторная установка уже опубликованного релиза восстанавливает
`history.json` и retention после сбоя между атомарными записями.

## Референсная реализация провайдера

`examples/provider/` содержит **одноразовый протокол целиком** в development-виде:
`server.mjs` (config/login/register/ticket/exchange с ETag, replay/expiry/binding
отказами), `build-pack.mjs` (реальный ZIP с `line-launch.json` и `client.jar`) и
`DemoGame.java` (main class, который выполняет handshake и завершается).

```sh
npm run provider:pack
npm run provider:serve
npm run test:provider
```

Это **не** production-код: аккаунты и ticket в памяти, пароль проверяется demo-сравнением,
сертификат самоподписанный. Используйте его как исполняемую спецификацию и как
контрагент для ручной проверки настольного приложения (`docs/RUNBOOK.md`).

## Что контракт пока не включает

Подпись конфигурации/манифеста, политика пользовательских файлов и overlay,
автоматический выбор JRE из сети и загрузка Java лаунчером не реализованы. Не
добавляйте произвольные `jvm_args`, `java_path` или пути установки: лаунчер их не
исполняет. Интеграция мода с Minecraft session/profile и серверная проверка
одноразового ticket остаются ответственностью провайдера.
