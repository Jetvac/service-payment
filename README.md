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
- ручные и автоматические списания по календарному расписанию;
- отдельные журналы зачислений и списаний;
- отмена зачислений и списаний через корректирующую обратную операцию;
- Telegram webhook или polling для `/pay`, `/deposit`, `/balance`, `/services`, `/help`;
- кнопки команд в личке Telegram и настройка бота из интерфейса;
- поддержка Telegram-топиков в группе через админ-команду `/settopic`;
- уведомления о низком остатке и общая сводка остатков после списания сервиса.

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

## Telegram

Webhook endpoint отображается в разделе Telegram. Для Telegram Bot API его нужно установить как:

```text
https://your-domain.example/api/telegram/webhook/<secret>
```

Пользователю в интерфейсе задаётся Telegram ID. Команда `/pay 600` зачисляет сумму в основной валюте сервиса, конвертирует её в общий RUB-баланс пользователя и не выполняется, если пополнение через бота заблокировано у участника. Команда `/services` показывает все подключённые сервисы пользователя и сколько списывается с него за период.

В разделе Telegram после сохранения настроек нажмите `Webhook`: приложение зарегистрирует webhook URL и команды `/pay`, `/deposit`, `/balance`, `/services`, `/help` в личке бота, а также `/settopic` для групп. Для локального `localhost` Telegram не сможет доставлять webhook-события без публичного туннеля или домена.

Если приложение запущено локально или webhook недоступен снаружи, нажмите `Polling`. В этом режиме приложение удалит webhook у Telegram и будет само забирать новые сообщения через `getUpdates`.

Чтобы направить общие уведомления в топик группы, отметьте нужного участника администратором бота в списке пользователей, затем отправьте `/settopic` прямо в нужном Telegram-топике. Бот сохранит `Chat ID` и `Topic ID`; после каждого списания по сервису в этот топик уйдёт список участников с текущими остатками, а уведомления о малом остатке будут пинговать конкретных пользователей там же.
