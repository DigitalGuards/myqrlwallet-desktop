import type en from './en';

const catalog = {
  'unlock.phraseLabel': 'Frase personal',
  'unlock.phraseHelp':
    'MyQRLWallet solo te pide la contraseña en una ventana que muestra esta frase.',
  'unlock.phraseLoading': 'Cargando frase personal...',
  'unlock.phraseUnavailable':
    'No se pudo cargar tu frase personal. Cierra MyQRLWallet y vuelve a abrirlo.',
  'settings.phraseHelp':
    'Busca esta frase en la ventana de desbloqueo antes de introducir tu contraseña.',
  'settings.phraseRandom': 'Elegir una nueva frase aleatoria',
  'settings.phraseCustom': 'Tu propia frase',
  'settings.phraseRules':
    'Usa de 3 a 64 caracteres: letras o números, separados por un solo espacio o guion.',
  'settings.phraseSave': 'Guardar frase',
  'unlock.keychainReason': 'Desbloquea tu billetera QRL',
  'common.continue': 'Continuar',
  'unlock.title': 'Desbloquear MyQRLWallet',
  'unlock.account': 'Cuenta que desbloquear',
  'unlock.password': 'Introduce la contraseña',
  'unlock.hide': 'Ocultar',
  'unlock.show': 'Mostrar',
  'unlock.busy': 'Desbloqueando...',
  'unlock.submit': 'Desbloquear',
  'unlock.touchId': 'Desbloquear con Touch ID',
  'unlock.recovery': '¿Olvidaste la contraseña? Vuelve a importar tu frase de recuperación.',
  'unlock.enterPassword': 'Introduce tu contraseña.',
  'unlock.noWallet': 'No hay ninguna billetera que desbloquear.',
  'unlock.incorrect': 'Contraseña incorrecta. Inténtalo de nuevo.',
  'unlock.failed': 'No se pudo desbloquear. Inténtalo de nuevo.',
  'unlock.biometricFailed': 'No se pudo desbloquear con biometría.',
  'unlock.biometricDisabled': 'El desbloqueo biométrico está desactivado en Ajustes.',
  'unlock.biometricUnavailable': 'El desbloqueo biométrico no está disponible. Usa tu contraseña.',
  'unlock.biometricPassword': 'No se pudo desbloquear con biometría. Usa tu contraseña.',
  'settings.title': 'Ajustes',
  'settings.windowTitle': 'Ajustes de MyQRLWallet',
  'settings.back': 'Volver a la billetera',
  'settings.loading': 'Cargando...',
  'settings.loadFailed': 'No se pudieron cargar los ajustes.',
  'settings.saved': 'Guardado.',
  'settings.saveFailed': 'No se pudo guardar. Inténtalo de nuevo.',
  'settings.removed': 'Cuenta eliminada de este dispositivo.',
  'settings.removeFailed': 'No se pudo eliminar la cuenta.',
  'settings.done': 'Hecho.',
  'settings.failed': 'Error.',
  'settings.registrationRefused': 'El sistema operativo rechazó el registro.',
  'settings.minutes_one': '{{count}} minuto',
  'settings.minutes_few': '{{count}} minutos',
  'settings.minutes_many': '{{count}} minutos',
  'settings.minutes_other': '{{count}} minutos',
  'settings.autolock': 'Tiempo de bloqueo automático',
  'settings.autolockHelp':
    'La billetera se bloquea y vuelve a pedir tu contraseña tras este tiempo de inactividad.',
  'settings.envOverride':
    'La variable de entorno QRL_AUTOLOCK_MS fija el tiempo (actualmente unos {{duration}}). Elimínala para gestionar el tiempo aquí.',
  'settings.biometric': 'Desbloqueo rápido biométrico',
  'settings.biometricHelp':
    'Desbloquea con tu dispositivo. Al desactivar esta opción se elimina la clave de desbloqueo guardada; al activarla, se aplica la próxima vez que desbloquees con contraseña.',
  'settings.links': 'Enlaces qrlconnect://',
  'settings.register': 'Volver a registrar el controlador',
  'settings.registerHelp':
    'Vuelve a asignar a esta aplicación los enlaces qrlconnect:// de dApps si otra aplicación se hizo cargo de ellos.',
  'settings.diagnostics': 'Diagnóstico',
  'settings.logs': 'Abrir carpeta de registros',
  'settings.logsHelp':
    'Los registros solo contienen decisiones, nunca claves, contraseñas ni direcciones completas.',
  'settings.remove': 'Eliminar cuenta',
  'settings.removing': 'Eliminando...',
  'settings.removeDevice': 'Eliminar de este dispositivo',
  'settings.removeHelp':
    'Elimina permanentemente la semilla cifrada de la cuenta activa de este dispositivo. Necesitarás la frase de recuperación (o la semilla hexadecimal) para restaurarla. Las demás cuentas de este dispositivo se conservan. Se te pedirá confirmación.',
  'error.startTitle': 'MyQRLWallet no pudo iniciarse',
  'error.startHelp':
    'La aplicación no puede continuar y se cerrará. Si el problema persiste, vuelve a instalar MyQRLWallet.',
  'legacy.title': 'Cuentas QRL v3',
  'legacy.message':
    'Esta versión usa nuevas direcciones de 64 bytes y un almacenamiento separado para las billeteras v3.',
  'legacy.detail':
    'Tus archivos anteriores de billetera se conservan. Importa tu frase de recuperación o semilla extendida para crear su cuenta v3. Para recuperar una copia anterior, abre Desktop v1.0.0 y usa su exportación de billetera. Los saldos anteriores de la red de prueba no se transfieren a v3.',
  'menu.settings': 'Ajustes...',
  'menu.file': 'Archivo',
} satisfies Record<keyof typeof en, string>;

export default catalog;
