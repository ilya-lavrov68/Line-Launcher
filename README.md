# Line Launcher

**Plus In Plus** — готовое брендируемое решение для провайдеров игровых серверов: минималистичный Minecraft-лаунчер с авторизацией провайдера. Построен на [Obsy Launcher](https://github.com/obsy-official/obsy-launcher). Line распространяется как **source-available**, не как полностью open-source продукт; исходные компоненты Obsy сохраняют MIT.

```text
config.json провайдера → витрина серверов → вход / регистрация
→ проверка и установка ZIP → подготовленная сборка
```

Без Microsoft/offline-аккаунтов, ручного выбора загрузчиков, аддонов, виджетов и пользовательских JVM-флагов.

## Статус: первый вертикальный срез

Реализованы типизированный конфиг, кэш с TTL/ETag, API провайдера, Rust-хранилище сессий, потоковая загрузка с SHA-256, безопасная распаковка, атомарная публикация релиза и build-time брендинг. React-экраны переиспользуют компоненты и палитру Obsy/Base UI, Tailwind v4, Framer Motion и Lucide.

**Запуск Minecraft реализован на стороне launcher, но ещё не проверен с реальной сборкой.** Есть строгий `line-launch.json`, поиск Java, одноразовый launch ticket, приватный IPC, spawn/остановка процесса и откат релизов. Exchange endpoint и интеграция мода с Minecraft session остаются ответственностью провайдера; справочный Java-клиент приложен. Небезопасной передачи токена через `-D` нет. Это не готовый production-релиз.

## Документация

- [Брендинг под свой проект](docs/BRANDING.md) — палитра, логотипы, иконка приложения
- [Архитектура, решения безопасности и roadmap](docs/ARCHITECTURE.md)
- [Контракт провайдера](docs/PROVIDER.md)
- [Пример config.json](examples/config.json) — значения URL/размеров/хеша демонстрационные, архив не скачивается.
- [TypeScript-контракт](src/types/line.ts)
- [Rust-модуль установки](src-tauri/src/line/install.rs)
- [ServerCard](src/components/line/ServerCard.tsx)

## Брендинг

Лаунчер можно быстро адаптировать под свой игровой проект: название, акценты,
логотип в интерфейсе и иконка приложения задаются одним файлом [`branding/line.brand.json`](branding/line.brand.json).

```sh
# отредактируйте branding/line.brand.json, затем
npm run brand
npm run tauri:build
```

UI/UX, палитра и скругления остаются как в оригинальном Obsy Launcher: пресет по
умолчанию `obsy` не создаёт ни одного переопределения, а генератор разрешает
менять только семантические цвета. Для проектов есть готовые пресеты
(`emerald`, `violet`, `amber`, `rose`, `sky`) и точечные переопределения.

Упоминание **Line Launcher | Plus In Plus** — условие лицензии, а не просто
оформление. Без него использовать и распространять сборки с материалами Line
нельзя. Точные фразы: «Работает на Line Launcher | Plus In Plus» /
«Powered by Line Launcher | Plus In Plus». Конфиг выбирает только постоянный
футер или шапку и язык (`ru`, `en`, `both`); «О программе» всегда повторяет
упоминание дополнительно. Подробнее — [docs/BRANDING.md](docs/BRANDING.md).

## Разработка

Требования: Node.js 22+, npm, Rust stable и [системные зависимости Tauri v2](https://tauri.app/start/prerequisites/).

```sh
npm ci
npm run doctor      # окружение + совпадение версий Tauri (крейт ↔ npm API)
npm run check:tauri # только версии Tauri: major.minor должны совпадать
npm run tauri dev
```

Если `tauri dev` сообщает `cargo metadata: program not found` — не установлен
Rust; `npm run doctor` покажет, чего не хватает, и как это поставить. Пошаговая
инструкция для Windows/macOS/Linux — [docs/RUNBOOK.md](docs/RUNBOOK.md), раздел 1.
Если проверка ошибается, пропустите её: `LINE_SKIP_DOCTOR=1 npm run tauri dev`.

`npm audit` показывает уязвимости инструментов сборки (shadcn CLI, Tailwind,
Vite), которые не попадают в бандл. Проверять нужно `npm audit --omit=dev`.

`npm run dev` поднимает только frontend. Без desktop shell доступен интерфейс ввода ссылки; авторизация и установка не имитируются.

```sh
npm test
npm run test:rust
npm run test:java
npm run test:provider
npm run brand:check
npm run build
cargo fmt --manifest-path src-tauri/Cargo.toml --check
cargo test --locked --manifest-path src-tauri/Cargo.toml
cargo clippy --locked --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
```

Проверки TypeScript, production-сборки frontend, тестов контракта и брендинга,
чистой Rust-логики, Java-клиента и референсного провайдера выполняются локально.
Статус и ограничения среды — [docs/VERIFICATION.md](docs/VERIFICATION.md).
Полный `cargo check/test/clippy`, проверки на Windows/macOS, реальный Minecraft,
подпись и updater — по инструкции в [docs/RUNBOOK.md](docs/RUNBOOK.md).

Для end-to-end проверки без Minecraft есть референсный провайдер и генератор сборки:

```sh
npm run provider:pack     # .provider/pack.zip + config.json
npm run provider:serve    # https://127.0.0.1:8443/config.json
npm run test:provider     # автоматическая проверка связки
npm run test:ui           # UI-smoke (нужен playwright-core и запущенный npm run dev)
```

## Данные

Per-user каталог Tauri app data:

```text
config-cache.json
instances/<server-id>/
  .install.lock
  .staging-<uuid>/       # временно, удаляется при ошибке/следующей установке
  releases/<sha256>/     # проверенный immutable-релиз
  current.json           # атомарно публикуемый указатель
```

Пароли и токены не сохраняются на диск или в WebView. Старые данные Obsy не импортируются и не удаляются.

## Релизы

Автоматическое обновление Obsy и его ключ отключены. Workflow вручную собирает неподписанные кандидаты, применяя брендинг через `tauri build -c src-tauri/tauri.brand.conf.json`. Публикация, подпись кода и updater Line — отдельные этапы перед распространением.

## Лицензия

Оригинальные материалы Line — [Line Launcher Provider License 1.0](LICENSE):
source-available лицензия для провайдеров игровых серверов с обязательным
видимым упоминанием **Line Launcher | Plus In Plus**. Это не MIT и не
open-source лицензия. Разрешены интеграция, коммерческое использование для
своих игровых сервисов и распространение брендированных сборок их игрокам при
соблюдении условий. Удаление упоминания прекращает разрешение; отдельные
права требуют письменного согласия Plus In Plus.

Исходные материалы Obsy остаются под MIT: дословный текст сохранён в
[LICENSES/Obsy-MIT.txt](LICENSES/Obsy-MIT.txt). Новая лицензия Line не отзывает
права на upstream. Сторонние уведомления — [NOTICE.md](NOTICE.md) и
[LICENSES/](LICENSES/). Перед публичным коммерческим релизом рекомендуется
юридическая проверка текста под вашу юрисдикцию.
