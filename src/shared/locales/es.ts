import type en from './en';

const catalog = {
  'unlock.keychainReason': 'Desbloquea tu billetera QRL',
  'common.cancel': 'Cancelar',
  'common.next': 'Siguiente',
  'common.continue': 'Continuar',
  'common.ok': 'Aceptar',
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
  'confirm.approve': 'Aprobar y firmar',
  'confirm.approvalNote': 'Aprueba solo si iniciaste esta acción y los datos son correctos.',
  'confirm.request': 'Solicitud {{number}}',
  'confirm.page': 'Solicitud {{number}}, página {{page}} de {{pages}}',
  'confirm.origin': 'Solicitud de dApp (sin verificar, datos de la dApp):',
  'confirm.name': 'Nombre:',
  'confirm.url': 'URL:',
  'confirm.channel': 'Canal:',
  'confirm.absent': '(no proporcionado)',
  'confirm.initiated': 'Aprueba solo si iniciaste esta acción en esa dApp.',
  'confirm.renderer': 'Solicitud de: interfaz de la billetera (origen de dApp no proporcionado)',
  'confirm.account': 'Cuenta:',
  'confirm.scheme': 'Esquema:',
  'confirm.signing': 'Firma de:',
  'confirm.domain': 'Dominio {{field}}:',
  'confirm.walletChain': 'chainId de la red de la billetera: {{chainId}}',
  'confirm.chainMismatch':
    'ADVERTENCIA: el chainId del dominio difiere del de la red de la billetera.',
  'confirm.chainUnbound':
    'ADVERTENCIA: esta firma no está vinculada a una cadena y puede reutilizarse en otras cadenas.',
  'confirm.primaryType': 'Tipo principal:',
  'confirm.fields': 'Campos del mensaje:',
  'confirm.messageText': 'Mensaje (texto, {{bytes}} bytes):',
  'confirm.messageHex': 'Mensaje (hex, {{bytes}} bytes):',
  'confirm.empty': '(mensaje vacío)',
  'confirm.bytes': '{{count}} bytes',
  'confirm.characters': '{{count}} caracteres',
  'confirm.amount': 'Importe:',
  'confirm.to': 'Para:',
  'confirm.from': 'De:',
  'confirm.nonce': 'Nonce:',
  'confirm.gas': 'Límite de gas:',
  'confirm.fee': 'Comisión máx.:',
  'confirm.cost': 'Coste máx.:',
  'confirm.chain': 'ID de cadena:',
  'confirm.data': 'Datos:',
  'confirm.none': '(ninguno)',
  'confirm.feeValue': '{{fee}} (hasta {{perGas}} por gas, prioridad {{priority}})',
  'confirm.estimate': '{{gas}} (estimación de esta billetera)',
  'confirm.dappGas': '{{gas}} (fijado por la dApp; estimación de la billetera {{estimate}})',
  'confirm.walletGas': '{{gas}} (estimación de esta billetera; la dApp pidió {{requested}})',
  'confirm.cappedGas':
    '{{gas}} (limitado al gas del bloque; la dApp pidió {{requested}}, estimación de la billetera {{estimate}})',
  'confirm.feeUnknown':
    'NOTA: esta billetera no preparó los campos de comisión, por lo que desconoce cómo se eligió este límite de gas.',
  'confirm.refund':
    'El gas no utilizado se reembolsa, pero una llamada que falla por falta de gas o lo consume puede agotar todo el límite, por lo que el coste indicado puede alcanzarse.',
  'confirm.blockWarning':
    'ADVERTENCIA: este límite de gas supera una décima parte de un bloque completo. {{refund}}',
  'confirm.gasWarning':
    'ADVERTENCIA: la dApp pidió mucho más gas del estimado por esta billetera. {{refund}} Aprueba solo si sabes por qué esta llamada necesita tanto.',
  'confirm.transactionTitle': 'Confirmar transacción',
  'confirm.send': '¿Enviar {{amount}}?\nCoste máx. {{cost}}.',
  'confirm.messageTitle': 'Confirmar firma de mensaje',
  'confirm.messageQuestion': '¿Firmar este mensaje con la clave de tu billetera?',
  'confirm.typedTitle': 'Confirmar firma de datos estructurados',
  'confirm.typedQuestion': '¿Firmar estos datos estructurados con la clave de tu billetera?',
  'remove.button': 'Eliminar billetera',
  'remove.title': '¿Eliminar la billetera de este dispositivo?',
  'remove.question': '¿Eliminar permanentemente esta billetera de este dispositivo?',
  'remove.warning':
    'La semilla cifrada se eliminará de este dispositivo. Solo podrás restaurar la billetera con tu frase de recuperación. Esta acción es irreversible.',
  'error.metadata':
    'Los detalles de seguridad de los datos estructurados exceden el límite de visualización. Acorta los metadatos del origen de la dApp o del dominio.',
  'error.typedLong':
    'La solicitud de datos estructurados es demasiado grande para revisarla de forma segura en escritorio (máximo {{pages}} páginas).',
  'error.messageLong':
    'mensaje demasiado largo para revisarlo en el diálogo de confianza (máximo {{pages}} páginas).',
  'error.lockedConfirm':
    'La billetera se bloqueó durante la confirmación. Desbloquéala e inténtalo de nuevo.',
  'error.busyConfirm': 'ya hay otra confirmación abierta',
  'error.navigatedConfirm':
    'La ventana de la billetera se recargó o cambió de página durante la confirmación. Inténtalo de nuevo.',
  'error.stoppedConfirm':
    'La interfaz de la billetera se detuvo durante la confirmación. Inténtalo de nuevo.',
  'error.languageConfirm':
    'El idioma cambió durante la confirmación. Revisa la solicitud de nuevo.',
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
