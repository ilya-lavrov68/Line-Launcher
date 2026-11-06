# Line Launcher: архитектурный разбор и первый вертикальный срез

Студия **Plus In Plus**. Готовое брендируемое решение для провайдеров игровых серверов на основе Obsy Launcher. Оригинальные материалы Line — source-available (`LICENSE`), не полностью open-source; upstream Obsy остаётся MIT (`LICENSES/Obsy-MIT.txt`). Уведомления — `NOTICE.md`.

## 1. Четыре архитектурных решения

### 1.1. Сессия не должна путешествовать через JVM `-D`

Долгоживущий токен в аргументах процесса может оказаться в диагностике, списках процессов и crash reports. Случайный localhost-порт не является границей безопасности: к нему могут обращаться другие приложения пользователя. Передача секрета через stdin также требует отдельного анализа окружения и наследования дескрипторов.

Целевой контракт:

1. Rust авторизуется у провайдера; WebView получает только имя игрока и срок сессии.
2. Перед запуском провайдер выдаёт одноразовый launch ticket с коротким TTL, привязанный к аккаунту, серверу и клиенту. Сервер запрещает повторный обмен.
3. Мод получает ticket через named pipe Windows с ACL текущего пользователя или Unix socket в каталоге `0700` / socket `0600`. JVM передаётся только несекретный rendezvous ID. Проверяются peer credentials там, где это поддерживает ОС.
4. Мод меняет ticket на игровую сессию и закрывает канал. Долгоживущий refresh/access token не покидает backend лаунчера.
5. Временный файл допустим как переходный вариант для **одноразового ticket**, с ограниченными правами, TTL и атомарным claim/delete. Он не защищает от вредоносного процесса того же пользователя. Шифрование полезно только при отдельном хранении ключа; ключ рядом с ciphertext не решает задачу.

**Статус кода:** токен хранится в Rust (`Zeroizing`), не сериализуется в WebView IPC. `launch.rs` запрашивает одноразовый ticket, создаёт приватный канал до spawn, проверяет peer-процесс, строит Java-аргументы с `sessionChannel` и запускает процесс. Справочный Java-клиент использует строгий JSON codec, HTTPS без redirect, таймауты и лимиты; `npm run test:java` проверяет обмен, replay/expiry/bindings и повреждённый IPC против локального provider stub. Exchange endpoint и mod-loader интеграция остаются ответственностью провайдера. Небезопасного `-DlineLauncher.sessionToken` fallback нет. Реальный запуск Minecraft и production server-side одноразовость ticket ещё не проверены в этой среде.

### 1.2. ZIP: проверять до распаковки, публиковать после проверки

Обязательные поля: `sha256`, `size_bytes`, `unpacked_size_bytes`. Ссылка должна указывать на неизменяемый архив; изменение сборки требует нового URL/версии/хеша.

Реализованный pipeline:

```text
HTTPS chunks → archive.zip.part → exact size + SHA-256
  → bounded ZIP inspection → spawn_blocking extraction into staging
  → completion marker → immutable releases/<sha256>
  → atomic current.json publication
```

- Сеть асинхронная; распаковка и fsync выполняются в blocking pool.
- События ограничены примерно 80 мс; CSS Base UI сглаживает прогресс. При сетевом retry байты относятся к новой попытке, общий процент не откатывается назад.
- До трёх полных попыток для временных сетевых ошибок. Повреждение хеша не «лечится» бесконечным retry.
- `Range` намеренно не используется. Будущее resume требует сильного ETag, `If-Range`, проверки длины и полного итогового хеша. Слабый ETag/Last-Modified недостаточны.
- Zip Slip, абсолютные пути, `..`, backslash, ADS, device names, symlinks, специальные файлы, повторяющиеся пути и неизвестные методы сжатия отклоняются. Поддерживаются Stored/Deflate; лимиты 50 000 записей, 4 ГиБ ZIP, 16 ГиБ распаковки.
- Проверяются фактические размеры и CRC чтения ZIP, а не только заголовки. Проверяется свободное место с запасом на старую копию.
- Стадии не перезаписывают рабочий релиз. Ошибка удаляет staging; неудачная публикация оставляет прежний `current.json`. Immutable releases позволяют откатить указатель без обратной распаковки.
- Межпроцессный lock и очистка оставшегося staging после сбоя реализованы. Полная гарантия durability после отключения питания зависит от ФС; directory fsync выполняется на Unix.

