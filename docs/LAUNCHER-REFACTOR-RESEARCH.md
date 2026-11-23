# Исследование лаунчеров: необязательные идеи оптимизации

> Историческое исследование исходного состояния, а не описание текущей ветки.
> Текущие возможности и ограничения: [ROADMAP.md](ROADMAP.md),
> [INSTALLATION-AUDIT.md](INSTALLATION-AUDIT.md) и [DOWNLOAD-PERFORMANCE.md](DOWNLOAD-PERFORMANCE.md).

Это исследование исходного кода, а не результаты бенчмарков и не описание уже внедрённых изменений. Зафиксированы конкретные ревизии, чтобы ссылки не менялись. Приоритеты — предложение для реализации; сроки и ускорение пока не измерены.

## Исходное состояние Line

- Источники Modrinth/packwiz обрабатываются с максимумом 8 параллельных задач (`src-tauri/src/line/source/install.rs`); это также включает локальное копирование. Есть проверка целостности, временная область, публикация релиза и кэш идентичности источника.
- Неизменённый источник может не скачиваться повторно, но быстрый путь сверяет релиз, а подготовка Minecraft затем снова вызывает `integrity::scan`. Это потенциально дорого на больших сборках. При изменении источника/повреждении в настоящий момент возможна повторная загрузка всей сборки. Подробности: `docs/DOWNLOAD-PERFORMANCE.md`.
- Minecraft и загрузчики идут через `mc-launcher-core = 0.1.2` и отдельный путь NeoForge 1.20.1; лимит скорости сборок их не охватывает. Путь NeoForge скачивает временный установщик и запускает Java-процесс, который сам управляет своими библиотеками.
- Лаунчер проверяет выбранную Java и требует точный major из профиля версии (`resolve_java` в `minecraft.rs`). Требования всех модов он пока не вычисляет. Фоновый виджет и отмена сборки уже есть, но не у всех этапов одинаковые возможности.
- На Windows уже наблюдались: недоступный без VPN NeoForge Maven; отсутствие launcher_profiles.json, исправляемое в PR #69; конфликт Zoomify с Java 17. Все три случая разные; ускорение сетевой очереди само по себе их не устраняет.

## Источники и наблюдения

### Prism Launcher — `62d1e34d796858250c0390c36771bb8950f4f971`

