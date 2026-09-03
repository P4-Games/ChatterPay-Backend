/**
 * The Cardano provider: what the backend reads the chain through, and submits to.
 *
 * There is no local Cardano node — running one means a chain sync measured in hours and tens of
 * gigabytes — so a hosted provider stands between the API and the network. That choice has a
 * consequence this client is built around: **the provider is a third party that fails in ways the
 * chain does not**. It rate-limits, it times out, it answers 502 from a load balancer, and it can
 * return a body that does not parse. None of those mean the transaction failed, and none of them
 * mean it succeeded.
 *
 * So every failure here is classified rather than thrown as a string: {@link CardanoProviderError}
 * carries whether a retry is safe. The one that matters is submit — a timed-out submit may well
 * have reached the chain, and treating it as a failure is how the same transfer gets sent twice.
 * The caller re-reads the transaction id before concluding anything, which it can do because the
 * id is known before submission (it is the hash of the body it signed).
 *
 * `CardanoProvider` is an interface rather than a class on purpose: the tests drive the whole
 * transfer flow through an in-memory implementation, which is the only way to provoke a submit that
 * times out *after* the transaction reached the chain.
 */

import { getCardanoConfig } from '../../config/cardanoConfig';
import { Logger } from '../../helpers/loggerHelper';
import type { CardanoProtocolParameters, CardanoUtxo } from '../../types/cardanoType';

/** Why a provider call failed, in the terms the caller has to act on. */
export type CardanoProviderFailure =
  /** Rate limited. The call did not reach the chain; waiting is the whole remedy. */
  | 'rate_limited'
  /** The provider itself is unhealthy (5xx). Retryable. */
  | 'provider_unavailable'
  /** No answer within the timeout. **Undetermined** for a submit: it may have landed. */
  | 'timeout'
  /** Credentials missing, wrong, or out of quota. Retrying changes nothing. */
  | 'unauthorized'
  /** The provider answered, and the answer is not what this client can read. */
  | 'unexpected_response'
  /** The chain refused the transaction. It is not on chain and never will be as submitted. */
  | 'rejected_by_chain';

/**
 * A provider call that did not produce an answer this client can use.
 *
 * `retryable` is the field callers branch on, and `undetermined` is the one that keeps a retry from
 * double-spending: a submit that timed out has an unknown outcome, so the caller must look the
 * transaction up rather than send it again.
 */
export class CardanoProviderError extends Error {
  /**
   * @param failure - What went wrong, classified.
   * @param message - Human-readable detail, provider body included when there is one.
   * @param undetermined - Whether the operation's outcome is unknown rather than failed.
   */
  constructor(
    readonly failure: CardanoProviderFailure,
    message: string,
    readonly undetermined = false,
    readonly status?: number
  ) {
    super(message);
    this.name = 'CardanoProviderError';
  }

  /** Whether repeating the same call is safe and might succeed. */
  get retryable(): boolean {
    return (
      this.failure === 'rate_limited' ||
      this.failure === 'provider_unavailable' ||
      this.failure === 'timeout'
    );
  }
}

/** Where a transaction stands on chain, as far as the provider can see. */
export interface CardanoTransactionStatus {
  /** Whether the provider knows the transaction at all. */
  known: boolean;
  /** Blocks on top of the one that included it. `0` while it is only in the tip block. */
  confirmations: number;
}

/** The tip of the chain: the slot a TTL is measured against, and the height confirmations use. */
export interface CardanoTip {
  /** Absolute slot. Must come from the chain: a TTL computed from this machine's clock expires
   *  early or late by whatever the clock is off by. */
  slot: number;
  /** Block height. */
  height: number;
}

/** What the transfer flow needs from a Cardano provider, and nothing more. */
export interface CardanoProvider {
  tip(): Promise<CardanoTip>;
  protocolParameters(): Promise<CardanoProtocolParameters>;
  utxosFor(address: string): Promise<CardanoUtxo[]>;
  confirmedUtxosFor(address: string, minConfirmations: number): Promise<CardanoUtxo[]>;
  submit(cborHex: string): Promise<string>;
  statusOf(transactionId: string): Promise<CardanoTransactionStatus>;
}