Хеш обеспечивает целостность, но не доверие к автору. HTTPS и контроль конфигурации остаются ответственностью провайдера. Подпись самого config.json — следующий уровень защиты цепочки поставок.

### 1.3. Версии: формат отдельно от минимальной версии приложения

`schema_version: 1` определяет формат. `min_launcher_version` сравнивается через SemVer, включая prerelease precedence. Неизвестные необязательные поля допустимы. Неизвестный `required_features` или новая схема приводят к явной ошибке обновления, а не к попытке угадать формат.

TTL кэша ограничен 60–86400 секундами; отсутствие поля означает 300. Слишком новое требование никогда не обходится старым кэшем.

### 1.4. Кэш: быстрый просмотр, но не разрешение на запуск

Кэш атомарно сохраняется в per-user app data, проходит ту же валидацию, что сетевой документ. Поддерживаются ETag/304. Транспортная ошибка или временная ошибка сервера позволяет показать прежнюю конфигурацию с отметкой stale. 404/410, ошибка схемы, версии или данных не маскируются кэшем.

Новый интерфейс блокирует вход/установку по stale-конфигу. Токены и пароли в кэш не попадают. Автоматический offline-launch не предусмотрен.

## 2. Границы доверия и контракты

- JSON не может задать путь установки, Java executable или произвольные JVM-флаги.
- Tauri-команда установки принимает `serverId` и UUID операции; URL/хеш/назначение берутся из активного проверенного конфига.
- Только HTTPS, без URL credentials; redirects проверяются на каждом hop. Auth POST не следует redirects и не пересылает пароль другому origin.
- Конфиг и auth-ответы читаются с лимитом размера. Ошибки наружу имеют стабильный код, а не сырой текст HTTP-библиотеки/ответа.
- Пароли не пишутся в localStorage, логи или события. Ответы провайдера не логгируются. Zeroize уменьшает время жизни секретов, но не является защитой от скомпрометированной ОС.
- Конфигурация задаёт только данные витрины, auth endpoints и дистрибутив. Запуск использует строгий `line-launch.json` внутри проверенного релиза: classpath/main class/JRE major, без произвольных JVM-флагов и путей.
- Серверный API и мод аутентификации — ответственность провайдера, как оговорено в постановке.

## 3. Roadmap и фактически выполненные изменения

### Выполнено в этом срезе