1. [NetJob](https://github.com/PrismLauncher/PrismLauncher/blob/62d1e34d796858250c0390c36771bb8950f4f971/launcher/net/NetJob.cpp) очередью запускает параллельные запросы и повторно ставит неудачные задачи, не повторяя 404. [По умолчанию](https://github.com/PrismLauncher/PrismLauncher/blob/62d1e34d796858250c0390c36771bb8950f4f971/launcher/Application.cpp) настроены 6 одновременных загрузок и лимит повторов 2.
2. [LibrariesTask](https://github.com/PrismLauncher/PrismLauncher/blob/62d1e34d796858250c0390c36771bb8950f4f971/launcher/minecraft/update/LibrariesTask.cpp) собирает библиотечные задания из профиля. [Library](https://github.com/PrismLauncher/PrismLauncher/blob/62d1e34d796858250c0390c36771bb8950f4f971/launcher/minecraft/Library.cpp) использует локальный кэш и, когда хеш указан, валидатор. Без указанного хеша наличие кэша нельзя считать доказанной целостностью.
3. [FileSink](https://github.com/PrismLauncher/PrismLauncher/blob/62d1e34d796858250c0390c36771bb8950f4f971/launcher/net/FileSink.cpp) пишет через save-file и коммитит после валидаторов; [MetaCacheSink](https://github.com/PrismLauncher/PrismLauncher/blob/62d1e34d796858250c0390c36771bb8950f4f971/launcher/net/MetaCacheSink.cpp) поддерживает ETag и Last-Modified.
4. [VerifyJavaInstall](https://github.com/PrismLauncher/PrismLauncher/blob/62d1e34d796858250c0390c36771bb8950f4f971/launcher/minecraft/launch/VerifyJavaInstall.cpp) проверяет набор допустимых major из профиля и отдельно предусматривает пользовательское игнорирование проверки. Это не доказывает автоматический полный анализ зависимостей всех модов.

### Modrinth App — `1b27f67b4d0c870dee74050cb79163e370c03243`

1. [Модель установки](https://github.com/modrinth/code/blob/1b27f67b4d0c870dee74050cb79163e370c03243/packages/app-lib/src/install/model.rs) содержит фазы, события, повторное использование файлов, прерывание, ошибки и откат; запрос и состояние хранятся отдельно. [Управление](https://github.com/modrinth/code/blob/1b27f67b4d0c870dee74050cb79163e370c03243/packages/app-lib/src/install/control.rs) предусматривает паузу и отмену в контрольных точках, а [runner](https://github.com/modrinth/code/blob/1b27f67b4d0c870dee74050cb79163e370c03243/packages/app-lib/src/install/runner.rs) блокирует конкурирующие задачи для одной цели.
2. Идея для Line: переживающий перезапуск журнал задачи и прозрачные этапы. Не следует автоматически обещать побайтовое продолжение или паузу у внешнего Java-установщика.

### HMCL — `de39d2fc8fae18a7992849729fb708d59f2a1eda`

1. [DefaultCacheRepository](https://github.com/HMCL-dev/HMCL/blob/de39d2fc8fae18a7992849729fb708d59f2a1eda/HMCLCore/src/main/java/org/jackhuang/hmcl/download/DefaultCacheRepository.java) хранит проверенные библиотеки и ищет по хешам/индексу; legacy-файлы без метаданных обрабатываются отдельно. SHA-1 применяется там, где он предоставлен Minecraft-метаданными; для собственных индексов Line сохраняем SHA-256 и SHA-512, когда доступны.
2. [FileDownloadTask](https://github.com/HMCL-dev/HMCL/blob/de39d2fc8fae18a7992849729fb708d59f2a1eda/HMCLCore/src/main/java/org/jackhuang/hmcl/task/FileDownloadTask.java) поддерживает список URL-кандидатов и проверку файла. Это пример механизма, а не основание автоматически доверять любому стороннему зеркалу.

### XMCL — `cca4b9a905664e2942e62f3a1b4cf341a82de966`

1. [План установки](https://github.com/Voxelum/x-minecraft-launcher/blob/cca4b9a905664e2942e62f3a1b4cf341a82de966/xmcl-runtime/instanceIO/utils/installPlan.ts) учитывает перекрывающиеся файлы и смену версий; [pendingInstall](https://github.com/Voxelum/x-minecraft-launcher/blob/cca4b9a905664e2942e62f3a1b4cf341a82de966/xmcl-runtime/instanceIO/utils/pendingInstall.ts) сохраняет состояние через временный файл и повторяет некоторые временные Windows-ошибки rename.
2. [withRetry](https://github.com/Voxelum/x-minecraft-launcher/blob/cca4b9a905664e2942e62f3a1b4cf341a82de966/xmcl-runtime/user/utils/withRetry.ts) показывает политику повторов HTTP с backoff и Retry-After для конкретного fetch-слоя авторизации. Это не утверждение, что все загрузки XMCL работают идентично.
3. [downloadStaged](https://github.com/Voxelum/x-minecraft-launcher/blob/cca4b9a905664e2942e62f3a1b4cf341a82de966/xmcl-runtime/market/downloadStaged.ts) иллюстрирует staging и очистку. Его Windows fallback удаляет назначение перед повторным rename, поэтому не копируем его как гарантию полной атомарности.

## Предложения и статус

Нижеследующие направления ранее предлагались как возможные приоритеты, но не
утверждены к реализации. Они не являются отдельным backlog; актуальные
согласованные проверки и ограничения собраны в [ROADMAP.md](ROADMAP.md).
Перед любым изменением загрузчика нужны базовые измерения, обоснование
безопасности и отдельное согласование объёма.

## Ограничения исследования и лицензии

Исследованы отдельные исходники, не выполнено профилирование или запуск чужих лаунчеров. Нельзя заключать, что Prism обойдёт недоступный Maven, или что все загрузчики используют одинаковые пути. Ссылки демонстрируют архитектурные идеи, не являются разрешением копировать код: Prism GPL-3.0-only, у Modrinth пакеты могут иметь разные лицензии/ограничения бренда, HMCL имеет собственное дополнение к GPL, XMCL — MIT. Перед переносом кода требуется отдельная проверка лицензий и атрибуции; безопаснее самостоятельно реализовать описанные принципы.
