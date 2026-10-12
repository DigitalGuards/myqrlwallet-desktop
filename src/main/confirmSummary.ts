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
 * user WHO CLAIMS to be asking, while the amounts/addresses above remain
 * main-computed facts. Schema length caps bound the metadata; escaping keeps
 * URL whitespace and direction marks visible on a single row.
 */
export function originDetail(origin: DAppOrigin | undefined): string {
  if (!origin) return '';
  return [
    '',
    'Requested by dApp (unverified, dApp-supplied):',
    `  Name:    ${singleLineText(origin.name)}`,
    `  URL:     ${origin.url ? singleLineText(origin.url) : '(not provided)'}`,
    `  Channel: ${origin.channelId}`,
    'Only approve if you initiated this action in that dApp.',
  ].join('\n');
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
 * Thirty wrapped lines leave room for the native title, message and buttons
 * within roughly 700 logical pixels at common desktop font sizes. The budget
 * includes the approval note appended by confirm.ts. Native font metrics vary.
 */
export const TYPED_DATA_DISPLAY_LIMITS = {
  lines: 30,
  lineChars: 64,
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
  const maxChars = TYPED_DATA_DISPLAY_LIMITS.lines * TYPED_DATA_DISPLAY_LIMITS.lineChars;
  if (value.length > maxChars) throw new Error(TYPED_METADATA_ERROR);
  const escaped = singleLineText(value.slice(0, maxChars));
  if (escaped.length > maxChars) throw new Error(TYPED_METADATA_ERROR);
  return escaped;
}

/**
 * Conservative native word-wrap accounting, including long unbroken tokens.
 * Wide ASCII glyphs and non-ASCII code points consume two display columns.
 * Measuring leaves the text of small requests and full grouped addresses intact.
 */
export function typedDataDisplayLines(detail: string): number {
  let lines = 0;
  for (const line of detail.split('\n')) {
    lines += 1;
    let used = 0;
    for (const token of line.match(/ +|[^ ]+/gu) ?? []) {
      let width = 0;
      for (const char of token) {
        width += char.charCodeAt(0) > 0x7f || 'MW@%'.includes(char) ? 2 : 1;
      }
      if (used > 0 && used + width > TYPED_DATA_DISPLAY_LIMITS.lineChars) {
        lines += 1;
        used = 0;
      }
      while (width > TYPED_DATA_DISPLAY_LIMITS.lineChars) {
        lines += 1;
        width -= TYPED_DATA_DISPLAY_LIMITS.lineChars;
      }
      used += width;
    }
  }
  return lines;
}

/** Keep untrusted text on one row and make invisible direction/control marks visible. */
function singleLineText(value: string): string {
  return JSON.stringify(value)
    .slice(1, -1)
    .replace(
      /[\p{Cc}\p{Cf}\p{Co}\p{Cn}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}\u2800]/gu,
      (char) => {
        const point = char.codePointAt(0);
        if (point === undefined) return char;
        return point > 0xffff
          ? `\\u{${point.toString(16)}}`
          : `\\u${point.toString(16).padStart(4, '0')}`;
      },
    );
}

function displayTypedText(value: string, length: string): string {
  // Escape only a bounded input prefix, even for maximum-size control text.
  const limit = TYPED_DATA_DISPLAY_LIMITS.valueChars;
  const escaped = `"${singleLineText(value.slice(0, limit))}"`;
  if (value.length <= limit && escaped.length <= limit) return escaped;
  const suffix = `…" [${length}]`;
  const prefix = Array.from(escaped)
    .slice(0, limit - suffix.length)
    .join('');
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
    return `${label} (${type}): ${value}`;
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
          `Name:    ${fullTypedText(req.origin.name)}`,
          `URL:     ${req.origin.url ? fullTypedText(req.origin.url) : '(not provided)'}`,
        ]
      : ['Requested by: wallet renderer (dApp origin not provided)']),
    row('Account:', groupQrlAddress(req.signer)),
    row('Scheme:', scheme),
    row(
      'Request:',
      `${fullTypedText(payload.primaryType)} / ${typedScalar('string', payload.domain['name'], payload.types)}`,
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
      `Domain ${name}: ${value === undefined ? '(not provided)' : typedScalar(type, value, payload.types, false)}`,
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
  lines.push(`Primary type: ${payload.primaryType}`);
  const maxPages = TYPED_DATA_DISPLAY_LIMITS.pages;
  // Reserve the widest page counter before the total is known. Metadata is
  // mandatory on page one; every subsequent page repeats the compact header.
  const base = [...header, `Page ${maxPages} of ${maxPages}`].join('\n');
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
  return bodies.map((bodyLines, index) =>
    [...header, `Page ${index + 1} of ${bodies.length}`, ...bodyLines].join('\n'),
  );
}

