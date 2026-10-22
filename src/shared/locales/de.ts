import type en from './en';

const catalog = {
  'unlock.keychainReason': 'QRL-Wallet entsperren',
  'common.continue': 'Fortfahren',
  'unlock.title': 'MyQRLWallet entsperren',
  'unlock.account': 'Zu entsperrendes Konto',
  'unlock.password': 'Passwort eingeben',
  'unlock.hide': 'Verbergen',
  'unlock.show': 'Anzeigen',
  'unlock.busy': 'Wird entsperrt...',
  'unlock.submit': 'Entsperren',
  'unlock.touchId': 'Mit Touch ID entsperren',
  'unlock.recovery': 'Passwort vergessen? Wiederherstellungsphrase erneut importieren.',
  'unlock.enterPassword': 'Passwort eingeben.',
  'unlock.noWallet': 'Keine Wallet zum Entsperren vorhanden.',
  'unlock.incorrect': 'Falsches Passwort. Erneut versuchen.',
  'unlock.failed': 'Entsperren fehlgeschlagen. Erneut versuchen.',
  'unlock.biometricFailed': 'Biometrisches Entsperren fehlgeschlagen.',
  'unlock.biometricDisabled': 'Biometrisches Entsperren ist in den Einstellungen deaktiviert.',
  'unlock.biometricUnavailable':
    'Biometrisches Entsperren ist nicht verfügbar. Passwort verwenden.',
  'unlock.biometricPassword': 'Biometrisches Entsperren fehlgeschlagen. Passwort verwenden.',
  'settings.title': 'Einstellungen',
  'settings.windowTitle': 'MyQRLWallet Einstellungen',
  'settings.back': 'Zurück zur Wallet',
  'settings.loading': 'Wird geladen...',
  'settings.loadFailed': 'Einstellungen konnten nicht geladen werden.',
  'settings.saved': 'Gespeichert.',
  'settings.saveFailed': 'Speichern fehlgeschlagen. Erneut versuchen.',
  'settings.removed': 'Konto von diesem Gerät entfernt.',
  'settings.removeFailed': 'Konto konnte nicht entfernt werden.',
  'settings.done': 'Erledigt.',
  'settings.failed': 'Fehlgeschlagen.',
  'settings.registrationRefused': 'Registrierung vom Betriebssystem abgelehnt.',
  'settings.minutes_one': '{{count}} Minute',
  'settings.minutes_few': '{{count}} Minuten',
  'settings.minutes_many': '{{count}} Minuten',
  'settings.minutes_other': '{{count}} Minuten',
  'settings.autolock': 'Zeit bis zur automatischen Sperre',
  'settings.autolockHelp':
    'Nach dieser Zeit ohne Aktivität wird die Wallet gesperrt und das Passwort erneut benötigt.',
  'settings.envOverride':
    'Die Umgebungsvariable QRL_AUTOLOCK_MS legt die Zeit fest (derzeit etwa {{duration}}). Variable entfernen, um die Zeit hier einzustellen.',
  'settings.biometric': 'Biometrische Schnellentsperrung',
  'settings.biometricHelp':
    'Mit dem Gerät entsperren. Das Deaktivieren entfernt den gespeicherten Entsperrschlüssel; das Aktivieren wird beim nächsten Entsperren mit Passwort wirksam.',
  'settings.links': 'qrlconnect://-Links',
  'settings.register': 'Zuständigkeit erneut registrieren',
  'settings.registerHelp':
    'Diese App erneut für qrlconnect://-dApp-Links registrieren, falls eine andere Anwendung sie übernommen hat.',
  'settings.diagnostics': 'Diagnose',
  'settings.logs': 'Protokollordner öffnen',
  'settings.logsHelp':
    'Protokolle enthalten nur Entscheidungen, niemals Schlüssel, Passwörter oder vollständige Adressen.',
  'settings.remove': 'Konto entfernen',
  'settings.removing': 'Wird entfernt...',
  'settings.removeDevice': 'Von diesem Gerät entfernen',
  'settings.removeHelp':
    'Löscht den verschlüsselten Seed des aktiven Kontos dauerhaft von diesem Gerät. Zur Wiederherstellung wird die Wiederherstellungsphrase (oder der Hex-Seed) benötigt. Andere Konten auf diesem Gerät bleiben erhalten. Eine Bestätigung wird angefordert.',
  'error.startTitle': 'MyQRLWallet konnte nicht gestartet werden',
  'error.startHelp':
    'Die App kann nicht fortfahren und wird geschlossen. Bei wiederholtem Auftreten MyQRLWallet neu installieren.',
  'legacy.title': 'QRL v3-Konten',
  'legacy.message':
    'Diese Version verwendet neue 64-Byte-Adressen und einen separaten v3-Wallet-Speicher.',
  'legacy.detail':
    'Vorhandene Wallet-Dateien bleiben erhalten. Wiederherstellungsphrase oder erweiterten Seed importieren, um das v3-Konto zu erstellen. Zur Wiederherstellung einer älteren Sicherung Desktop v1.0.0 öffnen und den Wallet-Export verwenden. Frühere Testnetz-Guthaben werden nicht auf v3 übertragen.',
  'menu.settings': 'Einstellungen...',
  'menu.file': 'Datei',
} satisfies Record<keyof typeof en, string>;

export default catalog;
