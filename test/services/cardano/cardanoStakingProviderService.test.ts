import { afterEach, describe, expect, it, vi } from 'vitest';

import { CardanoProviderError } from '../../../src/services/cardano/cardanoProviderService';
import {
  BlockfrostStakingProvider,
  buildStakingProvider,
  KoiosStakingProvider,
  normalizeGovernanceDelegation,
  optionalLovelace,
  readDRepStatus,
  readKoiosPoolStatus,
  readKoiosStatus,
  readRegistrationFlags,
  requiredLovelace,
  rewardSourceKey
} from '../../../src/services/cardano/cardanoStakingProviderService';

const BASE = 'https://cardano-preprod.blockfrost.io/api/v0';
const REWARD = 'stake_test1up4xwpa29a3e6wcu6z4yj4ll3xkd38jy0ftmd53vprnguuq32mvx6';
const POOL = 'pool1vvkurfxhajtj4f7x8wjkeet7rg8amz34duy5nux76per5sn3npx';
const DREP = 'drep1ytcw6qzpqqclx2yd0zy64ztvlkkhnf6yrzza8whgnq4vz5gh89626';

/**
 * Responses recorded from the configured Preprod root.
 *
 * These are not invented shapes. Each one was read off the live endpoint, which is what makes them
 * worth asserting against: three of the fields below mean something other than what their names
 * suggest, and a fixture written from the documentation would have agreed with the mistake.
 */
const RECORDED: Readonly<Record<string, unknown>> = {
  '/epochs/latest': { epoch: 315 },
  '/epochs/latest/parameters': {
    epoch: 315,
    min_fee_a: 44,
    min_fee_b: 155381,
    max_tx_size: 16384,
    coins_per_utxo_size: '4310',
    key_deposit: '2000000',
    pool_deposit: '500000000',
    drep_deposit: '500000000',
    gov_action_deposit: '1000000000',
    min_utxo: '4310'
  },
  [`/accounts/${REWARD}`]: {
    stake_address: REWARD,
    active: true,
    registered: true,
    active_epoch: 308,
    controlled_amount: '10063987031',
    rewards_sum: '8183734',
    withdrawals_sum: '0',
    reserves_sum: '0',
    treasury_sum: '0',
    drep_id: null,
    withdrawable_amount: '8183734',
    pool_id: POOL
  },
  [`/accounts/${REWARD}/rewards?count=100&page=1`]: [
    { epoch: 310, amount: '2203610', pool_id: POOL, type: 'member' },
    { epoch: 311, amount: '1834986', pool_id: POOL, type: 'member' },
    { epoch: 312, amount: '2040456', pool_id: POOL, type: 'member' },
    { epoch: 313, amount: '2104682', pool_id: POOL, type: 'member' }
  ],
  [`/pools/${POOL}`]: {
    pool_id: POOL,
    active_stake: '7567793281422',
    live_stake: '8228974308112',
    registration: ['022972136e2031c25258033369875ba3db342b87af8575b18facf5f1b8a2f3ee'],
    retirement: []
  },
  [`/governance/dreps/${DREP}`]: {
    drep_id: DREP,
    hex: '22f0ed00410031f3288d7889aa896cfdad79a7441885d3bae8982ac151',
    amount: '11818056994',
    active: true,
    active_epoch: 178,
    has_script: false,
    retired: false,
    expired: true,
    last_active_epoch: 178
  },
  '/governance/dreps?count=3&page=1': [
    {
      drep_id: DREP,
      hex: '22f0ed00410031f3288d7889aa896cfdad79a7441885d3bae8982ac151',
      amount: '11818056994',
      has_script: false,
      retired: false,
      expired: true,
      last_active_epoch: 178
    },
    {
      drep_id: 'drep_always_abstain',
      hex: '',
      amount: '431820180184875',
      has_script: false,
      retired: false,
      expired: false,
      last_active_epoch: null
    }
  ]
};

/**
 * A wallet that has never staked, as the live endpoint answers for one.
 *
 * Worth its own fixture because it is the case a reader is most likely to get wrong: this dialect
 * answers `200` with both flags false, not `404`, so "never registered" arrives as data.
 */
const UNUSED_ACCOUNT = {
  stake_address: 'stake_test1uz46h2at4w46h2at4w46h2at4w46h2at4w46h2at4w46h2cwudutw',
  active: false,
  registered: false,
  active_epoch: null,
  controlled_amount: '215430920',
  rewards_sum: '0',
  withdrawals_sum: '0',
  drep_id: null,
  withdrawable_amount: null,
  pool_id: null
};