/**
 * Share of the block gas limit above which a gas limit is worth flagging when
 * main has no build of its own to compare against. A tenth of a block is far
 * above any ordinary transfer or settlement call, so it fires on the shape of
 * request that deserves a second look and stays quiet otherwise.
 */
const UNATTRIBUTED_GAS_BLOCK_SHARE = 10n;

/** The wording that explains what an over-large gas limit can actually cost. */
const REFUND_NOTE = [
  '         Unused gas is refunded, but a call that fails out of gas or burns',
  '         gas can consume the whole limit, so the cost below is reachable.',
];

/** The gas-limit row plus any provenance or warning lines that belong with it. */
function gasLines(
  gas: string,
  build: GasBuildRecord | undefined,
  blockGasLimit: bigint | undefined,
): string[] {
  if (!build) {
    const lines = [
      row('Gas limit:', gas),
      'NOTE: the fee fields were not assembled by this wallet, so it cannot say',
      '      how this gas limit was chosen.',
    ];
    if (blockGasLimit !== undefined && BigInt(gas) > blockGasLimit / UNATTRIBUTED_GAS_BLOCK_SHARE) {
      lines.push(
        'WARNING: this gas limit claims more than a tenth of a whole block.',
        ...REFUND_NOTE,
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
      row('Gas limit:', `${gas} (set by the dApp; wallet estimate ${build.estimatedGas})`),
    ];
    if (requested > gasWarningThreshold(estimated)) {
      lines.push(
        'WARNING: the dApp asked for far more gas than this wallet estimated.',
        ...REFUND_NOTE,
        '         Approve only if you know why this call needs that much.',
      );
    }
    return lines;
  }
  if (built === estimated) {
    return [
      row(
        'Gas limit:',
        `${gas} (this wallet's estimate; the dApp asked for ${build.requestedGas})`,
      ),
    ];
  }
  // Neither the request nor the estimate: the block gas limit capped the floor.
  return [
    row(
      'Gas limit:',
      `${gas} (capped at the block gas limit; the dApp asked for ${build.requestedGas}, wallet estimate ${build.estimatedGas})`,
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
      const maxFee = BigInt(tx.gas) * BigInt(tx.maxFeePerGas);
      const maxCost = BigInt(tx.value) + maxFee;
      const detail = [
        row('Amount:', formatQuanta(tx.value)),
        row('To:', groupQrlAddress(tx.to)),
        row('From:', groupQrlAddress(tx.from)),
        row('Nonce:', String(tx.nonce)),
        ...gasLines(tx.gas, build, blockGasLimit),
        row(
          'Max fee:',
          `${formatQuanta(maxFee)} (up to ${tx.maxFeePerGas} per gas, priority ${tx.maxPriorityFeePerGas})`,
        ),
        row('Max cost:', formatQuanta(maxCost)),
        row('Chain id:', String(tx.chainId)),
        tx.data && tx.data !== '0x'
          ? row('Data:', `${tx.data.slice(0, 66)}…`)
          : row('Data:', '(none)'),
      ].join('\n');
      return {
        title: 'Confirm transaction',
        message: `Send ${formatQuanta(tx.value)}? Max cost ${formatQuanta(maxCost)}.`,
        pages: [detail + originDetail(req.origin)],
      };
    }
    case 'message':
      return {
        title: 'Confirm message signature',
        message: 'Sign this message with your wallet key?',
        // req.signer is trustworthy to display: main verified it against the
        // unlocked session before this modal, and the signer re-enforces it.
        pages: [
          `${row('Account:', groupQrlAddress(req.signer))}\n` +
            `Message (hex):\n${req.messageHex.slice(0, 256)}${req.messageHex.length > 256 ? '…' : ''}` +
            originDetail(req.origin),
        ],
      };
    case 'typedData':
      return {
        title: 'Confirm typed-data signature',
        message: 'Sign this structured data with your wallet key?',
        pages: typedDataPages(req, context.connectedChainId),
      };
  }
}
