import { FastifyReply } from 'fastify';

export interface SuccessResponse {
    status: 'success';
    data: {
        id: string;
        message: string;
        [key: string]: unknown;
    };
    timestamp: string;
}

export interface ErrorResponse {
    status: 'error';
    data: {
        code: number;
        message: string;
        details?: string;
    };
    timestamp: string;
}

export function returnSuccessResponse(reply: FastifyReply, id: string, message: string, additionalData?: { [key: string]: unknown }) {
    const response: SuccessResponse = {
        status: 'success',
        data: {
            id,
            message,
            ...additionalData,
        },
        timestamp: new Date().toISOString(),
    };
    return reply.status(200).send(response);
}

export function returnErrorResponse(reply: FastifyReply, code: number, message: string, details?: string) {
    const response: ErrorResponse = {
        status: 'error',
        data: {
            code,
            message,
            details,
        },
        timestamp: new Date().toISOString(),
    };
    return reply.status(code).send(response);
}