# Участие в Line Launcher

Line Launcher — source-available решение Plus In Plus для провайдеров игровых серверов, построенное на Obsy Launcher. Не добавляйте универсальные аккаунты, загрузчики, аддоны или произвольные JVM-настройки без отдельного архитектурного решения.

1. Создайте ветку от актуальной `main`.
2. Установите Node.js 22+, Rust stable и зависимости Tauri v2.
3. `npm ci`, затем `npm run tauri dev`.
4. Frontend-компоненты Line находятся в `src/components/line/`; переиспользуйте `src/components/ui/`, Tailwind-токены, Framer Motion, Lucide и Base UI.
5. Backend-команды не должны принимать секреты в логи, произвольные пути из JSON или токены в WebView.
6. Перед PR выполните `npm test`, `npm run build`, Rust fmt/test/clippy из README.
7. Не прикладывайте пароли, токены, приватные конфиги и пользовательские миры к issue.

Документация: [архитектура](docs/ARCHITECTURE.md), [контракт провайдера](docs/PROVIDER.md), [брендинг](docs/BRANDING.md). Вклад в материалы Line принимается на условиях [LICENSE](LICENSE); исходные материалы Obsy остаются под MIT (`LICENSES/Obsy-MIT.txt`). Не удаляйте обязательное упоминание Line Launcher | Plus In Plus и сторонние уведомления.
