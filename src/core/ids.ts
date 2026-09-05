import { randomUUID } from 'node:crypto';

export function id(prefix: string): string {
  return `${prefix}_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
}
