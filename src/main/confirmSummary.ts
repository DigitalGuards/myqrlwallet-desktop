/**
 * The text the trusted confirmation window shows, computed as a pure function
 * of the validated signature request and of what main remembers about building
 * it.
 *
 * This lives apart from `confirm.ts` deliberately: `confirm.ts` imports
 * Electron to draw the dialog, while WHAT the user is asked to approve is the
 * security-relevant part and must be testable on its own.
 *
 * The transaction itself is renderer-supplied, so this module states the
 * numbers that will be signed and says where they came from. Main's own build
 * record is the only wallet-computed input here; when one is missing, the
 * summary says so plainly.
 */
import type { DAppOrigin, SignatureRequest } from '../shared/schemas';
import type { GasBuildRecord } from './buildRecords';
import { groupQrlAddress } from '../shared/address';
import { isArray, isRecord } from '../shared/guards';
import {
  parseFieldType,
  parseIntValue,
  typedDataSchemeVersion,
  type TypeMap,
  type TypedDataPayload,
} from '../shared/typedData';

const DECIMALS = 18n;

/** Conservative width shared by every trusted confirmation detail line. */
export const DETAIL_LINE_COLUMNS = 48;

/** Format a smallest-unit integer string as Quanta (18 decimals), trimmed. */
export function formatQuanta(smallestUnit: string | bigint): string {
  const v = typeof smallestUnit === 'bigint' ? smallestUnit : BigInt(smallestUnit);
  const base = 10n ** DECIMALS;
  const whole = v / base;
  const frac = v % base;
  if (frac === 0n) return `${whole.toString()} Quanta`;
  const fracStr = frac.toString().padStart(18, '0').replace(/0+$/, '');
  return `${whole.toString()}.${fracStr} Quanta`;
}

/** Label column width, so every detail line stays aligned in the dialog. */
const LABEL_WIDTH = 11;
const row = (label: string, value: string): string => `${label.padEnd(LABEL_WIDTH)}${value}`;

/**
 * How far above the wallet's own estimate a dApp-requested gas limit may go
 * before the dialog warns about it: four times the estimate, or the estimate
 * plus a flat million gas, whichever is higher.
 *
 * The flat term keeps ordinary settlement headroom quiet. QuantaSwap's HTLCv3
 * claim asks for `estimateGas + 250000`, which stays inside the allowance at
 * every realistic estimate size. The multiplicative term catches a large
 * request on a large estimate, where a flat million would be noise.
 */
export function gasWarningThreshold(estimated: bigint): bigint {
  const multiplied = estimated * 4n;
  const flat = estimated + 1_000_000n;
  return multiplied > flat ? multiplied : flat;
}

/**
 * Render the dApp provenance block for a request that arrived over a
 * dApp-connect session. The values are renderer-supplied (ultimately from the
 * dApp's ORIGINATOR_INFO), so they are labelled unverified: they tell the
 * user WHO CLAIMS to be asking. Schema length caps bound the metadata; escaping keeps
 * URL whitespace and direction marks visible inside labelled, wrapped rows.
 */
export function originDetail(origin: DAppOrigin | undefined): string {
  if (!origin) return '';
  return wrapDetailText(
    [
      '',
      'Requested by dApp (unverified, dApp-supplied):',
      wrapDetailText(`  Name:    ${singleLineText(origin.name)}`, 'dapp'),
      origin.url
        ? wrapDetailText(`  URL:     ${singleLineText(origin.url)}`, 'dapp')
        : '  URL:     (not provided)',
      wrapDetailText(`  Channel: ${origin.channelId}`, 'dapp'),
      'Only approve if you initiated this action in that dApp.',
    ].join('\n'),
  );
}

export interface ConfirmSummary {
  title: string;
  message: string;
  pages: string[];
}

/** What main knows beyond the request itself when it draws the confirmation. */
export interface ConfirmContext {
  /** Main's record of building this exact transaction, when it still holds one. */
  build?: GasBuildRecord | undefined;
  /** The latest block's gas limit, already read on the transaction path. */
  blockGasLimit?: bigint | undefined;
  /** The network identity pinned by main, independent of renderer input. */
  connectedChainId?: number | undefined;
}

/**
 * Thirty explicit lines leave room for the native title, message and buttons
 * within roughly 700 logical pixels at common desktop font sizes. The budget
 * includes the approval note appended by confirm.ts. Native font metrics vary.
 */
