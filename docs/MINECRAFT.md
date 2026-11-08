# Режим Minecraft через `mc-launcher-core`

Отдельный режим рядом с провайдерскими ZIP-сборками. Провайдер, ticket-канал,
гардероб и демо работают как раньше: профили Minecraft живут в
`<app-data>/minecraft/<instanceId>/` и не пересекаются с `instances/<server>/`.

Крейт: [`mc-launcher-core` 0.1.2](https://docs.rs/mc-launcher-core), MIT,
исходники — [Star-tears/mc-launcher-core](https://github.com/Star-tears/mc-launcher-core).
В `Cargo.toml` версия закреплена как `=0.1.2`: фасад 0.1.x ещё меняется, а
`minecraft.rs` разбирает `LauncherError` исчерпывающим `match`.

## Для каких серверов этот режим

Лаунчер делается под **серверы с `online-mode=false`**: они не проверяют сессию
Mojang, поэтому автономный аккаунт — штатный и правильный способ входа. Никакой
Microsoft-логики в режиме нет и не планируется: `auth::microsoft_account` из
крейта не вызывается, `Account::Microsoft` не конструируется, authlib-инъекторы
не используются. Регрессионный тест это фиксирует.

| Возможность                      | Поведение                                                          |
| -------------------------------- | ------------------------------------------------------------------ |
| Ваш сервер (`online-mode=false`) | вход под ником аккаунта проекта                                    |
| Автозаход после «Играть»         | сразу на сервер, без главного меню                                 |
| Одиночная игра                   | не предлагается лаунчером: кнопки «Одиночная игра» в потоке нет    |
| Серверы с `online-mode=true`     | не поддерживаются: они проверяют сессию, лаунчер её не подделывает |

**Про кнопку «Одиночная игра» честно.** В ванильном клиенте нет аргумента
командной строки, который её убирает (`--disableMultiplayer` и `--disableChat`
делают обратное — режут мультиплеер, они выключены). Автозаход через Quick Play
пропускает главное меню целиком, но если игрок нажмёт Esc → «Выйти в главное
меню», кнопка там останется. Чтобы убрать её физически, нужен клиентский мод в
сборке — это отдельная задача, могу сделать небольшой Fabric-мод.

## Автозаход на сервер

Mojang **удалил `--server` и `--port` в 23w14a** (1.20), заменив их Quick Play.
Крейт всё ещё добавляет старую пару через `LaunchOptions::server`, и современные
клиенты её молча игнорируют — автозахода не происходит. Поэтому:

- `LaunchOptions.server` остаётся `None`;
- поддержка определяется по метаданным: `game_argument_tokens` собирает все
  токены `arguments.game`, включая rule-gated, и `has_quick_play_token` ищет
  **точное** совпадение с `--quickPlayMultiplayer` (подстрока ошибочно приняла бы
  `--quickPlayMultiplayerLegacy`);
- `load_version` уже склеил `inheritsFrom`, так что профиль Fabric/Forge
  наследует признак поддержки от ванильного клиента;
- `ensure_server_join` добавляет `--quickPlayMultiplayer host:port` для 1.20+ и
  `--server host --port port` для более старых версий, никогда не дублируя пару.

Адрес берётся из `server_address` в конфиге провайдера (`host`, `host:port` или
`[ipv6]:port`, порт по умолчанию 25565) и проверяется до запуска: пробелы,
управляющие символы и ведущий дефис отклоняются, чтобы адрес не превратился в
ещё один флаг клиента.

## Одно нажатие «Играть»

Команда `mc_play` делает всё по порядку:

1. `install_profile` — установка **или проверка** уже скачанного: крейт
   пропускает каждый файл, чья контрольная сумма совпала (`SkipReason`), поэтому
   неизменившаяся сборка стоит один проход по метаданным, а не перекачивание;
2. выбор Java;
3. сборка команды и запуск с автозаходом на сервер.

Прогресс идёт в `line://mc-install-progress`, состояние игры — в
`line://mc-game-status`.

## Как это устроено

| Шаг             | Код                                    | API крейта                                                                         |
| --------------- | -------------------------------------- | ---------------------------------------------------------------------------------- |
| Инициализация   | `instance_root` + `Launcher::new(dir)` | `launcher::Launcher`                                                               |
| Установка       | `mc_install`                           | `install_with_progress(InstallRequest, reporter)`                                  |
| Загрузчик модов | `loader_spec`                          | `LoaderSpec::{Fabric,Quilt,Forge,NeoForge}`, `LoaderVersion::{LatestStable,Exact}` |
| Метаданные      | `start_game`                           | `load_version` → `VersionJson` (с учётом `inheritsFrom`)                           |
| Команда         | `start_game`                           | `build_launch_command_from_version(&version, LaunchOptions)`                       |
| Процесс         | `tokio::process::Command`              | `LaunchCommand { executable, args, working_dir, env }`                             |

Три особенности крейта, которые учтены в коде:

1. **Он блокирующий.** Внутри `reqwest::blocking`, поэтому каждый вызов обёрнут в
   `tokio::task::spawn_blocking`. Прямой вызов из async-воркера Tauri паникует с
   «cannot block the current thread from within a runtime».
2. **`JavaInstallPolicy::Auto` не ставит Java.** Документация крейта: «The crate
   does not currently bundle or manage a production Java runtime for the new
   facade». Политика оставлена `Auto` ради совместимости, а рантайм реально
   выбирается в `resolve_java` и передаётся через `LaunchOptions::java_executable`.
3. **В `LaunchOptions` нет памяти.** `-Xmx`/`-Xms` приходят из метаданных версии,
   поэтому `apply_heap` заменяет их на значение из настроек ровно один раз.

### Идентичность игрока

`Account::offline("Nick")` создаёт **случайный UUID при каждом вызове** — миры теряли бы владельца. Поэтому используется публичный вариант:

```rust
Account::Offline { username: account_name, uuid: account_uuid }
```

где `account_uuid = player_uuid(&username)` — тот же стабильный идентификатор,
что и в провайдерском режиме. Ник берётся из аккаунта проекта, вход обязателен.

### Java

`resolve_java` идёт по порядку и останавливается на первом подходящем:

1. путь, выбранный игроком в настройках (проверяется запуском `java -version`);
2. локальный поиск `java::discover(required_major)`;
3. уже скачанный JRE от Mojang — `runtime::get_executable_path`;
4. автозагрузка — `runtime::install_jvm_runtime(component, dir, &CallbackDict::default())`.

`required_major` и `component` берутся из `VersionJson::java_version`. Скачанный
рантайм тоже проверяется запуском, и несовпадение мажора — ошибка, а не тихий
запуск на другой Java.

### Защита

Метаданные версий скачиваются, а профили загрузчиков пишутся инсталляторами, поэтому
перед запуском аргументы проходят `reject_dangerous_args`: запрещены `-javaagent`,
`-agentlib`, `-agentpath`, `-Xbootclasspath`, `--patch-module`,
`--upgrade-module-path`, `-Djava.system.class.loader` и любое `-DlineLauncher.*`
(пространство приватного IPC провайдерского режима). Идентификатор экземпляра и
версии проверяются как имена каталогов: без `..`, разделителей и управляющих символов.

## Команды Tauri

| Команда             | Аргументы                                            | Результат                   |
| ------------------- | ---------------------------------------------------- | --------------------------- |
| `mc_install`        | `request: { instanceId, minecraftVersion, loader? }` | `{ instanceId, versionId }` |
| `mc_list_installed` | `instanceId`                                         | `string[]`                  |
| `mc_launch`         | `request: { instanceId, versionId }`                 | `McGameStatus`              |
| `mc_stop`           | `instanceId`                                         | `boolean`                   |
| `mc_status`         | `instanceId`                                         | `McGameStatus`              |

События: `line://mc-install-progress` и `line://mc-game-status`. Обёртки —
`lineApi.mcPlay/mcInstall/mcLaunch/mcStop/mcStatus/onMcProgress/onMcGame`.
Кнопка «Играть» вызывает `mcPlay`.

`versionId` из `mc_install` надо сохранять: с загрузчиком это не исходная версия
(`fabric-loader-0.16.9-1.21.1` вместо `1.21.1`).

Лог игры: `<app-data>/minecraft/<instanceId>/logs/launch.log`. Данные игрока —
каталог `game/` рядом с `versions/`, он не удаляется при обновлении профиля.

## Ограничения текущей реализации

- **Отмены установки нет.** Крейт не даёт точки отмены; `install_with_progress`
  можно только дождаться. Кнопка отмены появится, когда она сможет честно
  прерывать работу.
- **Интерфейс ещё не подключён.** Бэкенд, команды и типизированные обёртки
  готовы; экран выбора версии/загрузчика — следующий шаг.
- Forge и NeoForge запускают java-инсталлятор и ставятся заметно дольше, чем
  vanilla/Fabric/Quilt.

## Проверка

- `npm run test:rust` — чистые правила режима (`validate_version_id`,
  `validate_loader`, `apply_heap`, `reject_dangerous_args`) исполняются настоящим
  `rustc`, 4 новых теста.
- `npm test` — `tests/minecraft-mode.test.ts`: закрепление версии, импорт прелюдии
  без подмены `Result`, все блокирующие вызовы внутри `spawn_blocking`, стабильный
  UUID, порядок выбора Java, аргументы/env/cwd/kill switch, регистрация команд и
  аддитивная граница с провайдерским режимом.
- Обращение к API крейта дополнительно проверялось компиляцией стендом с точными
  сигнатурами 0.1.2. **Это не заменяет `cargo check`**: полный граф зависимостей
  в среде разработки не собирается.

На своей машине:

```powershell
cargo check --manifest-path src-tauri/Cargo.toml --all-targets
cargo test --locked --manifest-path src-tauri/Cargo.toml
```

**Про `Cargo.lock`.** Новая зависимость в лок-файл ещё не внесена: в среде
разработки нет доступа к crates.io. Первый `cargo check` **без** `--locked`
обновит `src-tauri/Cargo.lock` сам — этот файл нужно закоммитить, иначе CI и
`cargo test --locked` упадут на «lock file needs to be updated».

Первая сборка добавляет зависимости крейта (`zip 2.x`, `sha2 0.11`, `xz2`,
`chrono`, `rand`, `which`) — это нормально, они сосуществуют с текущими версиями
лаунчера, потому что мажоры разные.
