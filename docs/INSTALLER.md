# Установщик: что можно настроить и как собрать под каждую ОС

Этот файл — про **выпуск для игроков**: какой установщик получается на каждой
системе, что в нём можно переделать под свой проект и как это сделать на
Windows, macOS и Linux. Как менять название и цвета — [BRANDING.md](BRANDING.md),
как устроена сборка с нуля — [BUILD.md](BUILD.md).

---

## 1. Что вообще получится на выходе

Одна команда — `npm run tauri:build` — и в `src-tauri/target/release/bundle/`
появляются установщики. Их набор зависит от ОС, на которой вы собираете:
кросс-сборки у Tauri нет, `.msi` нельзя сделать на Linux, а `.dmg` — на Windows.

| ОС для сборки | Что получится                        | Куда смотрет                                     |
| ------------- | ------------------------------------ | ------------------------------------------------ |
| **Windows**   | `*-setup.exe` (NSIS) и `*.msi` (WiX) | `bundle/nsis/`, `bundle/msi/`                    |
| **macOS**     | `*.dmg` и `.app`                     | `bundle/dmg/`, `bundle/macos/`                   |
| **Linux**     | `*.deb`, `*.rpm`, `*.AppImage`       | `bundle/deb/`, `bundle/rpm/`, `bundle/appimage/` |

> **Почему два установщика на Windows.** NSIS — привычный «Далее → Далее →
> Установить», умеет ставиться без прав администратора. MSI — формат для
> корпоративных развёртываний (GPO, Intune), там ждут `.msi`. Оба читают одну и
> ту же лицензию, но по-разному, поэтому сборка на Windows делает два прохода.

Релизный workflow [`.github/workflows/release.yml`](../.github/workflows/release.yml)
собирает всё это сразу на четырёх машинах (две macOS-архитектуры, Ubuntu,
Windows) — локально повторять не нужно, если проект живёт на GitHub.

---

## 2. Что настраивается — и где

Всё лежит в одном файле: [`src-tauri/tauri.conf.json`](../src-tauri/tauri.conf.json).
Ключ `bundle` общий для всех ОС, дальше идут `bundle.windows`,
`bundle.linux`, `bundle.macOS`.

### 2.1. Общее для всех платформ

| Ключ               | Что задаёт                               | Значение сейчас                                      |
| ------------------ | ---------------------------------------- | ---------------------------------------------------- |
| `productName`      | имя папки, ярлыка, приложения            | приходит из брендинга (см. `npm run brand`)          |
| `version`          | версия сборки                            | из брендинга                                         |
| `identifier`       | обратный домен, **уникальный на проект** | `plusinplus.line.*`                                  |
| `publisher`        | издатель в свойствах файла и MSI         | `Plus In Plus`                                       |
| `copyright`        | строка копирайта                         | обязательна по лицензии                              |
| `shortDescription` | описание в свойствах и в меню «Пуск»     | `Provider-configured Minecraft launcher`             |
| `icon`             | иконки приложения                        | `icons/*` (генерируются из логотипа брендингом)      |
| `licenseFile`      | текст лицензии внутри установщика        | `../LICENSE`                                         |
| `resources`        | файлы, которые кладутся рядом с бинарём  | `LICENSE`, `NOTICE.md`, тексты лицензий зависимостей |
| `targets`          | какие форматы собирать                   | `"all"` — все, что поддерживает ОС                   |
| `category`         | категория приложения                     | не задана; для Linux-меню стоит указать `Game`       |

**Важно про `identifier`.** Это не косметика: от него зависят папка данных
(`%APPDATA%\<identifier>`, `~/Library/Application Support/<identifier>`,
`~/.local/share/<identifier>`) и ключ в реестре, по которому Windows понимает,
что установлено. Меняете его у уже выпущенного лаунчера — игроки теряют настройки
и получают второе приложение вместо обновления.

### 2.2. Windows: NSIS и MSI