export const TYPED_DATA_DISPLAY_LIMITS = {
  lines: 30,
  lineChars: DETAIL_LINE_COLUMNS,
  pages: 10,
  valueChars: 64,
  labelChars: 80,
} as const;

export const SIGNATURE_APPROVAL_NOTE =
  'Approve only if you initiated this and the details are correct.';

const TYPED_METADATA_ERROR =
  'Typed-data security details exceed the confirmation display limit. Shorten the dApp origin or domain metadata.';

/** Full metadata must fit on page one. Bound escaping before measuring it. */
function fullTypedText(value: string): string {
  const maxChars = TYPED_DATA_DISPLAY_LIMITS.lines * DETAIL_LINE_COLUMNS;
  if (value.length > maxChars) throw new Error(TYPED_METADATA_ERROR);
  const escaped = singleLineText(value.slice(0, maxChars));
  if (escaped.length > maxChars) throw new Error(TYPED_METADATA_ERROR);
  return escaped;
}

// Printable ASCII advances above 0.8 em in DejaVu Sans 2.37 (hmtx / unitsPerEm).
// Include OQGDHNU&: hinting can round their advances past a single column.
const WIDE_ASCII = '#%&+<=>@DGHMNOQUW^mw~';
// DejaVuSans.ttf 2.37, fontTools getBestCmap(): hmtx advance / unitsPerEm > 1.27.
// These 27 inclusive ranges contain 96 non-ASCII code points. U+20A7/U+20AF
// are 1.27246 em (exactly two digit widths), so they also pass this cutoff.
// Font-specific glyphs can still exceed this conservative model.
const THREE_COLUMN_RANGES = [
  [0x01c4, 0x01c5],
  [0x01f1, 0x01f2],
  [0x1670, 0x1676],
  [0x1685, 0x1685],
  [0x168a, 0x168a],
  [0x168f, 0x168f],
  [0x1694, 0x1694],
  [0x2030, 0x2031],
  [0x20a7, 0x20a7],
  [0x20af, 0x20af],
  [0x2152, 0x2152],
  [0x2167, 0x2167],
  [0x22d8, 0x22d9],
  [0x2326, 0x2326],
  [0x2328, 0x2328],
  [0x232b, 0x232b],
  [0x27f5, 0x27ff],
  [0x2a0c, 0x2a0c],
  [0xa66c, 0xa66c],
  [0xa698, 0xa698],
  [0xa74e, 0xa74e],
  [0xfb17, 0xfb17],
  [0xfeb2, 0xfeb2],
  [0xfeb6, 0xfeb6],
  [0x1030c, 0x1030c],
  [0x1f030, 0x1f061],
  [0x1f634, 0x1f634],
] as const;
// Main fixes each dApp line's paragraph direction; supplied marks are escaped.
const LEFT_TO_RIGHT_MARK = '\u200e';

export function displayWidth(value: string): number {
  let width = 0;
  for (const char of value) {
    const point = char.codePointAt(0);
    if (point === undefined || char === LEFT_TO_RIGHT_MARK) continue;
    if (point <= 0x7f) {
      width += WIDE_ASCII.includes(char) ? 2 : 1;
    } else {
      width += THREE_COLUMN_RANGES.some(([start, end]) => point >= start && point <= end) ? 3 : 2;
    }
  }
  return width;
}

/**
 * Escapes and Unicode code points are indivisible during wrapping and preview
 * truncation. Literal backslashes have already been escaped by the formatter.
 */
function* displayTokens(value: string): Generator<string> {
  for (const match of value.matchAll(/\\(?:u\{[0-9a-f]+\}|u[0-9a-f]{4}|.)|./gu)) {
    yield match[0];
  }
}

/**
 * Wrap trusted text with a plain indent. Callers must first wrap rows containing
 * dApp text with source 'dapp', anchoring each line left-to-right and keeping
 * their continuations behind a pipe.
 * Prefer word boundaries and preserve every character, including boundary spaces.
 * Already wrapped rows fit the width and pass through unchanged during assembly.
 */
