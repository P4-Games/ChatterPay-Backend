import { createRelayClient } from './services/polymarket/polymarketRelayerService';

async function test() {
  console.log('Testing RelayClient creation...');
  const privateKey = '0x0123456789012345678901234567890123456789012345678901234567890123';

  try {
    const client = createRelayClient(privateKey);
    console.log('RelayClient created successfully!');

    console.log('Testing signer access (this triggers createAbstractSigner):');
    // @ts-expect-error
    console.log('Signer address:', await client.signer.getAddress());

    console.log('SUCCESS: Fix is working!');
  } catch (e: any) {
    console.error('FAIL: Error still occurring:');
    console.error(e.message);
    if (e.stack) console.error(e.stack);
    process.exit(1);
  }
}

test();
