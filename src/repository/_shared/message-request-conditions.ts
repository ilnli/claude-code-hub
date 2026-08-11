import { sql } from "drizzle-orm";
import { messageRequest } from "@/drizzle/schema";
import { NON_BILLING_ENDPOINTS } from "@/lib/utils/performance-formatter";

/**
 * Warmup 抢答请求只用于探测/预热：日志可见，但不计入任何聚合统计/限额计算。
 *
 * 统一的过滤条件：排除 blocked_by='warmup' 的记录。
 */
export const EXCLUDE_WARMUP_CONDITION = sql`(${messageRequest.blockedBy} IS NULL OR ${messageRequest.blockedBy} <> 'warmup')`;

const NON_BILLING_MESSAGE_ENDPOINT_CONDITION = sql`(
  ${messageRequest.endpoint} IS NULL
  OR LOWER(REGEXP_REPLACE(${messageRequest.endpoint}, '/+$', '')) NOT IN (
    ${sql.join(
      NON_BILLING_ENDPOINTS.map((endpoint) => sql`${endpoint}`),
      sql`, `
    )}
  )
)`;

/** Cost and token aggregates only include requests eligible for billing. */
export const MESSAGE_REQUEST_BILLING_CONDITION = sql`(
  ${messageRequest.blockedBy} IS NULL
  AND ${messageRequest.isReplay} = false
  AND ${NON_BILLING_MESSAGE_ENDPOINT_CONDITION}
)`;
