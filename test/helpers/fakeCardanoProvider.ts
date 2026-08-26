import type {
  CardanoProvider,
  CardanoTip,
  CardanoTransactionStatus
} from '../../src/services/cardano/cardanoProviderService';
import { CardanoProviderError } from '../../src/services/cardano/cardanoProviderService';
import { transactionIdOf } from '../../src/services/cardano/cardanoTxService';
import type {
  CardanoAssetAmount,
  CardanoProtocolParameters,
  CardanoUtxo
} from '../../src/types/cardanoType';

/**
 * A Cardano provider that lives in memory.
 *
 * It exists to provoke, on demand, the states that are impossible to arrange on a real chain: a
 * submit that times out *after* the transaction reached the network, a provider that rate-limits
 * mid-transfer, an output that is on chain but not yet deep enough to spend. Those are exactly the
 * branches where a wrong decision costs money twice, and a live testnet gives no way to reproduce
 * them.
 *
 * Everything it returns is real in shape: the same types the Koios client produces, so the transfer
 * flow cannot tell the difference.
 */
export class FakeCardanoProvider implements CardanoProvider {
  /** UTxOs per address. */
  private readonly utxos = new Map<string, CardanoUtxo[]>();
  /** Transactions the chain has accepted, by id. */
  readonly submitted = new Map<string, { confirmations: number }>();
  /** Raw CBOR of everything submitted, in order — what the assertions inspect. */
  readonly submissions: string[] = [];

  /** How the next submit should behave. Reset to `'accept'` after it fires. */
  private nextSubmit:
    | { mode: 'accept' }
    | { mode: 'reject'; message?: string }
    /** Times out, and the transaction *did* reach the chain. The dangerous one. */
    | { mode: 'timeout_landed' }
    /** Times out, and the transaction did not reach the chain. Safe to retry. */
    | { mode: 'timeout_lost' } = { mode: 'accept' };

  /** A failure to raise on the next read call, if any. */
  private nextReadFailure: CardanoProviderError | null = null;

  /**
   * Outpoints consumed by transactions the chain accepted.
   *
   * Deliberately *not* removed from `utxos`: a provider reads an indexed chain, and until the block
   * carrying the spend is indexed it goes on offering the output as if nothing had happened. That
   * gap is where consecutive transfers collide, so the fake has to have it too.
   */
  private readonly spent = new Set<string>();

  /** The inputs each accepted submit consumed, in order. What the consecutive-transfer tests read. */
  readonly spentInputs: string[][] = [];

  /**
   * How many outputs this fake has minted.
   *
   * Counted across every address rather than per address, because an outpoint is unique on the whole
   * chain. Numbering per address gave the sender and the sponsor the same `txHash#index`, which no
   * real chain can produce and which quietly made them look like one output to anything keyed by
   * outpoint.
   */
  private minted = 0;

  constructor(
    private tipState: CardanoTip = { slot: 131_235_000, height: 5_064_000 },
    private parameters: CardanoProtocolParameters = {
      minFeeA: 44,
      minFeeB: 155381,
      coinsPerUtxoByte: 4310n,
      maxTxSize: 16384
    }
  ) {}

  /** Gives an address a UTxO, at a depth measured back from the current tip. */
  fund(
    address: string,
    lovelace: bigint,
    options: { confirmations?: number; index?: number } = {}
  ) {
    const confirmations = options.confirmations ?? 10;
    const existing = this.utxos.get(address) ?? [];
    const serial = this.minted++;
    existing.push({
      txHash: `fa${String(serial).padStart(2, '0')}`.repeat(16).slice(0, 64),
      outputIndex: options.index ?? existing.length,
      lovelace,
      holdsOtherAssets: false,
      blockHeight: this.tipState.height - confirmations + 1
    });
    this.utxos.set(address, existing);
    return this;
  }

  /**
   * Gives an address a UTxO holding native assets alongside its ADA.
   *
   * An ADA transfer refuses to spend one of these — its tokens would have to be carried into the
   * change output. A token transfer spends exactly these.
   */
  fundWithAssets(address: string, lovelace: bigint, assets: CardanoAssetAmount[]) {
    const existing = this.utxos.get(address) ?? [];
    const serial = this.minted++;
    existing.push({
      txHash: `ba${String(serial).padStart(2, '0')}`.repeat(16).slice(0, 64),
      outputIndex: existing.length,
      lovelace,
      holdsOtherAssets: assets.length > 0,
      assets,
      blockHeight: this.tipState.height - 10
    });
    this.utxos.set(address, existing);
    return this;
  }

  /** Convenience for the ADA-path tests: a token-bearing UTxO whose assets do not matter. */
  fundWithNativeAssets(address: string, lovelace: bigint) {
    return this.fundWithAssets(address, lovelace, [
      { policyId: 'ff'.repeat(28), assetName: '', quantity: 1n }
    ]);
  }

