# VPN Payment Control

Веб-приложение для контроля равных оплат участников VPN-сервисов.

## Возможности

- сервисы с месячной стоимостью и валютой;
- закрепление участников за сервисами;
- расчёт доли участника за месяц, неделю, день и час;
- общий баланс участника в RUB для всех подключённых сервисов;
- списания могут уводить баланс участника в минус, показывая задолженность;
- денежные операции округляются и отображаются с точностью до 2 знаков;
- ручные пополнения с конвертацией по настроенным курсам;
- ежемесячные автоплатежи участников с настраиваемым числом месяца и суммой;
- ручные и автоматические списания по календарному расписанию;
- отдельные журналы зачислений и списаний;
- отмена зачислений и списаний через корректирующую обратную операцию;
- Telegram webhook или polling для `/pay`, `/deposit`, `/balance`, `/services`, `/users`, `/help`;
- кнопки команд в личке Telegram и настройка бота из интерфейса;
- поддержка Telegram-топиков в группе через админ-команду `/settopic`;
- уведомления о низком остатке и общая сводка остатков после списания сервиса;
- выгрузка и загрузка JSON-backup базы данных;
- обновление приложения из git через интерфейс.

## Запуск

```bash
npm install
npm run dev
```

Клиент будет доступен на `http://localhost:5173`, API на `http://localhost:4077`.

## Production

```bash
npm run build
npm start
```

После сборки backend отдаёт готовый интерфейс на `http://localhost:4077`.

В разделе Telegram есть блок `Система`: кнопки `Скачать БД`, `Загрузить БД` и `Обновить приложение`. На Ubuntu обновление подтягивает raw update-скрипт с GitHub, скачивает публичный архив проекта, пересобирает приложение и на сервере, установленном через deploy-скрипт, перезапускает systemd-сервис.

## Deploy на Ubuntu

В репозитории есть скрипт `scripts/deploy-ubuntu.sh`. Он устанавливает Node.js, клонирует или обновляет `Jetvac/service-payment`, собирает приложение, создаёт systemd-сервис и при необходимости настраивает nginx.

Минимальный запуск на сервере:

```bash
curl -fsSL https://raw.githubusercontent.com/Jetvac/service-payment/main/scripts/deploy-ubuntu.sh | sudo bash
```

С доменом и nginx:

```bash
curl -fsSL https://raw.githubusercontent.com/Jetvac/service-payment/main/scripts/deploy-ubuntu.sh | sudo env DOMAIN=pay.example.com bash
```

С HTTPS через Let's Encrypt:

```bash
curl -fsSL https://raw.githubusercontent.com/Jetvac/service-payment/main/scripts/deploy-ubuntu.sh | sudo env DOMAIN=pay.example.com ENABLE_SSL=true EMAIL=admin@example.com bash
```

Полезные переменные: `APP_DIR=/opt/service-payment`, `PORT=4077`, `BRANCH=main`, `ENABLE_UFW=true`.

## Echo-сервер для замера задержки

Для ручного точечного развёртывания WebSocket echo-сервера на VPN-сервере используйте:

```bash
curl -fsSL https://raw.githubusercontent.com/Jetvac/service-payment/main/scripts/deploy-echo-server.sh | sudo bash
```

Скрипт собирает `LazyDoomSlayer/rust-websocket-server`, устанавливает systemd-сервис `rust-websocket-echo-server.service` и открывает `8765/tcp` в UFW, если UFW активен. В настройках сервиса приложения укажите порт `8765` и путь `/echo`.

## Обновление сервера

Если сервер уже развёрнут, обновить приложение можно без авторизации в GitHub через raw-скрипт:

```bash
curl -fsSL https://raw.githubusercontent.com/Jetvac/service-payment/main/scripts/update-ubuntu.sh | sudo env APP_DIR=/opt/service-payment APP_SERVICE_NAME=service-payment bash
```

Этот скрипт скачивает публичный архив ветки `main`, обновляет файлы приложения, сохраняет `data/db.json`, пересобирает проект, восстанавливает владельца файлов по systemd-сервису и перезапускает сервис. Если приложение развёрнуто под нестандартным пользователем и systemd ещё не знает его, добавьте `APP_USER=servicepay` в `sudo env`.

После одного обновления до версии с новой кнопкой можно пользоваться `Telegram -> Система -> Обновить приложение`. На Ubuntu эта кнопка тоже подтягивает update-скрипт с `https://raw.githubusercontent.com/Jetvac/service-payment` и не требует git-авторизации.

## Telegram

Webhook endpoint отображается в разделе Telegram. Для Telegram Bot API его нужно установить как:

```text
https://your-domain.example/api/telegram/webhook/<secret>
```

Пользователю в интерфейсе задаётся Telegram ID. Команда `/pay 600` зачисляет сумму в основной валюте сервиса, конвертирует её в общий RUB-баланс пользователя и не выполняется, если пополнение через бота заблокировано у участника. Команда `/services` показывает все подключённые сервисы пользователя и сколько списывается с него за период. Команда `/users` доступна только администратору бота и показывает пользователей с остатками по сервисам.

В разделе Telegram после сохранения настроек нажмите `Webhook`: приложение зарегистрирует webhook URL и команды `/pay`, `/deposit`, `/balance`, `/services`, `/users`, `/help` в личке бота, а также `/settopic` и `/users` для групп. Для локального `localhost` Telegram не сможет доставлять webhook-события без публичного туннеля или домена.

Если приложение запущено локально или webhook недоступен снаружи, нажмите `Polling`. В этом режиме приложение удалит webhook у Telegram и будет само забирать новые сообщения через `getUpdates`.

Чтобы направить общие уведомления в топик группы, отметьте нужного участника администратором бота в списке пользователей, затем отправьте `/settopic` прямо в нужном Telegram-топике. Бот сохранит `Chat ID` и `Topic ID`; после каждого списания по сервису в этот топик уйдёт список участников с текущими остатками, а уведомления о малом остатке будут пинговать конкретных пользователей там же.
