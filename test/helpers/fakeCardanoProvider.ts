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
    existing.push({
      txHash: `fa${String(existing.length).padStart(2, '0')}`.repeat(16).slice(0, 64),
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
    existing.push({
      txHash: `ba${String(existing.length).padStart(2, '0')}`.repeat(16).slice(0, 64),
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
        return transactionId;
    }
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