/** Unit Koios uses for ADA. Anything else in `asset_list` is a native asset. */
const DEFAULT_TIMEOUT_MS = 20_000;

interface KoiosAsset {
  policy_id: string;
  asset_name: string | null;
  quantity: string;
}

interface KoiosUtxo {
  tx_hash: string;
  tx_index: number;
  value: string;
  block_height: number | null;
  asset_list: KoiosAsset[] | null;
  is_spent?: boolean;
}

interface KoiosTip {
  abs_slot: number;
  block_no: number;
}

interface KoiosEpochParams {
  min_fee_a: number;
  min_fee_b: number;
  max_tx_size: number;
  coins_per_utxo_size: string | number;
}

interface KoiosTxStatus {
  tx_hash: string;
  num_confirmations: number | null;
}

/**
 * The HTTP plumbing every hosted provider shares.
 *
 * What differs between one provider and the next is the dialect — paths, body shapes, and the name
 * the credential goes under — not the failure handling, and the failure handling is the part that
 * must not diverge. A submit that times out is undetermined whoever answered it, and a client that
 * read a 429 as a hard failure on one provider and as a retry on the other would eventually send
 * the same transfer twice. So the classification lives here once, and each provider below says
 * only what its own dialect is.
 */
abstract class HttpCardanoProvider {
  /**
   * @param baseUrl - Network-specific provider root. The network lives in the URL: pointing a
   *   Preprod deployment at a mainnet root would read and submit against a chain whose addresses
   *   this deployment cannot derive.
   * @param timeoutMs - Per-call ceiling. A provider that has not answered by then is reported as
   *   `timeout`, which for a submit means undetermined and not failed.
   * @param apiKey - Credential for the provider, empty when it needs none.
   */
  constructor(
    protected readonly baseUrl: string,
    protected readonly timeoutMs: number = DEFAULT_TIMEOUT_MS,
    protected readonly apiKey: string = ''
  ) {}

  /**
   * The header this provider wants its credential under.
   *
   * @returns The headers to add, empty when there is no credential to send.
   */
  protected abstract authHeaders(): Record<string, string>;

  /**
   * One provider call, with every failure mode classified.
   *
   * @param path - Path under the network root, leading slash included.
   * @param init - Method, body and content type; absent for a plain read.
   * @returns The parsed body.
   * @throws CardanoProviderError For every failure.
   */
  protected async call<T>(path: string, init?: RequestInit): Promise<T> {
    const isWrite = init?.method === 'POST';
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        ...init,
        headers: {
          accept: 'application/json',
          ...this.authHeaders(),
          ...(init?.headers ?? {})
        },
        signal: AbortSignal.timeout(this.timeoutMs)
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      // A submit whose answer never arrived may still be on chain: the caller has to look the
      // transaction up before deciding, and `undetermined` is what tells it to.
      throw new CardanoProviderError(
        'timeout',
        `CARDANO_PROVIDER_TIMEOUT: ${path}: ${detail}`,
        isWrite
      );
    }

    if (!response.ok) {
      const body = (await response.text()).slice(0, 500);
      throw new CardanoProviderError(
        classifyStatus(response.status, init?.method),
        `CARDANO_PROVIDER_${response.status}: ${path}: ${body}`,
        false,
        response.status
      );
    }

    const text = await response.text();
    try {
      return JSON.parse(text) as T;
    } catch {
      // A submit answers a bare quoted hash, which is valid JSON; anything else that does not parse
      // is a provider that changed its contract, not a transaction that failed.
      throw new CardanoProviderError(
        'unexpected_response',
        `CARDANO_PROVIDER_UNREADABLE: ${path}: ${text.slice(0, 200)}`
      );
    }
  }

  /**
   * The same call, with `404` answered as `null` rather than raised as a failure.
   *
   * Some providers report "this address has never been used" and "this transaction is not in a
   * block" with a 404, and both are ordinary answers rather than outages: an address with no
   * history holds no UTxOs, and a transaction nobody has seen yet is what an unconfirmed submit
   * looks like. Reading either as an error would turn a brand new wallet into a failure.
   *
   * @param path - Path under the network root, leading slash included.
   * @param init - Method, body and content type; absent for a plain read.
   * @returns The parsed body, or `null` when the provider answered 404.
   * @throws CardanoProviderError For every other failure.
   */
  protected async callOptional<T>(path: string, init?: RequestInit): Promise<T | null> {
    try {
      return await this.call<T>(path, init);
    } catch (error) {
      if (error instanceof CardanoProviderError && error.status === 404) return null;
      throw error;
    }
  }
}

