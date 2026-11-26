<div align="center">
  <img src="docs/assets/readme-hero.svg" alt="dokploy-infisical — безопасный перенос секретов между Dokploy и Infisical" width="100%">

  <br>

  [![CI](https://github.com/sadrozzy/dokploy-infisical/actions/workflows/ci.yml/badge.svg)](https://github.com/sadrozzy/dokploy-infisical/actions/workflows/ci.yml)
  [![npm](https://img.shields.io/npm/v/dokploy-infisical.svg)](https://www.npmjs.com/package/dokploy-infisical)
  [![Лицензия: MIT](https://img.shields.io/badge/лицензия-MIT-22c55e.svg)](LICENSE)

  [English](README.md) · **Русский**
</div>

## Что это

`dokploy-infisical` — терминальная утилита, которая переносит секреты приложений из Dokploy в Infisical и подключает их обратно через Vault-ссылки.

Вместо ручного копирования значений между двумя панелями вы выбираете проекты, проверяете готовый план и подтверждаете миграцию. До первого изменения программа создаёт зашифрованный снимок для отката, а после переноса повторно проверяет обе системы.

> Это проект сообщества. Он не связан официально с Dokploy или Infisical.

### Когда утилита полезна

- секреты сейчас хранятся прямо в переменных окружения Dokploy;
- Infisical уже настроен как Vault-провайдер в Dokploy;
- нужно перенести несколько проектов без ручной работы и риска пропустить значение;
- важно заранее увидеть изменения и иметь понятный путь назад.

## Как это работает

<p align="center">
  <img src="docs/assets/migration-flow.svg" alt="Схема миграции: Dokploy, проверка плана, зашифрованный снимок, Infisical и Vault-ссылки" width="100%">
</p>

Утилита поддерживает два безопасных сценария:

- **Dokploy → Infisical** — переносит исходные значения в `/<project>/_shared` или `/<project>/<service>`, затем заменяет их в Dokploy на Vault-ссылки.
- **Infisical → Dokploy** — добавляет недостающие Vault-ссылки из существующей структуры папок. Открытые значения из Infisical обратно не копируются.

## Быстрый старт

### 1. Установите

**Homebrew** — автономный бинарный файл, Node.js и Bun не нужны:

```bash
brew install sadrozzy/tap/dokploy-infisical
```

Или установите из npm registry:

```bash
npm install -g dokploy-infisical
```

Для npm и pnpm нужен Node.js 26.4+, для Bun — Bun 1.3.14+.

<details>
<summary>Другие команды установки</summary>

```bash
pnpm add -g dokploy-infisical
# или
bun add -g dokploy-infisical
```

</details>

Поддерживаются macOS и Linux на arm64 и x64.

### 2. Подготовьте доступы

Понадобятся:

- URL и API-токен Dokploy;
- URL Infisical;
- Client ID и Client Secret от Infisical Machine Identity с Universal Auth;
- ID проекта и slug окружения Infisical;
- имя уже настроенного Vault-провайдера Dokploy.

Vault-провайдер должен быть заранее назначен проектам и окружениям, которые вы собираетесь переносить.

### 3. Запустите

```bash
dokploy-infisical
```

При первом запуске мастер попросит доступы, проверит соединения и покажет проекты. Дальше: выберите сценарий → отметьте проекты или сервисы → проверьте план → подтвердите перенос.

![Выбор проектов и сервисов](docs/screenshots/project-selection.svg)

## Что защищает миграцию

| Механизм | Что он даёт |
| --- | --- |
| План до записи | Показывает количество секретов, замен, конфликтов и предупреждений до применения |
| Зашифрованный снимок | Создаётся до первого изменения и шифруется AES-256-GCM |
| Автоматический откат | Запускается, если запись завершилась ошибкой |
| Повторная проверка | После миграции обе системы читаются заново |
| Безопасный повторный запуск | Существующие `${{vault.*}}` не изменяются и не превращаются в открытый текст |
| Отдельный redeploy | Никогда не запускается автоматически и требует подтверждения |

Программа не выводит значения секретов в терминал. Пароль восстановления не сохраняется.

## Настройки и учётные данные

Несекретные настройки сохраняются в:

```text
~/.config/dokploy-infisical/config.json
```

На macOS учётные данные хранятся в Keychain. На Linux передайте их через окружение:

```bash
export DOKPLOY_API_KEY="..."
export INFISICAL_CLIENT_ID="..."
export INFISICAL_CLIENT_SECRET="..."
dokploy-infisical
```

Вместо `DOKPLOY_API_KEY` можно использовать `DOKPLOY_AUTH_TOKEN`.

## Откат

Зашифрованные снимки хранятся в:

```text
~/.local/share/dokploy-infisical/migrations/<migration-id>.json.enc
```

Откат можно выбрать в главном меню или запустить напрямую:

```bash
dokploy-infisical rollback <migration-id>
```

Ручной откат восстанавливает значения, но не перезапускает сервисы.

## Справочник

### Команды

```text
dokploy-infisical
dokploy-infisical rollback <migration-id>
dokploy-infisical --help
dokploy-infisical --version
```

### Клавиши

| Клавиши | Действие |
| --- | --- |
| `↑` / `↓`, `j` / `k` | Перемещение |
| `←` / `→` | Свернуть или раскрыть проект |
| `space` / `enter` | Выбрать проект или сервис |
| `a` | Выбрать или снять все проекты |
| `tab` | Перейти к кнопке продолжения |
| `m` | Открыть проверку миграции |
| `esc` | Вернуться назад |
| `q` | Выйти |

<details>
<summary>Полная последовательность миграции</summary>

1. Проверяются соединения с Dokploy, Infisical и Vault-провайдером.
2. Вы выбираете проекты или отдельные сервисы.
3. Утилита разрешает проектные ссылки Dokploy и строит предварительный план.
4. Вы проверяете секреты, замены, конфликты и предупреждения.
5. Создаётся зашифрованный снимок отката.
6. В Infisical создаются папки и секреты.
7. Значения Dokploy заменяются на Vault-ссылки.
8. Обе системы читаются повторно, результат проверяется.
9. При необходимости redeploy подтверждается отдельным действием.

</details>

## Обновление и удаление

| Менеджер | Обновление | Удаление |
| --- | --- | --- |
| npm | `npm update -g dokploy-infisical` | `npm uninstall -g dokploy-infisical` |
| pnpm | `pnpm update -g dokploy-infisical` | `pnpm remove -g dokploy-infisical` |
| Bun | `bun update -g dokploy-infisical` | `bun remove -g dokploy-infisical` |
| Homebrew | `brew upgrade sadrozzy/tap/dokploy-infisical` | `brew uninstall dokploy-infisical` |

Удаление программы не удаляет конфигурацию, записи Keychain и зашифрованные снимки.

## Разработка

```bash
bun install
bun run start
```

```bash
bun run check
bun run test:runtimes
bun run test:install
bun run screenshots
```

Скриншоты генерируются из настоящих OpenTUI-компонентов без секретов и производственных данных. CI проверяет типы, движок миграции, TUI, оба runtime, нативную сборку и установку упакованного npm-архива на macOS и Linux.

Инструкции по выпуску находятся в [релизном чек-листе](docs/RELEASING.md).

## Лицензия

[MIT](LICENSE)