```jsonc
{
  "bundle": {
    "windows": {
      "nsis": {
        // "currentUser" — без прав администратора, ставится в профиль игрока.
        // "perMachine" — в Program Files, нужен админ.
        // "both" — установщик спрашивает при запуске.
        "installMode": "currentUser",

        // Языки мастера установки. Русский — "Russian", английский — "English".
        // OS-язык игрока выбирает сам, если он есть в списке.
        "languages": ["Russian", "English"],
        "displayLanguageSelector": true,

        // Картинки мастера: 150×57 (шапка) и 164×314 (боковая панель).
        // BMP, не PNG. Без них мастер выглядит стандартным NSIS.
        "headerImage": "installer/header.bmp",
        "sidebarImage": "installer/sidebar.bmp",

        // Своя иконка установщика (по умолчанию берётся иконка приложения).
        "installerIcon": "icons/icon.ico",
        "uninstallerIcon": "icons/icon.ico",

        // Сжатие: "lzma" (по умолчанию) — самый маленький файл,
        // "bzip2"/"zlib" — быстрее собирается.
        "compression": "lzma",

        // Папка в меню «Пуск»; по умолчанию — без группировки.
        "startMenuFolder": "Line Launcher",
      },
      "wix": {
        // Один и тот же upgradeCode у всех версий — иначе MSI ставится
        // рядом, а не обновляет. Менять только до первого релиза!
        "upgradeCode": "00000000-0000-0000-0000-000000000000",
        "language": ["ru-RU", "en-US"],
        // Баннер 493×58 и картинка диалога 493×312, тоже BMP.
        "bannerPath": "installer/wix-banner.bmp",
        "dialogImagePath": "installer/wix-dialog.bmp",
      },
    },
  },
}
```

Ещё два ключа `bundle.windows`, которые стоит знать:

- `webviewInstallMode` — что делать, если в системе нет WebView2 (на Windows 10
  его часто нет). По умолчанию Tauri скачивает и ставит его сам; `"embedBootstrapper"`
  кладёт загрузчик внутрь установщика (работает офлайн-старт), `"offlineInstaller"`
  — самый надёжный вариант для машин без интернета, но установщик тяжелеет на ~130 МБ.
  В конфигурации Line Launcher теперь выбран `offlineInstaller`: он включается
  в Windows NSIS/MSI, а не загружается на ПК игрока при установке. При сборке
  установщика Tauri всё равно может потребоваться сеть для получения компонента.
  Установка ещё требует проверки на чистой Windows без WebView2; нельзя обещать,
  что компонент установится при любых правах доступа или состоянии системы.
- `allowDowngrades` — по умолчанию `false`: MSI откажется ставить версию ниже уже
  установленной. Если вы раздаёте откат сборки вручную, включайте осознанно.
- `signCommand` — внешняя подпись кода. Без неё SmartScreen покажет
  «Неизвестный издатель» — см. [RUNBOOK.md](RUNBOOK.md), раздел 7.

### 2.3. macOS

```jsonc
{
  "bundle": {
    "macOS": {
      "minimumSystemVersion": "10.15",
      "bundleVersion": "1", // CFBundleVersion; растит CI, не руками
      "signingIdentity": null, // имя сертификата Developer ID, если есть
      "hardenedRuntime": true,
      "dmg": {
        // Фон окна DMG: PNG/JPG/GIF. Под него подгоняются позиции иконок.
        "background": "installer/dmg-background.png",
        "windowSize": { "width": 660, "height": 400 },
        "appPosition": { "x": 180, "y": 170 },
        "applicationFolderPosition": { "x": 480, "y": 170 },
      },
    },
  },
}
```

Для раздачи вне App Store нужен **подписанный и нотаризованный** `.dmg`: без
этого Gatekeeper пишет «приложение повреждено» и не даёт запустить. Ключи
`signingIdentity`, `hardenedRuntime`, `entitlements` и переменные окружения для
нотаризации описаны в фазе 3 [RUNBOOK.md](RUNBOOK.md).