/**
 * Koios as the Cardano provider.
 *
 * The default, because it answers without a credential at all: a testnet deployment can be brought
 * up with nothing but a URL. It also reports `block_height` on every UTxO, so confirmations resolve
 * without a per-output lookup — the call pattern that earns a rate limit elsewhere. What the public
 * tier does not give is headroom, and that is what the optional token buys.
 */
export class KoiosProvider extends HttpCardanoProvider implements CardanoProvider {
  /**
   * Koios takes its token as a JWT bearer, and takes the absence of one as a request for the
   * public tier — so an unconfigured deployment keeps working, on a smaller quota.
   *
   * @returns The authorization header, or nothing when no token is configured.
   */
  protected authHeaders(): Record<string, string> {
    return this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {};
  }

  /**
   * The tip of the chain.
   *
   * @returns Absolute slot and block height of the latest block.
   * @throws CardanoProviderError On any provider failure.
   */
  async tip(): Promise<CardanoTip> {
    const rows = await this.call<KoiosTip[]>('/tip');
    const row = Array.isArray(rows) ? rows[0] : undefined;
    if (!row || typeof row.abs_slot !== 'number') {
      throw new CardanoProviderError('unexpected_response', 'CARDANO_PROVIDER_TIP_SHAPE');
    }
    return { slot: row.abs_slot, height: row.block_no };
  }

  /**
   * Protocol parameters of the current epoch.
   *
   * @returns The four values a transfer needs. Read every time rather than cached at startup: a fee
   *   computed from stale parameters is a transaction the network rejects, and parameters change at
   *   epoch boundaries without anything restarting.
   * @throws CardanoProviderError On any provider failure, or when a field is missing.
   */
  async protocolParameters(): Promise<CardanoProtocolParameters> {
    const rows = await this.call<KoiosEpochParams[]>('/epoch_params?limit=1');
    const row = Array.isArray(rows) ? rows[0] : undefined;
    if (!row || typeof row.min_fee_a !== 'number' || typeof row.min_fee_b !== 'number') {
      throw new CardanoProviderError('unexpected_response', 'CARDANO_PROVIDER_PARAMETERS_SHAPE');
    }
    return {
      minFeeA: row.min_fee_a,
      minFeeB: row.min_fee_b,
      coinsPerUtxoByte: BigInt(row.coins_per_utxo_size),
      maxTxSize: Number(row.max_tx_size)
    };
  }

