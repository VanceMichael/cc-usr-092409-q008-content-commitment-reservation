/** bigint 在 JSON 中以字符串传输，避免 JS Number 精度损失。 */
export function bigintReplacer(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? value.toString() : value;
}

export function toBigint(value: unknown, field: string): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isSafeInteger(value)) return BigInt(value);
  if (typeof value === "string" && /^-?\d+$/.test(value.trim())) return BigInt(value.trim());
  throw new Error(`字段 ${field} 必须是整数字符串（最小货币单位）`);
}

export function optionalBigint(value: unknown, field: string): bigint | undefined {
  if (value === undefined || value === null) return undefined;
  return toBigint(value, field);
}