export function wrapDetailText(detail: string, source: 'trusted' | 'dapp' = 'trusted'): string {
  const lineStart = source === 'dapp' ? LEFT_TO_RIGHT_MARK : '';
  const continuation = source === 'dapp' ? `${lineStart}    | ` : '    ';
  const lines: string[] = [];
  for (const original of detail.split('\n')) {
    let prefix = lineStart;
    let content = '';
    let used = 0;
    for (const token of displayTokens(original)) {
      const width = displayWidth(token);
      if (used + width > DETAIL_LINE_COLUMNS) {
        const boundary = content.lastIndexOf(' ') + 1;
        const end =
          boundary > 0 &&
          displayWidth(continuation + content.slice(boundary) + token) <= DETAIL_LINE_COLUMNS
            ? boundary
            : content.length;
        lines.push(prefix + content.slice(0, end));
        content = content.slice(end);
        prefix = continuation;
        used = displayWidth(prefix + content);
      }
      content += token;
      used += width;
    }
    lines.push(prefix + content);
  }
  return lines.join('\n');
}

/** Count the exact code-wrapped lines, including blank lines and markers. */
export function typedDataDisplayLines(detail: string): number {
  return wrapDetailText(detail).split('\n').length;
}

/** Escape invisible marks and known ultra-wide glyphs for reversible, bounded rows. */
function singleLineText(value: string): string {
  return JSON.stringify(value)
    .slice(1, -1)
    .replace(
      /[\p{Cc}\p{Cf}\p{Co}\p{Cn}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}\u2800\u2e3a-\u2e3b\ufdfa-\ufdfd\u{12000}-\u{1254f}]/gu,
      (char) => {
        const point = char.codePointAt(0);
        if (point === undefined) return char;
        return point > 0xffff ||
          (point >= 0x2e3a && point <= 0x2e3b) ||
          (point >= 0xfdfa && point <= 0xfdfd)
          ? `\\u{${point.toString(16)}}`
          : `\\u${point.toString(16).padStart(4, '0')}`;
      },
    );
}

/** Message quotes stay literal; backslashes and invisible characters stay reversible. */
function escapeMessageCharacter(char: string): string {
  return char === '"' ? char : singleLineText(char);
}

// The gutter separates every untrusted body row from account labels and approval notes.
const MESSAGE_BODY_GUTTER = `${LEFT_TO_RIGHT_MARK}| `;
const MESSAGE_BODY_COLUMNS = DETAIL_LINE_COLUMNS - displayWidth(MESSAGE_BODY_GUTTER);

/** Wrap complete escaped code points, reserving two display columns for the gutter. */
function* messageTextRows(value: string): Generator<string> {
  let line = '';
  let used = 0;
  for (const char of value) {
    const escaped = escapeMessageCharacter(char);
    const width = displayWidth(escaped);
    if (used + width > MESSAGE_BODY_COLUMNS) {
      yield MESSAGE_BODY_GUTTER + line;
      line = '';
      used = 0;
    }
    line += escaped;
    used += width;
  }
  yield MESSAGE_BODY_GUTTER + (line.length > 0 ? line : '(empty message)');
}

function* messageHexRows(hex: string): Generator<string> {
  for (let offset = 0; offset < hex.length; offset += MESSAGE_BODY_COLUMNS) {
    yield MESSAGE_BODY_GUTTER + hex.slice(offset, offset + MESSAGE_BODY_COLUMNS);
  }
}

function messagePages(req: Extract<SignatureRequest, { kind: 'message' }>): string[] {
  const hex = req.messageHex.startsWith('0x') ? req.messageHex.slice(2) : req.messageHex;
  let text: string | undefined;
  try {
    // Preserve a leading BOM as a code point so its bytes receive a visible escape.
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
      Buffer.from(hex, 'hex'),
    );
  } catch {
    // Invalid UTF-8 receives complete hexadecimal review.
  }
  const heading = `Message (${text === undefined ? 'hex' : 'text'}, ${hex.length / 2} bytes):`;
  const header = [
    row('Account:', groupQrlAddress(req.signer)),
    req.origin
      ? originDetail(req.origin)
      : 'Requested by: wallet renderer (dApp origin not provided)',
  ];
  const maxPages = TYPED_DATA_DISPLAY_LIMITS.pages;
  const tooLong = `message too long to review in the trusted dialog (maximum ${maxPages} pages).`;
  const base = [...header, heading].join('\n');
  const baseLines = typedDataDisplayLines(`${base}\n\n${SIGNATURE_APPROVAL_NOTE}`);
  if (baseLines > TYPED_DATA_DISPLAY_LIMITS.lines) throw new Error(tooLong);
  let body: string[] = [];
  const bodies = [body];
  let used = baseLines;
  const rows = text === undefined ? messageHexRows(hex) : messageTextRows(text);
  // Stop at the page cap while preparing the full review, before opening a dialog.
  for (const line of rows) {
    const cost = typedDataDisplayLines(line);
    if (used + cost > TYPED_DATA_DISPLAY_LIMITS.lines) {
      if (bodies.length >= maxPages || baseLines + cost > TYPED_DATA_DISPLAY_LIMITS.lines) {
        throw new Error(tooLong);
      }
      body = [];
      bodies.push(body);
      used = baseLines;
    }
    body.push(line);
    used += cost;
  }
  return bodies.map((bodyLines) => wrapDetailText([...header, heading, ...bodyLines].join('\n')));
}