Универсальный бинарник (Intel + Apple Silicon одной сборкой) делается так:

```sh
node scripts/tauri-build.mjs --target universal-apple-darwin
```

Либо две отдельные сборки, как в release-workflow: `aarch64-apple-darwin` и
`x86_64-apple-darwin`.

### 2.4. Linux

```jsonc
{
  "bundle": {
    "linux": {
      "deb": {
        "depends": ["libwebkit2gtk-4.1-0", "libgtk-3-0"],
        "section": "games",
        "priority": "optional",
        // Скрипты ставятся в пакет как есть, без переводов строк.
        "postInstallScript": "installer/post-install.sh",
      },
      "rpm": {
        "depends": ["webkit2gtk4.1", "gtk3"],
        "release": "1",
        "compression": { "type": "zstd", "level": 19 },
      },
      "appimage": {
        // Включает gstreamer для видео/звука — нужно, если внутри есть
        // видеоплеер или браузерный движок с медиа. Нам не нужно: выключено.
        "bundleMediaFramework": false,
      },
    },
  },
}
```

**AppImage** — единственный формат, который запускается на любом дистрибутиве
без установки (`chmod +x` и запуск). Это самый простой путь для игроков на
Linux: не надо объяснять, какой у них пакетный менеджер.

> **Имя пакета.** Пакеты `.deb`/`.rpm` получают имя из `productName`, приведённого
> к нижнему регистру с дефисами. Если в названии кириллица — переименуйте через
> `bundle.linux.deb` → проверьте имя файла после сборки; для Linux безопаснее
> латинский `productName`.

---

## 3. Иконки: почему их не рисуют руками

`npm run brand` собирает `icons/32x32.png`, `128x128.png`, `128x128@2x.png`,
`icon.ico` (Windows) и `icon.icns` (macOS) из одного логотипа проекта. Все
форматы обязаны быть на месте к моменту `tauri:build` — установщик Windows
падает на сборке MSI, если `.ico` нет.

Если меняли логотип:

```sh
npm run brand          # перегенерировать все размеры
npm run brand:check    # убедиться, что файлы совпадают с брендингом
```

---

## 4. Сборка по шагам — Windows

1. **Что нужно:** Windows 10/11 x64, Node.js 22+, Rust (MSVC toolchain),
   Visual Studio Build Tools с нагрузкой «Разработка классических приложений
   на C++» и Windows SDK. Подробно — [BUILD.md](BUILD.md), шаг 1.3.
2. **Поставить зависимости и проверить окружение:**

   ```powershell
   npm ci
   npm run doctor
   ```

3. **Заполнить `branding/provider.json`** боевым адресом — иначе сборка
   остановится на проверке (это защита, а не ошибка).
4. **Собрать:**

   ```powershell
   npm run tauri:build
   ```

   Первый раз — 5–20 минут: Rust компилирует всё с нуля. Дальше — секунды.

5. **Забрать файлы:** `src-tauri\target\release\bundle\nsis\*-setup.exe` и
   `...\bundle\msi\*.msi`.
6. **Проверить на чистой машине:** поставить `.exe`, войти, запустить сервер.
   Особенно если ставили `installMode: "perMachine"` — тогда нужны права
   администратора, и это надо честно написать игрокам.

## 5. Сборка по шагам — macOS

1. **Что нужно:** macOS 11+, Xcode Command Line Tools (`xcode-select --install`),
   Node.js 22+, Rust через rustup.
2. **Архитектура:** на Apple Silicon по умолчанию соберётся `aarch64`. Чтобы
   получить сборку для Intel, добавьте rust-target и соберите с `--target`:

   ```sh
   rustup target add x86_64-apple-darwin
   node scripts/tauri-build.mjs --target x86_64-apple-darwin
   ```

3. **Собрать:**

   ```sh
   npm ci
   npm run doctor
   npm run tauri:build
   ```

