// KeychainHelper: a tiny Swift CLI that stores the wallet KEK in the macOS
// Keychain behind a user-presence (Touch ID / passcode) gate, with the item
// bound to this app's code signature.
//
// Why this exists: keytar is archived and never supported access-control
// flags, and @napi-rs/keyring only writes plain generic-password items without
// surfacing SecAccessControl. So src/keyvault/macKeychainVault.ts shells out to
// this binary, which calls the Security.framework primitives directly.
//
// Designated Requirement (DR) binding: for a Keychain item created by a signed
// app, macOS AUTOMATICALLY records the creating app's Designated Requirement
// and denies read access to any other app whose signature does not match
// (Apple Technical Note TN2206). We therefore do NOT set kSecAttrAccessGroup
// and do NOT add any explicit ACL application list: the default app-bound
// behaviour is exactly what we want. The .userPresence flag layered on top is
// the added Touch ID / passcode gate enforced on every read.
//
// This only works reliably in a properly codesigned + notarized build. In an
// unsigned dev run the DR is empty / ad-hoc and the prompts/binding are not
// trustworthy, which is why the TS vault reports itself unavailable unless the
// app is signed.
//
// Protocol (KEK transferred as hex on stdin/stdout so it never appears in argv
// or process listings):
//   store  <service> <account>           reads kek-hex from stdin  -> "ok"
//   get    <service> <account> <reason>  prints kek-hex on stdout  (prompts)
//   has    <service> <account>           -> "yes" | "no"
//   delete <service> <account>           -> "ok"
// Exit code 0 on success; non-zero with a short stderr message otherwise.

import Foundation
import Security
import LocalAuthentication

// Print a short message to stderr and exit non-zero.
func fail(_ message: String) -> Never {
    FileHandle.standardError.write(Data((message + "\n").utf8))
    exit(1)
}

// Read all of stdin as a UTF-8 string (used to receive the KEK hex for store).
func readStdin() -> String {
    let data = FileHandle.standardInput.readDataToEndOfFile()
    return String(decoding: data, as: UTF8.self)
        .trimmingCharacters(in: .whitespacesAndNewlines)
}

func baseQuery(service: String, account: String) -> [String: Any] {
    return [
        kSecClass as String: kSecClassGenericPassword,
        kSecAttrService as String: service,
        kSecAttrAccount as String: account,
    ]
}

func doStore(service: String, account: String) -> Never {
    let kekHex = readStdin()
    if kekHex.isEmpty {
        fail("store: empty KEK on stdin")
    }
    guard let valueData = kekHex.data(using: .utf8) else {
        fail("store: could not encode KEK")
    }

    // Build the access control: item is usable only while the device is
    // unlocked, never migrates to another device or backup
    // (kSecAttrAccessibleWhenUnlockedThisDeviceOnly), and every access requires
    // user presence (Touch ID, Apple Watch, or passcode). Note that
    // kSecAttrAccessControl and kSecAttrAccessible are mutually exclusive, so we
    // set ONLY the access control below.
    var acError: Unmanaged<CFError>?
    guard let access = SecAccessControlCreateWithFlags(
        kCFAllocatorDefault,
        kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
        .userPresence,
        &acError
    ) else {
        let msg = acError?.takeRetainedValue().localizedDescription ?? "unknown"
        fail("store: SecAccessControlCreateWithFlags failed: \(msg)")
    }

    // Remove any prior item so SecItemAdd does not return errSecDuplicateItem.
    SecItemDelete(baseQuery(service: service, account: account) as CFDictionary)

    var addQuery: [String: Any] = baseQuery(service: service, account: account)
    addQuery[kSecValueData as String] = valueData
    addQuery[kSecAttrAccessControl as String] = access

    let status = SecItemAdd(addQuery as CFDictionary, nil)
    if status != errSecSuccess {
        fail("store: SecItemAdd failed: \(status)")
    }
    print("ok")
    exit(0)
}

func doGet(service: String, account: String, reason: String) -> Never {
    // Provide an authenticated context carrying the prompt reason. Setting
    // kSecUseOperationPrompt (via the LAContext localizedReason) is what
    // triggers the Touch ID / passcode UI for the .userPresence item.
    let context = LAContext()
    context.localizedReason = reason

    var query: [String: Any] = baseQuery(service: service, account: account)
    query[kSecReturnData as String] = true
    query[kSecMatchLimit as String] = kSecMatchLimitOne
    query[kSecUseOperationPrompt as String] = reason
    query[kSecUseAuthenticationContext as String] = context

    var item: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &item)
    if status != errSecSuccess {
        fail("get: SecItemCopyMatching failed: \(status)")
    }
    guard let data = item as? Data,
          let hex = String(data: data, encoding: .utf8) else {
        fail("get: recovered item was not valid UTF-8")
    }
    print(hex)
    exit(0)
}

func doHas(service: String, account: String) -> Never {
    // Existence check only: do NOT return data, so this does not prompt the
    // user for biometrics. errSecInteractionNotAllowed still means present.
    var query: [String: Any] = baseQuery(service: service, account: account)
    query[kSecReturnData as String] = false
    query[kSecMatchLimit as String] = kSecMatchLimitOne
    query[kSecUseAuthenticationUI as String] = kSecUseAuthenticationUISkip

    let status = SecItemCopyMatching(query as CFDictionary, nil)
    if status == errSecSuccess || status == errSecInteractionNotAllowed {
        print("yes")
    } else {
        print("no")
    }
    exit(0)
}

func doDelete(service: String, account: String) -> Never {
    let status = SecItemDelete(baseQuery(service: service, account: account) as CFDictionary)
    if status != errSecSuccess && status != errSecItemNotFound {
        fail("delete: SecItemDelete failed: \(status)")
    }
    print("ok")
    exit(0)
}

let args = CommandLine.arguments
guard args.count >= 2 else {
    fail("usage: qrl-keychain-helper <store|get|has|delete> <service> <account> [reason]")
}

let verb = args[1]
switch verb {
case "store":
    guard args.count >= 4 else { fail("store: usage: store <service> <account>") }
    doStore(service: args[2], account: args[3])
case "get":
    guard args.count >= 5 else { fail("get: usage: get <service> <account> <reason>") }
    doGet(service: args[2], account: args[3], reason: args[4])
case "has":
    guard args.count >= 4 else { fail("has: usage: has <service> <account>") }
    doHas(service: args[2], account: args[3])
case "delete":
    guard args.count >= 4 else { fail("delete: usage: delete <service> <account>") }
    doDelete(service: args[2], account: args[3])
default:
    fail("unknown verb: \(verb)")
}