/**
 * Answers provider calls from a table instead of the network.
 *
 * @param table - Path to response body, or to a `{ status, body }` pair.
 * @returns The recorded requests, so a test can assert what was asked for.
 */
function stubFetch(table: Readonly<Record<string, unknown>>): string[] {
  const asked: string[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = String(input);
    const path = url.startsWith(BASE) ? url.slice(BASE.length) : url;
    asked.push(path);
    const entry = table[path];
    if (entry === undefined) {
      return new Response(JSON.stringify({ status_code: 404, error: 'Not Found' }), {
        status: 404
      });
    }
    const shaped = entry as { status?: number; body?: unknown };
    const status = typeof shaped?.status === 'number' ? shaped.status : 200;
    const body = typeof shaped?.status === 'number' ? shaped.body : entry;
    return new Response(JSON.stringify(body), { status });
  });
  return asked;
}

/**
 * A Blockfrost staking provider reading the recorded responses.
 *
 * @param overrides - Extra or replacement entries.
 * @returns The provider and the list of paths it asked for.
 */
function blockfrost(overrides: Readonly<Record<string, unknown>> = {}) {
  const asked = stubFetch({ ...RECORDED, ...overrides });
  return { provider: new BlockfrostStakingProvider(BASE, 5_000, 'preprodkey'), asked };
}

