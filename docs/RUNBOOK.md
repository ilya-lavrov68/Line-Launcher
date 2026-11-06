# Ранбук: что нужно сделать вне песочницы

Этот документ — пошаговая инструкция для действий, которые **нельзя выполнить в
среде разработки агента**: полная сборка Rust, проверки на Windows/macOS,
реальный запуск Minecraft, подпись кода и публикация обновлений.

Каждый раздел содержит: зачем это нужно → что сделать → как понять, что получилось
→ что делать, если не получилось.

Текущий фактический статус проверок — в [VERIFICATION.md](VERIFICATION.md).
Контракт провайдера — в [PROVIDER.md](PROVIDER.md).

---

## 0. Что уже проверено, а что нет

| Проверено локально                                      | Проверено в CI                        | Не проверено (нужно вам)                     |
| ------------------------------------------------------- | ------------------------------------- | -------------------------------------------- |
| TypeScript, production-сборка frontend, 22 unit-теста   | `cargo fmt/check/test/clippy` на 3 ОС | Сборка Tauri-приложения и инсталляторов      |
| Чистая Rust-логика реальным `rustc` (10 тестов)         | IPC-тесты Windows/macOS/Linux         | Запуск окна приложения и реальная установка  |
| Java-клиент на реальной JVM: 11 сценариев               | Java + провайдер на 3 ОС              | Реальный Minecraft и мод конкретного лоадера |
| Референсный провайдер + сборка + demo-игра: 12 проверок | Gitleaks                              | Подпись кода, нотаризация, updater           |
| UI-smoke в Chromium, обязательная атрибуция             | —                                     | —                                            |

