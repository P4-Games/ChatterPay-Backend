/**
 * Base interface for request parameters
 */
interface BaseParams<T> {
  Params: T;
}

/**
 * Interface for simple GET requests
 */
export interface SimpleQuerystring {
  Querystring: {
    channel_user_id: string;
  };
}

/**
 * Interface for GET requests with numeric id parameter
 */
export type IDParam = BaseParams<{ id: number }>;

/**
 * Interface for GET requests with string id parameter
 */
export type IDStringParam = BaseParams<{ id: string }>;

/**
 * Interface for GET requests with token id parameter
 */
export type NFTListParam = BaseParams<{ tokenId: number }>;