function displayTypedText(value: string, length: string): string {
  // Escape only a bounded input prefix, even for maximum-size control text.
  const limit = TYPED_DATA_DISPLAY_LIMITS.valueChars;
  let input = '';
  for (const char of value) {
    if (input.length + char.length > limit) break;
    input += char;
  }
  const escaped = `"${singleLineText(input)}"`;
  if (value.length <= limit && escaped.length <= limit) return escaped;
  const suffix = `…" [${length}]`;
  let prefix = '';
  for (const token of displayTokens(escaped)) {
    if (prefix.length + token.length + suffix.length > limit) break;
    prefix += token;
  }
  return prefix + suffix;
}

function* typedMessageRows(payload: TypedDataPayload): Generator<string> {
  let count = 0;
  const formatRow = (path: string, type: string, value: string): string => {
    count += 1;
    let label = path;
    if (path.length > TYPED_DATA_DISPLAY_LIMITS.labelChars) {
      // Keep the complete leaf and its indices. The row number distinguishes
      // paths whose elided ancestors differ, including repeated leaf names.
      const leaf = path.slice(path.lastIndexOf('.') + 1);
      const suffix = `…#${count}.${leaf}`;
      const prefixChars = Math.max(8, TYPED_DATA_DISPLAY_LIMITS.labelChars - suffix.length);
      label = path.slice(0, prefixChars) + suffix;
    }
    return wrapDetailText(`${label} (${type}): ${value}`, 'dapp');
  };
  function* walkStruct(type: string, data: unknown, path: string): Generator<string> {
    if (!isRecord(data)) throw new Error('invalid typed-data summary struct');
    const fields = payload.types[type];
    if (!fields) throw new Error('missing typed-data summary type');
    for (const field of fields) yield* walk(field.type, data[field.name], `${path}.${field.name}`);
  }
  function* walk(type: string, value: unknown, path: string): Generator<string> {
    const parsed = parseFieldType(type, payload.types);
    if (parsed.kind === 'ref') {
      yield* walkStruct(parsed.name, value, path);
    } else if (parsed.kind === 'array') {
      if (!isArray(value)) throw new Error('invalid typed-data summary array');
      if (value.length === 0) yield formatRow(path, type, '[]');
      for (const [index, item] of value.entries())
        yield* walk(parsed.inner, item, `${path}[${index}]`);
    } else {
      yield formatRow(path, type, typedScalar(type, value, payload.types));
    }
  }
  yield* walkStruct(payload.primaryType, payload.message, 'message');
}

function typedScalar(type: string, value: unknown, types: TypeMap, shorten = true): string {
  const parsed = parseFieldType(type, types);
  if (parsed.kind === 'uintN' || parsed.kind === 'intN')
    return parseIntValue(value, type).toString();
  if (parsed.kind === 'bool' && typeof value === 'boolean') return String(value);
  if (typeof value !== 'string') throw new Error('invalid typed-data summary value');
  if (parsed.kind === 'address') return groupQrlAddress(value);
  if (!shorten) return `"${fullTypedText(value)}"`;
  if ((parsed.kind === 'bytes' || parsed.kind === 'bytesN') && value.length <= 66) {
    return `"${value}"`;
  }
  const length =
    parsed.kind === 'bytes' || parsed.kind === 'bytesN'
      ? `${(value.length - 2) / 2} bytes`
      : `${value.length} characters`;
  return displayTypedText(value, length);
}