describe('cardanoStakingProviderService', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('Blockfrost, against responses recorded from Preprod', () => {
    it('reads the staking deposits the transfer parameters do not carry', async () => {
      const { provider } = blockfrost();

      const parameters = await provider.stakingProtocolParameters();

      expect(parameters.stakeAddressDeposit).toBe(2_000_000n);
      expect(parameters.drepDeposit).toBe(500_000_000n);
      // The four a transfer already needed, unchanged.
      expect(parameters.minFeeA).toBe(44);
      expect(parameters.minFeeB).toBe(155_381);
      expect(parameters.coinsPerUtxoByte).toBe(4_310n);
      expect(parameters.maxTxSize).toBe(16_384);
    });

    it('reads a registered, delegated account', async () => {
      const { provider } = blockfrost();

      const account = await provider.stakeAccount(REWARD);

      expect(account.registered).toBe(true);
      expect(account.poolId).toBe(POOL);
      expect(account.withdrawableRewardsLovelace).toBe(8_183_734n);
      expect(account.lifetimeRewardsLovelace).toBe(8_183_734n);
      expect(account.withdrawnLovelace).toBe(0n);
      // This dialect reports no deposit at all. Reporting a figure here would be an invention, and
      // the refund a deregistration owes would be built on it.
      expect(account.depositLovelace).toBeNull();
    });

    it('reads a registered account that delegates its vote to nobody as `none`', async () => {
      // Not `not_registered`, and not a read error. In Conway this exact state is what blocks a
      // reward withdrawal, so the product has to be able to tell it apart from the other two.
      const { provider } = blockfrost();

      const account = await provider.stakeAccount(REWARD);

      expect(account.governanceDelegation).toEqual({ kind: 'none' });
    });

    it('reads a never-used credential from a 200, not from a 404', async () => {
      const address = UNUSED_ACCOUNT.stake_address;
      const { provider } = blockfrost({ [`/accounts/${address}`]: UNUSED_ACCOUNT });

      const account = await provider.stakeAccount(address);

      expect(account.registered).toBe(false);
      expect(account.governanceDelegation).toEqual({ kind: 'not_registered' });
      // Asked for, not assumed: an unregistered credential has no withdrawable balance, and the
      // field the live response leaves null is never read as a figure.
      expect(account.withdrawableRewardsLovelace).toBe(0n);
    });

    it('sums the reward history to exactly the withdrawable balance', async () => {
      // The two come from different endpoints. That they agree is the check that the history is
      // being read whole and keyed per credit rather than collapsed.
      const { provider } = blockfrost();

      const history = await provider.rewardHistory(REWARD);
      const account = await provider.stakeAccount(REWARD);

      const total = history.credits.reduce((sum, credit) => sum + credit.amountLovelace, 0n);
      expect(total).toBe(account.withdrawableRewardsLovelace);
      expect(history.completeness).toBe('complete');
      expect(history.credits).toHaveLength(4);
    });

    it('gives every reward credit a key that separates the epochs', async () => {
      const { provider } = blockfrost();

      const history = await provider.rewardHistory(REWARD);

      const keys = new Set(history.credits.map((credit) => credit.sourceKey));
      expect(keys.size).toBe(history.credits.length);
      expect(history.credits[0]?.sourceKey).toBe(`member:${POOL}:310`);
    });

    it('stops paging at the first short page', async () => {
      const { provider, asked } = blockfrost();

      await provider.rewardHistory(REWARD);

      expect(asked.filter((path) => path.includes('/rewards'))).toEqual([
        `/accounts/${REWARD}/rewards?count=100&page=1`
      ]);
    });

    it('reports a partial history rather than a short one when paging hits the ceiling', async () => {
      // A truncated history read as complete produces lifetime earnings that look plausible and
      // are wrong, and nothing downstream could tell.
      const full = Array.from({ length: 100 }, (_, index) => ({
        epoch: 200 + index,
        amount: '1000000',
        pool_id: POOL,
        type: 'member'
      }));
      const pages = Object.fromEntries(
        Array.from({ length: 20 }, (_, index) => [
          `/accounts/${REWARD}/rewards?count=100&page=${index + 1}`,
          full
        ])
      );
      const { provider } = blockfrost(pages);

      const history = await provider.rewardHistory(REWARD);

      expect(history.completeness).toBe('partial');
      expect(history.credits).toHaveLength(2_000);
    });

    it('reads a pool with no retirement on record', async () => {
      const { provider } = blockfrost();

      const pool = await provider.poolState(POOL);

      expect(pool?.retirementScheduled).toBe(false);
      expect(pool?.activeStakeLovelace).toBe(7_567_793_281_422n);
    });

    it('reads a retirement certificate as a retirement, without claiming the epoch', async () => {
      // The live response lists retirement certificates by transaction hash. A reader that took
      // that list for a list of epochs would report a transaction hash as the retiring epoch.
      const { provider } = blockfrost({
        [`/pools/${POOL}`]: {
          active_stake: '0',
          retirement: ['bbda7432ed3c90f3e78879f45148b158fc015f9820213c57ad6814cf545c593d']
        }
      });

      const pool = await provider.poolState(POOL);

      expect(pool?.retirementScheduled).toBe(true);
      expect(pool?.retiringEpoch).toBeNull();
    });

    it('answers null for a pool the provider does not know', async () => {
      const { provider } = blockfrost();

      expect(
        await provider.poolState('pool1unknownunknownunknownunknownunknownunknown')
      ).toBeNull();
    });

    it('identifies a DRep from its identifier, not from its `hex`', async () => {
      // `hex` on a DRep is the CIP-129 payload: the header byte and the hash, 29 bytes. Taking it
      // for the 28-byte credential would put an identity on file that is off by one byte.
      const { provider } = blockfrost();

      const drep = await provider.drepState(DREP);

      expect(drep?.idCip129).toBe(DREP);
      expect(drep?.credential.hashHex).toBe(
        'f0ed00410031f3288d7889aa896cfdad79a7441885d3bae8982ac151'
      );
      expect(drep?.credential.hashHex).toHaveLength(56);
      expect(drep?.votingPowerLovelace).toBe(11_818_056_994n);
    });

    it('reads an expired DRep as expired, not as active', async () => {
      // The live response says `active: true` and `expired: true` at once. A DRep past its activity
      // window keeps its delegators and stops counting, so offering it hands a voice to nobody.
      const { provider } = blockfrost();

      expect((await provider.drepState(DREP))?.status).toBe('expired');
    });

    it('answers null for a DRep the provider does not know', async () => {
      const { provider } = blockfrost();
      const unknown = 'drep1ygqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq7vlc9n';

      expect(await provider.drepState(unknown)).toBeNull();
    });

    it('refuses an unreadable DRep identifier before spending a call on it', async () => {
      const { provider, asked } = blockfrost();

      await expect(provider.drepState('not-a-drep')).rejects.toThrow(
        'CARDANO_PROVIDER_DREP_UNREADABLE'
      );
      expect(asked).toEqual([]);
    });

    it('leaves the predefined targets and the expired ones out of the list', async () => {
      // `drep_always_abstain` is a delegation target but not a credential; the domain carries it as
      // a kind of its own. The expired one is left out for a different reason: it cannot vote.
      const { provider } = blockfrost();

      const dreps = await provider.listDReps(3);

      expect(dreps).toEqual([]);
    });

    it('keeps an active DRep in the list', async () => {
      const { provider } = blockfrost({
        '/governance/dreps?count=3&page=1': [
          {
            drep_id: DREP,
            hex: '',
            amount: '42',
            has_script: false,
            retired: false,
            expired: false
          }
        ]
      });

      const dreps = await provider.listDReps(3);

      expect(dreps).toHaveLength(1);
      expect(dreps[0]?.idCip129).toBe(DREP);
      expect(dreps[0]?.status).toBe('active');
    });

    it('reads the current epoch', async () => {
      const { provider } = blockfrost();

      expect(await provider.currentEpoch()).toBe(315);
    });
  });

  describe('what a provider is not allowed to leave out', () => {
    it('refuses an account whose registration flags are both missing', async () => {
      const { provider } = blockfrost({
        [`/accounts/${REWARD}`]: { stake_address: REWARD, pool_id: null, drep_id: null }
      });

      await expect(provider.stakeAccount(REWARD)).rejects.toThrow('CARDANO_PROVIDER_ACCOUNT_SHAPE');
    });

    it('refuses a registered account with no withdrawable figure', async () => {
      // Reading a missing amount as zero would present a reward account as empty, and the rewards
      // the user owns would simply not be offered.
      const { provider } = blockfrost({
        [`/accounts/${REWARD}`]: {
          stake_address: REWARD,
          registered: true,
          active: true,
          pool_id: POOL,
          drep_id: null,
          withdrawable_amount: null
        }
      });

      await expect(provider.stakeAccount(REWARD)).rejects.toThrow(
        'CARDANO_PROVIDER_AMOUNT_MISSING'
      );
    });

    it('refuses parameters with no registration deposit', async () => {
      const { provider } = blockfrost({
        '/epochs/latest/parameters': {
          min_fee_a: 44,
          min_fee_b: 155381,
          max_tx_size: 16384,
          coins_per_utxo_size: '4310'
        }
      });

      await expect(provider.stakingProtocolParameters()).rejects.toThrow(
        'CARDANO_PROVIDER_AMOUNT_MISSING'
      );
    });
  });

  describe('normalising a vote delegation', () => {
    it('separates the three facts a delegation field can carry', () => {
      expect(normalizeGovernanceDelegation(null, false)).toEqual({ kind: 'not_registered' });
      expect(normalizeGovernanceDelegation(null, true)).toEqual({ kind: 'none' });
      expect(normalizeGovernanceDelegation('', true)).toEqual({ kind: 'none' });
    });

    it('reads the predefined targets however they are punctuated', () => {
      for (const spelling of ['drep_always_abstain', 'DRepAlwaysAbstain', 'always-abstain']) {
        expect(normalizeGovernanceDelegation(spelling, true).kind).toBe('always_abstain');
      }
      for (const spelling of ['drep_always_no_confidence', 'AlwaysNoConfidence']) {
        expect(normalizeGovernanceDelegation(spelling, true).kind).toBe('always_no_confidence');
      }
    });

    it('canonicalises a real DRep and keeps the legacy spelling beside it', () => {
      const delegation = normalizeGovernanceDelegation(DREP, true);

      expect(delegation.kind).toBe('drep');
      expect(delegation.idCip129).toBe(DREP);
      expect(delegation.idLegacy).toMatch(/^drep_vkh1/);
    });

    it('raises on a value it cannot classify rather than reading it as `none`', () => {
      // This is the whole point. A credential delegated to something this code has not been taught
      // would otherwise be reported as delegating to nobody — and the product would offer to
      // delegate it, overwriting a choice the user made elsewhere.
      for (const raw of ['drep_always_maybe', 'garbage', 42, {}]) {
        expect(() => normalizeGovernanceDelegation(raw, true)).toThrow(CardanoProviderError);
        expect(() => normalizeGovernanceDelegation(raw, true)).toThrow(
          'CARDANO_PROVIDER_GOVERNANCE_UNREADABLE'
        );
      }
    });

    it('answers not_registered before looking at the field at all', () => {
      // An unregistered credential cannot have delegated, whatever the provider left in the field.
      expect(normalizeGovernanceDelegation('garbage', false)).toEqual({ kind: 'not_registered' });
    });
  });

  describe('reading amounts', () => {
    it('accepts the string and number spellings both providers use', () => {
      expect(requiredLovelace('2000000', 'x')).toBe(2_000_000n);
      expect(requiredLovelace(2_000_000, 'x')).toBe(2_000_000n);
      expect(optionalLovelace('0', 'x')).toBe(0n);
    });

    it('keeps absent apart from unreadable', () => {
      expect(optionalLovelace(null, 'x')).toBeNull();
      expect(optionalLovelace(undefined, 'x')).toBeNull();
      expect(optionalLovelace('', 'x')).toBeNull();
      expect(() => optionalLovelace('1.5', 'x')).toThrow('CARDANO_PROVIDER_AMOUNT_UNREADABLE');
      expect(() => optionalLovelace('abc', 'x')).toThrow('CARDANO_PROVIDER_AMOUNT_UNREADABLE');
      expect(() => optionalLovelace(1.5, 'x')).toThrow('CARDANO_PROVIDER_AMOUNT_UNREADABLE');
      expect(() => requiredLovelace(null, 'x')).toThrow('CARDANO_PROVIDER_AMOUNT_MISSING');
    });

    it('carries an amount no double could hold', () => {
      // The whole Cardano supply in lovelace exceeds what a double represents exactly.
      expect(requiredLovelace('45000000000000000', 'x')).toBe(45_000_000_000_000_000n);
    });
  });

  describe('reading flags', () => {
    it('prefers the registration flag over the activity one', () => {
      // A credential can be registered — a deposit is held — while not delegating anywhere.
      expect(readRegistrationFlags(true, false)).toBe(true);
      expect(readRegistrationFlags(false, true)).toBe(false);
      expect(readRegistrationFlags(undefined, true)).toBe(true);
      expect(() => readRegistrationFlags(undefined, undefined)).toThrow(
        'CARDANO_PROVIDER_ACCOUNT_SHAPE'
      );
    });

    it('puts retirement above expiry', () => {
      expect(readDRepStatus(true, true)).toBe('retired');
      expect(readDRepStatus(false, true)).toBe('expired');
      expect(readDRepStatus(false, false)).toBe('active');
      expect(readDRepStatus(undefined, undefined)).toBe('active');
    });

    it('refuses a Koios status it cannot read', () => {
      expect(readKoiosStatus('registered')).toBe(true);
      expect(readKoiosStatus('not registered')).toBe(false);
      expect(() => readKoiosStatus('pending')).toThrow(
        'CARDANO_PROVIDER_ACCOUNT_STATUS_UNREADABLE'
      );
      expect(() => readKoiosStatus(undefined)).toThrow(
        'CARDANO_PROVIDER_ACCOUNT_STATUS_UNREADABLE'
      );
    });

    it('refuses a Koios pool status it cannot read', () => {
      expect(readKoiosPoolStatus('registered')).toBe(false);
      expect(readKoiosPoolStatus('retiring')).toBe(true);
      expect(readKoiosPoolStatus('retired')).toBe(true);
      expect(() => readKoiosPoolStatus('unknown')).toThrow(
        'CARDANO_PROVIDER_POOL_STATUS_UNREADABLE'
      );
    });
  });

  describe('reward identity', () => {
    it('never keys a credit by its amount', () => {
      // Two epochs paying the same amount is ordinary. A key carrying it would merge them, and
      // lifetime earnings would look as though they had stopped growing.
      expect(rewardSourceKey('member', POOL, 310)).not.toBe(rewardSourceKey('member', POOL, 311));
      expect(rewardSourceKey('member', POOL, 310)).toBe(rewardSourceKey('member', POOL, 310));
    });

    it('separates two kinds of credit in the same epoch', () => {
      // A pool operator earns both a member and a leader reward for the same epoch.
      expect(rewardSourceKey('member', POOL, 310)).not.toBe(rewardSourceKey('leader', POOL, 310));
    });
  });

  describe('choosing a dialect', () => {
    it('builds the provider the configuration names', () => {
      expect(buildStakingProvider('blockfrost', BASE, 1_000, 'k')).toBeInstanceOf(
        BlockfrostStakingProvider
      );
      expect(
        buildStakingProvider('koios', 'https://preprod.koios.rest/api/v1', 1_000, '')
      ).toBeInstanceOf(KoiosStakingProvider);
    });
  });
});
