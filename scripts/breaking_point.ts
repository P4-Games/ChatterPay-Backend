import fs from 'fs';
import path from 'path';
import axios, { AxiosResponse } from 'axios';

import { Logger } from '../src/helpers/loggerHelper';

// const BASE_URL: string = 'https://dev.back.chatterpay.net';
const BASE_URL: string = 'http://localhost:3001';
const ORIGIN_HEADER = { origin: 'dev.chatterpay.net' };
const AUTH_HEADER = { Authorization: `Bearer ${process.env.CHATIZALO_TOKEN}` };
const TOTAL_USERS: number = 2;
const START_PHONE_NUMBER: number = 55122222222;
const RECEIVER_PHONES: string[] = [
  '5491153475204',
  '5491156034231',
  '5492233049354',
  '5491124062885'
];

function logToFile(phone: string, message: string): void {
  const logDir = path.join(process.cwd(), 'logs');
  if (!fs.existsSync(logDir)) {
    fs.mkdirSync(logDir);
  }
  const filePath = path.join(logDir, `user_${phone}.log`);
  fs.appendFileSync(filePath, `${message}\n`);
}

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

async function makeTransaction(channelUserId: string, index: number): Promise<void> {
  const token = index % 2 === 0 ? 'USDT' : 'WETH';
  const amount = token === 'USDT' ? '500' : '2';
  const to = RECEIVER_PHONES[index % RECEIVER_PHONES.length];

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
    const log = `Transaction from ${channelUserId} to ${to} with ${amount} ${token}: ${JSON.stringify(response.data)}`;
    Logger.log('makeTransaction', log);
    logToFile(channelUserId, log);
  } catch (error: unknown) {
    const log = `Error for ${channelUserId}: ${error}`;
    Logger.log('makeTransaction', log);
    logToFile(channelUserId, log);
  }
}

async function simulateUserFullFlow(
  index: number
): Promise<{ phone: string; address: string | null }> {
  const phone: string = (START_PHONE_NUMBER + index).toString();
  const startLog = `Starting user ${phone}`;
  Logger.log('simulateUser', startLog);
  logToFile(phone, startLog);

  const address: string | null = await createWallet(phone);
  if (!address) return { phone, address: null };

  const addressLog = `Obtained address for ${phone}: ${address}`;
  Logger.log('simulateUser', addressLog);
  logToFile(phone, addressLog);

  await issueFunds(address, phone);

  const completeLog = `Completed creation & funding for ${phone}`;
  Logger.log('simulateUser', completeLog);
  logToFile(phone, completeLog);

  return { phone, address };
}

async function run(): Promise<void> {
  const indices = Array.from({ length: TOTAL_USERS }, (_, i) => i + 1);

  const creationResults = await Promise.all(indices.map((i) => simulateUserFullFlow(i)));

  const users = creationResults.filter((result) => result.address !== null) as {
    phone: string;
    address: string;
  }[];

  const txPromises = users.map((user, index) => makeTransaction(user.phone, index));
  await Promise.all(txPromises);
}

run();
