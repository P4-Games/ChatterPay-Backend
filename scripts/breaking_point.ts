import fs from 'fs';
import path from 'path';
import axios, { AxiosResponse } from 'axios';

import { Logger } from '../src/helpers/loggerHelper';

// Base URL for the API
const BASE_URL: string = 'http://localhost:3001';
// Headers for the requests
const ORIGIN_HEADER = { origin: 'dev.chatterpay.net' };
const AUTH_HEADER = { Authorization: `Bearer ${process.env.CHATIZALO_TOKEN}` };
// Total number of users to create
const TOTAL_USERS: number = 100;
// Starting phone number for users
const START_PHONE_NUMBER: number = 55122222222;
// List of receiver phone numbers for transactions
const RECEIVER_PHONES: string[] = process.env.RECEIVER_PHONES
  ? process.env.RECEIVER_PHONES.split(',')
  : ['111111111111'];

interface Balance {
  token: string;
  balance: number;
}

// Function to introduce a delay in the execution
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Function to log messages to a file
function logToFile(phone: string, message: string): void {
  const logDir = path.join(process.cwd(), 'logs');
  if (!fs.existsSync(logDir)) {
    fs.mkdirSync(logDir);
  }
  const filePath = path.join(logDir, `user_${phone}.log`);
  fs.appendFileSync(filePath, `${message}\n`);
}

// Function to create a wallet for the user
async function createWallet(channelUserId: string): Promise<string | null> {
  try {
    const response: AxiosResponse = await axios.post(
      `${BASE_URL}/create_wallet`,
      { channel_user_id: channelUserId },
      { headers: { ...ORIGIN_HEADER, ...AUTH_HEADER } }
    );
    const log = `User ${channelUserId} response: ${JSON.stringify(response.data)}`;
    Logger.log('createWallet', log);
    logToFile(channelUserId, log);
    const walletAddressMatch = response.data?.data?.message?.match(/0x[a-fA-F0-9]{40}/);
    return walletAddressMatch ? walletAddressMatch[0] : null;
  } catch (error: unknown) {
    const log = `Error for ${channelUserId}: ${error}`;
    Logger.log('createWallet', log);
    logToFile(channelUserId, log);
    return null;
  }
}

// Function to issue funds to a user’s wallet
async function issueFunds(address: string, phone: string): Promise<void> {
  try {
    const response: AxiosResponse = await axios.post(
      `${BASE_URL}/issue`,
      { address },
      { headers: { ...ORIGIN_HEADER, ...AUTH_HEADER } }
    );
    const log = `Issued to ${address}: ${JSON.stringify(response.data)}`;
    Logger.log('issueFunds', log);
    logToFile(phone, log);
  } catch (error: unknown) {
    const log = `Error issuing to ${address}: ${error}`;
    Logger.log('issueFunds', log);
    logToFile(phone, log);
  }
}

// Function to get the wallet balance by phone number
async function getBalanceByPhone(channelUserId: string): Promise<unknown> {
  try {
    const response: AxiosResponse = await axios.get(
      `${BASE_URL}/balance_by_phone?channel_user_id=${channelUserId}`,
      { headers: { ...ORIGIN_HEADER, ...AUTH_HEADER } }
    );
    const log = `Balance for ${channelUserId}: ${JSON.stringify(response.data)}`;
    Logger.log('getBalanceByPhone', log);
    logToFile(channelUserId, log);
    return response.data?.data?.balances || [];
  } catch (error: unknown) {
    const log = `Error fetching balance for ${channelUserId}: ${error}`;
    Logger.log('getBalanceByPhone', log);
    logToFile(channelUserId, log);
    return [];
  }
}

// Function to make a transaction for a user
async function makeTransaction(channelUserId: string, index: number): Promise<void> {
  const token = index % 2 === 0 ? 'USDT' : 'WETH';
  const amount = token === 'USDT' ? '500' : '2';
  const to = RECEIVER_PHONES[index % RECEIVER_PHONES.length];
  let log = `Transaction from ${channelUserId}`;
  Logger.log('makeTransaction', log);
  logToFile(channelUserId, log);

  // Check if the user has enough balance
  const balances = await getBalanceByPhone(channelUserId);

  // Type assertion to let TypeScript know that balances is an array of Balance type
  const userBalance =
    (balances as Balance[]).find((balance) => balance.token === token)?.balance || 0;

  if (userBalance < parseFloat(amount)) {
    log = `User ${channelUserId} does not have enough funds for transaction. Current balance: ${userBalance}`;
    Logger.log('makeTransaction', log);
    logToFile(channelUserId, log);
    return;
  }

  try {
    const response: AxiosResponse = await axios.post(
      `${BASE_URL}/make_transaction`,
      {
        channel_user_id: channelUserId,
        to,
        token,
        amount
      },
      { headers: { ...ORIGIN_HEADER, ...AUTH_HEADER } }
    );
    log = `Transaction from ${channelUserId} to ${to} with ${amount} ${token}: ${JSON.stringify(response.data)}`;
    Logger.log('makeTransaction', log);
    logToFile(channelUserId, log);
  } catch (error: unknown) {
    log = `Error for ${channelUserId}: ${error}`;
    Logger.log('makeTransaction', log);
    logToFile(channelUserId, log);
  }
}

// Main function to create users, issue funds, and perform transactions sequentially
async function run(): Promise<void> {
  const indices = Array.from({ length: TOTAL_USERS }, (_, i) => i + 1);

  // Create users in parallel
  const users = await Promise.all(
    indices.map(async (i) => {
      const phone: string = (START_PHONE_NUMBER + i).toString();

      const startLog = `Starting full flow for user ${phone}`;
      Logger.log('simulateUser', startLog);
      logToFile(phone, startLog);

      // Create wallet for the user
      const address: string | null = await createWallet(phone);
      if (!address) {
        const failedLog = `Failed to create wallet for user ${phone}`;
        Logger.log('simulateUser', failedLog);
        logToFile(phone, failedLog);
        return null; // Skip this user if wallet creation failed
      }

      const addressLog = `Wallet created for user ${phone}: ${address}`;
      Logger.log('simulateUser', addressLog);
      logToFile(phone, addressLog);

      return { phone, address };
    })
  );

  // Filter out any users with invalid addresses (null or undefined)
  const validUsers = users.filter((user) => user && user.address) as {
    phone: string;
    address: string;
  }[];

  // Issue funds sequentially with a delay between each issuance
  await validUsers.reduce(async (prevPromise, user) => {
    if (!user || !user.address) return prevPromise;
    await prevPromise;
    await issueFunds(user.address, user.phone);
    await delay(1000);
    return Promise.resolve();
  }, Promise.resolve());

  // Make transactions for all valid users in parallel
  const transactionPromises = validUsers.map((user, index) => makeTransaction(user.phone, index));
  await Promise.all(transactionPromises);

  Logger.log('run', 'All users have been processed successfully!');
}

run();