4. **Забрать файлы:** `src-tauri/target/release/bundle/dmg/*.dmg`
   (и `.app` в `bundle/macos/`).
5. **Подписать и нотаризовать** перед раздачей — иначе Gatekeeper заблокирует
   запуск. Инструкция: [RUNBOOK.md](RUNBOOK.md), фаза 3.

## 6. Сборка по шагам — Linux

1. **Что нужно (Debian/Ubuntu):**

   ```sh
   sudo apt update
   sudo apt install -y libwebkit2gtk-4.1-dev build-essential curl wget file \
     libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev \
     libgtk-3-dev librsvg2-dev patchelf
   ```

   Fedora: `webkit2gtk4.1-devel openssl-devel libappindicator-gtk3-devel
librsvg2-devel patchelf`. Arch: `webkit2gtk-4.1 base-devel curl wget file
openssl appmenu-gtk-module libappindicator-gtk3 librsvg patchelf`.

   > `libayatana-appindicator3-dev` обязателен: без него не собирается
   > **иконка в трее**, а именно она держит лаунчер доступным, когда игрок
   > выбрал «Скрывать в трей».

2. **Собрать:**

   ```sh
   npm ci
   npm run doctor
   npm run tauri:build
   ```

3. **Забрать файлы:** `src-tauri/target/release/bundle/deb/*.deb`,
   `.../rpm/*.rpm`, `.../appimage/*.AppImage`.
4. **Проверить AppImage на чистой системе** (или в контейнере нужного
   дистрибутива): у AppImage свои требования к glibc — собранный на Ubuntu 22.04
   не запустится на 20.04.

---

## 7. Как проверить установщик, не раздавая его

- **Windows:** поставить в новом профиле пользователя, затем «Программы и
  компоненты» → должно быть одно приложение, а не два (это проверка
  `upgradeCode` у MSI и `identifier` у NSIS).
- **macOS:** `spctl -a -vv /Applications/*.app` — должно быть `accepted`,
  `source=Notarized Developer ID`. До нотаризации будет `rejected`.
- **Linux:** `dpkg -i *.deb && apt-get -f install` (проверка зависимостей),
  затем `rm -rf ~/.config/<identifier>` и запуск — лаунчер должен открыться
  заново как в первый раз, а не упасть.

Общий чек-лист перед раздачей — конец [BUILD.md](BUILD.md), шаг 6.

---

## 8. Частые вопросы по установщику

| Симптом                                           | Причина                                  | Что делать                                               |
| ------------------------------------------------- | ---------------------------------------- | -------------------------------------------------------- |
| Сборка падает на «Сборка не настроена»            | пустой `config_url`                      | заполнить `branding/provider.json`                       |
| MSI ставится рядом со старой версией              | разный `upgradeCode` между релизами      | задать один GUID навсегда и не менять                    |
| Обновление не видит установленную версию          | сменился `identifier`                    | вернуть прежний `identifier`                             |
| SmartScreen: «Неизвестный издатель»               | нет подписи кода                         | подписать (`bundle.windows.signCommand`), см. RUNBOOK    |
| macOS: «приложение повреждено»                    | нет подписи/нотаризации                  | подписать и нотаризовать, см. RUNBOOK, фаза 3            |
| `.deb` не ставится: неудовлетворённые зависимости | в списке нет `depends` нужной библиотеки | дополнить `bundle.linux.deb.depends`                     |
| AppImage падает с ошибкой GLIBC                   | собран на более новой системе            | собирать на самом старом из поддерживаемых дистрибутивов |
| Установщик на русском, но кавычки/меню английские | `languages` без `Russian`                | добавить `"Russian"` в `bundle.windows.nsis.languages`   |
| Нет иконки в трее на Linux                        | не установлен `libayatana-appindicator3` | поставить пакет разработки и пересобрать                 |

---

Дальше: [RUNBOOK.md](RUNBOOK.md) — подпись, нотаризация и релизы;
[BRANDING.md](BRANDING.md) — название, цвета, логотип.