  /**
   * The unspent outputs an address holds.
   *
   * @param address - Bech32 Cardano address.
   * @returns Its UTxOs, with native assets flagged rather than dropped: the ADA in an output that
   *   also holds tokens is real, it is simply not spendable by a V1 that carries ADA only, and
   *   reporting it as absent would make a balance disagree with any explorer.
   * @throws CardanoProviderError On any provider failure.
   */
  async utxosFor(address: string): Promise<CardanoUtxo[]> {
    const rows = await this.call<KoiosUtxo[]>('/address_utxos', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      // `_extended` is what turns `asset_list` from a presence flag into the policy id, name and
      // quantity a token transfer needs. Asked for unconditionally: the alternative is discovering
      // mid-transfer that the detail is missing, and a second round trip to the provider.
      body: JSON.stringify({ _addresses: [address], _extended: true })
    });
    if (!Array.isArray(rows)) {
      throw new CardanoProviderError('unexpected_response', 'CARDANO_PROVIDER_UTXO_SHAPE');
    }
    return rows
      .filter((row) => row.is_spent !== true)
      .map((row) => {
        const assets = (row.asset_list ?? []).map((asset) => ({
          policyId: asset.policy_id.toLowerCase(),
          // An asset with an empty name is legal, and the provider reports it as null.
          assetName: (asset.asset_name ?? '').toLowerCase(),
          quantity: BigInt(asset.quantity)
        }));
        return {
          txHash: row.tx_hash,
          outputIndex: row.tx_index,
          lovelace: BigInt(row.value),
          holdsOtherAssets: assets.length > 0,
          assets,
          blockHeight: row.block_height ?? undefined
        };
      });
  }

  /**
   * The unspent outputs an address holds that are deep enough to be treated as firm.
   *
   * Cardano has no confirmation count on a UTxO, so this resolves one from the height of the block
   * that created each output against the tip. What that buys is the answer to the rollback
   * question: an output on a chain branch that gets discarded stops existing, and spending from it
   * means spending funds that are not there. Below the threshold the output is simply not seen yet,
   * which is a delay and not an error, and the next read sees it.
   *
   * @param address - Bech32 Cardano address.
   * @param minConfirmations - Blocks required on top of the including block. `0` accepts anything
   *   the provider reports as on chain.
   * @returns The UTxOs that meet the threshold.
   * @throws CardanoProviderError On any provider failure.
   */
  async confirmedUtxosFor(address: string, minConfirmations: number): Promise<CardanoUtxo[]> {
    const utxos = await this.utxosFor(address);
    if (minConfirmations <= 0 || utxos.length === 0) return utxos;
    const { height } = await this.tip();
    return utxos.filter(
      (utxo) => utxo.blockHeight !== undefined && height - utxo.blockHeight + 1 >= minConfirmations
    );
  }

  /**
   * Submits a signed transaction.
   *
   * @param cborHex - The serialized signed transaction.
   * @returns The transaction id the provider echoes back.
   * @throws CardanoProviderError `rejected_by_chain` when the node refuses it — that is final and
   *   the transaction does not exist. Everything else may be retried, and a `timeout` is
   *   `undetermined`: the transaction may be on chain, so the caller looks it up by the id it
   *   already knows instead of submitting again.
   */
  async submit(cborHex: string): Promise<string> {
    const submitted = await this.call<string>('/submittx', {
      method: 'POST',
      headers: { 'content-type': 'application/cbor' },
      body: Uint8Array.from(Buffer.from(cborHex, 'hex'))
    });
    if (typeof submitted !== 'string') {
      throw new CardanoProviderError('unexpected_response', 'CARDANO_PROVIDER_SUBMIT_SHAPE');
    }
    return submitted;
  }

  /**
   * Where a transaction stands.
   *
   * @param transactionId - The id, hex without `0x`.
   * @returns Its status. An unknown transaction is reported as `known: false` rather than as an
   *   error: before inclusion that is the ordinary answer, and it is also the answer that resolves
   *   an undetermined submit.
   * @throws CardanoProviderError On any provider failure.
   */
  async statusOf(transactionId: string): Promise<CardanoTransactionStatus> {
    const rows = await this.call<KoiosTxStatus[]>('/tx_status', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ _tx_hashes: [transactionId] })
    });
    const row = Array.isArray(rows) ? rows[0] : undefined;
    if (!row) return { known: false, confirmations: 0 };
    const confirmations = row.num_confirmations;
    // Koios answers with the row present and `num_confirmations: null` for a transaction it has
    // never seen, which is "not on chain" and not a malformed answer.
    if (confirmations === null || confirmations === undefined) {
      return { known: false, confirmations: 0 };
    }
    return { known: true, confirmations };
  }
}

/** Outputs Blockfrost returns per page, and the most it accepts. */
const BLOCKFROST_PAGE_SIZE = 100;

/**
 * Pages of UTxOs this client will walk for one address.
 *
 * A ceiling rather than an open loop: the paging protocol has no total to compare against, so the
 * only stop condition is a short page, and a provider that kept answering full ones would spin
 * forever. Ten thousand outputs is far past anything a wallet of this product holds.
 */
const BLOCKFROST_MAX_PAGES = 100;