CI зелёный по всем десяти job (PR #1). Полная компиляция Rust в песочнице
невозможна — нет доступа к crates.io, — поэтому первый настоящий `cargo build`
произошёл именно в CI; найденные там ошибки исправлены в этой ветке.
Всё, что в правом столбце, описано ниже.

---

## 1. Подготовка рабочего места

### 1.1. Обязательное ПО

| ПО            | Версия                       | Зачем                                  |
| ------------- | ---------------------------- | -------------------------------------- |
| Node.js       | 22+                          | frontend, тесты, референсный провайдер |
| npm           | идёт с Node                  | lockfile v3                            |
| Rust (rustup) | stable ≥ 1.95                | backend Tauri                          |
| JDK           | 17+ (для CI используется 21) | тесты Java-клиента и сборка демо-пака  |
| openssl       | 3.x (есть в составе Git)     | сертификат локального провайдера       |
| Git           | любая свежая                 | работа с репозиторием                  |

Системные зависимости Tauri v2 обязательны и различаются по ОС:
<https://tauri.app/start/prerequisites/>

**Windows:** Microsoft Visual Studio C++ Build Tools, WebView2 Runtime.
**macOS:** Xcode Command Line Tools (`xcode-select --install`).
**Linux (Debian/Ubuntu):**

```sh
sudo apt-get update
sudo apt-get install -y libwebkit2gtk-4.1-dev build-essential curl wget file \
  libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev
```

### 1.2. Установка проекта

```sh
git clone <ваш-репозиторий> Line-Launcher
cd Line-Launcher
npm ci
npm run doctor       # проверяет всё окружение и печатает, чего не хватает
```

**Готово, если:** `npm run doctor` завершился с кодом 0 и напечатал «Готово к сборке».

`npm run tauri dev` и `npm run tauri:build` запускают эту проверку автоматически,
поэтому вместо невнятного `cargo metadata ... program not found` вы сразу
увидите, чего именно не хватает.

### 1.3. Если `tauri dev` пишет `cargo metadata: program not found`

Это значит, что **Rust не установлен** (или не попал в `PATH`). Сам лаунчер тут
ни при чём: Tauri вызывает `cargo`, а его нет в системе.

**Windows**

1. Установите Rust: скачайте <https://win.rustup.rs/x86_64>, запустите, выберите
   вариант `1) Proceed with standard installation`.
2. Установите **Microsoft C++ Build Tools**:
   <https://visualstudio.microsoft.com/visual-cpp-build-tools/> → workload
   «Разработка классических приложений на C++», обязательно с компонентом
   «Windows 10/11 SDK». Без него Rust установится, но линковка упадёт на
   `link.exe`.
3. Убедитесь, что установлен **WebView2 Runtime** (в Windows 11 он уже есть):
   <https://developer.microsoft.com/microsoft-edge/webview2/>
4. **Закройте и заново откройте терминал** — `PATH` подхватывается только при
   старте процесса. Это самая частая причина «я же установил, а не работает».
5. Проверьте: `rustc --version`, `cargo --version`, затем `npm run doctor`.

**macOS:** `xcode-select --install`, затем
`curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh`.

**Linux:** та же команда `rustup` плюс системные пакеты из раздела 1.1.

Первый `npm run tauri dev` после установки собирает ~470 крейтов и занимает
несколько минут — это нормально, последующие запуски быстрые.

### 1.4. Если doctor говорит «MSVC не установлен», а он установлен

Проверка ищет toolchain тремя способами: через `vswhere`, по наличию `cl.exe` на
диске и — если первые два не нашли — реальной пробной линковкой через `rustc`.
Пробная компиляция решает спор: если она прошла, doctor считает окружение годным,
даже когда Visual Studio стоит на нестандартном диске.

Проверить вручную:

```powershell
& "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe" `
  -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 `
  -property installationPath
```

Пустой вывод означает, что компонент C++ действительно не выбран в инсталляторе
(сам Visual Studio при этом может быть установлен). Откройте Visual Studio
Installer → «Изменить» → вкладка «Отдельные компоненты» → отметьте
«MSVC v143 — VS 2022 C++ x64/x86 build tools» и «Windows 11 SDK».

Если проверка ошибается, а сборка при этом идёт, её можно пропустить:

```powershell
$env:LINE_SKIP_DOCTOR=1; npm run tauri dev
```

### 1.5. Если `npm run dev` падает на `spawnSync npx.cmd EINVAL`

Начиная с Node 18.20.2 / 20.12.2 (исправление CVE-2024-27980) запуск `.cmd`-файла
без шелла запрещён. Генератор брендинга запускал `npx.cmd` для `tauri icon` —
теперь он вызывает JS-точку входа CLI напрямую через текущий Node, поэтому
ошибка больше не возникает.

Заодно устранена причина, по которой иконки перегенерировались **при каждом**
запуске: Git for Windows по умолчанию ставит `core.autocrlf=true`, штамп
`src-tauri/icons/.brand-source.sha256` читался как CRLF и никогда не совпадал.
В репозитории появился `.gitattributes` (`* text=auto eol=lf`), а сравнение
файлов игнорирует различия в переводах строк.

Если вы клонировали репозиторий до этого исправления, нормализуйте окончания
строк один раз:

```powershell
git add --renormalize .
git status        # должны быть только ожидаемые изменения
```

### 1.6. Если `provider:serve` пишет `spawnSync openssl ENOENT`

openssl нужен только для самоподписанного сертификата демо-провайдера. Отдельная
установка обычно не требуется: **Git for Windows уже содержит рабочий openssl** в
`<Git>\usr\bin\openssl.exe`, и скрипты теперь находят его сами (как и варианты
OpenSSL-Win64, Strawberry Perl, MSYS2, Chocolatey). Проверить:

```powershell
& "$env:ProgramFiles\Git\usr\bin\openssl.exe" version
```

Если его действительно нет:

```powershell
winget install --id ShiningLight.OpenSSL.Light
# либо укажите путь явно
$env:LINE_OPENSSL="C:\Program Files\Git\usr\bin\openssl.exe"
```

`npm run doctor` показывает, откуда взят openssl (`[PATH]`, `[Git for Windows]`).

### 1.7. Если `test:ui` не находит браузер

`playwright-core` входит в devDependencies и **не скачивает браузер**. Скрипт
сам находит установленный Edge или Chrome — на Windows Edge есть всегда. Если
нужен другой:

```powershell
$env:CHROMIUM_PATH="C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
npm run test:ui
```

Либо скачайте Chromium один раз: `npx playwright-core install chromium`.

UI-smoke обращается к запущенному dev-серверу, поэтому в другом терминале должен
работать `npm run dev`. Если сервер не поднят, скрипт теперь говорит об этом
прямо, а не падает со стеком соединения.

### 1.8. Про `npm audit`

`npm ci` может показать два десятка уязвимостей. Все они относятся к
**инструментам сборки** (`shadcn` CLI, Tailwind, Vite) и не попадают в бандл:

```sh
npm audit --omit=dev    # уязвимости того, что реально уходит пользователю → 0
```

Проверяйте именно эту команду. `npm audit fix --force` применять не нужно —
он ломает мажорные версии инструментов сборки.

---

## 2. Полная проверка Rust (главный пробел)

В песочнице недоступны архивы крейтов с crates.io, поэтому `cargo check/test/clippy`
не выполнялись. Синтаксис проверен парсером, форматирование — `rustfmt`, а чистая
логика — реальным `rustc`. **Полную компиляцию нужно сделать у вас.**

```sh
cargo fmt --manifest-path src-tauri/Cargo.toml --check
cargo check --locked --manifest-path src-tauri/Cargo.toml --all-targets
cargo test  --locked --manifest-path src-tauri/Cargo.toml
cargo clippy --locked --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
```

Повторите **на всех трёх ОС** (или доверьте это CI, раздел 8).

**Готово, если:** все четыре команды завершились с кодом 0, `cargo test` показал
`test result: ok` без `failed`, clippy не выдал предупреждений.

**Если не получилось:**

- _Ошибки компиляции._ Наиболее вероятные места — платформенный код:
  `src-tauri/src/line/ipc.rs` (Windows named pipe ACL, `windows-sys`),
  `src-tauri/src/line/java.rs` (поиск JRE), `src-tauri/src/line/launch.rs`
  (монитор процесса). Пришлите текст ошибки — это правится точечно.
- _Clippy ругается на стиль._ Применяйте `cargo clippy --fix` только осознанно;
  подавление через `#[allow(...)]` допустимо с комментарием, почему это безопасно.
- _`cargo test` падает на IPC-тестах._ Они создают реальные сокеты/пайпы; на
  Windows/macOS это первая настоящая проверка ACL и peer-credentials. Не отключайте
  тесты — сообщите об ошибке.
- _Долгая первая сборка._ Tauri собирает 470+ крейтов; 10–20 минут нормально.

---

## 3. Локальный провайдер и тестовая сборка

Чтобы проверить установку и запуск **без Minecraft и без боевого бэкенда**, в
репозитории есть референсный провайдер и генератор реальной сборки.

### 3.1. Собрать пак и запустить провайдер

```sh
npm run provider:pack     # .provider/pack.zip + .provider/config.json
npm run provider:serve    # https://127.0.0.1:8443/config.json
```

Генератор компилирует `DemoGame.java` и справочный `LineTicketClient.java`, кладёт
их в `client.jar`, пишет `line-launch.json` и собирает ZIP. Main class пака
выполняет настоящий обмен ticket по приватному IPC и завершается — то есть
проверяется весь путь лаунчера, кроме самого Minecraft.

Требуется `javac` (JDK 17+) либо `ECJ_JAR` рядом с JRE:

```sh
JAVA_HOME=/path/to/jdk npm run provider:pack
# или
JAVA_HOME=/path/to/jre ECJ_JAR=/path/to/ecj.jar npm run provider:pack
```

Версия Java в манифесте берётся из активного рантайма; переопределить:
`LINE_JAVA_MAJOR=21`.

### 3.2. Довериться самоподписанному сертификату

Лаунчер принимает только HTTPS и не отключает проверку сертификата — это
намеренно. Сертификат лежит в `.provider/tls.crt`; добавьте его в доверенные
**только на тестовой машине** и удалите после проверки.

**Windows (PowerShell от администратора):**

```powershell
Import-Certificate -FilePath .provider\tls.crt -CertStoreLocation Cert:\LocalMachine\Root
# удалить после тестов:
# Get-ChildItem Cert:\LocalMachine\Root | Where-Object { $_.Subject -eq "CN=localhost" } | Remove-Item
```

**macOS:**

```sh
sudo security add-trusted-cert -d -r trustRoot \
  -k /Library/Keychains/System.keychain .provider/tls.crt
```

**Linux (Debian/Ubuntu):**

```sh
sudo cp .provider/tls.crt /usr/local/share/ca-certificates/line-dev.crt
sudo update-ca-certificates
# удалить: sudo rm /usr/local/share/ca-certificates/line-dev.crt && sudo update-ca-certificates
```

Java-клиент использует своё хранилище доверия. Если demo-игра падает на
`PKIX path building failed`, импортируйте сертификат в JDK:

```sh
keytool -importcert -noprompt -alias line-dev -file .provider/tls.crt \
  -cacerts -storepass changeit
```

### 3.3. Автоматическая проверка связки

```sh
npm run test:provider
```

Скрипт сам собирает пак, поднимает провайдер, скачивает архив по HTTPS, сверяет
хеш, входит в аккаунт, выдаёт ticket, запускает demo-игру через приватный канал,
проверяет обмен, отказ при повторе (409) и при несовпадении привязок (403).

**Готово, если:** `Reference provider end-to-end: 12/12 passed`.

---

## 4. Проверка настольного приложения

### 4.1. Запуск в режиме разработки

```sh
npm run tauri dev
```

### 4.2. Сценарий ручной проверки

Введите в поле конфигурации `https://127.0.0.1:8443/config.json`, затем пройдите
по списку. Демо-аккаунт: `Player_1` / `demo-password`.

| №   | Действие                                        | Ожидаемый результат                                           |
| --- | ----------------------------------------------- | ------------------------------------------------------------- |
| 1   | Ввести URL конфигурации                         | Появился список серверов, название провайдера                 |
| 2   | Открыть сервер, вкладка «Регистрация»           | Форма регистрации, пароль ≥ 8 символов                        |
| 3   | Войти                                           | Имя игрока в шапке, кнопка установки активна                  |
| 4   | Установить сборку                               | Прогресс Downloading → Verifying → Extracting → 100 %         |
| 5   | Нажать «Играть»                                 | Статус «Игра запущена», в логе провайдера `exchange accepted` |
| 6   | Дождаться выхода demo-игры                      | Статус «Игра завершилась с кодом 0»                           |
| 7   | «История сборок»                                | Текущий релиз помечен, откат доступен                         |
| 8   | «Играть» и сразу «Отменить запуск»              | Запуск отменён, процесс Java не остаётся висеть               |
| 9   | Во время игры попробовать установку/откат/выход | Заблокировано (Busy)                                          |
| 10  | «О программе / About»                           | Видна строка `Line Launcher \| Plus In Plus`                  |

**Готово, если:** все десять строк дали ожидаемый результат, в консоли приложения
нет паник Rust, а в логе провайдера нет `exchange rejected`.

### 4.3. Проверка приватного канала вручную

Во время запуска (шаг 5) канал существует доли секунды. Чтобы убедиться в
изоляции, запустите игру и **параллельно** попробуйте подключиться посторонним
процессом от другого пользователя ОС:

- **Linux/macOS:** каталог `/tmp/line-ipc-<uuid>` должен иметь права `0700`,
  сокет — `0600`; другой пользователь получает `Permission denied`.
- **Windows:** пайп `\\.\pipe\line-launcher-<uuid>` создан с ACL только текущего
  пользователя; проверка из-под другой учётной записи должна завершаться отказом.

Если канал уже закрылся — это нормально: он одноразовый. Повторите запуск.

### 4.4. Проверка целостности установки

Каталог данных приложения:

- **Windows:** `%APPDATA%\studio.plusinplus.line-launcher`
- **macOS:** `~/Library/Application Support/studio.plusinplus.line-launcher`
- **Linux:** `~/.local/share/studio.plusinplus.line-launcher`

Внутри: `instances/<server>/releases/<sha256>/`, `current.json`, `history.json`,
`.install.lock`.

Проверьте вручную:

1. Прервите установку (закрыть приложение во время загрузки) и запустите снова —
   каталог `.staging-*` должен быть удалён, `current.json` не повреждён.
2. Запустите два экземпляра лаунчера и попробуйте установку в обоих — второй
   должен получить «Другой процесс уже изменяет эту сборку».
3. После трёх установок разных сборок в `releases/` должно остаться не больше трёх
   каталогов, текущий и запущенный — всегда на месте.

---

## 5. Реальный Minecraft и мод провайдера

Demo-пак проверяет транспорт, но не интеграцию с игрой. Что нужно сделать:

1. **Собрать реальную сборку** (Minecraft + ваш лоадер + мод авторизации) и
   положить внутрь `line-launch.json` по контракту из
   [PROVIDER.md](PROVIDER.md). Пути — только относительные, classpath — только
   `.jar` внутри архива, произвольные JVM-флаги запрещены.
2. **Встроить справочный клиент** `examples/mod-client/LineTicketClient.java` в мод
   и вызвать `LineTicketClient.request()` до подключения к серверу, затем
   `exchange(ticket)`. Ответ обмена — ваша игровая сессия/профиль.
3. **Реализовать серверную часть** по образцу `examples/provider/server.mjs`:
   ticket одноразовый, TTL ≤ 120 с, привязан к `server_id`, `sha256`, `channel_id`,
   `username`; повтор — 409, истечение — 401, несовпадение — 403.
4. **Проверить матрицу версий Java:** ваша сборка объявляет `java_major`; лаунчер
   ищет ровно эту версию (`JAVA_HOME`, `PATH`, стандартные каталоги). Убедитесь, что
   на тестовой машине стоит именно она, иначе получите ошибку `JAVA_REQUIRED`.

**Готово, если:** игрок входит в Minecraft под своим ником, сервер видит
корректную сессию, повторный запуск со старым ticket невозможен.

---

## 6. Проверки устойчивости (по желанию, но до релиза желательно)

| Сценарий                | Как проверить                     | Ожидание                                              |
| ----------------------- | --------------------------------- | ----------------------------------------------------- |
| Обрыв сети при загрузке | Отключить сеть на 30 % прогресса  | До 3 попыток, затем понятная ошибка; старый релиз цел |
| Повреждённый архив      | Отдать ZIP с неверным хешем       | Ошибка `INTEGRITY`, установка не публикуется          |
| Zip Slip                | Архив с записью `../evil`         | Отказ `UNSAFE_ARCHIVE` до записи файлов               |
| Большой архив           | Сборка 2–4 ГиБ                    | Прогресс не замирает, память не растёт линейно        |
| Мало места              | Заполнить диск                    | Ошибка `DISK_SPACE`, рабочий релиз не тронут          |
| Отключение питания      | Выключить машину во время коммита | После включения `current.json` валиден                |

---

## 7. Подпись кода и обновления

Сейчас release-workflow собирает **неподписанные** кандидаты и ничего не
публикует. Это осознанное решение: ключи должны быть у Plus In Plus.

### 7.1. Подпись

- **Windows:** сертификат Code Signing (OV/EV) в GitHub Secrets; настройте
  `bundle.windows.certificateThumbprint` / `signCommand` в Tauri-конфигурации.
  Без подписи SmartScreen будет предупреждать пользователей.
- **macOS:** Apple Developer ID Application, затем нотаризация:
  переменные `APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`, `APPLE_ID`,
  `APPLE_PASSWORD` (app-specific), `APPLE_TEAM_ID`. Без нотаризации Gatekeeper
  заблокирует приложение.
- **Linux:** подпись пакетов не обязательна; распространяйте `.deb`/`.rpm`/AppImage
  с контрольными суммами.

### 7.2. Updater

1. Сгенерируйте ключ **у себя**, приватная часть никогда не попадает в репозиторий:

   ```sh
   npm run tauri signer generate -- -w ~/.tauri/line-launcher.key
   ```

2. Публичный ключ впишите в `plugins.updater.pubkey`, приватный — в CI-секрет
   `TAURI_SIGNING_PRIVATE_KEY` (и `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`).
3. Поднимите endpoint обновлений и заполните `plugins.updater.endpoints`.
4. Включите `bundle.createUpdaterArtifacts: true`.
5. Добавьте отдельный job публикации, который выполняется только после успешных
   проверок разделов 2–5 и вручную подтверждается.

**Готово, если:** установщик проходит SmartScreen/Gatekeeper без предупреждений,
а старая версия обновляется до новой с проверкой подписи.

---

## 8. CI: как включить и что должно пройти

Workflow уже настроен в `.github/workflows/ci.yml`:

| Job           | Что делает                                                                  |
| ------------- | --------------------------------------------------------------------------- |
| `frontend`    | branding-check, 22 unit-теста, production-сборка                            |
| `rust-pure`   | чистая Rust-логика реальным `rustc` (быстрый сигнал)                        |
| `rust`        | fmt/check/test/clippy на Linux, Windows, macOS                              |
| `java-client` | Java-клиент (11 сценариев) + референсный провайдер (12 проверок) на трёх ОС |
| `secret-scan` | Gitleaks                                                                    |

На момент открытия PR #1 **все десять job зелёные**. Ветка обязана оставаться
зелёной: `rust` и `java-client` на Windows/macOS закрывают то, что невозможно
проверить в песочнице.

Если job падает, откройте лог, найдите первую ошибку и пришлите её вместе с
названием job и ОС. Шаги `cargo check/test/clippy`, `test:java` и `test:provider`
дополнительно публикуют хвост вывода как `::error::`-аннотацию — её видно прямо
в списке проверок PR, без скачивания лога.

---

## 9. Финальный чек-лист релиза

- [x] `cargo fmt/check/test/clippy` — зелёные на трёх ОС (CI)
- [x] CI полностью зелёный (PR #1, 10/10 job)
- [ ] `npm run test:java` и `npm run test:provider` — прошли локально
- [ ] Ручной сценарий раздела 4.2 пройден на Windows и macOS
- [ ] Реальный Minecraft + мод провайдера входят на сервер (раздел 5)
- [ ] Проверки устойчивости раздела 6 выполнены хотя бы для сети и хеша
- [ ] Бренд утверждён: `branding/line.brand.json`, `npm run brand:check`
- [ ] Атрибуция `Line Launcher | Plus In Plus` видна (требование лицензии)
- [ ] Подпись и нотаризация настроены, ключи в секретах CI
- [ ] Updater endpoint поднят, публичный ключ в конфиге
- [ ] `docs/VERIFICATION.md` обновлён фактическими результатами

---

## 10. Что прислать, если что-то не работает

Минимальный набор для быстрой диагностики:

1. ОС и версия, версия Rust (`rustc --version`), Node (`node -v`), Java (`java -version`).
2. Полная команда и **первая** ошибка из вывода (не последняя).
3. Для сбоев запуска: лог провайдера (`.provider` сервер пишет причины отказа) и
   статус игры в интерфейсе.
4. Для сбоев установки: код ошибки из интерфейса (`INTEGRITY`, `UNSAFE_ARCHIVE`,
   `DISK_SPACE`, `BUSY`…) — он стабилен и достаточен для локализации проблемы.

Логи не должны содержать ticket, пароль или access-токен: лаунчер их не печатает,
и в отчётах их быть не должно.
