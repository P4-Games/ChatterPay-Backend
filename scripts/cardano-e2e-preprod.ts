/**
 * End-to-end proof that ChatterPay moves real ADA on Cardano Preprod, phone to phone.
 *
 * This is the live suite of `CARDANO_INTEGRATION_PLAN.md` §10.5, and it is a script rather than a
 * vitest test on purpose: it needs real funds, it waits for real blocks, and it fails for reasons
 * that are not the code's (a provider outage, an empty wallet). Putting that in CI would train
 * everyone to ignore a red build.
 *
 * It exercises the same path `make_transaction` takes: a sender phone number and a destination that
 * is another phone number, resolved into Cardano wallets through Mongo, and only then a transfer.
 * The recipient does not need to exist beforehand — the address is a function of the phone number,
 * so it is provisioned on the way through.
 *
 * What it proves that no fake can: that the bytes this codebase produces are bytes a Cardano node
 * accepts. Everything else is covered by unit tests against fabricated UTxOs.
 *
 * Usage:
 *   MONGO_URI=... bun run scripts/cardano-e2e-preprod.ts [--amount <ADA>] [--to <phone|addr>]
 *                                                        [--no-wait] [--keep]
 *
 * On WSL, MongoDB on the Windows host is not reachable at 127.0.0.1: use the host IP from
 * `ip route show default`, e.g. mongodb://172.30.64.1:27017/chatterpay-dev
 */

import 'dotenv/config';
import mongoose from 'mongoose';
import { getCardanoConfig } from '../src/config/cardanoConfig';
import { fromBaseUnits, lovelaceToAda, toBaseUnits } from '../src/helpers/cardanoAmountHelper';
import { Logger } from '../src/helpers/loggerHelper';
import { UserModel } from '../src/models/userModel';
import {
  executeCardanoOperation,
  resolveCardanoToken
} from '../src/services/cardano/cardanoOperationService';
import { buildCardanoProvider } from '../src/services/cardano/cardanoProviderService';
import { assetBalance, spendableBalance } from '../src/services/cardano/cardanoTxService';
import {
  deriveCardanoAccount,
  getOrCreateCardanoWallet
} from '../src/services/cardano/cardanoWalletService';

/** Test identities. Not real users: phone numbers reserved for this walkthrough. */
const SENDER_PHONE = '5491100000001';
const DEFAULT_RECIPIENT_PHONE = '5491100000002';

const CONFIRMATION_TIMEOUT_MS = 5 * 60 * 1000;
const POLL_INTERVAL_MS = 10_000;