/** Hex length of a policy id, which is the prefix of every `unit` that is not `lovelace`. */
const POLICY_ID_HEX_LENGTH = 56;

interface BlockfrostBlock {
  slot: number | null;
  height: number | null;
}

interface BlockfrostEpochParams {
  min_fee_a: number;
  min_fee_b: number;
  max_tx_size: number;
  coins_per_utxo_size: string | number | null;
}

interface BlockfrostAmount {
  unit: string;
  quantity: string;
}

interface BlockfrostUtxo {
  tx_hash: string;
  output_index: number;
  amount: BlockfrostAmount[] | null;
  block: string;
}

interface BlockfrostTx {
  block_height: number | null;
}

/**
 * Blockfrost as the Cardano provider.
 *
 * The alternative to Koios when the public tier's quota runs out, and the reason the interface
 * above exists: the transfer flow does not change, only what answers it. Three things about this
 * dialect are worth knowing before reading the methods.
 *
 * A submit takes the transaction as **raw CBOR bytes**, not as hex in a JSON envelope. A UTxO
 * names the block that created it by **hash rather than height**, so a depth threshold costs a
 * lookup that Koios does not charge for. And a 404 is an ordinary answer for both an address with
 * no history and a transaction that has not been included yet, which is why those two reads go
 * through {@link HttpCardanoProvider.callOptional} instead of raising.
 */
export class BlockfrostProvider extends HttpCardanoProvider implements CardanoProvider {
  /**
   * Blockfrost takes its project id in a header of that name, and refuses every call without one —
   * there is no anonymous tier to fall back to, which is why the configuration insists on a key
   * before the family is allowed to start.
   *
   * @returns The project id header, or nothing when none is configured.
   */
  protected authHeaders(): Record<string, string> {
    return this.apiKey ? { project_id: this.apiKey } : {};
  }

  /**
   * The tip of the chain.
   *
   * @returns Absolute slot and block height of the latest block.
   * @throws CardanoProviderError On any provider failure.
   */
  async tip(): Promise<CardanoTip> {
    const block = await this.call<BlockfrostBlock>('/blocks/latest');
    if (!block || typeof block.slot !== 'number' || typeof block.height !== 'number') {
      throw new CardanoProviderError('unexpected_response', 'CARDANO_PROVIDER_TIP_SHAPE');
    }
    return { slot: block.slot, height: block.height };
  }

  /**
   * Protocol parameters of the current epoch.
   *
   * Only `coins_per_utxo_size` is read, and its absence is a failure rather than a reason to fall
   * back on the `coins_per_utxo_word` the same response still carries. The two are quoted in
   * different units — bytes and eight-byte words — so the legacy field is roughly eight times the
   * current one, and reading it by mistake would put a minimum on every output that no wallet can
   * meet. A missing field is a provider contract that changed, and refusing is the only safe read.
   *
   * @returns The four values a transfer needs.
   * @throws CardanoProviderError On any provider failure, or when a field is missing.
   */
  async protocolParameters(): Promise<CardanoProtocolParameters> {
    const row = await this.call<BlockfrostEpochParams>('/epochs/latest/parameters');
    const coinsPerUtxoSize = row?.coins_per_utxo_size;
    if (
      !row ||
      typeof row.min_fee_a !== 'number' ||
      typeof row.min_fee_b !== 'number' ||
      coinsPerUtxoSize === null ||
      coinsPerUtxoSize === undefined
    ) {
      throw new CardanoProviderError('unexpected_response', 'CARDANO_PROVIDER_PARAMETERS_SHAPE');
    }
    return {
      minFeeA: row.min_fee_a,
      minFeeB: row.min_fee_b,
      coinsPerUtxoByte: BigInt(coinsPerUtxoSize),
      maxTxSize: Number(row.max_tx_size)
    };
  }

  /**
   * The unspent outputs an address holds.
   *
   * @param address - Bech32 Cardano address.
   * @returns Its UTxOs, with native assets flagged rather than dropped, and no block height: this
   *   dialect does not report one, and {@link confirmedUtxosFor} is where it is paid for.
   * @throws CardanoProviderError On any provider failure.
   */
  async utxosFor(address: string): Promise<CardanoUtxo[]> {
    const rows = await this.utxoRows(address);
    return rows.map((row) => toCardanoUtxo(row));
  }

