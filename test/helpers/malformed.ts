type Primitive = string | number | bigint | boolean | symbol | null | undefined;

type MalformedInput<T> = Partial<Record<keyof T, unknown>> | readonly unknown[] | Primitive;

// This helper lets tests pass deliberately partial or malformed fixtures.
// Object fixtures retain the target's field names and allow invalid values.
export function malformed<T>(value: MalformedInput<NoInfer<T>>): T {
  return value as T;
}