  /** Moves a submitted transaction into a block, so the provider would list what it created. */
  confirm(transactionId: string, confirmations = 1) {
    this.submitted.set(transactionId, { confirmations });
    return this;
  }

  /**
   * Empties an address, without touching what has been claimed or promised.
   *
   * Models an output that left by a route this flow knows nothing about — a transaction submitted
   * elsewhere, a wallet spending from the same keys.
   */
  forgetUtxosOf(address: string) {
    this.utxos.set(address, []);
    return this;
  }

  /** Arms the behaviour of the next submit. */
  failNextSubmit(mode: 'reject' | 'timeout_landed' | 'timeout_lost', message?: string) {
    this.nextSubmit = mode === 'reject' ? { mode, message } : { mode };
    return this;
  }

  /** Arms a classified failure for the next read call. */
  failNextRead(error: CardanoProviderError) {
    this.nextReadFailure = error;
    return this;
  }

  private consumeReadFailure(): void {
    if (this.nextReadFailure) {
      const error = this.nextReadFailure;
      this.nextReadFailure = null;
      throw error;
    }
  }

  async tip(): Promise<CardanoTip> {
    this.consumeReadFailure();
    return this.tipState;
  }

  async protocolParameters(): Promise<CardanoProtocolParameters> {
    this.consumeReadFailure();
    return this.parameters;
  }

  async utxosFor(address: string): Promise<CardanoUtxo[]> {
    this.consumeReadFailure();
    return [...(this.utxos.get(address) ?? [])];
  }

  async confirmedUtxosFor(address: string, minConfirmations: number): Promise<CardanoUtxo[]> {
    const all = await this.utxosFor(address);
    if (minConfirmations <= 0) return all;
    return all.filter(
      (utxo) =>
        utxo.blockHeight !== undefined &&
        this.tipState.height - utxo.blockHeight + 1 >= minConfirmations
    );
  }

  async submit(cborHex: string): Promise<string> {
    const behaviour = this.nextSubmit;
    this.nextSubmit = { mode: 'accept' };
    this.submissions.push(cborHex);

    // The id the chain would compute is the hash of the body inside the signed transaction. The
    // caller already knows it, so the fake records whatever the caller will look up.
    const transactionId = extractBodyHash(cborHex);
    const inputs = extractInputs(cborHex);

    // What a node answers when the inputs are gone. Without this the fake would accept a
    // double-spend and a test asserting `success` would prove nothing at all — this is the exact
    // rejection the incident produced, quoted from the log.
    if (behaviour.mode === 'accept' && inputs.some((outpoint) => this.spent.has(outpoint))) {
      throw new CardanoProviderError(
        'rejected_by_chain',
        'CARDANO_PROVIDER_400: /submittx: ConwayMempoolFailure "All inputs are spent. ' +
          'Transaction has probably already been included"'
      );
    }

    switch (behaviour.mode) {
      case 'reject':
        throw new CardanoProviderError(
          'rejected_by_chain',
          `CARDANO_PROVIDER_400: /submittx: ${behaviour.message ?? 'ValueNotConservedUTxO'}`
        );
      case 'timeout_landed':
        // The transaction *is* on chain; the answer simply never came back. Resubmitting would
        // double-spend the inputs.
        this.submitted.set(transactionId, { confirmations: 0 });
        throw new CardanoProviderError('timeout', 'CARDANO_PROVIDER_TIMEOUT: /submittx', true);
      case 'timeout_lost':
        throw new CardanoProviderError('timeout', 'CARDANO_PROVIDER_TIMEOUT: /submittx', true);
      default:
        this.submitted.set(transactionId, { confirmations: 0 });
        for (const outpoint of inputs) this.spent.add(outpoint);
        this.spentInputs.push(inputs);
        return transactionId;
    }
  }

  /**
   * Lets the indexer catch up with one transaction: its inputs disappear and its change shows up.
   *
   * The change arrives with no `blockHeight`, which is how a provider reports an output in a block
   * too recent to count as confirmed. Spending it is what a wallet has to do to pay twice in a row.
   *
   * @param address - The address whose view moves forward.
   * @param transactionId - The transaction that settled.
   * @param change - Lovelace the change output carries.
   */
  settleAsUnconfirmedChange(address: string, transactionId: string, change: bigint) {
    const remaining = (this.utxos.get(address) ?? []).filter(
      (utxo) => !this.spent.has(`${utxo.txHash}#${utxo.outputIndex}`)
    );
    remaining.push({
      txHash: transactionId,
      outputIndex: 1,
      lovelace: change,
      holdsOtherAssets: false
    });
    this.utxos.set(address, remaining);
    return this;
  }

  async statusOf(transactionId: string): Promise<CardanoTransactionStatus> {
    this.consumeReadFailure();
    const record = this.submitted.get(transactionId);
    return record
      ? { known: true, confirmations: record.confirmations }
      : {
          known: false,
          confirmations: 0
        };
  }
}