/** Correlation key every line of this run is logged under. */
const LOG_KEY = 'cardanoE2EPreprod';

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function step(title: string): void {
  Logger.info(LOG_KEY, `── ${title}`);
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function main(): Promise<number> {
  const uri = process.env.MONGO_URI;
  if (!uri) {
    Logger.error(LOG_KEY, 'MONGO_URI is missing');
    return 1;
  }

  // The script drives Cardano directly, so it does not require the deployment-wide flag.
  process.env.CARDANO_ENABLED = 'true';
  const config = getCardanoConfig();
  const provider = buildCardanoProvider();

  const amount = arg('amount') ?? '2';
  const to = arg('to') ?? DEFAULT_RECIPIENT_PHONE;
  // Any ticker registered on this network. A native asset takes the multiasset path, where the
  // protocol forces ADA to travel with the token.
  const tokenSymbol = arg('token') ?? 'ADA';

  step('Configuration');
  Logger.log(LOG_KEY, `network  : Cardano ${config.network} (internal chainId ${config.chainId})`);
  Logger.log(LOG_KEY, `provider : ${config.providerUrl}`);
  Logger.log(LOG_KEY, `mongo    : ${uri.replace(/\/\/[^@]*@/, '//***@')}`);

  await mongoose.connect(uri, { serverSelectionTimeoutMS: 8000 });

  try {
    step('Wallet resolution from the phone number');
    const { user: sender, wallet: senderWallet } = await getOrCreateCardanoWallet(SENDER_PHONE);
    Logger.log(LOG_KEY, `sender      ${SENDER_PHONE}`);
    Logger.log(
      LOG_KEY,
      `            ${senderWallet.address} ${senderWallet.wasCreated ? '(provisioned now)' : '(already existed)'}`
    );
    Logger.log(LOG_KEY, `destination ${to}`);
    if (!to.startsWith('addr')) {
      const preview = deriveCardanoAccount(to);
      Logger.log(
        LOG_KEY,
        `            ${preview.address} (derived from the phone, nothing written)`
      );
    }

    step('On-chain state');
    const tip = await provider.tip();
    const senderUtxos = await provider.utxosFor(senderWallet.address);
    const senderReady = await provider.confirmedUtxosFor(
      senderWallet.address,
      config.depositConfirmations
    );
    const destinationAddress = to.startsWith('addr') ? to : deriveCardanoAccount(to).address;
    const destinationUtxos = await provider.utxosFor(destinationAddress);
    const recipientBefore = spendableBalance(destinationUtxos);
    const adaBefore = destinationUtxos.reduce((sum, utxo) => sum + utxo.lovelace, 0n);
    const token = await resolveCardanoToken(tokenSymbol, config.chainId);
    const tokenBefore = token.asset ? assetBalance(destinationUtxos, token.asset) : 0n;

    Logger.log(LOG_KEY, `tip         : slot ${tip.slot}, height ${tip.height}`);
    Logger.log(
      LOG_KEY,
      `sender      : ${senderUtxos.length} UTxO(s), ${lovelaceToAda(spendableBalance(senderUtxos))} ADA total, ` +
        `${lovelaceToAda(spendableBalance(senderReady))} ADA spendable (${config.depositConfirmations} conf.)`
    );
    Logger.log(LOG_KEY, `destination : ${lovelaceToAda(recipientBefore)} ADA`);

    step(`Transfer of ${amount} ${tokenSymbol} (phone -> phone)`);
    const started = Date.now();
    const result = await executeCardanoOperation({
      fromUser: sender,
      to,
      amount,
      token: tokenSymbol,
      logKey: '[e2e:cardano:preprod]',
      provider
    });

    if (!result.success) {
      Logger.error(LOG_KEY, `${result.errorCode}: ${result.error}`);
      if (result.errorCode === 'CARDANO_INSUFFICIENT_FUNDS') {
        Logger.error(LOG_KEY, `Fund this address with Preprod tADA: ${senderWallet.address}`);
        Logger.error(LOG_KEY, 'Faucet: https://docs.cardano.org/cardano-testnets/tools/faucet');
        Logger.error(
          LOG_KEY,
          `It takes ${config.depositConfirmations} confirmations (~1 min) before it is spendable.`
        );
        return 0;
      }
      return 1;
    }

    Logger.info(LOG_KEY, `submitted in ${((Date.now() - started) / 1000).toFixed(1)}s`);
    Logger.log(LOG_KEY, `  from     : ${result.fromAddress}`);
    Logger.log(LOG_KEY, `  to       : ${result.toAddress}`);
    Logger.log(LOG_KEY, `  asset    : ${amount} ${result.tokenSymbol}`);
    Logger.log(LOG_KEY, `  tx       : ${result.transactionHash}`);
    Logger.log(LOG_KEY, `  network fee : ${result.networkFeeAda} ADA`);
    if (result.tokenSymbol.toUpperCase() !== 'ADA') {
      // Not a fee: the protocol will not carry a token in an output without ADA beside it, so this
      // leaves the sender and arrives at the recipient along with the token.
      Logger.log(LOG_KEY, `  ADA attached to the token : ${result.sentAda} ADA`);
    }
    Logger.log(LOG_KEY, `  explorer : ${result.explorerUrl}`);
    if (result.toUser) {
      Logger.log(LOG_KEY, `  recipient : ChatterPay user ${result.toUser.phone_number}`);
    }

    if (process.argv.includes('--no-wait')) return 0;

    step('Waiting for on-chain confirmation');
    const deadline = Date.now() + CONFIRMATION_TIMEOUT_MS;
    let confirmed = false;
    while (Date.now() < deadline) {
      const status = await provider.statusOf(result.transactionHash);
      if (status.known) {
        Logger.info(LOG_KEY, `confirmed (${status.confirmations} confirmation/s)`);
        confirmed = true;
        break;
      }
      Logger.log(LOG_KEY, 'not visible yet, polling again');
      await sleep(POLL_INTERVAL_MS);
    }
    if (!confirmed) {
      Logger.warn(LOG_KEY, 'did not show up within the timeout (it may still appear)');
      return 1;
    }

    step('On-chain balance verification');
    const after = await provider.utxosFor(result.toAddress);
    let ok: boolean;

    if (token.isAda) {
      // Compared in lovelace, never in ADA-as-a-float: a lovelace of rounding would read as a
      // mismatch that is not there.
      const delta = spendableBalance(after) - recipientBefore;
      const expected = toBaseUnits(amount, token.decimals, 'ADA');
      Logger.log(LOG_KEY, `destination before : ${lovelaceToAda(recipientBefore)} ADA`);
      Logger.log(LOG_KEY, `destination after  : ${lovelaceToAda(spendableBalance(after))} ADA`);
      Logger.log(LOG_KEY, `difference         : ${lovelaceToAda(delta)} ADA (expected ${amount})`);
      ok = delta === expected;
    } else {
      const asset = token.asset!;
      const tokenDelta = assetBalance(after, asset) - tokenBefore;
      const expectedTokens = toBaseUnits(amount, token.decimals, token.symbol);
      const adaDelta = after.reduce((sum, utxo) => sum + utxo.lovelace, 0n) - adaBefore;
      Logger.log(
        LOG_KEY,
        `${token.symbol} received : ${fromBaseUnits(tokenDelta, token.decimals)} ` +
          `(expected ${amount})`
      );
      Logger.log(
        LOG_KEY,
        `attached ADA received : ${lovelaceToAda(adaDelta)} (expected ${result.sentAda})`
      );
      // Both have to be right: the token arriving without its ADA is not a state the chain permits,
      // so a mismatch on either side means the transaction was not what we think it was.
      ok = tokenDelta === expectedTokens && lovelaceToAda(adaDelta) === result.sentAda;
    }

    if (ok) {
      Logger.info(
        LOG_KEY,
        `E2E OK: real ${tokenSymbol} transfer on Preprod, resolved from phone numbers.`
      );
    } else {
      Logger.error(LOG_KEY, 'E2E FAILED: the destination balance did not rise as expected.');
    }

    if (!process.argv.includes('--keep')) {
      // The walkthrough users are fixtures, not data. Left behind they would show up in any query
      // over real users, which is how a test account ends up in a report.
      const removed = await UserModel.deleteMany({
        phone_number: { $in: [SENDER_PHONE, DEFAULT_RECIPIENT_PHONE] }
      });
      Logger.log(
        LOG_KEY,
        `cleanup: ${removed.deletedCount} test user(s) deleted; --keep preserves them`
      );
    }

    return ok ? 0 : 1;
  } finally {
    await mongoose.disconnect();
  }
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    Logger.error(
      LOG_KEY,
      `unexpected error: ${error instanceof Error ? error.message : String(error)}`
    );
    process.exit(1);
  });
