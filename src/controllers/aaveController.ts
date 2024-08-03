import dotenv from "dotenv";
import { FastifyReply, FastifyRequest } from "fastify";
import { authenticate } from "./transactionController"
import { IUser, User } from "../models/user"
import { supplyAaveByUOp } from "../services/walletService";

dotenv.config({path: './.env'});

export const supplyController =  async (request: FastifyRequest<{ Body: { channel_user_id:string, tokenAddress: string, amount: number, chain_id: number } }>, reply: FastifyReply) => {
    authenticate(request);
    const {channel_user_id, tokenAddress, amount, chain_id} = request.body;

    const user: IUser[] = await User.find({"channel_user_id": channel_user_id});
    const walletUser = user[0].wallet;

    supplyAaveByUOp(walletUser, amount, tokenAddress, chain_id);

}