  /**
   * The unspent outputs an address holds that are deep enough to be treated as firm.
   *
   * The heights come from one lookup per **distinct block**, not per output: a wallet's outputs
   * cluster in a handful of blocks, and a call per output is the pattern that earns a rate limit.
   *
   * @param address - Bech32 Cardano address.
   * @param minConfirmations - Blocks required on top of the including block. `0` accepts anything
   *   the provider reports as on chain, and skips the lookups entirely.
   * @returns The UTxOs that meet the threshold, each carrying the height it was judged by.
   * @throws CardanoProviderError On any provider failure.
   */
  async confirmedUtxosFor(address: string, minConfirmations: number): Promise<CardanoUtxo[]> {
    const rows = await this.utxoRows(address);
    if (minConfirmations <= 0 || rows.length === 0) return rows.map((row) => toCardanoUtxo(row));
    const { height } = await this.tip();
    const heights = new Map<string, number>();
    for (const hash of new Set(rows.map((row) => row.block))) {
      // Sequential on purpose: firing every block lookup at once is what earns a rate limit.
      const block = await this.call<BlockfrostBlock>(`/blocks/${hash}`);
      if (typeof block?.height !== 'number') {
        throw new CardanoProviderError('unexpected_response', 'CARDANO_PROVIDER_BLOCK_SHAPE');
      }
      heights.set(hash, block.height);
    }
    return rows
      .map((row) => ({ ...toCardanoUtxo(row), blockHeight: heights.get(row.block) }))
      .filter(
        (utxo) =>
          utxo.blockHeight !== undefined && height - utxo.blockHeight + 1 >= minConfirmations
      );
  }

  /**
   * Submits a signed transaction.
   *
   * @param cborHex - The serialized signed transaction.
   * @returns The transaction id the provider echoes back.
   * @throws CardanoProviderError `rejected_by_chain` when the node refuses it — that is final and
   *   the transaction does not exist. Everything else may be retried, and a `timeout` is
   *   `undetermined`: the transaction may be on chain, so the caller looks it up by the id it
   *   already knows instead of submitting again.
   */
  async submit(cborHex: string): Promise<string> {
    const submitted = await this.call<string>('/tx/submit', {
      method: 'POST',
      // The bytes themselves, not the hex: this endpoint reads the body as CBOR, and a hex string
      // is refused as a malformed transaction rather than as a malformed request.
      headers: { 'content-type': 'application/cbor' },
      body: Uint8Array.from(Buffer.from(cborHex, 'hex'))
    });
    if (typeof submitted !== 'string') {
      throw new CardanoProviderError('unexpected_response', 'CARDANO_PROVIDER_SUBMIT_SHAPE');
    }
    return submitted;
  }

  /**
   * Where a transaction stands.
   *
   * Blockfrost answers only for transactions that reached a block, so anything it does not know is
   * reported as `known: false` — which before inclusion is the ordinary answer, and is also the
   * answer that resolves an undetermined submit. The including block counts as the first
   * confirmation, matching how {@link confirmedUtxosFor} counts, because the caller reads `>= 1` as
   * "in a block" and a transaction this endpoint answers for is in one.
   *
   * @param transactionId - The id, hex without `0x`.
   * @returns Its status.
   * @throws CardanoProviderError On any provider failure.
   */
  async statusOf(transactionId: string): Promise<CardanoTransactionStatus> {
    const transaction = await this.callOptional<BlockfrostTx>(`/txs/${transactionId}`);
    if (!transaction || typeof transaction.block_height !== 'number') {
      return { known: false, confirmations: 0 };
    }
    const { height } = await this.tip();
    return { known: true, confirmations: Math.max(1, height - transaction.block_height + 1) };
  }

