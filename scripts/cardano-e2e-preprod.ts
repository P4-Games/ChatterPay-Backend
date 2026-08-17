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
import {
  fromBaseUnits,
  lovelaceToAda,
  toBaseUnits
} from '../src/helpers/cardanoAmountHelper';
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

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function step(title: string): void {
  console.log(`\n\x1b[1m── ${title}\x1b[0m`);
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function main(): Promise<number> {
  const uri = process.env.MONGO_URI;
  if (!uri) {
    console.error('❌ falta MONGO_URI');
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

  step('Configuración');
  console.log(`  red      : Cardano ${config.network} (chainId interno ${config.chainId})`);
  console.log(`  provider : ${config.providerUrl}`);
  console.log(`  mongo    : ${uri.replace(/\/\/[^@]*@/, '//***@')}`);

  await mongoose.connect(uri, { serverSelectionTimeoutMS: 8000 });

  try {
    step('Resolución de wallets desde el teléfono');
    const { user: sender, wallet: senderWallet } = await getOrCreateCardanoWallet(SENDER_PHONE);
    console.log(`  emisor   ${SENDER_PHONE}`);
    console.log(`           ${senderWallet.address} ${senderWallet.wasCreated ? '(provisionada ahora)' : '(ya existía)'}`);
    console.log(`  destino  ${to}`);
    if (!to.startsWith('addr')) {
      const preview = deriveCardanoAccount(to);
      console.log(`           ${preview.address} (derivada del teléfono, sin escribir nada)`);
    }

    step('Estado en la cadena');
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

    console.log(`  tip      : slot ${tip.slot}, altura ${tip.height}`);
    console.log(
      `  emisor   : ${senderUtxos.length} UTxO(s), ${lovelaceToAda(spendableBalance(senderUtxos))} ADA total, ` +
        `${lovelaceToAda(spendableBalance(senderReady))} ADA gastable (${config.depositConfirmations} conf.)`
    );
    console.log(`  destino  : ${lovelaceToAda(recipientBefore)} ADA`);

    step(`Transferencia de ${amount} ${tokenSymbol} (teléfono -> teléfono)`);
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
      console.log(`  ❌ ${result.errorCode}`);
      console.log(`     ${result.error}`);
      if (result.errorCode === 'CARDANO_INSUFFICIENT_FUNDS') {
        console.log(`\n  Fondeá esta address con tADA de Preprod:\n`);
        console.log(`      ${senderWallet.address}\n`);
        console.log('  Faucet: https://docs.cardano.org/cardano-testnets/tools/faucet');
        console.log(
          `  Hacen falta ${config.depositConfirmations} confirmaciones (~1 min) antes de gastarlo.`
        );
        return 0;
      }
      return 1;
    }

    console.log(`  ✅ enviada en ${((Date.now() - started) / 1000).toFixed(1)}s`);
    console.log(`     de       : ${result.fromAddress}`);
    console.log(`     a        : ${result.toAddress}`);
    console.log(`     activo   : ${amount} ${result.tokenSymbol}`);
    console.log(`     tx       : ${result.transactionHash}`);
    console.log(`     fee red  : ${result.networkFeeAda} ADA`);
    if (result.tokenSymbol.toUpperCase() !== 'ADA') {
      // Not a fee: the protocol will not carry a token in an output without ADA beside it, so this
      // leaves the sender and arrives at the recipient along with the token.
      console.log(`     ADA adjunta al token : ${result.sentAda} ADA`);
    }
    console.log(`     explorer : ${result.explorerUrl}`);
    if (result.toUser) {
      console.log(`     receptor : usuario ChatterPay ${result.toUser.phone_number}`);
    }

    if (process.argv.includes('--no-wait')) return 0;

    step('Esperando confirmación en la cadena');
    const deadline = Date.now() + CONFIRMATION_TIMEOUT_MS;
    let confirmed = false;
    while (Date.now() < deadline) {
      const status = await provider.statusOf(result.transactionHash);
      if (status.known) {
        console.log(`  confirmada (${status.confirmations} confirmación/es)`);
        confirmed = true;
        break;
      }
      process.stdout.write('  .');
      await sleep(POLL_INTERVAL_MS);
    }
    if (!confirmed) {
      console.log('\n  ⚠️  no apareció dentro del tiempo de espera (puede aparecer todavía)');
      return 1;
    }

    step('Verificación de saldos en la cadena');
    const after = await provider.utxosFor(result.toAddress);
    let ok: boolean;

    if (token.isAda) {
      // Compared in lovelace, never in ADA-as-a-float: a lovelace of rounding would read as a
      // mismatch that is not there.
      const delta = spendableBalance(after) - recipientBefore;
      const expected = toBaseUnits(amount, token.decimals, 'ADA');
      console.log(`  destino antes   : ${lovelaceToAda(recipientBefore)} ADA`);
      console.log(`  destino después : ${lovelaceToAda(spendableBalance(after))} ADA`);
      console.log(`  diferencia      : ${lovelaceToAda(delta)} ADA (esperado ${amount})`);
      ok = delta === expected;
    } else {
      const asset = token.asset!;
      const tokenDelta = assetBalance(after, asset) - tokenBefore;
      const expectedTokens = toBaseUnits(amount, token.decimals, token.symbol);
      const adaDelta = after.reduce((sum, utxo) => sum + utxo.lovelace, 0n) - adaBefore;
      console.log(
        `  ${token.symbol} recibido : ${fromBaseUnits(tokenDelta, token.decimals)} ` +
          `(esperado ${amount})`
      );
      console.log(`  ADA adjunta recibida : ${lovelaceToAda(adaDelta)} (esperado ${result.sentAda})`);
      // Both have to be right: the token arriving without its ADA is not a state the chain permits,
      // so a mismatch on either side means the transaction was not what we think it was.
      ok = tokenDelta === expectedTokens && lovelaceToAda(adaDelta) === result.sentAda;
    }

    console.log(
      ok
        ? `\n\x1b[32m✅ E2E OK: transferencia real de ${tokenSymbol} en Preprod, resuelta desde teléfonos.\x1b[0m`
        : '\n\x1b[31m❌ E2E FALLÓ: el saldo del destino no subió lo esperado.\x1b[0m'
    );

    if (!process.argv.includes('--keep')) {
      // The walkthrough users are fixtures, not data. Left behind they would show up in any query
      // over real users, which is how a test account ends up in a report.
      const removed = await UserModel.deleteMany({
        phone_number: { $in: [SENDER_PHONE, DEFAULT_RECIPIENT_PHONE] }
      });
      console.log(`\n  (limpieza: ${removed.deletedCount} usuario(s) de prueba borrados; --keep los conserva)`);
    }

    return ok ? 0 : 1;
  } finally {
    await mongoose.disconnect();
  }
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error('\n❌ error inesperado:', error);
    process.exit(1);
  });
