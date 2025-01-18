/**
 * Base interface for request parameters
 */
interface BaseParamsType<T> {
  Params: T;
}

/**
 * Interface for simple GET requests
 */
export interface SimpleQuerystringType {
  Querystring: {
    channel_user_id: string;
  };
}

/**
 * Interface for GET requests with numeric id parameter
 */
export type IdParamType = BaseParamsType<{ id: number }>;

/**
 * Interface for GET requests with string id parameter
 */
export type IdStringParamType = BaseParamsType<{ id: string }>;

/**
 * Interface for GET requests with token id parameter
 */
export type NftListParamType = BaseParamsType<{ tokenId: number }>;