  /**
   * Every UTxO page for an address, walked to the end.
   *
   * The paging is not optional detail: a read that stopped at the first page would hide funds, and
   * the transfer that follows would fail for an insufficient balance the wallet actually has.
   *
   * @param address - Bech32 Cardano address.
   * @returns The rows as the provider returned them, block hash included.
   * @throws CardanoProviderError On any provider failure.
   */
  private async utxoRows(address: string): Promise<BlockfrostUtxo[]> {
    const rows: BlockfrostUtxo[] = [];
    for (let page = 1; page <= BLOCKFROST_MAX_PAGES; page += 1) {
      // Sequential because the number of pages is only known once a short one comes back.
      const batch = await this.callOptional<BlockfrostUtxo[]>(
        `/addresses/${address}/utxos?count=${BLOCKFROST_PAGE_SIZE}&page=${page}`
      );
      // 404 is "this address has never been used", which is an empty wallet and not a failure.
      if (batch === null) break;
      if (!Array.isArray(batch)) {
        throw new CardanoProviderError('unexpected_response', 'CARDANO_PROVIDER_UTXO_SHAPE');
      }
      rows.push(...batch);
      if (batch.length < BLOCKFROST_PAGE_SIZE) break;
    }
    return rows;
  }
}

/**
 * One Blockfrost output in the shape the rest of the code reads.
 *
 * The amounts arrive as a flat list in which ADA is just another entry, under the unit
 * `lovelace`; everything else is a policy id and an asset name concatenated into one hex string.
 *
 * @param row - The provider's row.
 * @returns The UTxO, without a block height — this dialect reports the block by hash.
 */
function toCardanoUtxo(row: BlockfrostUtxo): CardanoUtxo {
  const amounts = row.amount ?? [];
  const assets = amounts
    .filter((amount) => amount.unit !== 'lovelace')
    .map((amount) => ({
      policyId: amount.unit.slice(0, POLICY_ID_HEX_LENGTH).toLowerCase(),
      // An asset with an empty name is legal, and leaves the unit as the policy id alone.
      assetName: amount.unit.slice(POLICY_ID_HEX_LENGTH).toLowerCase(),
      quantity: BigInt(amount.quantity)
    }));
  const lovelace = amounts.find((amount) => amount.unit === 'lovelace');
  return {
    txHash: row.tx_hash,
    outputIndex: row.output_index,
    lovelace: BigInt(lovelace?.quantity ?? '0'),
    holdsOtherAssets: assets.length > 0,
    assets
  };
}

/**
 * What an HTTP status from the provider means.
 *
 * @param status - The status code.
 * @param method - The method used, which is what separates "the chain refused this transaction"
 *   from "the request was malformed": a submit the node rejects comes back as a 4xx on POST.
 * @returns The classified failure.
 */
function classifyStatus(status: number, method?: string): CardanoProviderFailure {
  if (status === 429 || status === 418) return 'rate_limited';
  if (status === 401 || status === 402 || status === 403) return 'unauthorized';
  if (status >= 500) return 'provider_unavailable';
  if ((status === 400 || status === 422) && method === 'POST') return 'rejected_by_chain';
  return 'unexpected_response';
}

/**
 * Builds the provider this deployment reads and submits through.
 *
 * Lives here rather than beside the transfer flow so that a caller which only needs to *read* the
 * chain — a balance, a transaction status — does not have to import the operation layer, and with
 * it the database. The dependency would run the wrong way.
 *
 * @returns A provider bound to the configured network, of whichever kind the root URL names.
 */
export function buildCardanoProvider(): CardanoProvider {
  const config = getCardanoConfig();
  if (config.providerKind === 'blockfrost') {
    return new BlockfrostProvider(
      config.providerUrl,
      config.providerTimeoutMs,
      config.providerApiKey
    );
  }
  return new KoiosProvider(config.providerUrl, config.providerTimeoutMs, config.providerApiKey);
}

/**
 * Logs a provider failure with the one fact that decides what happens next.
 *
 * @param context - Where the failure happened.
 * @param error - The error to describe.
 */
export function logCardanoProviderError(context: string, error: unknown): void {
  if (error instanceof CardanoProviderError) {
    Logger.error(
      context,
      `${error.message} [failure=${error.failure} retryable=${error.retryable} undetermined=${error.undetermined}]`
    );
    return;
  }
  Logger.error(context, error);
}
