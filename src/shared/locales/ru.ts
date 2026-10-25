import type en from './en';

const catalog = {
  'unlock.keychainReason': 'Разблокируйте кошелёк QRL',
  'common.continue': 'Продолжить',
  'unlock.title': 'Разблокировать MyQRLWallet',
  'unlock.account': 'Аккаунт для разблокировки',
  'unlock.password': 'Введите пароль',
  'unlock.hide': 'Скрыть',
  'unlock.show': 'Показать',
  'unlock.busy': 'Разблокировка...',
  'unlock.submit': 'Разблокировать',
  'unlock.touchId': 'Разблокировать с Touch ID',
  'unlock.recovery': 'Забыли пароль? Повторно импортируйте фразу восстановления.',
  'unlock.enterPassword': 'Введите пароль.',
  'unlock.noWallet': 'Нет кошелька для разблокировки.',
  'unlock.incorrect': 'Неверный пароль. Попробуйте снова.',
  'unlock.failed': 'Не удалось разблокировать. Попробуйте снова.',
  'unlock.biometricFailed': 'Не удалось разблокировать с помощью биометрии.',
  'unlock.biometricDisabled': 'Биометрическая разблокировка отключена в настройках.',
  'unlock.biometricUnavailable': 'Биометрическая разблокировка недоступна. Используйте пароль.',
  'unlock.biometricPassword': 'Биометрическая разблокировка не удалась. Используйте пароль.',
  'settings.title': 'Настройки',
  'settings.windowTitle': 'Настройки MyQRLWallet',
  'settings.back': 'Вернуться в кошелёк',
  'settings.loading': 'Загрузка...',
  'settings.loadFailed': 'Не удалось загрузить настройки.',
  'settings.saved': 'Сохранено.',
  'settings.saveFailed': 'Не удалось сохранить. Попробуйте снова.',
  'settings.removed': 'Аккаунт удалён с этого устройства.',
  'settings.removeFailed': 'Не удалось удалить аккаунт.',
  'settings.done': 'Готово.',
  'settings.failed': 'Не удалось выполнить.',
  'settings.registrationRefused': 'Операционная система отклонила регистрацию.',
  'settings.minutes_one': '{{count}} минута',
  'settings.minutes_few': '{{count}} минуты',
  'settings.minutes_many': '{{count}} минут',
  'settings.minutes_other': '{{count}} минуты',
  'settings.autolock': 'Время до автоблокировки',
  'settings.autolockHelp':
    'После этого периода бездействия кошелёк заблокируется и снова потребует пароль.',
  'settings.envOverride':
    'Время задано переменной окружения QRL_AUTOLOCK_MS (сейчас около {{duration}}). Удалите её, чтобы управлять временем здесь.',
  'settings.biometric': 'Быстрая биометрическая разблокировка',
  'settings.biometricHelp':
    'Разблокируйте с помощью устройства. Отключение удаляет сохранённый ключ разблокировки; включение вступит в силу при следующей разблокировке паролем.',
  'settings.links': 'Ссылки qrlconnect://',
  'settings.register': 'Зарегистрировать обработчик заново',
  'settings.registerHelp':
    'Снова назначьте это приложение обработчиком ссылок dApp qrlconnect://, если их перехватило другое приложение.',
  'settings.diagnostics': 'Диагностика',
  'settings.logs': 'Открыть папку журналов',
  'settings.logsHelp': 'Журналы содержат только решения, без ключей, паролей и полных адресов.',
  'settings.remove': 'Удалить аккаунт',
  'settings.removing': 'Удаление...',
  'settings.removeDevice': 'Удалить с этого устройства',
  'settings.removeHelp':
    'Навсегда удаляет зашифрованный сид активного аккаунта с этого устройства. Для восстановления потребуется фраза восстановления (или шестнадцатеричный сид). Другие аккаунты на этом устройстве сохранятся. Потребуется подтверждение.',
  'error.startTitle': 'Не удалось запустить MyQRLWallet',
  'error.startHelp':
    'Приложение не может продолжить работу и будет закрыто. Если это повторяется, переустановите MyQRLWallet.',
  'legacy.title': 'Аккаунты QRL v3',
  'legacy.message':
    'Эта версия использует новые 64-байтовые адреса и отдельное хранилище кошельков v3.',
  'legacy.detail':
    'Прежние файлы кошельков сохранены. Импортируйте фразу восстановления или расширенный сид, чтобы создать аккаунт v3. Для восстановления прежней резервной копии откройте Desktop v1.0.0 и воспользуйтесь экспортом кошелька. Прежние балансы тестовой сети не переносятся в v3.',
  'menu.settings': 'Настройки...',
  'menu.file': 'Файл',
} satisfies Record<keyof typeof en, string>;

export default catalog;