function typedDataPages(
  req: Extract<SignatureRequest, { kind: 'typedData' }>,
  connectedChainId: number | undefined,
): string[] {
  const { payload } = req;
  const scheme = typedDataSchemeVersion(payload);
  const header = [
    ...(req.origin
      ? [
          'Requested by dApp (unverified, dApp-supplied):',
          wrapDetailText(`Name:    ${fullTypedText(req.origin.name)}`, 'dapp'),
          req.origin.url
            ? wrapDetailText(`URL:     ${fullTypedText(req.origin.url)}`, 'dapp')
            : 'URL:     (not provided)',
        ]
      : ['Requested by: wallet renderer (dApp origin not provided)']),
    row('Account:', groupQrlAddress(req.signer)),
    row('Scheme:', scheme),
    wrapDetailText(
      row(
        'Signing:',
        `${fullTypedText(payload.primaryType)} / ${typedScalar('string', payload.domain['name'], payload.types)}`,
      ),
      'dapp',
    ),
  ];
  const lines: string[] = [];
  for (const [name, type] of [
    ['name', 'string'],
    ['version', 'string'],
    ['chainId', 'uint256'],
    ['verifyingContract', 'address'],
    ['salt', 'bytes32'],
  ] as const) {
    const value = payload.domain[name];
    lines.push(
      value === undefined
        ? `Domain ${name}: (not provided)`
        : wrapDetailText(
            `Domain ${name}: ${typedScalar(type, value, payload.types, false)}`,
            'dapp',
          ),
    );
  }
  if (connectedChainId !== undefined) {
    lines.push(`Wallet network chainId: ${connectedChainId}`);
    const domainChain = payload.domain['chainId'];
    if (
      domainChain !== undefined &&
      parseIntValue(domainChain, 'uint256') !== BigInt(connectedChainId)
    ) {
      lines.push('WARNING: domain chainId differs from the wallet network.');
    }
  }
  if (payload.domain['chainId'] === undefined) {
    lines.push(
      'WARNING: this signature is not bound to a chain and can be replayed on other chains.',
    );
  }
  lines.push(wrapDetailText(`Primary type: ${payload.primaryType}`, 'dapp'));
  const maxPages = TYPED_DATA_DISPLAY_LIMITS.pages;
  // Metadata is mandatory on page one; later pages repeat the compact header.
  const base = header.join('\n');
  const continuationLines = typedDataDisplayLines(
    `${base}\nMessage fields:\n\n${SIGNATURE_APPROVAL_NOTE}`,
  );
  let used = continuationLines + typedDataDisplayLines(lines.join('\n'));
  if (used > TYPED_DATA_DISPLAY_LIMITS.lines) throw new Error(TYPED_METADATA_ERROR);
  const bodies = [lines];
  let body = lines;
  body.push('Message fields:');
  // Consume rows lazily so a request over the page limit stops formatting as
  // soon as it is known to be too large. No dialog is shown during preparation.
  for (const field of typedMessageRows(payload)) {
    const cost = typedDataDisplayLines(field);
    if (used + cost > TYPED_DATA_DISPLAY_LIMITS.lines) {
      if (bodies.length >= maxPages || continuationLines + cost > TYPED_DATA_DISPLAY_LIMITS.lines) {
        throw new Error(
          `Typed-data request is too large to review safely on desktop (maximum ${maxPages} pages).`,
        );
      }
      body = ['Message fields:'];
      bodies.push(body);
      used = continuationLines;
    }
    body.push(field);
    used += cost;
  }
  return bodies.map((bodyLines) => wrapDetailText([...header, ...bodyLines].join('\n')));
}

/**
 * Share of the block gas limit above which a gas limit is worth flagging when
 * main has no build of its own to compare against. A tenth of a block is far
 * above any ordinary transfer or settlement call, so it fires on the shape of
 * request that deserves a second look and stays quiet otherwise.
 */
const UNATTRIBUTED_GAS_BLOCK_SHARE = 10n;

/** The wording that explains what an over-large gas limit can actually cost. */
const REFUND_NOTE =
  'Unused gas is refunded, but a call that fails out of gas or burns gas can consume the whole limit, so the cost below is reachable.';

