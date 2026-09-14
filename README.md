# QueryCraft

Быстрый кроссплатформенный десктопный клиент MySQL в духе DataGrip. macOS, Windows, Linux.

Стек: Tauri 2 (Rust, `mysql_async`) + React 19 / TypeScript, CodeMirror 6, виртуализированный грид.
Подробнее об архитектуре и составе MVP — в [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Возможности (MVP)

- Подключения к MySQL: создание, проверка, редактирование; пароли хранятся в системном keyring (Keychain / Credential Manager / Secret Service).
- Проводник БД: базы → таблицы и представления → колонки, индексы, внешние ключи. Ленивая загрузка, фильтр, контекстные меню.
- SQL-консоль с подсветкой и автодополнением по схеме: выполнение текущего выражения (⌘/Ctrl+Enter), выделения или всего скрипта (⌘/Ctrl+Shift+Enter), отмена запроса, несколько результатов, время выполнения.
- Каждая консоль и вкладка данных работает в своём соединении: `USE`, транзакции и временные таблицы живут в рамках вкладки.
- Грид результатов: виртуализация строк и колонок, сортировка, копирование, экспорт в CSV / JSON / TSV / SQL INSERT.
- Данные таблицы: фильтр `WHERE`, сортировка, пагинация, редактирование ячеек, добавление и удаление строк с отложенной фиксацией (Submit / Revert) в транзакции.
- DDL таблицы (`SHOW CREATE TABLE`).
- Тёмная и светлая темы.

## Разработка

Требования: Rust (stable), Node.js 20+, pnpm, системные зависимости Tauri (см. https://tauri.app/start/prerequisites/).

```bash
pnpm install
pnpm tauri dev        # запуск в режиме разработки
pnpm tauri build      # сборка установщика для текущей ОС
pnpm test             # unit-тесты фронтенда (vitest)
pnpm typecheck        # tsc --noEmit
cd src-tauri && cargo test   # unit-тесты бэкенда
```

Интеграционные тесты бэкенда против живого MySQL (пропускаются без переменной окружения):

```bash
cd src-tauri && QUERYCRAFT_TEST_DSN="127.0.0.1:33070:root:secret" cargo test --test live_mysql
```

UI можно разрабатывать в обычном браузере без Tauri: `pnpm dev` и открыть http://localhost:1420 —
команды IPC обслуживает мок (`src/api/mock.ts`) с фиктивными подключениями и данными.

Тестовая база для разработки:

```bash
docker run -d --name querycraft-mysql -p 33070:3306 -e MYSQL_ROOT_PASSWORD=secret mysql:8.0
```

## Структура

```
src-tauri/   Rust-бэкенд: команды Tauri, пул соединений, выполнение SQL, метаданные схемы
src/         React-фронтенд: api (контракт IPC), store (zustand), lib (чистые функции + тесты), components
docs/        Архитектура
```
