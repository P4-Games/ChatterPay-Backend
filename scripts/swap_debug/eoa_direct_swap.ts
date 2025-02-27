/* eslint-disable no-console */
import dotenv from 'dotenv';
import { ethers } from 'ethers';

// Cargar variables de entorno
dotenv.config();

/**
 * Realiza un swap directo usando el Router de Uniswap
 * No utiliza Account Abstraction, llama directamente desde una EOA
 */
async function executeDirectSwap() {
  console.log('=====================================================');
  console.log('SWAP DIRECTO CON ROUTER UNISWAP');
  console.log('=====================================================');
  
  // Obtener configuración desde variables de entorno
  const RPC_URL = ('https://arbitrum-sepolia.infura.io/v3/INF_KEY').replace('INF_KEY', process.env.INFURA_API_KEY ?? '');
  const PRIVATE_KEY = process.env.SIGNING_KEY;
  const ROUTER_ADDRESS = process.env.ROUTER_ADDRESS || '0x101F443B4d1b059569D643917553c771E1b9663E';
  const TOKEN_IN = process.env.TOKEN_IN || '0xE9C723D01393a437bac13CE8f925A5bc8E1c335c'; // WETH
  const TOKEN_OUT = process.env.TOKEN_OUT || '0xe6B817E31421929403040c3e42A6a5C5D2958b4A'; // USDT
  const AMOUNT = process.env.AMOUNT || '0.1'; // Cantidad pequeña para prueba
  
  // Validar la clave privada
  if (!PRIVATE_KEY) {
    console.error('ERROR: PRIVATE_KEY no está configurada en el archivo .env');
    process.exit(1);
  }
  
  // Configurar provider y signer
  const provider = new ethers.providers.JsonRpcProvider(RPC_URL);
  const signer = new ethers.Wallet(PRIVATE_KEY, provider);
  console.log(`Ejecutando como: ${signer.address}`);
  
  // ABI simplificado para ERC20
  const erc20ABI = [
    "function balanceOf(address) view returns (uint256)",
    "function decimals() view returns (uint8)",
    "function symbol() view returns (string)",
    "function allowance(address,address) view returns (uint256)",
    "function approve(address, uint256) returns (bool)"
  ];
  
  // ABI simplificado para el Router de Uniswap
  const routerABI = [
    "function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96)) external payable returns (uint256 amountOut)"
  ];
  
  // Inicializar contratos
  const tokenInContract = new ethers.Contract(TOKEN_IN, erc20ABI, provider);
  const tokenOutContract = new ethers.Contract(TOKEN_OUT, erc20ABI, provider);
  const routerContract = new ethers.Contract(ROUTER_ADDRESS, routerABI, signer);
  
  // Obtener información de tokens
  const [tokenInSymbol, tokenInDecimals, tokenOutSymbol, tokenOutDecimals] = await Promise.all([
    tokenInContract.symbol(),
    tokenInContract.decimals(),
    tokenOutContract.symbol(),
    tokenOutContract.decimals()
  ]);
  
  console.log(`TokenIn: ${tokenInSymbol} (${tokenInDecimals} decimales) - ${TOKEN_IN}`);
  console.log(`TokenOut: ${tokenOutSymbol} (${tokenOutDecimals} decimales) - ${TOKEN_OUT}`);
  console.log(`Router: ${ROUTER_ADDRESS}`);
  
  // Convertir el monto a la unidad correcta
  const amountIn = ethers.utils.parseUnits(AMOUNT, tokenInDecimals);
  console.log(`Cantidad a swapear: ${AMOUNT} ${tokenInSymbol}`);
  
  // Verificar balance
  const balance = await tokenInContract.balanceOf(signer.address);
  console.log(`Balance actual: ${ethers.utils.formatUnits(balance, tokenInDecimals)} ${tokenInSymbol}`);
  
  if (balance.lt(amountIn)) {
    console.error(`ERROR: Balance insuficiente. Necesitas al menos ${AMOUNT} ${tokenInSymbol}`);
    process.exit(1);
  }
  
  // Verificar allowance
  const allowance = await tokenInContract.allowance(signer.address, ROUTER_ADDRESS);
  console.log(`Allowance actual: ${ethers.utils.formatUnits(allowance, tokenInDecimals)} ${tokenInSymbol}`);
  
  // Aprobar el router si es necesario
  if (allowance.lt(amountIn)) {
    console.log('Aprobando tokens para el router...');
    const tokenInWithSigner = tokenInContract.connect(signer);
    const approveTx = await tokenInWithSigner.approve(ROUTER_ADDRESS, ethers.constants.MaxUint256);
    console.log(`Transacción de aprobación enviada: ${approveTx.hash}`);
    await approveTx.wait();
    console.log('Aprobación confirmada');
  } else {
    console.log('Ya hay suficiente allowance, omitiendo aprobación');
  }
  
  // Calcular amountOutMin con slippage de 90%
  const slippagePercent = 90; // 90% slippage para pruebas
  const expectedOut = amountIn; // Para un pool 1:1
  const amountOutMin = expectedOut.mul(100 - slippagePercent).div(100);
  
  console.log(`Slippage configurado: ${slippagePercent}%`);
  console.log(`Mínimo esperado: ${ethers.utils.formatUnits(amountOutMin, tokenOutDecimals)} ${tokenOutSymbol}`);
  
  // Leer balance inicial de token de salida
  const initialOutBalance = await tokenOutContract.balanceOf(signer.address);
  console.log(`Balance inicial de ${tokenOutSymbol}: ${ethers.utils.formatUnits(initialOutBalance, tokenOutDecimals)}`);
  
  try {
    // Definir los parámetros del swap
    const params = {
      tokenIn: TOKEN_IN,
      tokenOut: TOKEN_OUT,
      fee: 3000, // 0.3%
      recipient: signer.address,
      amountIn,
      amountOutMinimum: amountOutMin,
      sqrtPriceLimitX96: 0
    };
    
    console.log('\nEjecutando swap con los siguientes parámetros:');
    console.log(JSON.stringify(params, (key, value) => 
      typeof value === 'bigint' || ethers.BigNumber.isBigNumber(value) ? value.toString() : value, 2));
    
    // Ejecutar el swap
    const swapTx = await routerContract.exactInputSingle(params);
    console.log(`Transacción de swap enviada: ${swapTx.hash}`);
    
    // Esperar a que la transacción sea minada
    console.log('Esperando confirmación...');
    const receipt = await swapTx.wait();
    console.log(`Transacción confirmada en el bloque ${receipt.blockNumber}`);
    
    // Verificar balance final
    const finalOutBalance = await tokenOutContract.balanceOf(signer.address);
    const outDiff = finalOutBalance.sub(initialOutBalance);
    
    console.log(`\nBalance final de ${tokenOutSymbol}: ${ethers.utils.formatUnits(finalOutBalance, tokenOutDecimals)}`);
    console.log(`Tokens ${tokenOutSymbol} recibidos: ${ethers.utils.formatUnits(outDiff, tokenOutDecimals)}`);
    
    if (outDiff.gt(0)) {
      console.log('\n✅ SWAP EXITOSO!');
      return true;
    } 
      console.error('\n❌ ERROR: No se recibieron tokens');
      return false;
    
  } catch (error) {
    console.error('\n❌ ERROR ejecutando swap:');
    console.error(error);
    return false;
  }
}

// Ejecutar el script
executeDirectSwap()
  .then(success => {
    console.log('\n=====================================================');
    console.log(`Proceso ${success ? 'exitoso ✅' : 'fallido ❌'}`);
    process.exit(success ? 0 : 1);
  })
  .catch(error => {
    console.error('Error fatal:', error);
    process.exit(1);
  });