- Новый пакет/идентификатор/бренд Line Launcher, версия `0.1.0`.
- Удалены активные и исходные пути MSA/offline, ручных версий/загрузчиков, инстансов, гардероба, аддонов, Modrinth/CurseForge/Discord RPC, пользовательских JVM-настроек.
- Удалены связанные Tauri-модули, разрешения и зависимости; сохранены общие Obsy/Base UI-примитивы.
- Удалён чужой updater endpoint/public key и автоматическая установка обновлений Obsy. Release workflow теперь строит неподписанные кандидаты без публикации.
- `src/types/line.ts`: публичный контракт конфигурации, IPC DTO и ошибки.
- `src-tauri/src/line/`: config/cache/auth/state/storage/http/install/launch/error-модули.
- `src/components/line/`: `ConfigUrlInput`, `ServerList`, `ServerCard`, `AuthForm`, `InstallProgress`, orchestration `LineLauncher`.
- `Button`, `Input`, `Label`, `Tabs`, `Progress` переиспользуются. Отдельных Card/Modal/ProgressBar в Obsy нет; карточки следуют `InstalledAddonCard`, диалоги — `Dialog`, прогресс — составному `Progress`.
- Tailwind v4, исходные токены и скругления Obsy без изменений, Framer Motion, Lucide, Base UI. Учтён reduced motion; карточки доступны с клавиатуры. Захардкоженные цвета убраны в пользу токенов Obsy.
- Build-time брендинг: `branding/line.brand.json` → генератор CSS/TS/Tauri-overlay/иконок, пресеты и переопределения только для семантических цветов, обязательная по лицензии видимая атрибуция Line Launcher | Plus In Plus (`docs/BRANDING.md`).
- Тесты контракта TS, тесты валидатора брендинга и Rust-тесты путей/размеров/symlink/cancellation/lock/atomic write/SemVer.
- CI переведён на npm lockfile: frontend/branding/license tests, Java-client integration matrix и Rust fmt/check/test/clippy на Linux/Windows/macOS. Rust-прогоны ещё должны быть выполнены в CI до релиза.

### Следующие этапы до production release

1. Provider exchange API и приватный IPC: **реализованы на стороне launcher** (`launch_ticket_url`, one-shot канал, PID/UID/ACL проверки). Справочный Java-клиент — `examples/mod-client/LineTicketClient.java`; интеграционный тест `npm run test:java` покрывает обмен/replay/expiry/bindings/redirect/oversize/malformed/timeout против локального stub. Интеграция с конкретным mod loader и production server-side хранение ticket остаются ответственностью провайдера.
2. Строгий `line-launch.json`, поиск/проверка JRE, classpath, spawn Java и контроль жизненного цикла игры: **реализованы**. Кнопка запуска появляется только при настроенных endpoints и установленном релизе; реальный Minecraft-запуск ещё не проверен в этой среде.
3. Явный rollback указателя, `history.json` и хранение текущего + двух последних релизов с защитой запущенного релиза: **реализованы**. Cross-process lease удерживается от чтения релиза до выхода Java; rollback резервирует состояние до blocking IO; повторная установка восстанавливает history/retention после сбоя. Ожидание lease при запуске отменяемо кнопкой «Отменить запуск».
4. Порядок событий игры: **реализован**. Каждый статус несёт монотонный `revision`; WebView отбрасывает устаревшие события, а `get_game_status` возвращает последний опубликованный переход, а не синтезированную фазу.
5. Windows ACL/macOS/Linux permission tests на реальных ОС, полное отключение питания, production HTTP integration tests, большие архивы и замер памяти/скорости. Lock recovery и crash staging cleanup покрыты Rust-тестами, но Rust compile/tests в этой среде ещё не выполнены.
6. Подпись кода, Line updater key/endpoint и политика распространения. Иконки и палитра теперь задаются через `branding/line.brand.json`; финальное утверждение бренда — за Plus In Plus.
7. Подписанный конфиг/manifest, pinned provider policy и согласованный API модерации/банов/скинов — только если это действительно нужно B2B-продукту.

## 4. Проверка

```sh
npm ci
npm test
npm run test:rust
npm run build
npm run test:java
npm run test:provider
cargo fmt --manifest-path src-tauri/Cargo.toml --check
cargo test --locked --manifest-path src-tauri/Cargo.toml
cargo clippy --locked --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
npm run tauri dev
```

Frontend без Tauri показывает экран подключения, но сетевые/файловые операции требуют desktop shell. Никаких фиктивных успешных авторизаций или mock-download в рабочем интерфейсе нет.

Фактический статус проверок и ограничения песочницы зафиксированы в `docs/VERIFICATION.md`.
Полный Rust compile/tests/clippy, проверки на Windows/macOS, реальный Minecraft, подпись и
updater выполняются по пошаговой инструкции в `docs/RUNBOOK.md`; это не заявляется как
прошедшая проверка.