/** The gas-limit row plus any provenance or warning lines that belong with it. */
function gasLines(
  gas: string,
  build: GasBuildRecord | undefined,
  blockGasLimit: bigint | undefined,
): string[] {
  if (!build) {
    const lines = [
      row('Gas limit:', gas),
      'NOTE: the fee fields were not assembled by this wallet, so it cannot say how this gas limit was chosen.',
    ];
    if (blockGasLimit !== undefined && BigInt(gas) > blockGasLimit / UNATTRIBUTED_GAS_BLOCK_SHARE) {
      lines.push(
        `WARNING: this gas limit claims more than a tenth of a whole block. ${REFUND_NOTE}`,
      );
    }
    return lines;
  }
  if (build.requestedGas === undefined) {
    return [row('Gas limit:', `${gas} (this wallet's estimate)`)];
  }
  const built = BigInt(gas);
  const requested = BigInt(build.requestedGas);
  const estimated = BigInt(build.estimatedGas);
  // Three outcomes, each named for what actually happened. Saying "set by the
  // dApp" when the wallet's own floor or the block ceiling decided the limit
  // would credit the dApp with a number it did not choose.
  if (built === requested) {
    const lines = [
      row('Gas limit:', `${gas} (set by the dApp; wallet estimate ${estimated.toString()})`),
    ];
    if (requested > gasWarningThreshold(estimated)) {
      lines.push(
        `WARNING: the dApp asked for far more gas than this wallet estimated. ${REFUND_NOTE} Approve only if you know why this call needs that much.`,
      );
    }
    return lines;
  }
  if (built === estimated) {
    return [
      row(
        'Gas limit:',
        `${gas} (this wallet's estimate; the dApp asked for ${requested.toString()})`,
      ),
    ];
  }
  // Neither the request nor the estimate: the block gas limit capped the floor.
  return [
    row(
      'Gas limit:',
      `${gas} (capped at the block gas limit; the dApp asked for ${requested.toString()}, wallet estimate ${estimated.toString()})`,
    ),
  ];
}

/**
 * Compute the confirm-window text for a signature request.
 *
 * `context.build` is what main remembers about assembling this exact
 * transaction, and it is what lets the gas row name its own source;
 * `context.blockGasLimit` gives an unattributed limit something to be measured
 * against. For a transaction the fee
 * block is derived from the gas limit that is in the transaction, which may be
 * a dApp-requested limit the builder honoured over its own estimate (see
 * `resolveGasLimit` in rpc.ts). The user therefore sees the worst case they
 * are approving:
 *   max fee  = gas limit * maxFeePerGas
 *   max cost = amount + max fee
 * and the max cost is repeated in the dialog's prominent message line, because
 * for a zero-value contract call the fee IS the whole cost.
 */
export function summariseSignatureRequest(
  req: SignatureRequest,
  context: ConfirmContext = {},
): ConfirmSummary {
  const { build, blockGasLimit } = context;
  switch (req.kind) {
    case 'transaction': {
      const { tx } = req;
      // Main formats numeric values into canonical decimal text for trusted rows.
      const gas = BigInt(tx.gas);
      const feePerGas = BigInt(tx.maxFeePerGas);
      const priorityFeePerGas = BigInt(tx.maxPriorityFeePerGas);
      const maxFee = gas * feePerGas;
      const maxCost = BigInt(tx.value) + maxFee;
      const detail = [
        row('Amount:', formatQuanta(tx.value)),
        wrapDetailText(row('To:', groupQrlAddress(tx.to)), 'dapp'),
        // Main verifies tx.from against the unlocked signer before confirmation.
        row('From:', groupQrlAddress(tx.from)),
        row('Nonce:', String(tx.nonce)),
        ...gasLines(gas.toString(), build, blockGasLimit),
        row(
          'Max fee:',
          `${formatQuanta(maxFee)} (up to ${feePerGas.toString()} per gas, priority ${priorityFeePerGas.toString()})`,
        ),
        row('Max cost:', formatQuanta(maxCost)),
        row('Chain id:', String(tx.chainId)),
        tx.data && tx.data !== '0x'
          ? wrapDetailText(row('Data:', `${tx.data.slice(0, 66)}…`), 'dapp')
          : row('Data:', '(none)'),
      ].join('\n');
      return {
        title: 'Confirm transaction',
        message: `Send ${formatQuanta(tx.value)}? Max cost ${formatQuanta(maxCost)}.`,
        pages: [wrapDetailText(detail + originDetail(req.origin))],
      };
    }
    case 'message':
      return {
        title: 'Confirm message signature',
        message: 'Sign this message with your wallet key?',
        // req.signer is trustworthy to display: main verified it against the
        // unlocked session before this modal, and the signer re-enforces it.
        pages: messagePages(req),
      };
    case 'typedData':
      return {
        title: 'Confirm typed-data signature',
        message: 'Sign this structured data with your wallet key?',
        pages: typedDataPages(req, context.connectedChainId),
      };
  }
}