/**
 * The transaction id of a submitted signed transaction.
 *
 * A signed transaction is `[body, witnessSet, true, null]`, so its body is what the id hashes. The
 * fake re-derives it the same way the production code does rather than trusting the caller to say
 * what it submitted — otherwise a test would pass even if the flow looked up the wrong id.
 */
function extractBodyHash(signedCborHex: string): string {
  const bytes = Buffer.from(signedCborHex, 'hex');
  // A signed transaction is `[body, witnessSet, true, null]`, so the body starts right after the
  // one-byte outer array head and runs to the end of its own map.
  const bodyStart = 1;
  // The body map is `a4` (4 entries) in every transfer this codebase builds.
  if (bytes[bodyStart] !== 0xa4) throw new Error('FAKE_PROVIDER_UNEXPECTED_BODY');
  const bodyEnd = findBodyEnd(bytes, bodyStart);
  return transactionIdOf(Uint8Array.from(bytes.subarray(bodyStart, bodyEnd)));
}

/**
 * The outpoints a signed transaction spends, as `txHash#index`.
 *
 * Reads the first entry of the body map, which is the input set. The set may be tagged (258) or a
 * bare array depending on the encoder, so both are accepted. Every head is read through
 * `readHead` rather than by masking the initial byte: a 32-byte hash encodes its length in a
 * following byte, and treating that byte as part of the head silently shifts everything after it.
 */
function extractInputs(signedCborHex: string): string[] {
  const bytes = Buffer.from(signedCborHex, 'hex');
  let offset = 2; // past the outer array head and the body map head
  offset = skipItem(bytes, offset); // the key `0`
  if (bytes[offset] >> 5 === 6) offset = readHead(bytes, offset).next; // an optional set tag

  const set = readHead(bytes, offset);
  offset = set.next;

  const outpoints: string[] = [];
  for (let i = 0; i < set.value; i++) {
    offset = readHead(bytes, offset).next; // the two-element array head
    const hash = readHead(bytes, offset);
    outpoints.push(
      `${bytes.subarray(hash.next, hash.next + hash.value).toString('hex')}#${
        readHead(bytes, hash.next + hash.value).value
      }`
    );
    offset = readHead(bytes, hash.next + hash.value).next;
  }
  return outpoints;
}

/** The argument of a CBOR head — a length, a count or a small integer — and where the item begins. */
function readHead(bytes: Buffer, offset: number): { value: number; next: number } {
  const additional = bytes[offset] & 0x1f;
  if (additional < 24) return { value: additional, next: offset + 1 };
  if (additional === 24) return { value: bytes[offset + 1], next: offset + 2 };
  if (additional === 25) return { value: bytes.readUInt16BE(offset + 1), next: offset + 3 };
  if (additional === 26) return { value: bytes.readUInt32BE(offset + 1), next: offset + 5 };
  return { value: Number(bytes.readBigUInt64BE(offset + 1)), next: offset + 9 };
}

/**
 * Where the transaction body ends inside a signed transaction.
 *
 * Walks the four known entries of the body map rather than implementing a general CBOR reader: the
 * bodies this codebase produces have a fixed shape (inputs set, outputs array, fee, ttl), and a
 * general parser here would be more code than the thing it verifies.
 */
function findBodyEnd(bytes: Buffer, start: number): number {
  let offset = start + 1; // past the map head
  for (let entry = 0; entry < 4; entry++) {
    offset = skipItem(bytes, offset); // key
    offset = skipItem(bytes, offset); // value
  }
  return offset;
}

/** Advances past one CBOR item, returning the offset of the next. */
function skipItem(bytes: Buffer, offset: number): number {
  const initial = bytes[offset];
  const major = initial >> 5;
  const additional = initial & 0x1f;
  let cursor = offset + 1;
  let length = additional;

  if (additional === 24) {
    length = bytes[cursor];
    cursor += 1;
  } else if (additional === 25) {
    length = bytes.readUInt16BE(cursor);
    cursor += 2;
  } else if (additional === 26) {
    length = bytes.readUInt32BE(cursor);
    cursor += 4;
  } else if (additional === 27) {
    length = Number(bytes.readBigUInt64BE(cursor));
    cursor += 8;
  }

  switch (major) {
    case 0: // unsigned
    case 1: // negative
      return cursor;
    case 2: // byte string
    case 3: // text string
      return cursor + length;
    case 4: // array
      for (let i = 0; i < length; i++) cursor = skipItem(bytes, cursor);
      return cursor;
    case 5: // map
      for (let i = 0; i < length * 2; i++) cursor = skipItem(bytes, cursor);
      return cursor;
    case 6: // tag
      return skipItem(bytes, cursor);
    default: // simple / float
      return cursor;
  }
}
